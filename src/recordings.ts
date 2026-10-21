import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import sharp from 'sharp';
import type { Config } from './config.js';
import { ToolError, publicError } from './errors.js';
import type { LogEvent } from './diagnostics.js';

export type RecordingMeta = {
  id: string;
  instance_id: string;
  task_description?: string;
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
export class RecordingStore {
  active = new Map<string, InstanceRecorder>();
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
    await writeFile(`${path}.tmp`, JSON.stringify(m), { mode: 0o600 });
    const { rename } = await import('node:fs/promises');
    await rename(`${path}.tmp`, path);
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
      .map((x) => (x ? (this.active.get(x.instance_id)?.meta ?? x) : null))
      .filter((x): x is RecordingMeta => !!x)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async get(id: string) {
    try {
      const m = JSON.parse(await readFile(this.path(id, 'json'), 'utf8')) as RecordingMeta;
      return { meta: m, path: this.path(id) };
    } catch {
      throw new ToolError('RECORDING_NOT_FOUND', 'Unknown or expired recording.');
    }
  }
  async start(
    instance: string,
    owner: string,
    getPage: () =>
      { page: Page; page_id: string; deviceScaleFactor?: number; busy?: boolean } | undefined,
    taskDescription?: string,
  ) {
    const r = new InstanceRecorder(this, instance, owner, getPage, taskDescription);
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
        total -= bytes;
      }
    }
  }
}
export class InstanceRecorder {
  latest?: LiveFrame;
  meta: RecordingMeta;
  private process?: ChildProcessWithoutNullStreams;
  private ended?: Promise<number | null>;
  private timer?: NodeJS.Timeout;
  private capturing?: Promise<void>;
  private stopped = false;
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
    private getPage: () =>
      { page: Page; page_id: string; deviceScaleFactor?: number; busy?: boolean } | undefined,
    taskDescription?: string,
  ) {
    const cfg = store.cfg;
    this.meta = {
      id: `rec_${randomUUID()}`,
      instance_id: instance,
      task_description: taskDescription,
      owner,
      created_at: new Date().toISOString(),
      status: cfg.recordVideo ? 'recording' : 'live_only',
      frames: 0,
      fps: cfg.videoFps,
      width: cfg.videoWidth,
      height: cfg.videoHeight,
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
          '160k',
          '-deadline',
          'realtime',
          '-cpu-used',
          '8',
          '-threads',
          '1',
          '-vf',
          `pad=${c.videoWidth}:${c.videoHeight}:0:0:black`,
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
            code === 0 || this.meta.status === 'limit_reached' ? 'info' : 'error',
            {
              exit_code: code,
              signal,
              expected: this.stopped || this.meta.status === 'limit_reached',
            },
          );
          this.encoderDone = true;
          if (code !== 0 && !['failed', 'limit_reached'].includes(this.meta.status)) {
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
  }
  private async tick() {
    if (this.stopped || this.capturing) return;
    this.captureStarted = Date.now();
    this.capturing = this.capture()
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
    const raw = await active.page.screenshot({
      type: 'jpeg',
      quality: cfg.videoQuality,
      scale: 'css',
      timeout: 2000,
    });
    const bytes = await sharp(raw)
      .resize({
        width: cfg.videoWidth,
        height: cfg.videoHeight,
        fit: 'inside',
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
      const size = (await stat(this.store.path(this.meta.id)).catch(() => null))?.size ?? 0;
      this.meta.bytes = size;
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
  async stop() {
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
    if (!this.latest) await this.capture().catch(() => {});
    if (this.process) {
      this.process.stdin.end();
      const kill = setTimeout(() => this.process?.kill('SIGKILL'), 10000);
      kill.unref();
      await this.ended;
      clearTimeout(kill);
      this.meta.ended_at = new Date().toISOString();
      this.meta.bytes = (await stat(this.store.path(this.meta.id)).catch(() => null))?.size ?? 0;
      if (this.meta.status === 'recording')
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
