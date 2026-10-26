import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  rename,
  stat,
  readdir,
  unlink,
  statfs,
} from 'node:fs/promises';
import { join } from 'node:path';
import { freemem, totalmem, loadavg } from 'node:os';
import type { Config } from './config.js';
import { ToolError } from './errors.js';
import type { BrowserEnvironment } from './browser-environment.js';
import type { InstanceProperties, InstancePage } from './instance-details.js';
import type { NavigationEvent } from './navigation.js';

export type Level = 'info' | 'warn' | 'error';
export type Component =
  'service' | 'browser' | 'page' | 'operation' | 'recorder' | 'tunnel' | 'navigation';
export type LogEvent = {
  seq: number;
  time: string;
  level: Level;
  component: Component;
  code: string;
  owner?: string;
  instance_id?: string;
  page_id?: string;
  operation_id?: string;
  fields?: Record<string, string | number | boolean | null>;
  arguments?: Record<string, unknown>;
  navigation?: NavigationEvent;
};
export type InstanceRecord = {
  navigation_since_seq?: number;
  instance_id: string;
  task_description?: string;
  environment?: BrowserEnvironment;
  properties?: InstanceProperties;
  pages?: InstancePage[];
  owner: string;
  created_at: string;
  updated_at: string;
  status: 'starting' | 'active' | 'closing' | 'closed' | 'crashed' | 'interrupted' | 'failed';
  recording?: {
    recording_id: string;
    status: string;
    frames: number;
    bytes: number;
    last_frame_at: string | null;
    sampling_failures: number;
  };
  ended_at?: string;
  close_reason?: string;
  pid?: number;
  exit_code?: number | null;
  exit_signal?: string | null;
  last_operation?: {
    operation_id: string;
    tool: string;
    started_at: string;
    recording?: {
      recording_id: string;
      status: string;
      frames: number;
      bytes: number;
      last_frame_at: string | null;
      sampling_failures: number;
    };
    ended_at?: string;
    status: string;
  };
};
const ranks = { info: 0, warn: 1, error: 2 };
const instancePattern = /^ins_[a-f0-9-]{36}$/;
export class Diagnostics {
  private dir: string;
  private records = new Map<string, InstanceRecord>();
  private next = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private secrets = new Set<string>();
  private pinnedSecrets = new Set<string>();
  private queuedEvents = 0;
  droppedEvents = 0;
  private fileSize = 0;
  writeErrors = 0;
  lastWriteError?: string;
  constructor(private cfg: Config) {
    this.dir = join(cfg.dataDir, 'diagnostics');
    this.registerSecret(cfg.webPassword);
    this.registerSecret(cfg.cfTunnelToken);
  }
  registerSecret(value?: string, pinned = true) {
    if (!value || value.length < 4) return;
    this.secrets.add(value);
    if (pinned) this.pinnedSecrets.add(value);
    if (this.secrets.size > 4096) {
      const removable = [...this.secrets].find((v) => !this.pinnedSecrets.has(v));
      if (removable) this.secrets.delete(removable);
    }
  }
  private cleanText(value: string) {
    let text = value;
    for (const secret of this.secrets) text = text.split(secret).join('[redacted]');
    return text
      .replace(/(?:Bearer\s+|(?:password|token|secret|cookie)\s*[:=]\s*)[^\s,;]+/gi, '[redacted]')
      .slice(0, 512);
  }
  url(raw: string) {
    try {
      const u = new URL(raw);
      if (!['http:', 'https:'].includes(u.protocol)) return '[non-http-url]';
      return this.cleanText(u.origin + u.pathname);
    } catch {
      return '[invalid-url]';
    }
  }
  private file(index = 0) {
    return join(this.dir, `events${index ? '.' + index : ''}.jsonl`);
  }
  private enqueue(work: () => Promise<unknown>) {
    this.pending = this.pending.then(work).catch((error) => {
      this.lastWriteError =
        typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)
          ? error.code
          : 'WRITE_FAILED';
      if (!this.writeErrors++)
        process.stderr.write('Diagnostic storage write failed; inspect health for write_errors.\n');
    });
  }
  async flush() {
    await this.pending;
  }
  sequence() {
    return this.next;
  }
  async init() {
    await mkdir(join(this.dir, 'instances'), { recursive: true, mode: 0o700 });
    for (const row of await this.readEvents()) this.next = Math.max(this.next, row.seq);
    this.fileSize = (await stat(this.file()).catch(() => null))?.size ?? 0;
    if (this.fileSize && !(await readFile(this.file(), 'utf8')).endsWith('\n')) {
      await appendFile(this.file(), '\n');
      this.fileSize++;
    }
    for (const name of await readdir(join(this.dir, 'instances'))) {
      if (!/^ins_[a-f0-9-]{36}\.json$/.test(name)) continue;
      const record = await readFile(join(this.dir, 'instances', name), 'utf8')
        .then((s) => JSON.parse(s) as InstanceRecord)
        .catch(() => null);
      if (record?.instance_id && instancePattern.test(record.instance_id)) {
        this.records.set(record.instance_id, record);
        if (['starting', 'active', 'closing'].includes(record.status)) {
          this.update(record.instance_id, {
            status: 'interrupted',
            ...(record.recording
              ? { recording: { ...record.recording, status: 'interrupted' } }
              : {}),
            ...(record.last_operation?.status === 'running'
              ? { last_operation: { ...record.last_operation, status: 'interrupted' } }
              : {}),
            close_reason: 'manager_interrupted',
            ended_at: new Date().toISOString(),
          });
          this.log({
            owner: record.owner,
            instance_id: record.instance_id,
            level: 'warn',
            component: 'service',
            code: 'instance_interrupted_on_restart',
          });
        } else if (record.last_operation?.status === 'running') {
          this.update(record.instance_id, {
            last_operation: { ...record.last_operation, status: 'interrupted' },
          });
        }
      }
    }
    await this.clean();
    await this.flush();
  }
  log(event: Omit<LogEvent, 'seq' | 'time'>) {
    const priority = ['service', 'browser', 'tunnel'].includes(event.component);
    if (this.queuedEvents >= (priority ? 1100 : 1000)) {
      this.droppedEvents++;
      return;
    }
    this.queuedEvents++;

    const fields = event.fields
      ? Object.fromEntries(
          Object.entries(event.fields)
            .slice(0, 20)
            .map(([k, v]) => [
              k,
              typeof v === 'string' && event.component !== 'operation' ? this.cleanText(v) : v,
            ]),
        )
      : undefined;
    const row: LogEvent = { ...event, fields, seq: ++this.next, time: new Date().toISOString() };
    const line = JSON.stringify(row) + '\n';
    if (Buffer.byteLength(line) > this.cfg.maxLogBytes / 4) {
      this.queuedEvents--;
      this.droppedEvents++;
      return;
    }
    this.enqueue(async () => {
      try {
        if (this.fileSize + Buffer.byteLength(line) > this.cfg.maxLogBytes / 4) {
          await unlink(this.file(3)).catch(() => {});
          for (let i = 2; i >= 0; i--)
            await rename(this.file(i), this.file(i + 1)).catch((e) => {
              if (e.code !== 'ENOENT') throw e;
            });
          this.fileSize = 0;
        }
        await appendFile(this.file(), line, { mode: 0o600 });
        this.fileSize += Buffer.byteLength(line);
      } finally {
        this.queuedEvents--;
      }
    });
  }
  register(record: Omit<InstanceRecord, 'updated_at'>) {
    this.records.set(record.instance_id, { ...record, updated_at: record.created_at });
    this.update(record.instance_id, {});
  }
  update(id: string, patch: Partial<InstanceRecord>) {
    const previous = this.records.get(id);
    if (!previous) return;
    const record = { ...previous, ...patch, updated_at: new Date().toISOString() };
    this.records.set(id, record);
    this.enqueue(async () => {
      const path = join(this.dir, 'instances', `${id}.json`);
      await writeFile(path + '.tmp', JSON.stringify(record), { mode: 0o600 });
      await rename(path + '.tmp', path);
    });
  }
  get(owner: string, id: string) {
    const record = this.records.get(id);
    if (!record || record.owner !== owner)
      throw new ToolError('INSTANCE_NOT_FOUND', 'Unknown or expired instance history.');
    const { owner: _owner, ...safe } = record;
    return structuredClone(safe);
  }
  adminGet(id: string) {
    const record = this.records.get(id);
    return record ? this.get(record.owner, id) : undefined;
  }
  async adminInstanceLogs(id: string, options: Parameters<Diagnostics['query']>[1]) {
    const record = this.records.get(id);
    if (!record) throw new ToolError('INSTANCE_NOT_FOUND', 'Unknown or expired instance history.');
    return {
      instance: this.get(record.owner, id),
      ...(await this.query(record.owner, { ...options, instance_id: id })),
    };
  }
  async navigation(
    owner: string,
    id: string,
    options: { page_id?: string; after_seq?: number; limit?: number },
  ) {
    const record = this.get(owner, id);
    const result = await this.query(owner, {
      instance_id: id,
      component: 'navigation',
      page_id: options.page_id,
      after_seq: options.after_seq ?? record.navigation_since_seq ?? 0,
      limit: options.limit ?? 100,
    });
    return {
      ...result,
      instance_id: id,
      recorded: record.navigation_since_seq !== undefined,
      scope: 'top_level',
      entries: result.entries
        .filter((e) => e.navigation)
        .map((e) => ({
          seq: e.seq,
          time: e.time,
          page_id: e.page_id,
          operation_id: e.operation_id,
          ...e.navigation!,
        })),
    };
  }
  async adminNavigation(
    id: string,
    options: { page_id?: string; after_seq?: number; limit?: number },
  ) {
    const record = this.records.get(id);
    if (!record) throw new ToolError('INSTANCE_NOT_FOUND', 'Unknown or expired instance history.');
    return this.navigation(record.owner, id, options);
  }
  private async readEvents() {
    const all: LogEvent[] = [];
    for (let i = 3; i >= 0; i--) {
      const text = await readFile(this.file(i), 'utf8').catch((e) => {
        if (e.code === 'ENOENT') return '';
        throw e;
      });
      for (const line of text.split('\n')) {
        try {
          const row = JSON.parse(line) as LogEvent;
          if (Number.isSafeInteger(row.seq) && row.time && row.component) all.push(row);
        } catch {
          /* An interrupted final write may leave a partial line. */
        }
      }
    }
    return all;
  }
  async query(
    owner: string,
    options: {
      instance_id?: string;
      page_id?: string;
      operation_id?: string;
      component?: Component;
      level?: Level;
      since?: string;
      after_seq?: number;
      limit: number;
    },
  ) {
    if (options.instance_id && this.records.has(options.instance_id))
      this.get(owner, options.instance_id);
    const reading = this.pending
      .then(() => this.readEvents())
      .catch(() => {
        throw new ToolError(
          'LOG_READ_FAILED',
          'Cannot read diagnostic storage. Check data volume health and permissions.',
        );
      });
    this.pending = reading.then(
      () => {},
      () => {},
    );
    const snapshot = await reading;
    if (
      options.instance_id &&
      !this.records.has(options.instance_id) &&
      !snapshot.some((e) => e.owner === owner && e.instance_id === options.instance_id)
    )
      throw new ToolError('INSTANCE_NOT_FOUND', 'Unknown or expired instance log history.');
    const cutoff = Math.max(
      Date.now() - this.cfg.logRetentionHours * 3600000,
      options.since ? Date.parse(options.since) : 0,
    );
    const all = snapshot.filter((e) => Date.parse(e.time) >= cutoff);
    const visible = all.filter(
      (e) =>
        (e.owner === owner || !e.owner) &&
        (!options.instance_id || e.instance_id === options.instance_id) &&
        (!options.page_id || e.page_id === options.page_id) &&
        (!options.operation_id || e.operation_id === options.operation_id) &&
        (!options.component || e.component === options.component) &&
        (!options.level || ranks[e.level] >= ranks[options.level]) &&
        (options.after_seq === undefined || e.seq > options.after_seq),
    );
    const rows =
      options.after_seq === undefined
        ? visible.slice(-options.limit)
        : visible.slice(0, options.limit);
    return {
      entries: rows.map(({ owner: _owner, ...row }) => row),
      next_after_seq: rows.at(-1)?.seq ?? options.after_seq ?? this.next,
      has_more: options.after_seq !== undefined && visible.length > rows.length,
      oldest_available_seq: all[0]?.seq ?? null,
      history_truncated:
        options.after_seq !== undefined && !!all.length && options.after_seq < all[0].seq - 1,
      write_errors: this.writeErrors,
      last_write_error: this.lastWriteError ?? null,
      dropped_events: this.droppedEvents,
    };
  }
  async clean() {
    const cutoff = Date.now() - this.cfg.logRetentionHours * 3600000;
    const ended = [...this.records.values()]
      .filter((r) => ['closed', 'interrupted', 'failed', 'crashed'].includes(r.status))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    for (let n = 0; n < ended.length; n++) {
      const r = ended[n];
      if (n >= 1000 || Date.parse(r.updated_at) < cutoff) {
        this.records.delete(r.instance_id);
        this.enqueue(() =>
          unlink(join(this.dir, 'instances', r.instance_id + '.json')).catch(() => {}),
        );
      }
    }
    this.enqueue(async () => {
      for (let i = 3; i >= 0; i--) {
        const info = await stat(this.file(i)).catch(() => null);
        if (info && info.mtimeMs < cutoff) {
          await unlink(this.file(i));
          if (!i) this.fileSize = 0;
        }
      }
    });
  }
}

export async function resources(dataDir: string) {
  const number = async (path: string) => {
    const raw = await readFile(path, 'utf8').catch(() => '');
    return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
  };
  const [current, limit, events, disk] = await Promise.all([
    number('/sys/fs/cgroup/memory.current'),
    number('/sys/fs/cgroup/memory.max'),
    readFile('/sys/fs/cgroup/memory.events', 'utf8').catch(() => ''),
    statfs(dataDir).catch(() => null),
  ]);
  const counts = Object.fromEntries(
    events
      .trim()
      .split('\n')
      .map((line) => line.split(/\s+/))
      .filter((x) => x.length === 2)
      .map(([k, v]) => [k, Number(v)]),
  );
  return {
    manager_rss_bytes: process.memoryUsage().rss,
    host_free_memory_bytes: freemem(),
    host_total_memory_bytes: totalmem(),
    load_average: loadavg(),
    container_memory_bytes: current,
    container_memory_limit_bytes: limit,
    container_oom_kill_count: counts.oom_kill ?? null,
    data_free_bytes: disk ? disk.bavail * disk.bsize : null,
    logging_note:
      'SIGKILL or a lost connection alone does not prove OOM; compare cgroup counters and host/container logs.',
  };
}
