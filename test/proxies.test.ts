import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'proxy-chain';
import { config, createSchema } from '../src/config.js';
import { BrowserManager } from '../src/browser.js';
import { ProxyStore } from '../src/proxies.js';
import { definitions } from '../src/tools.js';
import { socksFixture } from './socks-fixture.js';

const fields = {
  name: '美国代理',
  protocol: 'socks5',
  host: '127.0.0.1',
  port: 1080,
  country: 'US',
  username: 'user',
  password: 'pass',
  enabled: true,
};
const listen = async (s: http.Server | import('node:net').Server) => {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as any).port as number;
};
test('saved proxies: atomic CRUD, restart, import, filters, disabled rejection and credential-free discovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloudbrowser-proxies-'));
  const cfg = { ...config(), dataDir: dir, proxyFile: join(dir, 'legacy.json') };
  await writeFile(
    cfg.proxyFile,
    JSON.stringify({
      gb: {
        server: 'socks5://127.0.0.1:1080',
        country: 'gb',
        username: 'legacy',
        password: 'secret',
      },
    }),
  );
  const store = new ProxyStore(cfg);
  try {
    await store.init();
    assert.equal(store.available({ country: 'GB' })[0].proxy_id, 'gb');
    const proxy = await store.save(fields);
    const [a, b] = await Promise.all([
      store.save({ ...fields, name: 'A' }),
      store.save({ ...fields, name: 'B' }),
    ]);
    assert.notEqual(a.proxy_id, b.proxy_id);
    assert.equal(store.list().length, 4);
    const list = store.available({ country: 'US', protocol: 'socks5' });
    assert.equal(list.length, 3);
    assert.ok(list.every((p) => !('username' in p) && !('password' in p)));
    assert.equal(list[0].authenticated, true);
    await store.save({ ...fields, enabled: false }, proxy.proxy_id);
    assert.throws(() => store.resolve(proxy.proxy_id), /disabled/);
    assert.equal(store.available().length, 3);
    assert.equal(store.available({ enabled_only: false }).length, 4);
    assert.equal((await stat(join(dir, 'proxies.json'))).mode & 0o777, 0o600);
    await writeFile(cfg.proxyFile, 'invalid');
    const restored = new ProxyStore(cfg);
    await restored.init();
    assert.equal(restored.list().find((p) => p.proxy_id === proxy.proxy_id)?.password, 'pass');
    await restored.remove(proxy.proxy_id);
    assert.throws(() => restored.resolve(proxy.proxy_id), /Unknown/);
    await assert.rejects(() => restored.save(fields, proxy.proxy_id), /Unknown/);
    assert.throws(() => store.save({ ...fields, host: 'host/evil' }));
    assert.throws(() => store.save({ ...fields, port: 0 }));
    assert.equal(createSchema.safeParse({ proxy_id: 'x', proxy_ref: 'y' }).success, false);
    assert.equal(
      createSchema.safeParse({ proxy_id: 'x', proxy: { server: 'socks5://host:80' } }).success,
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'proxy_curl and Chromium use saved SOCKS5/HTTP IDs; request isolation, limits, no fallback and policy enforcement',
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cloudbrowser-curl-'));
    let hits = 0,
      socksConnections = 0,
      httpConnections = 0;
    const destination = http.createServer(async (req, res) => {
      hits++;
      if (req.url === '/large') return void res.end(Buffer.alloc(100000, 120));
      if (req.url === '/slow') return;
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/result' });
        return void res.end();
      }
      if (req.url === '/blocked-redirect') {
        res.writeHead(302, { Location: `http://localhost:${port}/forbidden` });
        return void res.end();
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-test', 'via-proxy');
      if (req.url === '/404') res.statusCode = 404;
      res.end(
        JSON.stringify({
          method: req.method,
          body: Buffer.concat(chunks).toString(),
          marker: req.headers['x-marker'],
        }),
      );
    });
    const port = await listen(destination),
      url = `http://127.0.0.1:${port}`;
    const socks = socksFixture(() => socksConnections++);
    const socksPort = await listen(socks.server);
    const upstream = new Server({
      host: '127.0.0.1',
      port: 0,
      prepareRequestFunction: ({ username, password }) => {
        httpConnections++;
        return { requestAuthentication: username !== 'user' || password !== 'pass' };
      },
    });
    await upstream.listen();
    const m = new BrowserManager({
      ...config(),
      dataDir: dir,
      proxyFile: join(dir, 'no-config'),
      recordVideo: false,
      allowPrivate: true,
      allowedHosts: ['127.0.0.1'],
    });
    await m.init();
    const call = async (name: string, args: any) =>
      m.execute('alice', name, definitions[name].schema.parse(args));
    try {
      const proxy = await m.proxies.save({ ...fields, port: socksPort });
      const httpProxy = await m.proxies.save({ ...fields, protocol: 'http', port: upstream.port });
      const request = (args: any = {}) =>
        call('proxy_curl', { proxy_id: proxy.proxy_id, url, ...args });
      const response = await request({
        method: 'POST',
        headers: { 'X-Marker': 'saved-id' },
        body: 'line1\nline2 \\ " @/etc/passwd $(echo nope)',
      });
      assert.equal(response.status_code, 200);
      assert.equal(JSON.parse(response.body).method, 'POST');
      assert.equal(JSON.parse(response.body).marker, 'saved-id');
      assert.equal(JSON.parse(response.body).body, 'line1\nline2 \\ " @/etc/passwd $(echo nope)');
      assert.ok(response.headers.some((h: any) => h.name === 'x-test' && h.value === 'via-proxy'));
      assert.ok(socksConnections > 0);
      const other = await request({ proxy_id: httpProxy.proxy_id });
      assert.equal(other.status_code, 200);
      assert.ok(httpConnections > 0);
      assert.equal((await request({ url: url + '/404' })).status_code, 404);
      assert.equal((await request({ method: 'HEAD' })).body, '');
      assert.equal((await request({ url: url + '/redirect' })).status_code, 302);
      const redirected = await request({ url: url + '/redirect', follow_redirects: true });
      assert.equal(redirected.status_code, 200);
      assert.equal(redirected.redirect_count, 1);
      assert.equal(redirected.final_url, url + '/result');
      const blocked = await request({ url: url + '/blocked-redirect', follow_redirects: true });
      assert.notEqual(blocked.status_code, 200);
      const binary = await request({ response_encoding: 'base64' });
      assert.equal(JSON.parse(Buffer.from(binary.body, 'base64').toString()).method, 'GET');
      await assert.rejects(
        () => request({ url: url + '/large', max_bytes: 32 }),
        /exceeds max_bytes/,
      );
      await assert.rejects(() => request({ url: url + '/slow', timeout_ms: 1000 }), /timed out/);
      await assert.rejects(() => request({ url: 'file:///etc/passwd' }), /HTTP/);
      await assert.rejects(() => request({ headers: { X: 'one\r\ntwo' } }));
      await assert.rejects(() => request({ proxy_id: 'does-not-exist' }), /Unknown/);
      const wrong = await m.proxies.save({ ...fields, port: socksPort, password: 'wrong' });
      const before = hits;
      try {
        const failed = await request({ proxy_id: wrong.proxy_id });
        assert.notEqual(failed.status_code, 200);
      } catch (e) {
        assert.match((e as Error).message, /curl failed/);
      }
      assert.equal(
        hits,
        before,
        'Bad proxy authentication must never fall back to the direct destination',
      );
      const instance = await call('create_instance', {
        proxy_id: proxy.proxy_id,
        user_agent: 'SavedProxy/1.0',
      });
      const ids = { instance_id: instance.instance_id, page_id: instance.pages[0].page_id };
      await call('navigate', { ...ids, url });
      await m.proxies.save({ ...fields, port: socksPort, enabled: false }, proxy.proxy_id);
      await assert.rejects(() => request(), /disabled/);
      await assert.rejects(() => call('create_instance', { proxy_id: proxy.proxy_id }), /disabled/);
      await call('navigate', { ...ids, url: url + '/existing' });
      await call('close_instance', { instance_id: instance.instance_id });
      const events = JSON.stringify(await call('get_logs', { limit: 200 }));
      assert.ok(
        !events.includes('line1') && !events.includes('saved-id') && !events.includes('wrong'),
      );
      assert.equal((await m.proxies.list()).length, 3);
      await m.logs.flush();
      assert.ok(!(await readFile(join(dir, 'diagnostics/events.jsonl'), 'utf8')).includes('line1'));
    } finally {
      for (const i of m.instances.values()) await m.close(i.owner, i.id);
      await m.logs.flush();
      await upstream.close(true);
      socks.close();
      destination.closeAllConnections();
      await new Promise<void>((r) => destination.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
