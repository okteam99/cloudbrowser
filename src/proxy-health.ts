import { isIP } from 'node:net';
import type { Config, Proxy } from './config.js';
import type { NetworkPolicy } from './network.js';
import { proxyCurl } from './proxy-http.js';
import { ProxyStore, type ProxyHealth, type SavedProxy } from './proxies.js';
import { ToolError, publicError } from './errors.js';

type Result = { status_code: number; elapsed_ms: number; body: string };
type Probe = (proxy: Proxy, id: string, signal: AbortSignal) => Promise<Result>;
export class ProxyHealthMonitor {
  private stopped = true;
  private timer?: NodeJS.Timeout;
  private batch?: Promise<void>;
  private pending = new Set<string>();
  private attempts = new Map<string, { revision: string; next: number }>();
  private active = new Map<string, { revision: string; controller: AbortController }>();
  constructor(
    private store: ProxyStore,
    private cfg: Config,
    policy: NetworkPolicy,
    private emit: (
      code: string,
      fields: Record<string, string | number | boolean>,
    ) => void = () => {},
    private probe: Probe = (proxy, id, signal) =>
      proxyCurl(
        policy,
        proxy,
        {
          proxy_id: id,
          url: cfg.proxyCheckUrl,
          timeout_ms: 10000,
          max_bytes: 8192,
        },
        signal,
      ),
  ) {
    store.onChange = () => {
      const ids = new Set(store.list().map((p) => p.proxy_id));
      for (const id of this.attempts.keys()) if (!ids.has(id)) this.attempts.delete(id);
      for (const [id, active] of this.active) {
        if (
          !store
            .list()
            .some((p) => p.proxy_id === id && p.enabled && p.updated_at === active.revision)
        )
          active.controller.abort();
      }
      this.queue();
    };
  }
  status() {
    return {
      running: !this.stopped,
      interval_seconds: this.cfg.proxyCheckIntervalSeconds,
      checking: this.active.size,
      queued: this.pending.size,
    };
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.queue(true);
    this.timer = setInterval(
      () => this.queue(),
      Math.min(5000, this.cfg.proxyCheckIntervalSeconds * 1000),
    );
    this.timer.unref();
  }
  requestAll() {
    this.queue(true);
    return this.status();
  }
  private queue(force = false) {
    if (this.stopped) return;
    for (const p of this.store.list()) {
      const attempt = this.attempts.get(p.proxy_id);
      const due =
        attempt?.revision === p.updated_at
          ? attempt.next
          : p.health.next_check_at
            ? Date.parse(p.health.next_check_at)
            : p.health.checked_at
              ? Date.parse(p.health.checked_at) + this.cfg.proxyCheckIntervalSeconds * 1000
              : 0;
      if (p.enabled && !this.active.has(p.proxy_id) && (force || Date.now() >= due))
        this.pending.add(p.proxy_id);
    }
    if (!this.batch && this.pending.size) {
      this.batch = this.drain()
        .catch(() => this.emit('proxy_health_worker_failed', {}))
        .finally(() => {
          this.batch = undefined;
          if (!this.stopped && this.pending.size) this.queue();
        });
    }
  }
  private async drain() {
    const worker = async () => {
      while (!this.stopped && this.pending.size) {
        const id = this.pending.values().next().value!;
        this.pending.delete(id);
        const p = this.store.list().find((r) => r.proxy_id === id);
        if (p?.enabled) await this.check(p);
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
  }
  private async check(p: SavedProxy) {
    if (!this.store.beginCheck(p.proxy_id, p.updated_at)) return;
    const controller = new AbortController();
    this.active.set(p.proxy_id, { revision: p.updated_at, controller });
    const started = Date.now();
    this.attempts.set(p.proxy_id, {
      revision: p.updated_at,
      next: started + this.cfg.proxyCheckIntervalSeconds * 1000,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 12000);
    let abort: () => void = () => {};
    try {
      let health: ProxyHealth;
      try {
        const cancelled = new Promise<never>((_, reject) => {
          abort = () => reject(new ToolError('CHECK_CANCELLED', 'Proxy check cancelled.'));
          controller.signal.addEventListener('abort', abort, { once: true });
        });
        const result = await Promise.race([
          this.probe(this.store.resolve(p.proxy_id), p.proxy_id, controller.signal),
          cancelled,
        ]);
        let ip: string | undefined;
        try {
          const body = JSON.parse(result.body);
          if (typeof body.ip === 'string' && isIP(body.ip)) ip = body.ip;
        } catch {}
        health = {
          status: result.status_code >= 200 && result.status_code < 300 ? 'healthy' : 'unhealthy',
          http_status: result.status_code,
          latency_ms: result.elapsed_ms,
          observed_ip: ip,
          error_code:
            result.status_code >= 200 && result.status_code < 300
              ? undefined
              : `HTTP_${result.status_code}`,
        };
      } catch (e) {
        if (this.stopped || (controller.signal.aborted && !timedOut)) return;
        health = {
          status: 'unhealthy',
          latency_ms: Date.now() - started,
          error_code: timedOut ? 'TIMEOUT' : publicError(e).code,
        };
      }
      if (this.stopped) return;
      const accepted = await this.store.recordHealth(p.proxy_id, p.updated_at, {
        ...health,
        checked_at: new Date().toISOString(),
        next_check_at: new Date(started + this.cfg.proxyCheckIntervalSeconds * 1000).toISOString(),
      });
      if (accepted)
        this.emit('proxy_health_checked', {
          proxy_id: p.proxy_id,
          status: health.status,
          latency_ms: health.latency_ms ?? 0,
          ...(health.error_code ? { error_code: health.error_code } : {}),
        });
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      this.active.delete(p.proxy_id);
      this.store.endCheck(p.proxy_id, p.updated_at);
      // A configuration changed during this probe. Queue its new revision, never apply the old result.
      this.queue();
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.pending.clear();
    for (const active of this.active.values()) active.controller.abort();
    await this.batch;
  }
}
