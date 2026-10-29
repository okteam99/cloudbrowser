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
  type Request,
  type Frame,
  type CDPSession,
} from 'playwright';
import type { Server } from 'proxy-chain';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
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
import { PageData } from './page-data.js';
import { NavigationRecorder } from './navigation.js';
import { readStorageState, storageLimit, deadline } from './browser-state.js';
import sharp from 'sharp';
import { operatingSystem, type BrowserEnvironment } from './browser-environment.js';
import { userAgentMetadata } from './user-agent.js';
import {
  profileMetadata,
  protocolProfile,
  acceptLanguage,
  applyProfileUserAgent,
  webObservablesScript,
  type AppliedDeviceProfile,
} from './device-profile.js';
import { DeviceProfileStore } from './device-profiles.js';
import { verifyDeviceProfile, type DeviceVerification } from './device-verification.js';
import { SystemSettings } from './system-settings.js';
import { instanceDocument } from './instance-document.js';
import {
  instanceDetailsUrl,
  type InstanceProperties,
  type InstancePage,
} from './instance-details.js';

type PageEntry = {
  page: Page;
  generation: number;
  refs: Map<string, ElementHandle>;
  dialog?: Dialog;
  crashed?: boolean;
  requiresReload?: boolean;
  watchdogs: Map<Frame, CDPSession>;
  watchdogPending: Map<Frame, Promise<CDPSession>>;
  navigation: NavigationRecorder;
  navigationReady: Promise<void>;
};
type EffectiveInstanceOptions = Omit<
  InstanceOptions,
  'device_profile' | 'locale' | 'timezone' | 'viewport' | 'mobile'
