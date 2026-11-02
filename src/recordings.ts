import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile, appendFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import sharp from 'sharp';
import type { Config } from './config.js';
import { ToolError, publicError } from './errors.js';
import type { LogEvent } from './diagnostics.js';
import type { BrowserEnvironment } from './browser-environment.js';
import type { InstanceProperties, InstancePage } from './instance-details.js';

export type RecordingMeta = {
  id: string;
  instance_id: string;
  task_description?: string;
  schema_version?: 2;
  page_id?: string;
  page_title?: string;
  page_url?: string;
  instance_created_at?: string;
  started_offset_ms?: number;
  ended_offset_ms?: number;
  timing_available?: boolean;
  sampling_failures?: number;
  environment?: BrowserEnvironment;
  properties?: InstanceProperties;
  pages?: InstancePage[];
  owner: string;
  created_at: string;
  ended_at?: string;
  status: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  bytes: number;
  error?: string;
};
export type LiveFrame = { bytes: Buffer; time: number; page_id: string };
export type RecordingPage = {
  page: Page;
  page_id: string;
  title?: string;
  url?: string;
  deviceScaleFactor?: number;
};
export class RecordingStore {
  active = new Map<string, InstanceRecorder>();
  private pending: Promise<unknown> = Promise.resolve();
  private sampling = 0;
  private sampleQueue: Array<() => void> = [];
  async sample(work: () => Promise<void>) {
    await new Promise<void>((resolve) => {
      this.sampleQueue.push(resolve);
      this.drainSamples();
    });
    try {
      await work();
    } finally {
      this.sampling--;
      this.drainSamples();
    }
  }
  private drainSamples() {
    while (this.sampling < 4 && this.sampleQueue.length) {
      this.sampling++;
      this.sampleQueue.shift()!();
    }
  }
  constructor(
    public cfg: Config,
    public emit: (event: Omit<LogEvent, 'seq' | 'time'>) => void = () => {},
  ) {}
  path(id: string, ext = 'webm') {
    if (!/^rec_[a-f0-9-]{36}$/.test(id))
      throw new ToolError('RECORDING_NOT_FOUND', 'Unknown recording.');
    return join(this.cfg.dataDir, 'recordings', `${id}.${ext}`);
  }
  async init() {
    await mkdir(join(this.cfg.dataDir, 'recordings'), { recursive: true, mode: 0o700 });
    for (const m of await this.list()) {
      if (['recording', 'finalizing'].includes(m.status)) {
        m.status = 'interrupted';
        m.ended_at = new Date().toISOString();
        await this.persist(m);
      }
    }
    await this.clean();
  }
  async persist(m: RecordingMeta) {
    const path = this.path(m.id, 'json');
    const value = JSON.stringify(m);
    const work = this.pending.then(async () => {
      await writeFile(`${path}.tmp`, value, { mode: 0o600 });
      const { rename } = await import('node:fs/promises');
      await rename(`${path}.tmp`, path);
    });
    this.pending = work.catch(() => {});
    await work;
  }
  async setEnvironment(
    instance: string,
    environment: BrowserEnvironment,
    properties?: InstanceProperties,
    pages?: InstancePage[],
  ) {
    const recorder = this.active.get(instance);
    if (!recorder) return;
    for (const r of recorder.pages.values()) {
      r.meta.environment = structuredClone(environment);
      if (properties) r.meta.properties = structuredClone(properties);
      if (pages) r.meta.pages = structuredClone(pages);
      if (this.cfg.recordVideo) await this.persist(r.meta);
    }
    recorder.environment = { environment: structuredClone(environment), properties, pages };
  }
  async list() {
    const names = await readdir(join(this.cfg.dataDir, 'recordings'));
    const entries = await Promise.all(
      names
        .filter((x) => x.endsWith('.json'))
        .map(async (n) => {
          try {
            return JSON.parse(
              await readFile(join(this.cfg.dataDir, 'recordings', n), 'utf8'),
            ) as RecordingMeta;
          } catch {
            return null;
          }
        }),
    );
    return entries
      .map((x) => (x ? (this.active.get(x.instance_id)?.byId(x.id)?.meta ?? x) : null))
      .filter((x): x is RecordingMeta => !!x)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async get(id: string) {
    try {
      const m = JSON.parse(await readFile(this.path(id, 'json'), 'utf8')) as RecordingMeta;
      return { meta: this.active.get(m.instance_id)?.byId(id)?.meta ?? m, path: this.path(id) };
    } catch {
      throw new ToolError('RECORDING_NOT_FOUND', 'Unknown or expired recording.');
    }
  }
  async timeline(id: string) {
    const { meta } = await this.get(id);
    if (!meta.timing_available) return { recording_id: id, recorded: false, frame_offsets_ms: [] };
    const content = await readFile(this.path(id, 'frames'), 'utf8').catch(() => '');
    const offsets: number[] = [];
    for (const line of content.split('\n').slice(0, -1)) {
      const n = Number(line);
      if (!line || !Number.isFinite(n) || n < 0 || (offsets.length && n < offsets.at(-1)!)) break;
      offsets.push(n);
    }
    return {
      recording_id: id,
      instance_id: meta.instance_id,
      page_id: meta.page_id,
      recorded: true,
      origin_at: meta.instance_created_at,
      fps: meta.fps,
      frame_offsets_ms: offsets,
      complete: offsets.length === meta.frames,
      status: meta.status,
    };
  }
  async start(
    instance: string,
    owner: string,
    getPages: () => RecordingPage[],
    getActive: () => string | undefined,
    taskDescription?: string,
    createdAt = new Date().toISOString(),
  ) {
    const r = new InstanceRecorder(
      this,
      instance,
      owner,
      getPages,
      getActive,
      taskDescription,
      createdAt,
    );
    this.active.set(instance, r);
    await r.start();
    return r;
  }
  async stop(instance: string) {
    const r = this.active.get(instance);
    if (r) {
      await r.stop();
      this.active.delete(instance);
    }
    await this.clean();
  }
  async clean() {
    const all = await this.list();
    let total = 0;
    for (const m of all) total += (await stat(this.path(m.id)).catch(() => null))?.size ?? 0;
    for (const m of [...all].reverse()) {
      if (this.active.has(m.instance_id)) continue;
      if (
        Date.now() - Date.parse(m.created_at) > this.cfg.retentionHours * 3600000 ||
        total > this.cfg.recordingsLimit
      ) {
        const bytes = (await stat(this.path(m.id)).catch(() => null))?.size ?? 0;
        await unlink(this.path(m.id)).catch(() => {});
        await unlink(this.path(m.id, 'json')).catch(() => {});
        await unlink(this.path(m.id, 'frames')).catch(() => {});
        total -= bytes;
      }
    }
  }
}
export class PageRecorder {
  latest?: LiveFrame;
  meta: RecordingMeta;
  private process?: ChildProcessWithoutNullStreams;
  private ended?: Promise<number | null>;
  private timer?: NodeJS.Timeout;
  private capturing?: Promise<void>;
  private stopped = false;
  private stopping?: Promise<void>;
  private lastPersisted = 0;
  private encoderDone = false;
  private samplingFailures = 0;
  private totalSamplingFailures = 0;
  private lastSamplingError?: number;
  private captureStarted?: number;
  private encoderExit?: { code: number | null; signal: string | null };
  private lastReported = new Map<string, number>();
  private report(code: string, level: LogEvent['level'], fields?: LogEvent['fields']) {
    const previous = this.lastReported.get(code) ?? 0;
    if (Date.now() - previous < 30000) return;
    this.lastReported.set(code, Date.now());
    this.store.emit({
      owner: this.meta.owner,
      instance_id: this.meta.instance_id,
      page_id: this.meta.page_id,
      component: 'recorder',
      level,
      code,
      fields,
    });
  }
  diagnostics() {
    return {
      recording_id: this.meta.id,
      status: this.meta.status,
      frames: this.meta.frames,
      bytes: this.meta.bytes,
      capture_inflight: !!this.capturing,
      capture_started_at: this.captureStarted ? new Date(this.captureStarted).toISOString() : null,
      consecutive_sampling_failures: this.samplingFailures,
      total_sampling_failures: this.totalSamplingFailures,
      last_sampling_error_at: this.lastSamplingError
        ? new Date(this.lastSamplingError).toISOString()
        : null,
      encoder_pid: this.process?.pid ?? null,
      encoder_exit: this.encoderExit ?? null,
    };
  }
  constructor(
    private store: RecordingStore,
    instance: string,
    owner: string,
    private getPage: () => RecordingPage | undefined,
    taskDescription?: string,
    createdAt = new Date().toISOString(),
  ) {
    const cfg = store.cfg;
    const source = getPage()!;
    const viewport = source.page.viewportSize() ?? {
      width: cfg.videoWidth,
      height: cfg.videoHeight,
    };
    // Keep recording captures in CSS pixels. Device-scale capture clips in Chromium
    // can disturb hit testing on mobile pages without a viewport meta tag.
    const dpr = 1;
    const scale = Math.min(
      1,
      cfg.videoWidth / (viewport.width * dpr),
      cfg.videoHeight / (viewport.height * dpr),
    );
    this.meta = {
      id: `rec_${randomUUID()}`,
      instance_id: instance,
      task_description: taskDescription,
      schema_version: 2,
      page_id: source.page_id,
      page_title: source.title ?? '',
      page_url: source.url ?? source.page.url(),
      instance_created_at: createdAt,
      started_offset_ms: Math.max(0, Date.now() - Date.parse(createdAt)),
      timing_available: cfg.recordVideo,
      owner,
      created_at: new Date().toISOString(),
      status: cfg.recordVideo ? 'recording' : 'live_only',
      frames: 0,
      fps: cfg.videoFps,
      width: Math.max(2, Math.floor((viewport.width * dpr * scale) / 2) * 2),
      height: Math.max(2, Math.floor((viewport.height * dpr * scale) / 2) * 2),
      bytes: 0,
    };
  }
  async start() {
    if (this.store.cfg.recordVideo) {
      await this.store.persist(this.meta);
      const c = this.store.cfg;
      this.process = spawn(
        c.ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'image2pipe',
          '-r',
          String(c.videoFps),
          '-c:v',
          'mjpeg',
          '-i',
          'pipe:0',
          '-an',
          '-c:v',
          'libvpx-vp9',
          '-b:v',
          '0',
          '-crf',
          '30',
          '-deadline',
          'realtime',
          '-cpu-used',
          '8',
          '-threads',
          '1',
          '-vf',
          `pad=${this.meta.width}:${this.meta.height}:0:0:black`,
          '-pix_fmt',
          'yuv420p',
          '-y',
          this.store.path(this.meta.id),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      this.process.stdin.on('error', () => this.report('encoder_input_error', 'warn'));
      this.process.stdout.resume();
      this.process.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (/no space left/i.test(text)) this.report('encoder_disk_full', 'error');
        else if (/Unknown encoder|not found/i.test(text))
          this.report('encoder_codec_unavailable', 'error');
        else if (/error|failed|invalid/i.test(text)) this.report('encoder_reported_error', 'error');
      });
      this.ended = new Promise((resolve) => {
        this.process!.once('error', (error: NodeJS.ErrnoException) => {
          this.encoderDone = true;
          this.report('encoder_unavailable', 'error', {
            error_code: ['ENOENT', 'EACCES', 'ENOMEM', 'ENOSPC'].includes(error.code ?? '')
              ? error.code!
              : 'ENCODER_ERROR',
          });
          this.meta.status = 'failed';
          this.meta.error = 'Video encoder unavailable; check FFMPEG_PATH.';
          resolve(null);
        });
        this.process!.once('exit', (code, signal) => {
          this.encoderExit = { code, signal };
          this.report(
            'encoder_exited',
            code === 0 ||
              this.meta.status === 'limit_reached' ||
              (this.stopped && this.meta.frames === 0)
              ? 'info'
              : 'error',
            {
              exit_code: code,
              signal,
              expected: this.stopped || this.meta.status === 'limit_reached',
            },
          );
          this.encoderDone = true;
          if (
            code !== 0 &&
            this.stopped &&
            this.meta.frames === 0 &&
            this.meta.status === 'finalizing'
          ) {
            this.meta.status = 'empty';
            this.meta.error = undefined;
          } else if (code !== 0 && !['failed', 'limit_reached'].includes(this.meta.status)) {
            this.meta.status = 'failed';
            this.meta.error = 'Video encoder failed.';
          }
          resolve(code);
        });
      });
    }
    this.report(this.store.cfg.recordVideo ? 'recording_started' : 'live_preview_started', 'info', {
      recording_id: this.meta.id,
    });
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000 / this.store.cfg.videoFps);
    this.timer.unref();
    void this.tick();
  }
  private async tick() {
    if (this.stopped || this.capturing) return;
    this.captureStarted = Date.now();
    this.capturing = this.store
      .sample(() => (this.stopped ? Promise.resolve() : this.capture()))
      .then(() => {
        if (this.samplingFailures)
          this.report('frame_sampling_recovered', 'info', {
            previous_failures: this.samplingFailures,
          });
        this.samplingFailures = 0;
        if (this.meta.error === 'Frame sampling temporarily unavailable')
          this.meta.error = undefined;
      })
      .catch((error) => {
        this.samplingFailures++;
        this.totalSamplingFailures++;
        this.meta.sampling_failures = this.totalSamplingFailures;
        this.lastSamplingError = Date.now();
        this.meta.error = 'Frame sampling temporarily unavailable';
        this.report('frame_sampling_failed', 'warn', {
          error_code: publicError(error).code,
          consecutive_failures: this.samplingFailures,
        });
      });
    try {
      await this.capturing;
    } finally {
      this.capturing = undefined;
      this.captureStarted = undefined;
    }
  }
  private async capture() {
    const active = this.getPage();
    if (!active || active.page.isClosed()) return;
    const cfg = this.store.cfg;
    this.meta.page_url = active.url ?? active.page.url();
    this.meta.page_title = active.title ?? this.meta.page_title;
    const raw = await active.page.screenshot({
      type: 'jpeg',
      quality: cfg.videoQuality,
      scale: 'css',
      timeout: 2000,
    });
    const bytes = await sharp(raw)
      .resize({
        width: this.meta.width,
        height: this.meta.height,
        fit: 'contain',
        background: 'black',
        withoutEnlargement: true,
      })
      .jpeg({ quality: cfg.videoQuality })
      .toBuffer();
    this.latest = { bytes, time: Date.now(), page_id: active.page_id };
    if (
      this.process &&
      !this.encoderDone &&
      !this.process.stdin.destroyed &&
      !this.process.stdin.writableEnded
    ) {
      if (this.process.stdin.writableLength > 1048576) {
        this.report('encoder_backpressure', 'warn', {
          queued_bytes: this.process.stdin.writableLength,
        });
        return;
      } // Drop samples rather than accumulate memory under encoder backpressure.
      this.process.stdin.write(bytes);
      this.meta.frames++;
      await appendFile(
        this.store.path(this.meta.id, 'frames'),
        `${Math.max(0, Date.now() - Date.parse(this.meta.instance_created_at!))}\n`,
        { mode: 0o600 },
      );
      const size = (await stat(this.store.path(this.meta.id)).catch(() => null))?.size ?? 0;
      this.meta.bytes = size;
      if (Date.now() - this.lastPersisted > 5000) {
        this.lastPersisted = Date.now();
        await this.store.persist(this.meta);
      }
      if (size > cfg.recordingLimit) {
        this.meta.status = 'limit_reached';
        this.report('recording_limit_reached', 'warn', {
          bytes: size,
          limit_bytes: cfg.recordingLimit,
        });
        this.process.stdin.end();
      }
    }
  }
  stop() {
    this.stopping ??= this.finish();
    return this.stopping;
  }
  private async finish() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.race([
      this.capturing,
      new Promise((r) => {
        const t = setTimeout(r, 3000);
        t.unref();
      }),
    ]);
    // Include a last view even for a short-lived instance.
    if (!this.latest) await this.store.sample(() => this.capture()).catch(() => {});
    this.meta.ended_at = new Date().toISOString();
    this.meta.ended_offset_ms = Date.now() - Date.parse(this.meta.instance_created_at!);
    if (this.process) {
      this.meta.status = this.meta.status === 'recording' ? 'finalizing' : this.meta.status;
      this.process.stdin.end();
      const kill = setTimeout(() => this.process?.kill('SIGKILL'), 10000);
      kill.unref();
      await this.ended;
      clearTimeout(kill);
      this.meta.ended_at = new Date().toISOString();
      this.meta.bytes = (await stat(this.store.path(this.meta.id)).catch(() => null))?.size ?? 0;
      if (this.meta.status === 'finalizing')
        this.meta.status = this.meta.frames > 0 && this.meta.bytes > 0 ? 'completed' : 'failed';
      await this.store.persist(this.meta);
      this.report('recording_finalized', this.meta.status === 'failed' ? 'warn' : 'info', {
        recording_id: this.meta.id,
        status: this.meta.status,
        frames: this.meta.frames,
        bytes: this.meta.bytes,
      });
    }
  }
}

