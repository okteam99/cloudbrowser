import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { loadProxies, proxySchema, type Config, type Proxy } from './config.js';
import { ToolError } from './errors.js';

export const savedProxySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    protocol: z.enum(['socks5', 'http', 'https']).default('socks5'),
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .refine((v) => {
        try {
          const url = new URL(`socks5://${v}:1080`);
          return (
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === '' &&
            url.port === '1080'
          );
        } catch {
          return false;
        }
      }, 'Use an IP address or hostname only; wrap IPv6 in brackets.'),
    port: z.number().int().min(1).max(65535),
    country: z.string().regex(/^[A-Z]{2}$/),
    username: z.string().max(512).default(''),
    password: z.string().max(512).default(''),
    enabled: z.boolean().default(true),
  })
  .strict();
const recordSchema = savedProxySchema.extend({
  proxy_id: z.string().min(1).max(128),
  updated_at: z.string().datetime(),
});
export type SavedProxy = z.infer<typeof recordSchema>;

export class ProxyStore {
  private records: SavedProxy[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private file: string;
  constructor(private cfg: Config) {
    this.file = join(cfg.dataDir, 'proxies.json');
  }
  async init() {
    try {
      this.records = z
        .array(recordSchema)
        .max(1000)
        .parse(JSON.parse(await readFile(this.file, 'utf8')));
      if (new Set(this.records.map((p) => p.proxy_id)).size !== this.records.length)
        throw Error('Duplicate IDs');
      await chmod(this.file, 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw Error('Invalid saved proxy configuration');
      // Import the legacy mounted configuration once; subsequent changes use the persisted platform list.
      this.records = Object.entries(await loadProxies(this.cfg.proxyFile)).map(
        ([proxy_id, raw]) => {
          const proxy = proxySchema.parse({
            server: raw.server,
            username: raw.username,
            password: raw.password,
          });
          const u = new URL(proxy.server);
          return recordSchema.parse({
            proxy_id,
            name: proxy_id,
            protocol: u.protocol.slice(0, -1),
            host: u.hostname,
            port: Number(
              u.port || (u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : 1080),
            ),
            country: raw.country?.toUpperCase() || 'ZZ',
            username: proxy.username,
            password: proxy.password,
            enabled: true,
            updated_at: new Date().toISOString(),
          });
        },
      );
      if (this.records.length > 1000) throw Error('Proxy limit exceeded');
      await this.persist(this.records);
    }
  }
  list() {
    return this.records.map((p) => ({ ...p }));
  }
  available(filters: { country?: string; protocol?: string; enabled_only?: boolean } = {}) {
    return this.records
      .filter(
        (p) =>
          (!filters.country || p.country === filters.country) &&
          (!filters.protocol || p.protocol === filters.protocol) &&
          (filters.enabled_only === false || p.enabled),
      )
      .map(({ proxy_id, name, protocol, host, port, country, enabled, username, password }) => ({
        proxy_id,
        proxy_ref: proxy_id,
        name,
        protocol,
        server: `${protocol}://${host}:${port}`,
        country,
        enabled,
        authenticated: !!(username || password),
      }));
  }
  resolve(id: string): Proxy {
    const p = this.records.find((r) => r.proxy_id === id);
    if (!p) throw new ToolError('PROXY_NOT_FOUND', 'Unknown proxy_id.');
    if (!p.enabled)
      throw new ToolError('PROXY_DISABLED', 'Proxy is disabled. Select an enabled proxy.');
    return {
      server: `${p.protocol}://${p.host}:${p.port}`,
      username: p.username,
      password: p.password,
    };
  }
  private async persist(records: SavedProxy[]) {
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  save(input: unknown, id?: string) {
    const fields = savedProxySchema.parse(input);
    return this.serial(async () => {
      if (id && !this.records.some((p) => p.proxy_id === id))
        throw new ToolError('PROXY_NOT_FOUND', 'Unknown proxy_id.');
      if (!id && this.records.length >= 1000)
        throw new ToolError('PROXY_LIMIT', 'Maximum 1000 saved proxies.');
      const record = {
        ...fields,
        proxy_id: id ?? `proxy_${randomUUID()}`,
        updated_at: new Date().toISOString(),
      };
      const next = id
        ? this.records.map((p) => (p.proxy_id === id ? record : p))
        : [...this.records, record];
      await this.persist(next);
      this.records = next;
      return { ...record };
    });
  }
  remove(id: string) {
    return this.serial(async () => {
      if (!this.records.some((p) => p.proxy_id === id))
        throw new ToolError('PROXY_NOT_FOUND', 'Unknown proxy_id.');
      const next = this.records.filter((p) => p.proxy_id !== id);
      await this.persist(next);
      this.records = next;
      return { deleted: true, proxy_id: id };
    });
  }
}
