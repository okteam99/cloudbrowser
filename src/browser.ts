import {
  chromium,
  type Browser,
  type BrowserServer,
  type BrowserContext,
  type Page,
  type Locator,
  type ElementHandle,
  type Dialog,
  type Download,
} from 'playwright';
import type { Server } from 'proxy-chain';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createSchema,
  proxySchema,
  type Config,
  type InstanceOptions,
  type Proxy,
} from './config.js';
import { NetworkPolicy, createGateway } from './network.js';
import { Artifacts } from './artifacts.js';
import { RecordingStore } from './recordings.js';
import { ShareStore } from './shares.js';
import { Diagnostics, resources } from './diagnostics.js';
import { ToolError, publicError, safeUrl } from './errors.js';
import { ProxyStore } from './proxies.js';
import { ProxyHealthMonitor } from './proxy-health.js';
import { proxyCurl } from './proxy-http.js';

type PageEntry = {
  page: Page;
  generation: number;
  refs: Map<string, ElementHandle>;
  dialog?: Dialog;
  crashed?: boolean;
};
type Instance = {
  id: string;
  owner: string;
  browser: Browser;
  server: BrowserServer;
  operation?: {
    operation_id: string;
    tool: string;
    started_at: string;
    warn_after_ms: number;
    warned?: boolean;
  };
  probes: Map<string, Promise<{ status: string }>>;
  context: BrowserContext;
  gateway: Server;
  options: InstanceOptions;
  proxy?: Proxy;
  pages: Map<string, PageEntry>;
  created: number;
  touched: number;
  events: any[];
  downloads: any[];
  dir: string;
  busy: boolean;
  closing: boolean;
  crashed: boolean;
  activePageId?: string;
};
export type Target = {
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
  css?: string;
  frame?: string;
};

