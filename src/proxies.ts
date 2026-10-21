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
export const proxyHealthSchema = z
  .object({
    status: z.enum(['unknown', 'healthy', 'unhealthy']).default('unknown'),
    checked_at: z.string().datetime().optional(),
    next_check_at: z.string().datetime().optional(),
    latency_ms: z.number().nonnegative().optional(),
    observed_ip: z.string().optional(),
    http_status: z.number().int().optional(),
    error_code: z.string().max(64).optional(),
  })
  .strict();
export type ProxyHealth = z.infer<typeof proxyHealthSchema>;
export type ProxyStatus = ProxyHealth['status'] | 'disabled' | 'checking';
const recordSchema = savedProxySchema.extend({
  health: proxyHealthSchema.default({ status: 'unknown' }),
  proxy_id: z.string().min(1).max(128),
  updated_at: z.string().datetime(),
});
export type SavedProxy = z.infer<typeof recordSchema>;

export class ProxyStore {
  private records: SavedProxy[] = [];
  private checking = new Map<string, string>();
  onChange?: () => void;
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
    try {
      const cached = z
        .array(
          z
            .object({ proxy_id: z.string(), revision: z.string(), health: proxyHealthSchema })
            .strict(),
        )
        .max(1000)
        .parse(JSON.parse(await readFile(join(this.cfg.dataDir, 'proxy-health.json'), 'utf8')));
      this.records = this.records.map((p) => {
        const found = cached.find((h) => h.proxy_id === p.proxy_id && h.revision === p.updated_at);
        return found ? { ...p, health: found.health } : p;
      });
    } catch {
      // Health is a derived cache, never a reason to stop the service. Recheck instead of trusting damaged results.
    }
  }
  list() {
    return this.records.map((p) => {
      const stale =
        !p.health.checked_at ||
        Date.now() - Date.parse(p.health.checked_at) > this.cfg.proxyCheckIntervalSeconds * 2000;
      return {
        ...p,
        status: !p.enabled
          ? ('disabled' as const)
          : this.checking.get(p.proxy_id) === p.updated_at
            ? ('checking' as const)
            : stale
              ? ('unknown' as const)
              : p.health.status,
        health: { ...p.health, checking: this.checking.get(p.proxy_id) === p.updated_at },
      };
    });
  }
  available(
    filters: {
      country?: string;
      protocol?: string;
      enabled_only?: boolean;
      status?: ProxyStatus;
    } = {},
  ) {
    return this.list()
      .filter(
        (p) =>
          (!filters.country || p.country === filters.country) &&
          (!filters.protocol || p.protocol === filters.protocol) &&
          (filters.enabled_only === false || p.enabled) &&
          (!filters.status || p.status === filters.status),
      )
      .map(
        ({
          proxy_id,
          name,
          protocol,
          host,
          port,
          country,
          enabled,
          username,
          password,
          health,
          status,
        }) => ({
          proxy_id,
          proxy_ref: proxy_id,
          name,
          protocol,
          server: `${protocol}://${host}:${port}`,
          country,
          enabled,
          authenticated: !!(username || password),
          health,
          status,
        }),
      );
  }
  beginCheck(id: string, revision: string) {
    if (!this.records.some((p) => p.proxy_id === id && p.updated_at === revision && p.enabled))
      return false;
    this.checking.set(id, revision);
    return true;
  }
  endCheck(id: string, revision: string) {
    if (this.checking.get(id) === revision) this.checking.delete(id);
  }
  recordHealth(id: string, revision: string, value: ProxyHealth) {
    const health = proxyHealthSchema.parse(value);
    return this.serial(async () => {
      if (!this.records.some((p) => p.proxy_id === id && p.updated_at === revision && p.enabled))
        return false;
      const next = this.records.map((p) => (p.proxy_id === id ? { ...p, health } : p));
      await this.persistHealth(next);
      this.records = next;
      return true;
    });
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
    await writeFile(
      tmp,
      JSON.stringify(
        records.map(({ health, ...record }) => record),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await rename(tmp, this.file);
  }
  private async persistHealth(records: SavedProxy[]) {
    const file = join(this.cfg.dataDir, 'proxy-health.json');
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(
      tmp,
      JSON.stringify(
        records.map((p) => ({ proxy_id: p.proxy_id, revision: p.updated_at, health: p.health })),
      ),
      { mode: 0o600 },
    );
    await rename(tmp, file);
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
      const previous = this.records.find((p) => p.proxy_id === id);
      const unchanged =
        previous &&
        ['protocol', 'host', 'port', 'username', 'password', 'enabled'].every(
          (k) => previous[k as keyof SavedProxy] === fields[k as keyof typeof fields],
        );
      const record = {
        ...fields,
        health: unchanged ? previous.health : { status: 'unknown' as const },
        proxy_id: id ?? `proxy_${randomUUID()}`,
        updated_at: new Date(
          Math.max(Date.now(), previous ? Date.parse(previous.updated_at) + 1 : 0),
        ).toISOString(),
      };
      const next = id
        ? this.records.map((p) => (p.proxy_id === id ? record : p))
        : [...this.records, record];
      await this.persist(next);
      this.records = next;
      this.onChange?.();
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
      this.checking.delete(id);
      this.onChange?.();
      return { deleted: true, proxy_id: id };
    });
  }
}
