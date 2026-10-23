import { mkdir, open, readFile, readdir, stat, unlink, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Config } from './config.js';
import { ToolError } from './errors.js';

export type Artifact = {
  id: string;
  owner: string;
  instance_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  created_at: string;
  kind: string;
};
type Input = { name: string; mime: string; bytes: Buffer; kind: string };
type Stored = { meta?: Artifact; created: number; files: Map<string, number> };
const artifactPattern = /^art_[a-f0-9-]{36}$/;
export class Artifacts {
  private entries = new Map<string, Stored>();
  private writes: Promise<unknown> = Promise.resolve();
  private cleaning?: Promise<void>;
  private total = 0;
  constructor(private cfg: Config) {}
  private dir() {
    return join(this.cfg.dataDir, 'artifacts');
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work);
    this.writes = next.catch(() => {});
    return next;
  }
  async init() {
    await mkdir(this.dir(), { recursive: true, mode: 0o700 });
    await this.loadIndex();
  }
  private async loadIndex() {
    this.entries.clear();
    this.total = 0;
    const files = await readdir(this.dir());
    for (let start = 0; start < files.length; start += 32) {
      await Promise.all(
        files.slice(start, start + 32).map(async (name) => {
          const info = await stat(join(this.dir(), name)).catch(() => null);
          if (!info?.isFile()) return;
          const match = /^(art_[a-f0-9-]{36})\.(?:bin|json|json\.tmp)$/.exec(name);
          const id = match?.[1] ?? name;
          const entry = this.entries.get(id) ?? {
            created: info.mtimeMs,
            files: new Map<string, number>(),
          };
          entry.files.set(name, info.size);
          if (!entry.meta) entry.created = Math.min(entry.created, info.mtimeMs);
          this.entries.set(id, entry);
          this.total += info.size;
          if (name === id + '.json') {
            try {
              const meta: Artifact = JSON.parse(await readFile(join(this.dir(), name), 'utf8'));
              if (meta.id === id && Number.isFinite(Date.parse(meta.created_at))) {
                entry.meta = meta;
                entry.created = Date.parse(meta.created_at);
              }
            } catch {}
          }
        }),
      );
    }
  }
  private path(id: string, ext = 'bin') {
    if (!artifactPattern.test(id)) throw new ToolError('ARTIFACT_NOT_FOUND', 'Unknown artifact.');
    return join(this.dir(), `${id}.${ext}`);
  }
  private expired(entry: Stored) {
    const hours = ['screenshot', 'screenshot_preview'].includes(entry.meta?.kind ?? '')
      ? this.cfg.screenshotRetentionDays * 24
      : this.cfg.retentionHours;
    return Date.now() - entry.created > hours * 3600000;
  }
  private async remove(id: string, entry: Stored) {
    for (const [name, size] of entry.files) {
      try {
        await unlink(join(this.dir(), name));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      }
      entry.files.delete(name);
      this.total -= size;
    }
    if (!entry.files.size) this.entries.delete(id);
  }
  private async cleanNow(required = 0) {
    const sorted = [...this.entries].sort(([, a], [, b]) => a.created - b.created);
    for (const [id, entry] of sorted) if (this.expired(entry)) await this.remove(id, entry);
    for (const [id, entry] of sorted) {
      if (this.total + required <= this.cfg.dataLimit) break;
      if (this.entries.has(id)) await this.remove(id, entry);
    }
  }
  clean(): Promise<void> {
    if (this.cleaning) return this.cleaning;
    const work = this.enqueue(() => this.cleanNow());
    this.cleaning = work;
    void work
      .finally(() => {
        if (this.cleaning === work) this.cleaning = undefined;
      })
      .catch(() => {});
    return work;
  }
  async usage() {
    const disk = await statfs(this.cfg.dataDir);
    const byKind: Record<string, { count: number; bytes: number }> = {};
    let count = 0;
    for (const entry of this.entries.values()) {
      if (!entry.meta) continue;
      count++;
      const row = (byKind[entry.meta.kind] ??= { count: 0, bytes: 0 });
      row.count++;
      row.bytes += [...entry.files.values()].reduce((a, b) => a + b, 0);
    }
    return {
      bytes: this.total,
      count,
      available_bytes: Math.max(0, this.cfg.dataLimit - this.total),
      disk_available_bytes: disk.bavail * disk.bsize,
      by_kind: byKind,
    };
  }
  async save(
    owner: string,
    instance: string,
    name: string,
    mime: string,
    bytes: Buffer,
    kind: string,
  ): Promise<Artifact> {
    return (await this.saveBatch(owner, instance, [{ name, mime, bytes, kind }]))[0];
  }
  saveBatch(owner: string, instance: string, inputs: Input[]): Promise<Artifact[]> {
    return this.enqueue(async () => {
      for (const input of inputs)
        if (input.bytes.length > this.cfg.downloadLimit)
          throw new ToolError('ARTIFACT_TOO_LARGE', 'Artifact exceeds MAX_DOWNLOAD_BYTES.');
      const items = inputs.map((input) => {
        const meta: Artifact = {
          id: `art_${randomUUID()}`,
          owner,
          instance_id: instance,
          name: input.name.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 200),
          mime: input.mime,
          size: input.bytes.length,
          sha256: createHash('sha256').update(input.bytes).digest('hex'),
          created_at: new Date().toISOString(),
          kind: input.kind,
        };
        return { meta, bytes: input.bytes, json: JSON.stringify(meta) };
      });
      const required = items.reduce(
        (sum, x) => sum + x.bytes.length + Buffer.byteLength(x.json),
        0,
      );
      if (required > this.cfg.dataLimit)
        throw new ToolError(
          'STORAGE_LIMIT',
          'Artifact batch exceeds the configured storage quota.',
        );
      await this.cleanNow(required);
      if (this.total + required > this.cfg.dataLimit)
        throw new ToolError(
          'STORAGE_LIMIT',
          'Artifact storage quota reached; unable to free enough space.',
        );
      const created: string[] = [];
      try {
        for (const item of items) {
          for (const [ext, value] of [
            ['bin', item.bytes],
            ['json', item.json],
          ] as const) {
            const file = this.path(item.meta.id, ext);
            const handle = await open(file, 'wx', 0o600);
            created.push(file);
            try {
              await handle.writeFile(value);
            } finally {
              await handle.close();
            }
          }
        }
      } catch (e) {
        await Promise.all(created.map((f) => unlink(f).catch(() => {})));
        await this.loadIndex();
        throw e;
      }
      for (const item of items)
        this.entries.set(item.meta.id, {
          meta: item.meta,
          created: Date.parse(item.meta.created_at),
          files: new Map([
            [item.meta.id + '.bin', item.bytes.length],
            [item.meta.id + '.json', Buffer.byteLength(item.json)],
          ]),
        });
      this.total += required;
      return items.map((x) => x.meta);
    });
  }
  async get(owner: string, id: string, offset = 0, length = 262144) {
    let meta: Artifact;
    try {
      meta = JSON.parse(await readFile(this.path(id, 'json'), 'utf8'));
    } catch {
      throw new ToolError('ARTIFACT_NOT_FOUND', 'Unknown or expired artifact.');
    }
    if (
      meta.owner !== owner ||
      this.expired({ meta, created: Date.parse(meta.created_at), files: new Map() })
    )
      throw new ToolError('ARTIFACT_NOT_FOUND', 'Unknown or expired artifact.');
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path(id));
    } catch {
      throw new ToolError('ARTIFACT_NOT_FOUND', 'Unknown or expired artifact.');
    }
    const chunk = bytes.subarray(offset, offset + length);
    return {
      ...meta,
      data_base64: chunk.toString('base64'),
      offset,
      next_offset: offset + chunk.length,
      complete: offset + chunk.length >= bytes.length,
    };
  }
}
