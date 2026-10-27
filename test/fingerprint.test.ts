import test from 'node:test';
import assert from 'node:assert/strict';
import http, { type IncomingMessage } from 'node:http';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { fingerprintRequest } from '../src/fingerprint.js';
import { config } from '../src/config.js';
import { BrowserManager } from '../src/browser.js';
import { startWeb } from '../dist/web.js';

test('public request evidence excludes secrets and trusts Cloudflare IP only on the configured local tunnel boundary', () => {
  const request = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      'cf-connecting-ip': '203.0.113.9',
      'user-agent': 'browser-test',
      'sec-ch-ua': '"Chromium";v="156"',
      authorization: 'Bearer secret',
      cookie: 'session=secret',
      'x-forwarded-for': '198.51.100.7',
    },
    url: '/fingerprint/request?access_token=secret',
  } as unknown as IncomingMessage;
  const direct = fingerprintRequest(request, { quickTunnel: false });
  assert.equal(direct.ip, '127.0.0.1');
  assert.equal(direct.ip_source, 'socket_peer');
  const tunnel = fingerprintRequest(request, { quickTunnel: true });
  assert.equal(tunnel.ip, '203.0.113.9');
  assert.equal(tunnel.ip_source, 'cloudflare_tunnel_header');
  assert.deepEqual(Object.keys(tunnel.headers), ['user-agent', 'sec-ch-ua']);
  assert.ok(!JSON.stringify(tunnel).includes('secret'));
  request.socket.remoteAddress = '198.51.100.5';
  assert.equal(fingerprintRequest(request, { quickTunnel: true }).ip, '198.51.100.5');
  request.socket.remoteAddress = '::ffff:127.0.0.1';
  request.headers['cf-connecting-ip'] = 'not-an-ip';
  assert.equal(
    fingerprintRequest(request, { cfTunnelToken: 'private-token', quickTunnel: false }).ip,
    '127.0.0.1',
  );
});

test('public fingerprint works without login, stays same-origin, exports JSON and observes a configured cloud browser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloudbrowser-fingerprint-'));
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as any).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const base = `http://127.0.0.1:${port}/browser`;
  const cfg = {
    ...config(),
    dataDir: dir,
    webPort: port,
    webPassword: 'fingerprint-test-password',
    baseUrl: base,
    quickTunnel: false,
    cfTunnelToken: undefined,
    recordVideo: false,
    allowPrivate: true,
  };
  const manager = new BrowserManager(cfg);
  await manager.init();
  const server = (await startWeb(manager, cfg, async () => {
    throw new Error('Public page must not invoke tools');
  }))!;
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const pageResponse = await fetch(base + '/fingerprint?access_token=never-reflect-this', {
      headers: {
        Authorization: 'Bearer never-reflect-this',
        Cookie: 'private-cookie=never-reflect-this',
      },
    });
    assert.equal(pageResponse.status, 200);
    assert.ok(pageResponse.headers.get('accept-ch')?.includes('Sec-CH-UA-Full-Version-List'));
    assert.equal(pageResponse.headers.get('cache-control'), 'no-store');
    const html = await pageResponse.text();
    assert.ok(!html.includes('never-reflect-this'));
    assert.ok(html.includes('设备指纹检测'));
    assert.equal((await fetch(base + '/fingerprint', { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(base + '/fingerprint/request', { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(base + '/fingerprint/request', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/api/connection')).status, 401);
    assert.equal((await fetch(base + '/api/settings')).status, 401);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    await context.addCookies([{ name: 'private-cookie', value: 'should-not-be-sent', url: base }]);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const origins = new Set<string>();
    const errors: string[] = [];
    let requestCookie: string | undefined;
    page.on('request', (r) => {
      origins.add(new URL(r.url()).origin);
      if (r.url().endsWith('/fingerprint/request')) requestCookie = r.headers().cookie;
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/fingerprint');
    const reportElement = page.locator('#fingerprint-report');
    await reportElement.waitFor({ state: 'attached' });
    const report = JSON.parse((await reportElement.textContent())!);
    assert.deepEqual(errors, []);
    assert.deepEqual([...origins], [new URL(base).origin]);
    assert.equal(requestCookie, undefined);
    assert.equal(report.navigator.user_agent, await page.evaluate(() => navigator.userAgent));
    assert.equal(report.request.value.headers['user-agent'], report.navigator.user_agent);
    assert.equal(report.worker.status, 'measured');
    assert.equal(report.worker.value.platform, report.navigator.platform);
    assert.equal(report.intl.timeZone, 'Asia/Shanghai');
    assert.match(report.canvas.value.hash, /^[a-f0-9]{64}$/);
    assert.match(report.audio.value.hash, /^[a-f0-9]{64}$/);
    assert.equal(report.webrtc.tested, false);
    assert.ok(!JSON.stringify(report).includes('should-not-be-sent'));
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载 JSON' }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), report);
    if (process.env.FINGERPRINT_SCREENSHOT_DIR) {
      await mkdir(process.env.FINGERPRINT_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.FINGERPRINT_SCREENSHOT_DIR, 'desktop.png') });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '重新检测' }).click();
    await page.waitForFunction(
      () =>
        JSON.parse(document.querySelector('#fingerprint-report')!.textContent!).window
          .inner_width === 390,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    if (process.env.FINGERPRINT_SCREENSHOT_DIR)
      await page.screenshot({ path: join(process.env.FINGERPRINT_SCREENSHOT_DIR, 'mobile.png') });
    assert.equal(manager.instances.size, 0);
    const instance = await manager.execute('alice', 'create_instance', {
      device_profile_id: 'android-pixel8-chrome155',
    });
    const ids = { instance_id: instance.instance_id, page_id: instance.pages[0].page_id };
    await manager.execute('alice', 'navigate', { ...ids, url: base + '/fingerprint' });
    const cloudPage = manager.instances.get(instance.instance_id)!.pages.get(ids.page_id)!.page;
    await cloudPage.locator('#fingerprint-report').waitFor({ state: 'attached' });
    const cloudReport = (
      await manager.execute('alice', 'evaluate', {
        ...ids,
        script: "JSON.parse(document.querySelector('#fingerprint-report').textContent)",
      })
    ).value;
    assert.equal(cloudReport.navigator.user_agent, instance.user_agent);
    assert.equal(cloudReport.request.value.headers['user-agent'], instance.user_agent);
    assert.equal(cloudReport.navigator.client_hints.high.platform, 'Android');
    assert.equal(cloudReport.worker.value.platform, instance.device_profile.navigator_platform);
    await manager.execute('alice', 'close_instance', { instance_id: instance.instance_id });
    const guide = await (await fetch(base + '/docs/agent-guide.md')).text();
    assert.ok(guide.includes('/fingerprint'));
    assert.ok(!guide.includes('Chrome/130.0.0.0'));
  } finally {
    await browser.close();
    await manager.shutdown();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
