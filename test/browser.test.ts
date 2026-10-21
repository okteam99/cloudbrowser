import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { socksFixture } from './socks-fixture.js';
import { Server } from 'proxy-chain';
import { BrowserManager } from '../src/browser.js';
import { config } from '../src/config.js';
import { createGateway, NetworkPolicy } from '../src/network.js';

const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture</title><input aria-label="Name"><button onclick="document.querySelector('#result').textContent=document.querySelector('input').value">Submit</button><div id="result"></div><button onclick="document.querySelector('#result').textContent=confirm('Continue?')?'accepted':'dismissed'">Ask</button><a href="/popup" target="_blank">New page</a><a href="/download">Download</a><input type="file" aria-label="Upload"><iframe src="/frame"></iframe>`;
test('real Chromium: device, isolation, interaction, popup, iframe, download, upload, ownership', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-test-'));
  const server = http.createServer((req, res) => {
    if (req.url === '/download') {
      res.setHeader('Content-Disposition', 'attachment; filename="sample.txt"');
      res.end('download evidence');
    } else if (req.url === '/ip') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ip: '127.0.0.1', ua: req.headers['user-agent'] }));
    } else if (req.url === '/frame') res.end('<button>Frame button</button>');
    else if (req.url === '/popup') res.end('<title>Popup</title><h1>Popup content</h1>');
    else {
      res.setHeader('content-type', 'text/html');
      res.end(html);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const url = `http://127.0.0.1:${port}`;
  const m = new BrowserManager({ ...config(), dataDir: dir, allowPrivate: true, maxInstances: 3 });
  await m.init();
  const call = (n: string, a: any) => m.execute('alice', n, a);
  try {
    const i = await call('create_instance', {
      user_agent: 'TestAndroid/1.0',
      viewport: { width: 412, height: 915 },
      mobile: { enabled: true, touch: true, device_scale_factor: 2 },
    });
    assert.equal(i.actual.user_agent, 'TestAndroid/1.0');
    assert.equal(i.actual.viewport.width, 412);
    assert.ok(i.actual.touch_points > 0);
    const ids = { instance_id: i.instance_id, page_id: i.pages[0].page_id };
    await call('navigate', { ...ids, action: 'goto', url });
    await call('interact', {
      ...ids,
      action: 'fill',
      target: { css: 'input[aria-label="Name"]' },
      value: 'Alice',
    });
    await call('interact', { ...ids, action: 'click', target: { role: 'button', name: 'Submit' } });
    const snap = await call('snapshot', { ...ids, limit: 80 });
    assert.match(snap.tree, /Alice/);
    const dialog = await call('interact', {
      ...ids,
      action: 'click',
      target: { role: 'button', name: 'Ask' },
    });
    assert.equal(dialog.pending_dialog.type, 'confirm');
    await call('handle_dialog', { ...ids, accept: true });
    assert.match((await call('snapshot', { ...ids, limit: 80 })).tree, /accepted/);
    assert.match(
      (await call('snapshot', { ...ids, frame: 'iframe', limit: 10 })).tree,
      /Frame button/,
    );
    await call('interact', { ...ids, action: 'click', target: { role: 'link', name: 'New page' } });
    let pages: any[] = [];
    for (let n = 0; n < 30; n++) {
      pages = await call('list_pages', { instance_id: i.instance_id });
      if (pages.length === 2 && pages.some((p) => p.title === 'Popup')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(pages.length, 2);
    assert.ok(pages.some((p) => p.title === 'Popup'));
    await call('interact', { ...ids, action: 'click', target: { role: 'link', name: 'Download' } });
    let downloads: any[] = [];
    for (let n = 0; n < 50; n++) {
      downloads = await call('list_downloads', { instance_id: i.instance_id });
      if (downloads[0]?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(downloads[0].status, 'completed');
    const artifact = await call('get_artifact', {
      artifact_id: downloads[0].artifact.id,
      offset: 0,
      length: 100,
    });
    assert.equal(Buffer.from(artifact.data_base64, 'base64').toString(), 'download evidence');
    await assert.rejects(
      () => m.execute('mallory', 'get_artifact', { artifact_id: artifact.id }),
      /Unknown/,
    );
    await call('upload_file', {
      ...ids,
      target: { css: 'input[type=file]' },
      artifact_id: artifact.id,
    });
    const env = await call('verify_environment', {
      instance_id: i.instance_id,
      check_url: url + '/ip',
    });
    assert.equal(env.observed_ip, '127.0.0.1');
    const metadata = await call('get_instance', { instance_id: i.instance_id });
    assert.equal(metadata.egress.ip, '127.0.0.1');
    assert.equal(metadata.egress.source, 'instance_check');
    assert.ok(metadata.egress.checked_at);
    assert.match(env.response, /TestAndroid/);
    const screen = await call('screenshot', { ...ids, full_page: false });
    assert.equal(screen.mime, 'image/png');
    const i2 = await call('create_instance', {});
    assert.notEqual(i2.instance_id, i.instance_id);
    assert.equal(i2.user_agent, i2.actual.user_agent);
    assert.match(i2.user_agent, /Mozilla/);
    assert.equal(i2.egress.ip, null);
    await m.instances
      .get(i.instance_id)!
      .context.addCookies([{ name: 'secret', value: 'one', url }]);
    assert.equal((await m.instances.get(i2.instance_id)!.context.cookies()).length, 0);
    await assert.rejects(
      () => m.execute('mallory', 'get_instance', { instance_id: i.instance_id }),
      /Unknown/,
    );
    await call('close_instance', { instance_id: i.instance_id });
    assert.equal(
      (await call('get_artifact', { artifact_id: screen.id, offset: 0, length: 10 })).size,
      screen.size,
    );
  } finally {
    await m.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('authenticated HTTP and SOCKS5 proxies work; broken upstream never falls back direct', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-proxy-'));
  let requests = 0,
    httpHits = 0,
    socksHits = 0;
  const fixture = http.createServer((req, res) => {
    requests++;
    res.setHeader('content-type', 'application/json');
    res.end('{"ip":"127.0.0.1"}');
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(fixture.address() as any).port}`;
  const upstream = new Server({
    host: '127.0.0.1',
    port: 0,
    prepareRequestFunction: ({ username, password }) => {
      httpHits++;
      return { requestAuthentication: username !== 'user' || password !== 'pass' };
    },
  });
  await upstream.listen();
  const sf = socksFixture(() => {
    socksHits++;
  });
  const s = sf.server;
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const m = new BrowserManager({ ...config(), dataDir: dir, allowPrivate: true });
  await m.init();
  try {
    for (const proxy of [
      { server: `http://127.0.0.1:${upstream.port}`, username: 'user', password: 'pass' },
      {
        server: `socks5://127.0.0.1:${(s.address() as any).port}`,
        username: 'user',
        password: 'pass',
      },
    ]) {
      const r = await m.execute('a', 'check_proxy', { proxy, check_url: url });
      assert.equal(r.observed_ip, '127.0.0.1');
      // Verify the CONNECT tunnel used by HTTPS, in addition to ordinary HTTP forwarding.
      const gateway = await createGateway(
        new NetworkPolicy({ allowPrivate: true, allowedHosts: [] }),
        proxy,
      );
      try {
        const tunneled = await new Promise<string>((resolve, reject) => {
          const req = http.request({
            host: '127.0.0.1',
            port: gateway.port,
            method: 'CONNECT',
            path: `127.0.0.1:${(fixture.address() as any).port}`,
          });
          req.on('connect', (res, socket, head) => {
            if (res.statusCode !== 200) {
              socket.destroy();
              reject(new Error('CONNECT failed'));
              return;
            }
            let body = head.toString();
            socket.on('data', (x) => (body += x));
            socket.on('end', () => resolve(body));
            socket.on('error', reject);
            socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
          });
          req.setTimeout(5000, () => req.destroy(new Error('CONNECT timeout')));
          req.on('error', reject);
          req.end();
        });
        assert.match(tunneled, /127.0.0.1/);
      } finally {
        await gateway.close(true);
      }
    }
    assert.ok(httpHits > 0);
    assert.ok(socksHits > 0);
    const before = requests;
    await assert.rejects(() =>
      m.execute('a', 'check_proxy', {
        proxy: { server: `http://127.0.0.1:${upstream.port}`, username: 'bad', password: 'bad' },
        check_url: url,
      }),
    );
    assert.equal(requests, before, 'Wrong credentials must not reach target directly');
    await assert.rejects(() =>
      m.execute('a', 'check_proxy', { proxy: { server: 'socks5://127.0.0.1:1' }, check_url: url }),
    );
    assert.equal(requests, before, 'Unavailable upstream must not reach target directly');
  } finally {
    await m.shutdown();
    await upstream.close(true);
    sf.close();
    await new Promise<void>((r) => fixture.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
