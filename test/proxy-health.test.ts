import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import { ProxyStore } from '../src/proxies.js';
import { ProxyHealthMonitor } from '../src/proxy-health.js';
import { NetworkPolicy } from '../src/network.js';
import { socksFixture } from './socks-fixture.js';

const fields = {
  name: 'Test',
  protocol: 'socks5',
  host: '127.0.0.1',
  port: 1080,
  country: 'US',
  username: 'user',
  password: 'pass',
  enabled: true,
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (predicate: () => boolean, timeout = 3000) => {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await delay(10);
  assert.ok(predicate(), 'Timed out waiting for proxy monitor');
};
async function fixture(interval = 300) {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-health-'));
  const cfg = {
    ...config(),
    dataDir: dir,
    proxyFile: join(dir, 'missing'),
    proxyCheckIntervalSeconds: interval,
  };
  const store = new ProxyStore(cfg);
  await store.init();
  return { dir, cfg, store, policy: new NetworkPolicy(cfg) };
}

test('health startup: concurrency bounded at three, disabled skipped, results survive restart and MCP filters omit credentials', async () => {
  assert.equal(config().proxyCheckIntervalSeconds, 300);
  const f = await fixture();
  const proxies = await Promise.all(
    Array.from({ length: 5 }, (_, n) =>
      f.store.save({ ...fields, name: String(n), enabled: n !== 4 }),
    ),
  );
  let active = 0,
    peak = 0;
  const calls = new Map<string, number>();
  const events: unknown[] = [];
  const monitor = new ProxyHealthMonitor(
    f.store,
    f.cfg,
    f.policy,
    (code, fields) => events.push({ code, fields }),
    async (_p, id) => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      active++;
      peak = Math.max(peak, active);
      await delay(20);
      active--;
      return {
        status_code: id === proxies[1].proxy_id ? 503 : 200,
        elapsed_ms: 17,
        body: '{"ip":"8.8.8.8"}',
      };
    },
  );
  try {
    monitor.start();
    monitor.requestAll();
    await until(() => f.store.list().filter((p) => p.health.checked_at).length === 4);
    assert.ok(peak <= 3 && peak > 1);
    assert.ok([...calls.values()].every((n) => n === 1));
    assert.ok(!calls.has(proxies[4].proxy_id));
    assert.equal(f.store.available({ status: 'healthy' }).length, 3);
    assert.equal(f.store.available({ status: 'unhealthy' })[0].health.error_code, 'HTTP_503');
    assert.equal(f.store.available({ enabled_only: false, status: 'disabled' }).length, 1);
    const list = f.store.available({ status: 'healthy' });
    assert.ok(
      !JSON.stringify(list).includes('password') && !JSON.stringify(list).includes('username'),
    );
    assert.equal(list[0].health.observed_ip, '8.8.8.8');
    const restart = new ProxyStore(f.cfg);
    await restart.init();
    assert.equal(restart.available({ status: 'healthy' }).length, 3);
    const old = f.store.list()[0];
    await f.store.recordHealth(old.proxy_id, old.updated_at, {
      status: 'healthy',
      checked_at: new Date(Date.now() - 700000).toISOString(),
    });
    assert.equal(f.store.list()[0].status, 'unknown', 'Stale success must never appear healthy');
    assert.ok(
      !(await readFile(join(f.dir, 'proxies.json'), 'utf8')).includes('checked_at'),
      'Configuration remains compatible with older images',
    );
    assert.ok(events.length >= 4);
    assert.ok(!JSON.stringify(events).includes('password'));
    assert.ok((await readFile(join(f.dir, 'proxy-health.json'), 'utf8')).includes('checked_at'));
  } finally {
    await monitor.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('monitor repeats on its configured cadence and immediately checks new configurations', async () => {
  const f = await fixture(0.08);
  const p = await f.store.save(fields);
  const calls = new Map<string, number>();
  const monitor = new ProxyHealthMonitor(f.store, f.cfg, f.policy, undefined, async (_p, id) => {
    calls.set(id, (calls.get(id) ?? 0) + 1);
    return { status_code: 200, elapsed_ms: 1, body: '{}' };
  });
  try {
    monitor.start();
    await until(() => (calls.get(p.proxy_id) ?? 0) >= 2);
    const added = await f.store.save({ ...fields, name: 'new' });
    await until(
      () => !!f.store.list().find((r) => r.proxy_id === added.proxy_id)?.health.checked_at,
    );
    assert.ok(calls.has(added.proxy_id));
    await f.store.save({ ...fields, enabled: false }, added.proxy_id);
    assert.equal(f.store.list().find((r) => r.proxy_id === added.proxy_id)?.status, 'disabled');
  } finally {
    await monitor.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('edit/delete/shutdown cancel old probes; an old result cannot overwrite a new revision', async () => {
  const f = await fixture();
  const p = await f.store.save(fields);
  let oldResolve: ((v: any) => void) | undefined;
  let oldSignal: AbortSignal | undefined;
  const monitor = new ProxyHealthMonitor(
    f.store,
    f.cfg,
    f.policy,
    undefined,
    async (proxy, _id, signal) => {
      if (proxy.server.endsWith(':1080')) {
        oldSignal = signal;
        return new Promise((r) => {
          oldResolve = r;
        });
      }
      return { status_code: 200, elapsed_ms: 9, body: '{"ip":"1.1.1.1"}' };
    },
  );
  try {
    monitor.start();
    await until(() => !!oldResolve);
    assert.equal(f.store.list()[0].status, 'checking');
    const edited = await f.store.save({ ...fields, port: 1081 }, p.proxy_id);
    assert.notEqual(edited.updated_at, p.updated_at);
    await until(() => f.store.list()[0].status === 'healthy');
    oldResolve!({ status_code: 503, elapsed_ms: 999, body: '{}' });
    await delay(10);
    assert.equal(oldSignal?.aborted, true);
    assert.equal(f.store.list()[0].health.observed_ip, '1.1.1.1');
    assert.equal(
      await f.store.recordHealth(p.proxy_id, p.updated_at, { status: 'unhealthy' }),
      false,
    );
    await f.store.save(fields, p.proxy_id);
    await until(() => f.store.list()[0].status === 'checking');
    await f.store.remove(p.proxy_id);
    await until(() => monitor.status().checking === 0);
    assert.equal(f.store.list().length, 0);
    await f.store.save(fields);
    await until(() => monitor.status().checking === 1);
    const started = Date.now();
    await monitor.stop();
    assert.ok(Date.now() - started < 1000);
    assert.equal(f.store.list()[0].health.checking, false);
  } finally {
    await monitor.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('a persistence failure backs off instead of starting an unbounded retry loop', async () => {
  const f = await fixture();
  await f.store.save(fields);
  let calls = 0;
  f.store.recordHealth = async () => {
    throw Error('disk unavailable');
  };
  const monitor = new ProxyHealthMonitor(f.store, f.cfg, f.policy, undefined, async () => {
    calls++;
    return { status_code: 200, elapsed_ms: 1, body: '{}' };
  });
  try {
    monitor.start();
    await delay(100);
    assert.equal(calls, 1);
  } finally {
    await monitor.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('real authenticated SOCKS5 health checks use the proxy and classify authentication/network failures', async () => {
  const f = await fixture();
  let connections = 0;
  const socks = socksFixture(() => connections++);
  await new Promise<void>((r) => socks.server.listen(0, '127.0.0.1', r));
  const target = http.createServer((_req, res) => res.end('{"ip":"8.8.8.8"}'));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  const port = (socks.server.address() as any).port;
  const cfg = {
    ...f.cfg,
    allowPrivate: true,
    proxyCheckUrl: `http://127.0.0.1:${(target.address() as any).port}`,
  };
  const good = await f.store.save({ ...fields, port });
  const bad = await f.store.save({ ...fields, port, password: 'wrong' });
  const monitor = new ProxyHealthMonitor(f.store, cfg, new NetworkPolicy(cfg));
  try {
    monitor.start();
    await until(() => f.store.list().every((p) => !!p.health.checked_at), 5000);
    assert.equal(f.store.list().find((p) => p.proxy_id === good.proxy_id)?.status, 'healthy');
    assert.equal(f.store.list().find((p) => p.proxy_id === bad.proxy_id)?.status, 'unhealthy');
    assert.ok(connections > 0);
  } finally {
    await monitor.stop();
    socks.close();
    target.closeAllConnections();
    await new Promise<void>((r) => target.close(() => r()));
    await rm(f.dir, { recursive: true, force: true });
  }
});