export class BrowserManager {
  instances = new Map<string, Instance>();
  artifacts: Artifacts;
  policy: NetworkPolicy;
  recordings: RecordingStore;
  shares: ShareStore;
  logs: Diagnostics;
  proxies: ProxyStore;
  proxyHealth: ProxyHealthMonitor;
  private curlActive = 0;
  private creating = 0;
  private closing = 0;
  constructor(public cfg: Config) {
    this.artifacts = new Artifacts(cfg);
    this.policy = new NetworkPolicy(cfg);
    this.logs = new Diagnostics(cfg);
    this.proxies = new ProxyStore(cfg);
    this.proxyHealth = new ProxyHealthMonitor(this.proxies, cfg, this.policy, (code, fields) =>
      this.logs.log({
        component: 'service',
        level: code.endsWith('failed') ? 'warn' : 'info',
        code,
        fields,
      }),
    );
    this.recordings = new RecordingStore(cfg, (event) => this.logs.log(event));
    this.shares = new ShareStore(cfg.dataDir);
  }
  async init() {
    await mkdir(this.cfg.dataDir, { recursive: true, mode: 0o700 });
    await this.logs.init();
    await this.proxies.init();
    for (const p of this.proxies.list())
      (this.logs.registerSecret(p.username, false), this.logs.registerSecret(p.password, false));
    await this.artifacts.init();
    await this.recordings.init();
    await this.shares.init();
    // The daemon holds its singleton lock before initialization. Remove orphaned download spools after restart.
    await rm(join(this.cfg.dataDir, 'sessions'), { recursive: true, force: true });
    await mkdir(join(this.cfg.dataDir, 'sessions'), { recursive: true, mode: 0o700 });
  }
  private instance(owner: string, id: string) {
    const i = this.instances.get(id);
    if (!i || i.owner !== owner || i.closing)
      throw new ToolError('INSTANCE_NOT_FOUND', 'Unknown or closed instance.');
    if (i.crashed)
      throw new ToolError(
        'BROWSER_CLOSED',
        'Browser crashed or disconnected; close and recreate instance.',
      );
    i.touched = Date.now();
    return i;
  }
  private page(i: Instance, id: string) {
    const p = i.pages.get(id);
    if (!p || p.page.isClosed()) throw new ToolError('PAGE_NOT_FOUND', 'Unknown or closed page.');
    return p;
  }
  private event(i: Instance, data: any) {
    i.events.push({ time: new Date().toISOString(), ...data });
    if (i.events.length > 300) i.events.shift();
    const fields = Object.fromEntries(
      Object.entries(data).filter(
        ([key, value]) =>
          !['type', 'page_id'].includes(key) &&
          ['string', 'number', 'boolean'].includes(typeof value),
      ),
    );
    if (typeof fields.url === 'string') fields.url = this.logs.url(fields.url);
    this.logs.log({
      owner: i.owner,
      instance_id: i.id,
      page_id: data.page_id,
      operation_id: i.operation?.operation_id,
      component: 'page',
      level: ['page_crashed', 'page_error'].includes(data.type)
        ? 'error'
        : ['request_failed', 'console'].includes(data.type)
          ? 'warn'
          : 'info',
      code: data.type,
      fields: fields as any,
    });
  }
  private clearRefs(p: PageEntry) {
    for (const h of p.refs.values()) void h.dispose().catch(() => {});
    p.refs.clear();
  }
  private attach(i: Instance, page: Page) {
    const id = `page_${randomUUID()}`;
    if (i.pages.size >= this.cfg.maxPages) {
      void page.close();
      this.event(i, { type: 'page_limit' });
      return id;
    }
    const entry: PageEntry = { page, generation: 0, refs: new Map() };
    i.pages.set(id, entry);
    i.activePageId = id;
    page.on('close', () => {
      this.clearRefs(entry);
      i.pages.delete(id);
      i.probes.delete(id);
      this.event(i, { type: 'page_closed', page_id: id, instance_closing: i.closing });
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.clearRefs(entry);
        this.event(i, { type: 'navigation', page_id: id, url: safeUrl(frame.url()) });
      }
    });
    page.on('requestfailed', (r) =>
      this.event(i, {
        type: 'request_failed',
        page_id: id,
        url: safeUrl(r.url()),
        error: r.failure()?.errorText.match(/(?:net::)?ERR_[A-Z0-9_]+/)?.[0] ?? 'REQUEST_FAILED',
      }),
    );
    page.on('response', (r) => {
      if (r.request().isNavigationRequest() || r.status() >= 400)
        this.event(i, { type: 'response', page_id: id, url: safeUrl(r.url()), status: r.status() });
    });
    // Page-supplied console strings can contain credentials; store category only.
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning')
        this.event(i, { type: 'console', level: msg.type(), page_id: id });
    });
    page.on('pageerror', (error) =>
      this.event(i, {
        type: 'page_error',
        page_id: id,
        error_name: [
          'Error',
          'TypeError',
          'ReferenceError',
          'SyntaxError',
          'RangeError',
          'URIError',
          'EvalError',
        ].includes(error.name)
          ? error.name
          : 'Error',
      }),
    );
    page.on('dialog', (dialog) => {
      entry.dialog = dialog;
    });
    page.on('download', (download) => {
      void this.download(i, id, download);
    });
    page.on('crash', () => {
      entry.crashed = true;
      this.event(i, { type: 'page_crashed', page_id: id });
    });
    return id;
  }
  private async download(i: Instance, pageId: string, download: Download) {
    const item: any = {
      download_id: `dl_${randomUUID()}`,
      page_id: pageId,
      name: download.suggestedFilename(),
      status: 'in_progress',
    };
    i.downloads.push(item);
    const sizeWatch = setInterval(() => {
      void readdir(i.dir)
        .then(async (files) => {
          for (const f of files) {
            const size = (await stat(join(i.dir, f)).catch(() => null))?.size ?? 0;
            if (size > this.cfg.downloadLimit) {
              void download.cancel();
              break;
            }
          }
        })
        .catch(() => {});
    }, 250);
    sizeWatch.unref();
    const watchdog = setTimeout(() => {
      void download.cancel();
    }, 120000);
    watchdog.unref();
    try {
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const part of stream) {
        total += part.length;
        if (total > this.cfg.downloadLimit) {
          await download.cancel();
          throw new ToolError('DOWNLOAD_TOO_LARGE', 'Download exceeds configured limit.');
        }
        chunks.push(Buffer.from(part));
      }
      if (await download.failure())
        throw new ToolError('DOWNLOAD_FAILED', 'Download did not complete.');
      const bytes = Buffer.concat(chunks);
      item.artifact = await this.artifacts.save(
        i.owner,
        i.id,
        item.name,
        'application/octet-stream',
        bytes,
        'download',
      );
      item.status = 'completed';
    } catch (e) {
      item.status = 'failed';
      item.error = publicError(e);
    } finally {
      clearInterval(sizeWatch);
      clearTimeout(watchdog);
      await download.delete().catch(() => {});
    }
  }
  private async resolveProxy(options: { proxy?: Proxy; proxy_id?: string; proxy_ref?: string }) {
    if (
      [options.proxy, options.proxy_id, options.proxy_ref].filter((x) => x !== undefined).length > 1
    )
      throw new ToolError('INVALID_ARGUMENT', 'Specify at most one proxy, proxy_id or proxy_ref.');
    const id = options.proxy_id ?? options.proxy_ref;
    if (id) return this.proxies.resolve(id);
    return options.proxy ? proxySchema.parse(options.proxy) : undefined;
  }
  private summary(i: Instance) {
    return {
      instance_id: i.id,
      active_page_id: i.activePageId,
      recording_id: this.recordings.active.get(i.id)?.meta.id,
      live_frame_at: this.recordings.active.get(i.id)?.latest?.time,
      live_url: this.cfg.baseUrl
        ? `${this.cfg.baseUrl.replace(/\/$/, '')}/api/instances/${i.id}/live`
        : undefined,
      status: i.crashed ? 'crashed' : 'ready',
      created_at: new Date(i.created).toISOString(),
      viewport: i.options.viewport,
      user_agent: i.options.user_agent ?? 'browser default',
      locale: i.options.locale,
      timezone: i.options.timezone,
      mobile: i.options.mobile,
      proxy: i.proxy
        ? {
            proxy_id: i.options.proxy_id ?? i.options.proxy_ref,
            server: i.proxy.server,
            authenticated: Boolean(i.proxy.username || i.proxy.password),
          }
        : null,
      idle_timeout_seconds: i.options.idle_timeout_seconds,
      max_lifetime_seconds: i.options.max_lifetime_seconds,
      pages: Array.from(i.pages, ([page_id, p]) => ({ page_id, url: p.page.url() })),
      warnings: [
        'UA/viewport simulation is not a real mobile device. Client Hints may differ; verify on the target.',
        'Host policy is defense in depth; use trusted upstream proxies and a network firewall for strict egress isolation.',
      ],
    };
  }
  async create(owner: string, raw: unknown, operationId?: string) {
    if (this.instances.size + this.creating + this.closing >= this.cfg.maxInstances)
      throw new ToolError('INSTANCE_LIMIT', 'Maximum instances reached.');
    this.creating++;
    let gateway: Server | undefined,
      browser: Browser | undefined,
      server: BrowserServer | undefined,
      dir: string | undefined;
    const id = `ins_${randomUUID()}`;
    let current: Instance | undefined,
      failed = false;
    this.logs.register({
      instance_id: id,
      owner,
      created_at: new Date().toISOString(),
      status: 'starting',
    });
    this.logs.log({
      owner,
      instance_id: id,
      operation_id: operationId,
      component: 'browser',
      level: 'info',
      code: 'browser_launch_started',
    });
    try {
      const options = createSchema.parse(raw);
      const proxy = await this.resolveProxy(options);
      gateway = await createGateway(this.policy, proxy);
      dir = await mkdtemp(join(this.cfg.dataDir, 'sessions', 'instance-'));
      this.logs.registerSecret(proxy?.username, false);
      this.logs.registerSecret(proxy?.password, false);
      server = await chromium.launchServer({
        host: '127.0.0.1',
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        headless: true,
        chromiumSandbox: process.env.CHROMIUM_SANDBOX === 'true',
        timeout: 30000,
        downloadsPath: dir,
        proxy: { server: `http://127.0.0.1:${gateway.port}`, bypass: '<-loopback>' },
        args: [
          '--disable-quic',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--disable-background-networking',
          '--disable-features=DnsOverHttps',
        ],
      });
      const child = server.process();
      this.logs.update(id, { pid: child.pid });
      child.once('exit', (code, signal) => {
        const expected = !!current?.closing || failed;
        this.logs.log({
          owner,
          instance_id: id,
          component: 'browser',
          level: expected ? 'info' : 'error',
          code: 'browser_process_exited',
          fields: { exit_code: code, signal, expected },
        });
        this.logs.update(id, {
          exit_code: code,
          exit_signal: signal,
          ...(!expected ? { status: 'crashed' as const } : {}),
        });
        if (current && !expected) current.crashed = true;
      });
      const reported = new Set<string>();
      let stderrTail = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = (stderrTail = (stderrTail + chunk.toString()).slice(-8192));
        const code = /out of memory|allocation failed|oom-kill/i.test(text)
          ? 'browser_allocation_failure'
          : /no space left on device/i.test(text)
            ? 'browser_disk_full'
            : /FATAL|Received signal/i.test(text)
              ? 'browser_native_fatal'
              : /sandbox.*(?:failed|error)|No usable sandbox/i.test(text)
                ? 'browser_sandbox_error'
                : undefined;
        if (code && !reported.has(code)) {
          reported.add(code);
          this.logs.log({
            owner,
            instance_id: id,
            component: 'browser',
            level: 'error',
            code,
            fields: { shutdown_requested: !!current?.closing || failed },
          });
        }
      });
      browser = await chromium.connect(server.wsEndpoint(), { timeout: 30000 });
      const context = await browser.newContext({
        userAgent: options.user_agent,
        viewport: options.viewport,
        isMobile: options.mobile?.enabled ?? false,
        hasTouch: options.mobile?.touch ?? false,
        deviceScaleFactor: options.mobile?.device_scale_factor ?? 1,
        locale: options.locale,
        timezoneId: options.timezone,
        acceptDownloads: true,
        serviceWorkers: 'block',
      });
      context.setDefaultTimeout(this.cfg.timeout);
      context.setDefaultNavigationTimeout(this.cfg.timeout);
      // Reject local schemes and redirects before request execution; the gateway also validates each destination.
      await context.route('**/*', async (route) => {
        try {
          await this.policy.url(route.request().url());
          await route.continue();
        } catch {
          await route.abort('blockedbyclient');
        }
      });
      const i: Instance = {
        id,
        owner,
        browser,
        server,
        context,
        gateway,
        options,
        proxy,
        pages: new Map(),
        probes: new Map(),
        created: Date.now(),
        touched: Date.now(),
        events: [],
        downloads: [],
        dir,
        busy: false,
        closing: false,
        crashed: false,
      };
      current = i;
      context.on('page', (page) => this.attach(i, page));
      browser.on('disconnected', () => {
        this.logs.log({
          owner,
          instance_id: id,
          component: 'browser',
          level: i.closing ? 'info' : 'error',
          code: 'browser_disconnected',
          fields: { expected: i.closing },
        });
        if (!i.closing) {
          i.crashed = true;
          this.logs.update(id, { status: 'crashed' });
        }
      });
      this.instances.set(i.id, i);
      this.logs.update(id, { status: 'active' });
      this.logs.log({
        owner,
        instance_id: id,
        operation_id: operationId,
        component: 'browser',
        level: 'info',
        code: 'instance_created',
        fields: {
          pid: child.pid ?? null,
          idle_timeout_seconds: options.idle_timeout_seconds,
          max_lifetime_seconds: options.max_lifetime_seconds,
          proxy_enabled: !!proxy,
        },
      });
      const p = await context.newPage();
      const recorder = await this.recordings.start(i.id, owner, () => {
        const e = i.pages.get(i.activePageId ?? '') ?? Array.from(i.pages.values()).at(-1);
        if (!e) return undefined;
        return {
          page: e.page,
          page_id: Array.from(i.pages).find(([, v]) => v === e)![0],
          deviceScaleFactor: i.options.mobile?.device_scale_factor ?? 1,
          busy: i.busy,
        };
      });
      this.logs.update(id, {
        recording: {
          recording_id: recorder.meta.id,
          status: recorder.meta.status,
          frames: recorder.meta.frames,
          bytes: recorder.meta.bytes,
          last_frame_at: null,
          sampling_failures: 0,
        },
      });
      return { ...this.summary(i), actual: await this.environment(p) };
    } catch (e) {
      failed = true;
      const message = e instanceof Error ? e.message : '';
      const creationReason = /executable.*(?:doesn.t exist|not found)|playwright install/i.test(
        message,
      )
        ? 'browser_binary_missing'
        : /sandbox/i.test(message)
          ? 'sandbox_configuration'
          : /no space|ENOSPC/i.test(message)
            ? 'disk_full'
            : /out of memory|ENOMEM|allocation failed/i.test(message)
              ? 'memory_allocation_failure'
              : /EACCES|permission denied/i.test(message)
                ? 'permission_denied'
                : /timeout|timed out/i.test(message)
                  ? 'creation_timeout'
                  : 'initialization_failed';
      if (current) current.closing = true;
      this.logs.update(id, {
        status: 'failed',
        close_reason: 'creation_failed',
        ended_at: new Date().toISOString(),
      });
      this.logs.log({
        owner,
        instance_id: id,
        operation_id: operationId,
        component: 'browser',
        level: 'error',
        code: 'instance_creation_failed',
        fields: { error_code: publicError(e).code, reason: creationReason },
      });
      if (browser) {
        for (const [id, i] of this.instances) if (i.browser === browser) this.instances.delete(id);
      }
      if (browser) {
        for (const [id, r] of this.recordings.active)
          if (!this.instances.has(id)) await this.recordings.stop(id).catch(() => {});
      }
      await server?.kill().catch(() => {});
      await browser?.close().catch(() => {});
      await gateway?.close(true).catch(() => {});
      if (dir) await rm(dir, { recursive: true, force: true });
      throw e;
    } finally {
      this.creating--;
    }
  }
  private async environment(p: Page) {
    return {
      viewport: p.viewportSize(),
      ...(await p.evaluate(() => ({
        user_agent: navigator.userAgent,
        layout_viewport: { width: innerWidth, height: innerHeight },
        screen: { width: screen.width, height: screen.height },
        device_scale_factor: devicePixelRatio,
        touch_points: navigator.maxTouchPoints,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        client_hints: (navigator as any).userAgentData?.toJSON() ?? null,
      }))),
    };
  }
  private async withDialog(p: PageEntry, action: () => Promise<unknown>) {
    let listener: (d: Dialog) => void = () => {};
    const dialog = new Promise<{ type: string; message: string }>((resolve) => {
      listener = (d) => resolve({ type: d.type(), message: d.message().slice(0, 1000) });
      p.page.once('dialog', listener);
    });
    try {
      return await Promise.race([action().then(() => null), dialog]);
    } finally {
      p.page.off('dialog', listener);
    }
  }
  private target(p: PageEntry, target: Target): Locator | ElementHandle {
    if (target.ref) {
      const ref = p.refs.get(target.ref);
      if (!ref)
        throw new ToolError(
          'STALE_ELEMENT_REFERENCE',
          'Get a new snapshot before using this reference.',
        );
      return ref;
    }
    const root = target.frame ? p.page.frameLocator(target.frame) : p.page;
    if (target.role) return root.getByRole(target.role as any, { name: target.name, exact: true });
    if (target.text !== undefined) return root.getByText(target.text, { exact: true });
    if (target.css) return root.locator(target.css);
    throw new ToolError('INVALID_TARGET', 'Specify ref, role, text, or css.');
  }
  async close(owner: string, id: string, reason = 'requested') {
    const i = this.instances.get(id);
    if (!i || i.owner !== owner) throw new ToolError('INSTANCE_NOT_FOUND', 'Unknown instance.');
    const recorder = this.recordings.active.get(id);
    i.closing = true;
    this.instances.delete(id);
    this.closing++;
    this.logs.update(id, { status: 'closing', close_reason: reason });
    this.logs.log({
      owner,
      instance_id: id,
      component: 'browser',
      level: 'info',
      code: 'instance_close_started',
      fields: { reason },
    });
    let forced = false;
    const kill = setTimeout(() => {
      forced = true;
      void i.server.kill().catch(() => {});
    }, 3000);
    kill.unref();
    await this.recordings.stop(i.id).catch(() =>
      this.logs.log({
        owner,
        instance_id: id,
        component: 'recorder',
        level: 'error',
        code: 'recorder_cleanup_failed',
      }),
    );
    await i.server.close().catch(async () => {
      this.logs.log({
        owner,
        instance_id: id,
        component: 'browser',
        level: 'warn',
        code: 'browser_close_failed',
      });
      await i.server.kill().catch(() => {});
    });
    clearTimeout(kill);
    await i.browser.close().catch(() => {});
    await i.gateway.close(true).catch(() => {});
    await rm(i.dir, { recursive: true, force: true }).catch(() =>
      this.logs.log({
        owner,
        instance_id: id,
        component: 'browser',
        level: 'warn',
        code: 'session_cleanup_failed',
      }),
    );
    this.closing--;
    if (recorder)
      this.logs.update(id, {
        recording: {
          recording_id: recorder.meta.id,
          status: recorder.meta.status,
          frames: recorder.meta.frames,
          bytes: recorder.meta.bytes,
          last_frame_at: recorder.latest ? new Date(recorder.latest.time).toISOString() : null,
          sampling_failures: recorder.diagnostics().total_sampling_failures,
        },
      });
    this.logs.update(id, {
      status: 'closed',
      close_reason: reason,
      ended_at: new Date().toISOString(),
    });
    this.logs.log({
      owner,
      instance_id: id,
      component: 'browser',
      level: forced ? 'warn' : 'info',
      code: 'instance_closed',
      fields: { reason, forced },
    });
    await this.logs.flush();
    return { instance_id: id, status: 'closed' };
  }
  async sweep() {
    for (const i of this.instances.values()) {
      if (
        i.operation &&
        !i.operation.warned &&
        Date.now() - Date.parse(i.operation.started_at) > i.operation.warn_after_ms
      ) {
        i.operation.warned = true;
        this.logs.log({
          owner: i.owner,
          instance_id: i.id,
          operation_id: i.operation.operation_id,
          component: 'operation',
          level: 'warn',
          code: 'operation_stalled',
          fields: {
            tool: i.operation.tool,
            elapsed_ms: Date.now() - Date.parse(i.operation.started_at),
          },
        });
      }
      const reason = i.crashed
        ? 'browser_disconnected'
        : Date.now() - i.created > i.options.max_lifetime_seconds * 1000
          ? 'max_lifetime'
          : !i.busy && Date.now() - i.touched > i.options.idle_timeout_seconds * 1000
            ? 'idle_timeout'
            : undefined;
      if (reason) await this.close(i.owner, i.id, reason);
    }
    await this.artifacts.clean();
    await this.recordings.clean();
    await this.logs.clean();
  }
  adminInstances() {
    return Array.from(this.instances.values(), (i) => ({ ...this.summary(i), owner: i.owner }));
  }
  async shutdown() {
    await this.proxyHealth.stop();
    await Promise.allSettled(
      Array.from(this.instances.values(), (i) => this.close(i.owner, i.id, 'service_shutdown')),
    );
    await this.logs.flush();
  }
  async inspect(owner: string, id: string, probe: boolean, timeout: number) {
    const record = this.logs.get(owner, id);
    const i = this.instances.get(id);
    const active = i && i.owner === owner ? i : undefined;
    const recorder = this.recordings.active.get(id);
    const elapsed = active?.operation ? Date.now() - Date.parse(active.operation.started_at) : null;
    const page =
      active?.pages.get(active.activePageId ?? '') ?? [...(active?.pages.values() ?? [])].at(-1);
    let responsiveness: { status: string } = { status: probe ? 'unavailable' : 'not_probed' };
    if (
      probe &&
      active &&
      page &&
      !page.page.isClosed() &&
      !page.crashed &&
      active.browser.isConnected()
    ) {
      const pageId = [...active.pages].find(([, entry]) => entry === page)![0];
      if (!active.probes.has(pageId)) {
        const promise = page.page
          .evaluate(() => true)
          .then(
            () => ({ status: 'responsive' }),
            () => ({ status: 'probe_failed' }),
          );
        active.probes.set(pageId, promise);
        void promise.finally(() => {
          if (active.probes.get(pageId) === promise) active.probes.delete(pageId);
        });
      }
      let timer: NodeJS.Timeout | undefined;
      responsiveness = await Promise.race([
        active.probes.get(pageId)!,
        new Promise<{ status: string }>((resolve) => {
          timer = setTimeout(() => resolve({ status: 'unresponsive' }), timeout);
        }),
      ]);
      clearTimeout(timer);
    }
    const findings: string[] = [];
    if (active?.crashed) findings.push('browser_disconnected');
    if (page?.crashed) findings.push('page_crashed');
    if (elapsed !== null && active?.operation && elapsed > active.operation.warn_after_ms)
      findings.push('operation_stalled');
    const frameAge = recorder?.latest ? Date.now() - recorder.latest.time : null;
    if (
      active &&
      page &&
      (frameAge === null ? Date.now() - active.created > 10000 : frameAge > 10000)
    )
      findings.push('live_frames_stale');
    if (responsiveness.status === 'unresponsive') findings.push('renderer_probe_timed_out');
    if (recorder?.meta.status === 'failed') findings.push('recording_failed');
    return {
      instance: this.logs.get(owner, id),
      live: active
        ? {
            connected: active.browser.isConnected(),
            busy: active.busy,
            active_operation: active.operation ?? null,
            operation_elapsed_ms: elapsed,
            page_count: active.pages.size,
            active_page_id: active.activePageId,
            last_frame_age_ms: frameAge,
            recording: recorder?.diagnostics() ?? null,
          }
        : null,
      responsiveness,
      findings,
      resources: await resources(this.cfg.dataDir),
      recent_logs: await this.logs.query(owner, { instance_id: id, level: 'warn', limit: 20 }),
      note: 'A probe timeout is an observation, not proof of a specific cause. This call does not cancel, retry or close browser actions.',
    };
  }
  async execute(
    owner: string,
    name: string,
    a: any,
    operationId: string = randomUUID(),
  ): Promise<any> {
    if (name === 'get_logs') return this.logs.query(owner, a);
    if (name === 'inspect_instance')
      return this.inspect(owner, a.instance_id, a.probe ?? true, a.timeout_ms ?? 1500);
    if (name === 'get_diagnostics') {
      const i = this.instances.get(a.instance_id);
      if (!i || i.owner !== owner)
        throw new ToolError(
          'INSTANCE_NOT_FOUND',
          'Unknown live instance. Use get_logs or inspect_instance for retained history.',
        );
      return { events: i.events.slice(-a.limit), downloads: i.downloads };
    }
    const started = Date.now();
    const own = this.instances.get(a.instance_id);
    const id = own?.owner === owner ? own.id : undefined;
    const track = ![
      'health',
      'list_instances',
      'list_pages',
      'get_instance',
      'list_recordings',
      'list_share_links',
    ].includes(name);
    if (track)
      this.logs.log({
        owner,
        instance_id: id,
        operation_id: operationId,
        component: 'operation',
        level: 'info',
        code: 'operation_started',
        fields: { tool: name },
      });
    try {
      const result = await this.dispatchOperation(owner, name, a, operationId);
      if (track)
        this.logs.log({
          owner,
          instance_id: id ?? (name === 'create_instance' ? result.instance_id : undefined),
          operation_id: operationId,
          component: 'operation',
          level: 'info',
          code: 'operation_succeeded',
          fields: { tool: name, elapsed_ms: Date.now() - started },
        });
      return result;
    } catch (error) {
      this.logs.log({
        owner,
        instance_id: id,
        operation_id: operationId,
        component: 'operation',
        level: 'error',
        code: 'operation_failed',
        fields: {
          tool: name,
          error_code: publicError(error).code,
          elapsed_ms: Date.now() - started,
        },
      });
      throw error;
    }
  }
  private async dispatchOperation(
    owner: string,
    name: string,
    a: any,
    operationId: string,
  ): Promise<any> {
    if (name === 'list_share_links') return this.shares.list(owner);
    if (name === 'revoke_share_link') return this.shares.revoke(owner, a.share_id);
    if (name === 'create_share_link') {
      if (!this.cfg.webPort || !this.cfg.baseUrl)
        throw new ToolError('SHARING_DISABLED', 'Public sharing requires web mode and BASE_URL.');
      let resource: string;
      if (a.kind === 'live') {
        const i = this.instance(owner, a.instance_id);
        if (!this.recordings.active.has(i.id))
          throw new ToolError('LIVE_UNAVAILABLE', 'Live preview is unavailable for this instance.');
        resource = i.id;
      } else {
        const { meta, path } = await this.recordings.get(a.recording_id);
        if (meta.owner !== owner) throw new ToolError('RECORDING_NOT_FOUND', 'Unknown recording.');
        if (['recording', 'finalizing'].includes(meta.status))
          throw new ToolError(
            'RECORDING_NOT_READY',
            'Close the instance before sharing its recording.',
          );
        if (!(await stat(path).catch(() => null))?.size)
          throw new ToolError('RECORDING_NOT_FOUND', 'Recording file unavailable.');
        resource = meta.id;
      }
      const { token, ...metadata } = await this.shares.create(
        owner,
        a.kind,
        resource,
        a.expires_in_seconds,
      );
      const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/share/${token}`;
      return {
        ...metadata,
        url,
        media_url: url + '/media',
        frame_url: a.kind === 'live' ? url + '/frame' : undefined,
        access: 'public_read_only',
      };
    }
    if (name === 'list_recordings')
      return (await this.recordings.list())
        .filter((r) => r.owner === owner && (!a.instance_id || r.instance_id === a.instance_id))
        .map((r) => ({
          ...r,
          playback_url: this.cfg.baseUrl
            ? `${this.cfg.baseUrl.replace(/\/$/, '')}/api/recordings/${r.id}/video`
            : undefined,
        }));
    if (name === 'put_artifact') {
      const bytes = Buffer.from(a.data_base64, 'base64');
      if (bytes.length > 524288)
        throw new ToolError('ARTIFACT_TOO_LARGE', 'put_artifact limit is 512 KiB.');
      return this.artifacts.save(owner, 'upload', a.name, a.mime, bytes, 'upload');
    }
    if (name === 'health')
      return {
        status: 'ok',
        version: '0.8.0',
        base_url: this.cfg.baseUrl,
        public_url_mode: this.cfg.quickTunnel
          ? 'quick_tunnel'
          : this.cfg.cfTunnelToken
            ? 'named_tunnel'
            : 'custom',
        instances: this.instances.size,
        starting_instances: this.creating,
        closing_instances: this.closing,
        max_instances: this.cfg.maxInstances,
        resources: await resources(this.cfg.dataDir),
        diagnostic_write_errors: this.logs.writeErrors,
        diagnostic_last_write_error: this.logs.lastWriteError ?? null,
        diagnostic_dropped_events: this.logs.droppedEvents,
      };
    if (name === 'list_proxies') return this.proxies.available(a);
    if (name === 'proxy_curl') {
      if (this.curlActive >= this.cfg.maxInstances)
        throw new ToolError('HTTP_BUSY', 'Concurrent HTTP request limit reached.');
      const proxy = this.proxies.resolve(a.proxy_id);
      this.logs.registerSecret(proxy.username, false);
      this.logs.registerSecret(proxy.password, false);
      this.curlActive++;
      try {
        return await proxyCurl(this.policy, proxy, a);
      } finally {
        this.curlActive--;
      }
    }
    if (name === 'create_instance') return this.create(owner, a, operationId);
    if (name === 'list_instances')
      return Array.from(this.instances.values())
        .filter((i) => i.owner === owner)
        .map((i) => this.summary(i));
    if (name === 'get_artifact')
      return this.artifacts.get(owner, a.artifact_id, a.offset, a.length);
    if (name === 'check_proxy') {
      const result = await this.create(owner, {
        proxy: a.proxy,
        proxy_id: a.proxy_id,
        proxy_ref: a.proxy_ref,
      });
      try {
        return await this.execute(owner, 'verify_environment', {
          instance_id: result.instance_id,
          check_url: a.check_url,
        });
      } finally {
        await this.close(owner, result.instance_id);
      }
    }
    if (name === 'close_instance') return this.close(owner, a.instance_id);
    const i = this.instance(owner, a.instance_id);
    if (i.busy)
      throw new ToolError('INSTANCE_BUSY', 'An operation is already running on this instance.');
    i.busy = true;
    i.operation = {
      operation_id: operationId,
      tool: name,
      started_at: new Date().toISOString(),
      warn_after_ms: Math.max(this.cfg.timeout, a.timeout_ms ?? 0) + 5000,
    };
    this.logs.update(i.id, { last_operation: { ...i.operation, status: 'running' } });
    let status = 'failed';
    try {
      const result = await this.action(i, name, a);
      status = 'succeeded';
      return result;
    } finally {
      this.logs.update(i.id, {
        last_operation: {
          operation_id: operationId,
          tool: name,
          started_at: i.operation!.started_at,
          ended_at: new Date().toISOString(),
          status,
        },
      });
      i.operation = undefined;
      i.busy = false;
      i.touched = Date.now();
    }
  }
  private async action(i: Instance, name: string, a: any): Promise<any> {
    if (name === 'get_instance') return this.summary(i);
    if (name === 'list_pages')
      return Promise.all(
        Array.from(i.pages, async ([page_id, p]) => ({
          page_id,
          url: p.page.url(),
          title: await p.page.title().catch(() => ''),
          dialog: p.dialog?.type(),
        })),
      );
    if (name === 'create_page') {
      if (i.pages.size >= this.cfg.maxPages)
        throw new ToolError('PAGE_LIMIT', 'Maximum pages reached.');
      if (a.url) await this.policy.url(a.url);
      const p = await i.context.newPage();
      const page_id = Array.from(i.pages).find(([, e]) => e.page === p)![0];
      if (a.url) await p.goto(a.url, { waitUntil: 'domcontentloaded' });
      return { page_id, url: p.url() };
    }
    if (name === 'list_downloads') return i.downloads;
    if (name === 'verify_environment') {
      const u = a.check_url ?? 'https://api.ipify.org?format=json';
      await this.policy.url(u);
      if (i.pages.size >= this.cfg.maxPages)
        throw new ToolError('PAGE_LIMIT', 'Free a page before verifying environment.');
      const p = await i.context.newPage();
      try {
        const response = await p.goto(u, { waitUntil: 'domcontentloaded' });
        const content = (await p.locator('body').innerText()).slice(0, 16384);
        if (!response || response.status() >= 400)
          throw new ToolError('ENVIRONMENT_CHECK_FAILED', 'IP check endpoint returned an error.');
        let parsed: any;
        try {
          parsed = JSON.parse(content);
        } catch {
          parsed = null;
        }
        return {
          instance_id: i.id,
          check_url: u,
          status: response.status(),
          actual: await this.environment(p),
          observed_ip: parsed?.ip ?? null,
          response: content,
          country: null,
          note: 'Verify observed_ip and any country assertion using a trusted source; HTTP success alone is not a proxy verification.',
        };
      } finally {
        await p.close();
      }
    }
    const p = this.page(i, a.page_id);
    if (['navigate', 'interact', 'upload_file'].includes(name)) i.activePageId = a.page_id;
    if (name === 'close_page') {
      await p.page.close();
      return { status: 'closed' };
    }
    if (name === 'navigate') {
      let response;
      if (a.action === 'back') response = await p.page.goBack({ waitUntil: 'domcontentloaded' });
      else if (a.action === 'forward')
        response = await p.page.goForward({ waitUntil: 'domcontentloaded' });
      else if (a.action === 'reload')
        response = await p.page.reload({ waitUntil: 'domcontentloaded' });
      else {
        await this.policy.url(a.url);
        response = await p.page.goto(a.url, { waitUntil: 'domcontentloaded' });
      }
      return {
        page_id: a.page_id,
        url: p.page.url(),
        status: response?.status() ?? null,
        title: await p.page.title(),
      };
    }
    if (name === 'snapshot') {
      this.clearRefs(p);
      p.generation++;
      const root = a.frame ? p.page.frameLocator(a.frame).locator('body') : p.page.locator('body');
      const tree = await root.ariaSnapshot();
      const elements = root.locator(
        'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]',
      );
      const found: any[] = [];
      for (let n = 0; n < Math.min(await elements.count(), a.limit); n++) {
        const loc = elements.nth(n);
        if (!(await loc.isVisible().catch(() => false))) continue;
        const ref = `g${p.generation}e${n}`;
        const handle = await loc.elementHandle();
        if (!handle) continue;
        p.refs.set(ref, handle);
        found.push({
          ref,
          ...(await loc.evaluate((el) => ({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            text: (
              el.getAttribute('aria-label') ||
              el.textContent ||
              el.getAttribute('placeholder') ||
              ''
            )
              .trim()
              .slice(0, 200),
            href: el.getAttribute('href'),
            type: el.getAttribute('type'),
          }))),
        });
      }
      return {
        page_id: a.page_id,
        url: p.page.url(),
        title: await p.page.title(),
        actual: await this.environment(p.page),
        tree: tree.slice(0, 60000),
        elements: found,
        frames: p.page.frames().map((f) => ({ name: f.name(), url: f.url() })),
        note: 'References identify the original DOM node; obtain a fresh snapshot after DOM changes. Content and URLs can contain user data.',
      };
    }
    if (name === 'interact') {
      let pendingDialog: { type: string; message: string } | null = null;
      if (a.action === 'scroll') {
        if (a.target) await this.target(p, a.target).scrollIntoViewIfNeeded();
        await p.page.mouse.wheel(a.delta_x ?? 0, a.delta_y ?? 600);
      } else {
        const loc = this.target(p, a.target);
        pendingDialog = await this.withDialog(p, async () => {
          if (a.action === 'click') await loc.click();
          else if (a.action === 'fill') await loc.fill(a.value ?? '');
          else if (a.action === 'press') await loc.press(a.value);
          else if (a.action === 'select') await loc.selectOption(a.value);
          else if (a.action === 'check') await loc.setChecked(a.checked ?? true);
          else if (a.action === 'hover') await loc.hover();
        });
      }
      this.clearRefs(p);
      return {
        url: p.page.url(),
        pending_dialog: pendingDialog,
        pages: Array.from(i.pages, ([page_id, e]) => ({ page_id, url: e.page.url() })),
      };
    }
    if (name === 'wait_for') {
      const timeout = Math.min(a.timeout_ms ?? this.cfg.timeout, 60000);
      if (a.target) {
        const loc = this.target(p, a.target);
        const state = a.state ?? 'visible';
        if ('waitFor' in loc) await loc.waitFor({ state, timeout });
        else if (state === 'attached') {
          if (!(await loc.evaluate((el) => el.isConnected)))
            throw new ToolError('STALE_ELEMENT_REFERENCE', 'Referenced node is detached.');
        } else if (state === 'detached') {
          const end = Date.now() + timeout;
          while (await loc.evaluate((el) => el.isConnected)) {
            if (Date.now() > end) throw new ToolError('TIMEOUT', 'Element remains attached.');
            await new Promise((r) => setTimeout(r, 100));
          }
        } else await loc.waitForElementState(state, { timeout });
      } else if (a.url) await p.page.waitForURL(a.url, { timeout, waitUntil: 'domcontentloaded' });
      else if (a.download_id) {
        const until = Date.now() + timeout;
        while (Date.now() < until) {
          const item = i.downloads.find((x) => x.download_id === a.download_id);
          if (!item) throw new ToolError('DOWNLOAD_NOT_FOUND', 'Unknown download.');
          if (item.status !== 'in_progress') return item;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new ToolError('TIMEOUT', 'Download is still in progress.');
      } else throw new ToolError('INVALID_ARGUMENT', 'Specify target, url, or download_id.');
      return { url: p.page.url() };
    }
    if (name === 'handle_dialog') {
      if (!p.dialog) throw new ToolError('DIALOG_NOT_FOUND', 'No pending dialog.');
      const d = p.dialog;
      p.dialog = undefined;
      if (a.accept) await d.accept(a.text);
      else await d.dismiss();
      return { type: d.type(), accepted: a.accept };
    }
    if (name === 'screenshot') {
      const bytes = await p.page.screenshot({
        type: 'png',
        fullPage: a.full_page ?? false,
        timeout: this.cfg.timeout,
      });
      return this.artifacts.save(i.owner, i.id, 'screenshot.png', 'image/png', bytes, 'screenshot');
    }
    if (name === 'upload_file') {
      const artifact = await this.artifacts.get(i.owner, a.artifact_id, 0, 0);
      // Read through the owner-checked artifact API in bounded chunks; no host filesystem path is accepted.
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < artifact.size; offset += 262144)
        chunks.push(
          Buffer.from(
            (await this.artifacts.get(i.owner, a.artifact_id, offset, 262144)).data_base64,
            'base64',
          ),
        );
      await this.target(p, a.target).setInputFiles({
        name: artifact.name,
        mimeType: artifact.mime,
        buffer: Buffer.concat(chunks),
      });
      return { uploaded: true, artifact_id: a.artifact_id };
    }
    throw new ToolError('UNKNOWN_TOOL', 'Unknown tool.');
  }
}