> & {
  locale: string;
  timezone: string;
  viewport: { width: number; height: number };
  mobile: { enabled: boolean; touch: boolean; device_scale_factor: number };
  configuration_sources: NonNullable<InstanceProperties['configuration_sources']>;
  configuration_warnings: string[];
  device_profile?: AppliedDeviceProfile;
  device_profile_source: 'explicit_id' | 'inline' | 'ua_default' | 'ua_unmatched' | 'none';
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
  options: EffectiveInstanceOptions;
  proxy?: Proxy;
  userAgent?: string;
  localeObservation?: InstanceProperties['locale_observation'];
  proxyCountry?: string;
  environment?: BrowserEnvironment;
  deviceVerification?: DeviceVerification;
  egress?: { ip: string; source: 'instance_check'; checked_at: string };
  pages: Map<string, PageEntry>;
  pageData: Map<string, PageData>;
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
  settings: SystemSettings;
  deviceProfiles: DeviceProfileStore;
  private curlActive = 0;
  private creating = 0;
  private closing = 0;
  constructor(public cfg: Config) {
    this.settings = new SystemSettings(cfg);
    this.deviceProfiles = new DeviceProfileStore(cfg.dataDir);
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
    await this.settings.init();
    await this.deviceProfiles.init();
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
    const existing = [...i.pages].find(([, entry]) => entry.page === page);
    if (existing) return existing[0];
    const retained = [...i.pageData].find(([, data]) => data.page === page);
    if (retained) return retained[0];
    if (page.isClosed()) return '';
    const id = `page_${randomUUID()}`;
    if (i.pages.size >= this.cfg.maxPages) {
      void page.close();
      this.event(i, { type: 'page_limit' });
      return id;
    }
    const navigation = new NavigationRecorder(page, (event) =>
      this.logs.log({
        owner: i.owner,
        instance_id: i.id,
        page_id: id,
        operation_id: i.operation?.operation_id,
        component: 'navigation',
        level: event.kind === 'failed' || event.kind === 'capture_warning' ? 'warn' : 'info',
        code: `navigation_${event.kind}`,
        navigation: event,
      }),
    );
    const entry: PageEntry = {
      page,
      generation: 0,
      refs: new Map(),
      watchdogs: new Map(),
      watchdogPending: new Map(),
      navigation,
      navigationReady: Promise.resolve(),
    };
    i.pages.set(id, entry);
    i.pageData.set(id, new PageData(page));
    entry.navigationReady = deadline(
      this.watchdog(i, entry).then((session) => navigation.attach(session)),
      3000,
      'Navigation observer initialization timed out.',
    ).catch(() => navigation.warning());
    while (i.pageData.size > this.cfg.maxPages) {
      const old = [...i.pageData].find(([, data]) => data.closed);
      if (!old) break;
      old[1].dispose();
      i.pageData.delete(old[0]);
    }
    i.activePageId = id;
    page.on('close', () => {
      for (const session of entry.watchdogs.values()) void session.detach().catch(() => {});
      entry.watchdogs.clear();
      this.clearRefs(entry);
      i.pages.delete(id);
      i.probes.delete(id);
      if (i.activePageId === id) i.activePageId = [...i.pages.keys()].at(-1);
      this.event(i, { type: 'page_closed', page_id: id, instance_closing: i.closing });
    });
    page.on('framedetached', (frame) => {
      const session = entry.watchdogs.get(frame);
      entry.watchdogs.delete(frame);
      if (session) void session.detach().catch(() => {});
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
      navigation.download(download.url(), download.suggestedFilename());
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
    let egress: {
      ip: string | null;
      source: 'unknown' | 'proxy_check' | 'instance_check';
      checked_at: string | null;
    } = i.egress ?? { ip: null, source: 'unknown', checked_at: null };
    if (!i.egress && i.proxy) {
      const proxyId = i.options.proxy_id ?? i.options.proxy_ref;
      const p = proxyId ? this.proxies.list().find((p) => p.proxy_id === proxyId) : undefined;
      // A proxy inventory check is only a sample, and only applies to the instance's unchanged connection settings.
      if (
        p &&
        new URL(`${p.protocol}://${p.host}:${p.port}`).href === new URL(i.proxy.server).href &&
        p.username === (i.proxy.username ?? '') &&
        p.password === (i.proxy.password ?? '') &&
        p.health.status === 'healthy' &&
        p.health.observed_ip &&
        isIP(p.health.observed_ip) &&
        p.health.checked_at &&
        Date.now() - Date.parse(p.health.checked_at) <= this.cfg.proxyCheckIntervalSeconds * 2000
      ) {
        egress = {
          ip: p.health.observed_ip,
          source: 'proxy_check',
          checked_at: p.health.checked_at,
        };
      }
    }
    return {
      instance_id: i.id,
      task_description: i.options.task_description,
      details_url: instanceDetailsUrl(this.cfg.baseUrl, i.id),
      active_page_id: i.activePageId,
      recording_id: this.recordings.active.get(i.id)?.meta.id,
      live_frame_at: this.recordings.active.get(i.id)?.latest?.time,
      live_url: this.cfg.baseUrl
        ? `${this.cfg.baseUrl.replace(/\/$/, '')}/api/instances/${i.id}/live`
        : undefined,
      status: i.crashed ? 'crashed' : 'ready',
      busy: i.busy,
      active_operation: i.operation ?? null,
      created_at: new Date(i.created).toISOString(),
      viewport: i.options.viewport,
      storage_state_id: i.options.storage_state_id,
      user_agent: i.userAgent ?? i.options.user_agent ?? 'browser default',
      browser_version: i.browser.version(),
      browser_mode: 'chromium_new_headless',
      device_profile: i.options.device_profile ?? null,
      device_profile_id: i.options.device_profile_id ?? null,
      device_profile_source: i.options.device_profile_source,
      device_verification: i.deviceVerification ?? null,
      user_agent_metadata: i.options.device_profile
        ? (profileMetadata(i.options.device_profile) ?? null)
        : (userAgentMetadata({ userAgent: i.options.user_agent }) ?? null),
      country: i.proxyCountry ?? null,
      country_source: i.proxyCountry ? ('proxy_config' as const) : ('unknown' as const),
      egress,
      locale: i.options.locale,
      timezone: i.options.timezone,
      configuration_sources: { ...i.options.configuration_sources },
      locale_observation: i.localeObservation ?? null,
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
        ...i.options.configuration_warnings,
        ...(i.options.device_profile_source === 'ua_unmatched'
          ? [
              'No enabled profile matches the UA operating system. Using UA-only settings without a device profile.',
            ]
          : []),
        ...(i.localeObservation && i.localeObservation.intl_locale !== i.options.locale
          ? [
              `Intl resolved locale ${i.localeObservation.intl_locale} from configured ${i.options.locale}; the browser may fall back when regional formatting data is unavailable. navigator.language and the configured timezone are reported separately.`,
            ]
          : []),
        operatingSystem(i.userAgent ?? i.options.user_agent ?? null) === 'iOS'
          ? 'The iOS identity is simulated by Chromium, not WebKit or an iOS runtime. browser_version reports the actual engine; verify the returned profile and observed behavior.'
          : 'Custom Chromium UA Client Hints follow the supplied UA. browser_version is the actual engine; changing UA does not install that engine or create a real mobile device. Verify on the target.',
        'Host policy is defense in depth; use trusted upstream proxies and a network firewall for strict egress isolation.',
      ],
    };
  }
  private async persistEnvironment(i: Instance) {
    const current = this.summary(i);
    const userAgent = i.userAgent ?? i.options.user_agent ?? null;
    // Keep the last known sample if the saved proxy is later edited, removed or unchecked.
    const environment: BrowserEnvironment = {
      captured_at: new Date().toISOString(),
      user_agent: userAgent,
      browser_version: current.browser_version,
      browser_mode: current.browser_mode,
      user_agent_metadata: current.user_agent_metadata,
      device_profile: current.device_profile,
      device_profile_id: current.device_profile_id,
      device_profile_source: current.device_profile_source,
      device_verification: i.deviceVerification ?? null,
      os: operatingSystem(userAgent),
      country: i.proxyCountry ?? null,
      country_source: i.proxyCountry ? 'proxy_config' : 'unknown',
      egress: current.egress.ip ? current.egress : (i.environment?.egress ?? current.egress),
    };
    i.environment = environment;
    const properties: InstanceProperties = {
      viewport: current.viewport,
      locale: current.locale,
      timezone: current.timezone,
      configuration_sources: current.configuration_sources,
      configuration_warnings: [...i.options.configuration_warnings],
      ...(i.localeObservation ? { locale_observation: i.localeObservation } : {}),
      mobile: current.mobile,
      proxy: current.proxy,
      idle_timeout_seconds: current.idle_timeout_seconds,
      max_lifetime_seconds: current.max_lifetime_seconds,
    };
    const pages = this.instancePages(i);
    this.logs.update(i.id, {
      environment: structuredClone(environment),
      properties: structuredClone(properties),
      pages,
    });
    await this.recordings.setEnvironment(i.id, environment, properties, pages).catch(() =>
      this.logs.log({
        owner: i.owner,
        instance_id: i.id,
        component: 'recorder',
        level: 'error',
        code: 'environment_persist_failed',
      }),
    );
  }
  async create(owner: string, raw: unknown, operationId?: string, id = `ins_${randomUUID()}`) {
    if (this.instances.size + this.creating + this.closing >= this.cfg.maxInstances)
      throw new ToolError('INSTANCE_LIMIT', 'Maximum instances reached.');
    this.creating++;
    let gateway: Server | undefined,
      browser: Browser | undefined,
      server: BrowserServer | undefined,
      dir: string | undefined;
    let current: Instance | undefined,
      failed = false;
    this.logs.register({
      instance_id: id,
      navigation_since_seq: this.logs.sequence(),
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
      const requested = createSchema.parse(raw);
      const auto =
        !requested.device_profile && !requested.device_profile_id && requested.user_agent
          ? this.deviceProfiles.defaultForUserAgent(requested.user_agent)
          : undefined;
      const selected =
        requested.device_profile ??
        (requested.device_profile_id
          ? this.deviceProfiles.resolve(requested.device_profile_id)
          : auto?.profile);
      const profile = selected ? applyProfileUserAgent(selected, requested.user_agent) : undefined;
      const locale =
        requested.locale !== undefined
          ? Intl.getCanonicalLocales(requested.locale)[0]
          : (profile?.locale ?? 'en-US');
      const timezone = requested.timezone ?? profile?.timezone ?? 'UTC';
      const viewport = requested.viewport ?? profile?.viewport ?? { width: 1280, height: 720 };
      const mobile = {
        enabled: requested.mobile?.enabled ?? profile?.mobile ?? requested.mobile !== undefined,
        touch: requested.mobile?.touch ?? profile?.touch ?? requested.mobile !== undefined,
        device_scale_factor:
          requested.mobile?.device_scale_factor ?? profile?.device_scale_factor ?? 1,
      };
      const configurationWarnings: string[] = [];
      let screenExpanded = false;
      if (profile) {
        profile.locale = locale;
        profile.timezone = timezone;
        if (requested.locale !== undefined) {
          profile.languages = [locale];
          profile.http_accept_language = acceptLanguage(profile.languages);
        }
        profile.viewport = { ...viewport };
        profile.mobile = mobile.enabled;
        profile.touch = mobile.touch;
        profile.device_scale_factor = mobile.device_scale_factor;
        if (requested.mobile?.touch !== undefined) {
          // Synchronize the native setting and the optional JS/profile observations.
          const observed = (profile.web_observables ??= {});
          const navigator = (observed.navigator ??= {});
          navigator.max_touch_points = mobile.touch
            ? Math.max(1, navigator.max_touch_points ?? 1)
            : 0;
          if (observed.media) {
            observed.media['pointer: coarse'] = mobile.touch;
            observed.media['pointer: fine'] = !mobile.touch;
            observed.media['hover: hover'] = !mobile.touch;
          }
        }
        if (requested.viewport !== undefined) {
          // A resized browser window may be smaller than its display, but must fit inside it.
          screenExpanded =
            viewport.width > profile.screen.width || viewport.height > profile.screen.height;
          profile.screen = {
            width: Math.max(profile.screen.width, viewport.width),
            height: Math.max(profile.screen.height, viewport.height),
          };
          const observed = profile.web_observables;
          if (observed?.screen) {
            if (observed.screen.available_width !== undefined)
              observed.screen.available_width = Math.max(
                observed.screen.available_width,
                viewport.width,
              );
            if (observed.screen.available_height !== undefined)
              observed.screen.available_height = Math.max(
                observed.screen.available_height,
                viewport.height,
              );
            if (screenExpanded && observed.screen.orientation !== undefined) {
              observed.screen.orientation =
                profile.screen.width > profile.screen.height
                  ? 'landscape-primary'
                  : 'portrait-primary';
              observed.screen.orientation_angle =
                mobile.enabled && profile.screen.width > profile.screen.height ? 90 : 0;
            }
          }
          if (observed?.window) {
            if (observed.window.outer_width !== undefined)
              observed.window.outer_width = Math.max(observed.window.outer_width, viewport.width);
            if (observed.window.outer_height !== undefined)
              observed.window.outer_height = Math.max(
                observed.window.outer_height,
                viewport.height,
              );
          }
          if (screenExpanded)
            configurationWarnings.push(
              'The profile screen was enlarged to contain the explicitly requested viewport; the saved profile is unchanged.',
            );
        }
        const requestedOs = requested.user_agent && operatingSystem(requested.user_agent);
        if (requestedOs && selected && requestedOs !== operatingSystem(selected.user_agent))
          configurationWarnings.push(
            'The explicit UA operating system differs from the selected profile. UA and Client Hints follow the request; other identity fields such as navigator.platform, hardware and GPU remain from the selected profile. Use a same-OS profile for a coherent identity.',
          );
      }
      const options: EffectiveInstanceOptions = {
        ...requested,
        locale,
        timezone,
        viewport,
        mobile,
        user_agent: profile?.user_agent ?? requested.user_agent,
        configuration_warnings: configurationWarnings,
        configuration_sources: {
          locale: requested.locale !== undefined ? 'request' : profile ? 'profile' : 'default',
          timezone: requested.timezone !== undefined ? 'request' : profile ? 'profile' : 'default',
          languages:
            requested.locale !== undefined
              ? 'request_locale'
              : profile
                ? 'profile'
                : 'default_locale',
          viewport: requested.viewport !== undefined ? 'request' : profile ? 'profile' : 'default',
          user_agent:
            requested.user_agent !== undefined ? 'request' : profile ? 'profile' : 'browser',
          mobile_enabled:
            requested.mobile?.enabled !== undefined ? 'request' : profile ? 'profile' : 'default',
          touch:
            requested.mobile?.touch !== undefined ? 'request' : profile ? 'profile' : 'default',
          device_scale_factor:
            requested.mobile?.device_scale_factor !== undefined
              ? 'request'
              : profile
                ? 'profile'
                : 'default',
          screen: screenExpanded ? 'expanded_for_viewport' : profile ? 'profile' : 'viewport',
        },
        device_profile: profile,
        device_profile_id: requested.device_profile_id ?? auto?.profile_id,
        device_profile_source: requested.device_profile
          ? 'inline'
          : requested.device_profile_id
            ? 'explicit_id'
            : auto
              ? 'ua_default'
              : requested.user_agent
                ? 'ua_unmatched'
                : 'none',
      };
      this.logs.update(id, { task_description: options.task_description });
      const proxy = await this.resolveProxy(options);
      const proxyId = options.proxy_id ?? options.proxy_ref;
      const country = proxyId
        ? this.proxies.list().find((p) => p.proxy_id === proxyId)?.country
        : undefined;
      const storage = options.storage_state_id
        ? await readStorageState(this.artifacts, owner, options.storage_state_id)
        : undefined;
      for (const origin of storage?.origins ?? []) await this.policy.url(origin.origin);
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
        channel: 'chromium',
        chromiumSandbox: process.env.CHROMIUM_SANDBOX === 'true',
        timeout: 30000,
        downloadsPath: dir,
        proxy: { server: `http://127.0.0.1:${gateway.port}`, bypass: '<-loopback>' },
        args: [
          '--disable-quic',
          // Full Chromium reads the Chrome preference switch. The old
          // --force-webrtc-* switch only configures the separate headless shell.
          '--webrtc-ip-handling-policy=disable_non_proxied_udp',
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
      const contextOptions = {
        userAgent: options.user_agent,
        viewport: options.viewport,
        screen: profile?.screen,
        cloudbrowserDeviceProfile: profile ? protocolProfile(profile) : undefined,
        extraHTTPHeaders:
          profile && !profile.http_accept_language
            ? { 'Accept-Language': acceptLanguage(profile.languages) }
            : undefined,
        isMobile: options.mobile?.enabled ?? false,
        hasTouch: options.mobile?.touch ?? false,
        deviceScaleFactor: options.mobile?.device_scale_factor ?? 1,
        locale: options.locale,
        timezoneId: options.timezone,
        colorScheme:
          profile?.web_observables?.media?.['prefers-color-scheme: dark'] === undefined
            ? undefined
            : profile.web_observables.media['prefers-color-scheme: dark']
              ? ('dark' as const)
              : ('light' as const),
        reducedMotion:
          profile?.web_observables?.media?.['prefers-reduced-motion: reduce'] === undefined
            ? undefined
            : profile.web_observables.media['prefers-reduced-motion: reduce']
              ? ('reduce' as const)
              : ('no-preference' as const),
        forcedColors:
          profile?.web_observables?.media?.['forced-colors: active'] === undefined
            ? undefined
            : profile.web_observables.media['forced-colors: active']
              ? ('active' as const)
              : ('none' as const),
        acceptDownloads: true,
        serviceWorkers: 'block' as const,
        storageState: storage,
      };
      const context = await browser.newContext(contextOptions);
      if (profile?.web_observables || profile?.client_hints === null)
        await context.addInitScript({ content: webObservablesScript(profile) });
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
        proxyCountry: country && country !== 'ZZ' ? country : undefined,
        pages: new Map(),
        pageData: new Map(),
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
      const dataFor = (request: Request) => {
        if (i.closing) return undefined;
        try {
          const page = request.frame().page();
          const pageId = this.attach(i, page);
          const data = i.pageData.get(pageId);
          data?.request(request);
          const navigation = i.pages.get(pageId)?.navigation;
          navigation?.request(request);
          return { data, navigation };
        } catch {
          return undefined;
        }
      };
      context.on('request', (request) => {
        dataFor(request);
      });
      context.on('response', (response) => {
        const entry = dataFor(response.request());
        entry?.data?.response(response);
        entry?.navigation?.response(response);
      });
      context.on('requestfinished', (request) => {
        dataFor(request)?.data?.finished(request);
      });
      context.on('requestfailed', (request) => {
        const entry = dataFor(request);
        entry?.data?.failed(request);
        entry?.navigation?.failed(request);
      });
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
      await [...i.pages.values()].find((entry) => entry.page === p)?.navigationReady;
      const recorder = await this.recordings.start(
        i.id,
        owner,
        () => {
          const e = i.pages.get(i.activePageId ?? '') ?? Array.from(i.pages.values()).at(-1);
          if (!e) return undefined;
          return {
            page: e.page,
            page_id: Array.from(i.pages).find(([, v]) => v === e)![0],
            deviceScaleFactor: i.options.mobile?.device_scale_factor ?? 1,
            busy: i.busy,
          };
        },
        options.task_description,
      );
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
      const actual = await this.environment(p);
      i.userAgent = actual.user_agent;
      i.localeObservation = {
        language: actual.language,
        languages: actual.languages,
        intl_locale: actual.locale,
        number_locale: actual.number_locale,
        timezone: actual.timezone,
        checked_at: new Date().toISOString(),
      };
      await this.persistEnvironment(i);
      return { ...this.summary(i), actual };
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
      ...(await p.evaluate(async () => ({
        user_agent: navigator.userAgent,
        layout_viewport: { width: innerWidth, height: innerHeight },
        screen: { width: screen.width, height: screen.height },
        device_scale_factor: devicePixelRatio,
        touch_points: navigator.maxTouchPoints,
        language: navigator.language,
        languages: [...navigator.languages],
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        number_locale: Intl.NumberFormat().resolvedOptions().locale,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        client_hints: (navigator as any).userAgentData
          ? await (navigator as any).userAgentData
              .getHighEntropyValues([
                'fullVersionList',
                'platformVersion',
                'architecture',
                'bitness',
                'model',
                'wow64',
                'formFactors',
              ])
              .catch(() => (navigator as any).userAgentData.toJSON())
          : null,
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
    await Promise.allSettled(
      [...i.pages.values()].map((page) =>
        deadline(page.navigation.flush(), 1000, 'Navigation metadata flush timed out.').catch(() =>
          page.navigation.warning(),
        ),
      ),
    );
    await this.persistEnvironment(i);
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
    for (const data of i.pageData.values()) data.dispose();
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
  private instancePages(i: Instance): InstancePage[] {
    return Array.from(i.pageData, ([page_id, data]) => {
      const info = data.info(page_id, page_id === i.activePageId);
      return { page_id, url: info.url, title: info.title, state: info.state, active: info.active };
    });
  }
  async adminInstanceDetails(id: string) {
    return this.instanceDetails(id, undefined);
  }
  async ownedInstanceDetails(owner: string, id: string) {
    return this.instanceDetails(id, owner);
  }
  private async instanceDetails(id: string, owner: string | undefined) {
    const candidate = this.instances.get(id);
    const active =
      candidate && (owner === undefined || candidate.owner === owner) ? candidate : undefined;
    const retained = this.logs.adminGet(id);
    const history = retained && owner !== undefined ? this.logs.get(owner, id) : retained;
    const recordings = (await this.recordings.list()).filter(
      (r) => r.instance_id === id && (owner === undefined || r.owner === owner),
    );
    const latest = recordings[0];
    if (!history && !active && !latest)
      throw new ToolError('INSTANCE_NOT_FOUND', 'Unknown or expired instance history.');
    const instance = history ?? {
      instance_id: id,
      task_description: active?.options.task_description ?? latest?.task_description,
      created_at: active ? new Date(active.created).toISOString() : latest?.created_at,
      ended_at: latest?.ended_at,
      status: active ? (active.crashed ? 'crashed' : 'active') : 'unknown',
      environment: active?.environment ?? latest?.environment,
      properties: latest?.properties,
      pages: latest?.pages,
    };
    return {
      details_url: instanceDetailsUrl(this.cfg.baseUrl, id),
      instance,
      current: active ? this.summary(active) : null,
      pages: active ? this.instancePages(active) : (instance.pages ?? latest?.pages ?? []),
      recordings: recordings.map(({ owner: _owner, ...recording }) => recording),
      logs_available: !!history,
      navigation_available: history?.navigation_since_seq !== undefined,
    };
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
      details_url: instanceDetailsUrl(this.cfg.baseUrl, id),
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
    if (name === 'list_navigation_events') return this.logs.navigation(owner, a.instance_id, a);
    if (name === 'get_instance_details')
      return instanceDocument(this, a.instance_id, this.cfg.baseUrl ?? '', owner);
    const started = Date.now();
    const own = this.instances.get(a.instance_id);
    let id =
      name === 'create_instance'
        ? `ins_${randomUUID()}`
        : own?.owner === owner
          ? own.id
          : undefined;
    if (!id && typeof a.instance_id === 'string') {
      try {
        id = this.logs.get(owner, a.instance_id).instance_id;
      } catch {
        /* Do not associate calls with another principal's instance. */
      }
    }
    const fields: Record<string, string | number | boolean | null> = { tool: name };
    if (['navigate', 'create_page'].includes(name) && typeof a.url === 'string') fields.url = a.url;
    if (name === 'verify_environment' && typeof a.check_url === 'string') fields.url = a.check_url;
    if (
      ['navigate', 'interact', 'pointer', 'keyboard'].includes(name) &&
      typeof a.action === 'string' &&
      [
        'goto',
        'reload',
        'back',
        'forward',
        'click',
        'fill',
        'press',
        'select',
        'check',
        'hover',
        'scroll',
        'double_click',
        'right_click',
        'move',
        'down',
        'up',
        'drag',
        'wheel',
        'type',
      ].includes(a.action)
    )
      fields.action = a.action;

    const track =
      !!id || !['health', 'list_instances', 'list_recordings', 'list_share_links'].includes(name);
    if (track)
      this.logs.log({
        owner,
        instance_id: id,
        operation_id: operationId,
        component: 'operation',
        level: 'info',
        code: 'operation_started',
        page_id: a.page_id,
        arguments: a,
        fields,
      });
    try {
      const result = await this.dispatchOperation(owner, name, a, operationId, id);
      if (track)
        this.logs.log({
          owner,
          instance_id: id,
          page_id: a.page_id,
          operation_id: operationId,
          component: 'operation',
          level: 'info',
          code: 'operation_succeeded',
          fields: { ...fields, elapsed_ms: Date.now() - started },
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
        page_id: a.page_id,
        fields: {
          ...fields,
          error_code: publicError(error).code,
          error_message:
            error instanceof Error
              ? error.cause instanceof Error
                ? error.cause.message
                : error.message
              : String(error),
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
    instanceId?: string,
  ): Promise<any> {
    if (name === 'list_device_profiles') return this.deviceProfiles.list(a);
    if (name === 'get_device_profile') return this.deviceProfiles.get(a.profile_id);
    if (
      [
        'get_instance',
        'list_pages',
        'get_page',
        'list_network_requests',
        'get_network_request',
        'get_console_logs',
      ].includes(name)
    ) {
      const i = this.instances.get(a.instance_id);
      if (!i || i.owner !== owner)
        throw new ToolError('INSTANCE_NOT_FOUND', 'Unknown or closed instance.');
      if (name === 'get_instance') return this.summary(i);
      if (name === 'list_pages')
        return [...i.pages].map(([page_id, p]) => ({
          ...i.pageData.get(page_id)!.info(page_id, i.activePageId === page_id),
          dialog: p.dialog?.type(),
          pending_dialog: p.dialog
            ? { type: p.dialog.type(), message: p.dialog.message().slice(0, 1000) }
            : null,
        }));
      const data = i.pageData.get(a.page_id);
      if (!data) throw new ToolError('PAGE_NOT_FOUND', 'Unknown or expired tab data.');
      if (name === 'get_page')
        return {
          ...data.info(a.page_id, i.activePageId === a.page_id),
          dialog: i.pages.get(a.page_id)?.dialog
            ? {
                type: i.pages.get(a.page_id)!.dialog!.type(),
                message: i.pages.get(a.page_id)!.dialog!.message().slice(0, 1000),
              }
            : null,
          requires_reload: i.pages.get(a.page_id)?.requiresReload ?? false,
        };
      if (name === 'list_network_requests')
        return { instance_id: i.id, page_id: a.page_id, ...data.network(a) };
      if (name === 'get_network_request')
        return {
          instance_id: i.id,
          page_id: a.page_id,
          ...data.detail(a.request_id, a.include_body ?? true),
        };
      return { instance_id: i.id, page_id: a.page_id, ...data.consoleLogs(a) };
    }
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
          details_url: instanceDetailsUrl(this.cfg.baseUrl, r.instance_id),
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
        version: '0.21.2',
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
        storage: this.settings.storage(),
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
    if (name === 'create_instance') return this.create(owner, a, operationId, instanceId);
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
  // Chromium resets some emulation state when an auxiliary CDP session detaches.
  // Keep timeout watchdogs for the target lifetime, shared by evaluate and verify.
  private watchdog(i: Instance, p: PageEntry, frame = p.page.mainFrame()): Promise<CDPSession> {
    const pending = p.watchdogPending.get(frame);
    if (pending) return pending;
    const existing = p.watchdogs.get(frame);
    if (existing) return Promise.resolve(existing);
    const work = this.openWatchdog(i, p, frame);
    p.watchdogPending.set(frame, work);
    const clear = () => {
      if (p.watchdogPending.get(frame) === work) p.watchdogPending.delete(frame);
    };
    void work.then(clear, clear);
    return work;
  }
  private async openWatchdog(i: Instance, p: PageEntry, frame: Frame): Promise<CDPSession> {
    let session: CDPSession;
    try {
      session = await i.context.newCDPSession(frame === p.page.mainFrame() ? p.page : frame);
    } catch (error) {
      if (frame === p.page.mainFrame()) throw error;
      return this.watchdog(i, p);
    }
    p.watchdogs.set(frame, session);
    session.on('close', () => {
      if (p.watchdogs.get(frame) === session) p.watchdogs.delete(frame);
    });
    const profile = i.options.device_profile;
    if (profile) {
      // Every inspector session must carry the same platform override; an empty
      // auxiliary session otherwise restores the native value on navigation.
      await session.send('Emulation.setUserAgentOverride', {
        userAgent: profile.user_agent,
        platform: profile.navigator_platform,
        acceptLanguage: profile.languages.join(','),
        userAgentMetadata: profileMetadata(profile),
      });
      if (profile.hardware_concurrency)
        await session.send('Emulation.setHardwareConcurrencyOverride', {
          hardwareConcurrency: profile.hardware_concurrency,
        });
      if (profile.web_observables?.navigator?.webdriver !== undefined)
        await session.send('Emulation.setAutomationOverride', {
          enabled: profile.web_observables.navigator.webdriver,
        });
      if (profile.touch && profile.web_observables?.navigator?.max_touch_points)
        await session.send('Emulation.setTouchEmulationEnabled', {
          enabled: true,
          maxTouchPoints: profile.web_observables.navigator.max_touch_points,
        });
    }
    return session;
  }
  private async evaluate(i: Instance, p: PageEntry, a: any) {
    const frame = a.frame_id ? i.pageData.get(a.page_id)!.frame(a.frame_id) : p.page.mainFrame();
    let argument: string;
    try {
      argument = JSON.stringify(a.arg ?? null);
    } catch {
      throw new ToolError('INVALID_ARGUMENT', 'Script arg must be JSON serializable.');
    }
    const session = await this.watchdog(i, p, frame);
    const expression = `(async () => { const candidate = (${a.script}); const value = await (typeof candidate === 'function' ? candidate(JSON.parse(${JSON.stringify(argument)})) : candidate); let json; try { json = JSON.stringify(value); } catch (e) { return {serialization_error: String(e)}; } if (json === undefined) return {json:'null', value_type:typeof value}; const bytes = new TextEncoder().encode(json).length; if (bytes > ${a.max_result_bytes ?? 65536}) return {too_large:true,bytes}; return {json,bytes,value_type:typeof value}; })()`;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result: any = await Promise.race([
        frame.evaluate(expression),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            p.requiresReload = true;
            void session.send('Runtime.terminateExecution').catch(() => {});
            reject(
              new ToolError(
                'SCRIPT_TIMEOUT',
                'Script exceeded its deadline. Reload this tab before further writes; do not blindly retry.',
              ),
            );
          }, a.timeout_ms ?? 5000);
        }),
      ]);
      if (result.too_large)
        throw new ToolError(
          'SCRIPT_RESULT_TOO_LARGE',
          `Script result exceeds ${a.max_result_bytes ?? 65536} bytes.`,
        );
      if (result.serialization_error)
        throw new ToolError('SCRIPT_RESULT_NOT_SERIALIZABLE', result.serialization_error);
      return {
        page_id: a.page_id,
        frame_id: i.pageData.get(a.page_id)!.frameId(frame),
        value: JSON.parse(result.json),
        value_type: result.value_type,
        bytes: result.bytes ?? 0,
      };
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError('SCRIPT_ERROR', error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      this.clearRefs(p);
    }
  }
  private async pointer(i: Instance, p: PageEntry, a: any) {
    const { width, height } = i.options.viewport;
    const validate = (x: number | undefined, y: number | undefined) => {
      if (x === undefined || y === undefined || x < 0 || y < 0 || x >= width || y >= height)
        throw new ToolError(
          'INVALID_COORDINATES',
          'Coordinates must be inside the viewport in CSS pixels.',
        );
    };
    if (a.x !== undefined || a.y !== undefined) validate(a.x, a.y);
    if (a.action === 'drag') validate(a.to_x, a.to_y);
    const held: string[] = [];
    let dragging = false;
    try {
      for (const raw of a.modifiers ?? []) {
        const modifier =
          raw === 'ControlOrMeta' ? (process.platform === 'darwin' ? 'Meta' : 'Control') : raw;
        await p.page.keyboard.down(modifier);
        held.push(modifier);
      }
      const options = { button: a.button ?? 'left' };
      if (a.action === 'drag') {
        await p.page.mouse.move(a.x, a.y);
        await p.page.mouse.down(options);
        dragging = true;
        await p.page.mouse.move(a.to_x, a.to_y, { steps: a.steps ?? 12 });
        await p.page.mouse.up(options);
        dragging = false;
      } else if (a.action === 'wheel') {
        if (a.x !== undefined) await p.page.mouse.move(a.x, a.y);
        await p.page.mouse.wheel(a.delta_x ?? 0, a.delta_y ?? 600);
      } else if (a.action === 'move') await p.page.mouse.move(a.x, a.y, { steps: a.steps ?? 1 });
      else if (a.action === 'down') {
        await p.page.mouse.move(a.x, a.y);
        await p.page.mouse.down(options);
      } else if (a.action === 'up') {
        if (a.x !== undefined) await p.page.mouse.move(a.x, a.y);
        await p.page.mouse.up(options);
      } else if (a.action === 'double_click') await p.page.mouse.dblclick(a.x, a.y, options);
      else
        await p.page.mouse.click(a.x, a.y, {
          button: a.action === 'right_click' ? 'right' : options.button,
        });
      this.clearRefs(p);
      return { page_id: a.page_id, action: a.action, coordinate_space: 'viewport_css_pixels' };
    } finally {
      if (dragging) await p.page.mouse.up({ button: a.button ?? 'left' }).catch(() => {});
      for (const modifier of held.reverse()) await p.page.keyboard.up(modifier).catch(() => {});
    }
  }
  private async navigationAttempt<T>(page: PageEntry, work: () => Promise<T>): Promise<T> {
    await page.navigationReady;
    page.navigation.begin();
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const download = /Download is starting/.test(error.message);
      if (!download && !/net::ERR_ABORTED/.test(error.message)) throw error;
      const external = page.navigation.lastExternal;
      const wrapped = new ToolError(
        download ? 'NAVIGATION_DOWNLOAD' : external ? 'EXTERNAL_PROTOCOL' : 'NAVIGATION_ABORTED',
        download
          ? 'Navigation became a download. Inspect list_downloads for completion; no web document was opened.'
          : external
            ? `Navigation redirected to an external application protocol (${external.split(':')[0]}:). No web document was opened. Inspect list_navigation_events for the full target; do not replay automatically.`
            : 'Navigation was aborted before a web document loaded. Inspect list_navigation_events and list_downloads to distinguish redirects, downloads and cancellation; do not replay automatically.',
      );
      wrapped.cause = error;
      throw wrapped;
    }
  }
  private async action(i: Instance, name: string, a: any): Promise<any> {
    if (name === 'verify_device_profile') {
      const p = this.page(i, a.page_id);
      if (p.requiresReload)
        throw new ToolError('PAGE_RELOAD_REQUIRED', 'Reload this tab before another verification.');
      const session = await this.watchdog(i, p);
      try {
        const result = await verifyDeviceProfile(
          p.page,
          a.page_id,
          i.browser,
          i.options.device_profile,
        );
        i.deviceVerification = result;
        await this.persistEnvironment(i);
        return { instance_id: i.id, ...result };
      } catch (error) {
        if (error instanceof ToolError && error.code === 'TIMEOUT') {
          p.requiresReload = true;
          await session.send('Runtime.terminateExecution').catch(() => {});
        }
        throw error;
      }
    }
    if (name === 'save_storage_state') {
      const state = await i.context.storageState({ indexedDB: a.indexed_db ?? false });
      const bytes = Buffer.from(JSON.stringify(state));
      if (bytes.length > storageLimit)
        throw new ToolError('STORAGE_STATE_TOO_LARGE', 'Login state exceeds 2 MiB.');
      const artifact = await this.artifacts.save(
        i.owner,
        i.id,
        'storage-state.json',
        'application/json',
        bytes,
        'storage_state',
      );
      return {
        storage_state_id: artifact.id,
        artifact,
        cookies: state.cookies.length,
        origins: state.origins.length,
        indexed_db: a.indexed_db ?? false,
      };
    }
    if (name === 'restore_storage_state') {
      const state = await readStorageState(this.artifacts, i.owner, a.storage_state_id);
      for (const origin of state.origins) await this.policy.url(origin.origin);
      await i.context.setStorageState(state);
      i.options.storage_state_id = a.storage_state_id;
      return {
        restored: true,
        storage_state_id: a.storage_state_id,
        cookies: state.cookies.length,
        origins: state.origins.length,
        reload_required: true,
      };
    }
    if (name === 'create_page') {
      if (i.pages.size >= this.cfg.maxPages)
        throw new ToolError('PAGE_LIMIT', 'Maximum pages reached.');
      if (a.url) await this.policy.url(a.url);
      const p = await i.context.newPage();
      const page_id = Array.from(i.pages).find(([, e]) => e.page === p)![0];
      await i.pages.get(page_id)!.navigationReady;
      if (a.url)
        await this.navigationAttempt(i.pages.get(page_id)!, () =>
          p.goto(a.url, { waitUntil: 'domcontentloaded' }),
        );
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
        await [...i.pages.values()].find((entry) => entry.page === p)?.navigationReady;
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
        const observedIp = typeof parsed?.ip === 'string' && isIP(parsed.ip) ? parsed.ip : null;
        if (observedIp)
          i.egress = {
            ip: observedIp,
            source: 'instance_check',
            checked_at: new Date().toISOString(),
          };
        if (observedIp) await this.persistEnvironment(i);
        return {
          instance_id: i.id,
          check_url: u,
          status: response.status(),
          actual: await this.environment(p),
          observed_ip: observedIp,
          response: content,
          country: null,
          note: 'Verify observed_ip and any country assertion using a trusted source; HTTP success alone is not a proxy verification.',
        };
      } finally {
        await p.close();
      }
    }
    const p = this.page(i, a.page_id);
    if (name !== 'close_page') await p.navigationReady;
    if (
      p.requiresReload &&
      !['navigate', 'close_page', 'snapshot', 'screenshot', 'read_element'].includes(name)
    )
      throw new ToolError(
        'PAGE_RELOAD_REQUIRED',
        'A script timed out. Reload this tab or close it before another write.',
      );
    if (p.requiresReload && name === 'navigate' && a.action !== 'reload')
      throw new ToolError(
        'PAGE_RELOAD_REQUIRED',
        'Use navigate action=reload to discard the timed-out script context.',
      );
    if (
      [
        'navigate',
        'interact',
        'upload_file',
        'evaluate',
        'pointer',
        'keyboard',
        'select_page',
      ].includes(name)
    )
      i.activePageId = a.page_id;
    if (name === 'select_page') {
      await deadline(p.page.bringToFront(), 2000);
      return i.pageData.get(a.page_id)!.info(a.page_id, true);
    }
    if (name === 'evaluate') return this.evaluate(i, p, a);
    if (name === 'read_element') {
      const element = this.target(p, a.target) as ElementHandle<Element>;
      const data = await deadline(
        element.evaluate((el, max) => {
          const input = el as HTMLInputElement;
          const rect = el.getBoundingClientRect();
          const attributes: Record<string, string> = {};
          for (const attribute of [...el.attributes].slice(0, 100))
            attributes[attribute.name] = attribute.value.slice(0, 4096);
          return {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent ?? '').trim().slice(0, max),
            value: typeof input.value === 'string' ? input.value.slice(0, max) : null,
            checked: typeof input.checked === 'boolean' ? input.checked : null,
            selected:
              typeof (el as HTMLOptionElement).selected === 'boolean'
                ? (el as HTMLOptionElement).selected
                : null,
            disabled: typeof input.disabled === 'boolean' ? input.disabled : null,
            attributes,
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            visible: !!(rect.width && rect.height) && getComputedStyle(el).visibility !== 'hidden',
          };
        }, a.max_text ?? 10000),
        this.cfg.timeout,
      );
      const box = await deadline(element.boundingBox(), this.cfg.timeout);
      return { page_id: a.page_id, ...data, box };
    }
    if (name === 'keyboard') {
      const pending_dialog = await this.withDialog(p, async () => {
        if (a.action === 'type') await p.page.keyboard.insertText(a.value);
        else if (a.action === 'down')
          await p.page.keyboard.down(
            a.value === 'ControlOrMeta'
              ? process.platform === 'darwin'
                ? 'Meta'
                : 'Control'
              : a.value,
          );
        else if (a.action === 'up')
          await p.page.keyboard.up(
            a.value === 'ControlOrMeta'
              ? process.platform === 'darwin'
                ? 'Meta'
                : 'Control'
              : a.value,
          );
        else await p.page.keyboard.press(a.value);
      });
      this.clearRefs(p);
      return { page_id: a.page_id, action: a.action, pending_dialog };
    }
    if (name === 'pointer') {
      const pending_dialog = await this.withDialog(p, () => this.pointer(i, p, a));
      return {
        page_id: a.page_id,
        action: a.action,
        pending_dialog,
        coordinate_space: 'viewport_css_pixels',
      };
    }
    if (name === 'close_page') {
      await deadline(p.navigation.flush(), 1000, 'Navigation metadata flush timed out.').catch(() =>
        p.navigation.warning(),
      );
      await p.page.close();
      return { status: 'closed' };
    }
    if (name === 'navigate') {
      const response = await this.navigationAttempt(p, async () => {
        if (a.action === 'back') return p.page.goBack({ waitUntil: 'domcontentloaded' });
        if (a.action === 'forward') return p.page.goForward({ waitUntil: 'domcontentloaded' });
        if (a.action === 'reload') return p.page.reload({ waitUntil: 'domcontentloaded' });
        await this.policy.url(a.url);
        return p.page.goto(a.url, { waitUntil: 'domcontentloaded' });
      });
      p.requiresReload = false;
      i.pageData.get(a.page_id)!.title = await p.page.title();
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
        frames: i.pageData.get(a.page_id)!.info(a.page_id, i.activePageId === a.page_id).frames,
        tree_truncated: tree.length > 60000,
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
      const options = {
        type: 'png',
        fullPage: a.full_page ?? false,
        clip: a.clip,
        timeout: this.cfg.timeout,
      } as const;
      const bytes = a.target
        ? await this.target(p, a.target).screenshot({ type: 'png', timeout: this.cfg.timeout })
        : await p.page.screenshot(options);
      let image = await sharp(bytes)
        .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 65 })
        .toBuffer();
      if (image.length > 524288)
        image = await sharp(bytes)
          .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 40 })
          .toBuffer();
      const [artifact, preview] = await this.artifacts.saveBatch(i.owner, i.id, [
        { name: 'screenshot.png', mime: 'image/png', bytes, kind: 'screenshot' },
        {
          name: 'screenshot-preview.jpg',
          mime: 'image/jpeg',
          bytes: image,
          kind: 'screenshot_preview',
        },
      ]);
      const dimensions = await sharp(image).metadata();
      return {
        ...artifact,
        preview: { ...preview, width: dimensions.width, height: dimensions.height },
        viewport: i.options.viewport,
      };
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