// One session owns independent encoders. The selected tab only controls the shared live view.
export class InstanceRecorder {
  pages = new Map<string, PageRecorder>();
  environment?: {
    environment: BrowserEnvironment;
    properties?: InstanceProperties;
    pages?: InstancePage[];
  };
  private starting = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(
    private store: RecordingStore,
    private instance: string,
    private owner: string,
    private getPages: () => RecordingPage[],
    private getActive: () => string | undefined,
    private taskDescription: string | undefined,
    private createdAt: string,
  ) {}
  byId(id: string) {
    return [...this.pages.values()].find((r) => r.meta.id === id);
  }
  frame(pageId?: string) {
    return this.pages.get(pageId ?? this.getActive() ?? '')?.latest;
  }
  get latest() {
    return this.frame();
  }
  get meta(): RecordingMeta {
    const all = [...this.pages.values()].map((r) => r.meta);
    const first = this.pages.get(this.getActive() ?? '')?.meta ?? all[0];
    return {
      ...first,
      frames: all.reduce((n, m) => n + m.frames, 0),
      bytes: all.reduce((n, m) => n + m.bytes, 0),
      status: all.some((m) => ['recording', 'finalizing'].includes(m.status))
        ? 'recording'
        : all.some((m) => m.status === 'failed')
          ? 'failed'
          : (first?.status ?? 'live_only'),
    };
  }
  diagnostics() {
    const all = [...this.pages.values()].map((r) => r.diagnostics());
    return {
      ...all[0],
      recording_id: this.meta.id,
      status: this.meta.status,
      frames: this.meta.frames,
      bytes: this.meta.bytes,
      capture_inflight: all.some((r) => r.capture_inflight),
      total_sampling_failures: all.reduce((n, r) => n + r.total_sampling_failures, 0),
      mode: 'per_page',
      pages: all.map((r, n) => ({ ...r, page_id: [...this.pages.keys()][n] })),
    };
  }
  async start() {
    await Promise.all(this.getPages().map((p) => this.add(p.page_id)));
  }
  async add(pageId: string) {
    if (this.stopped || this.pages.has(pageId)) return this.starting.get(pageId);
    const initial = this.getPages().find((p) => p.page_id === pageId);
    if (!initial) return;
    const r = new PageRecorder(
      this.store,
      this.instance,
      this.owner,
      () => this.getPages().find((p) => p.page_id === pageId) ?? initial,
      this.taskDescription,
      this.createdAt,
    );
    if (this.environment) Object.assign(r.meta, structuredClone(this.environment));
    this.pages.set(pageId, r);
    const start = r.start();
    this.starting.set(pageId, start);
    try {
      await start;
    } finally {
      this.starting.delete(pageId);
    }
  }
  async stopPage(pageId: string) {
    await this.starting.get(pageId);
    const r = this.pages.get(pageId);
    if (r) {
      await r.stop();
      r.latest = undefined;
    }
  }
  async stop() {
    this.stopped = true;
    await Promise.all([...this.starting.values()]);
    await Promise.all([...this.pages.values()].map((r) => r.stop()));
  }
}
