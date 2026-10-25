import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserManager } from '../src/browser.js';
import { config, createSchema } from '../src/config.js';
import { deviceProfileSchema, listDeviceProfiles } from '../src/device-profile.js';
import { userAgentMetadata } from '../src/user-agent.js';

test('profiles validate coherent identity and frozen Mac UA does not invent OS or architecture', () => {
  const profile = listDeviceProfiles()[0].profile;
  assert.ok(createSchema.safeParse({ device_profile: profile }).success);
  assert.ok(
    !createSchema.safeParse({ device_profile: profile, device_profile_id: 'macos-arm-chrome155' })
      .success,
  );
  for (const changes of [
    { client_hints: { ...profile.client_hints, full_version: '156.0.0.0' } },
    { client_hints: { ...profile.client_hints, platform: 'Windows' } },
    { screen: { width: 240, height: 240 } },
    { languages: ['en-US\r\nX-Test: true'] },
    { timezone: 'not-a-timezone' },
    { user_agent: 'CustomAgent/1' },
  ])
    assert.ok(!deviceProfileSchema.safeParse({ ...profile, ...changes }).success);
  const uaOnly = userAgentMetadata({ userAgent: profile.user_agent })!;
  assert.equal(uaOnly.platformVersion, '');
  assert.equal(uaOnly.architecture, '');
});

test(
  'complete profile applies before first script and request across tabs, popups, frames and Worker',
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-profile-'));
    const seen: { path: string; headers: http.IncomingHttpHeaders }[] = [];
    const read = `async()=>({ua:navigator.userAgent,platform:navigator.platform,languages:navigator.languages,cpu:navigator.hardwareConcurrency,hints:navigator.userAgentData?await navigator.userAgentData.getHighEntropyValues(['platformVersion','architecture','bitness','fullVersionList','formFactors']):null})`;
    let base = '';
    const fixture = http.createServer((req, res) => {
      seen.push({ path: req.url!, headers: req.headers });
      res.setHeader(
        'Accept-CH',
        'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch',
      );
      if (req.url === '/worker.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(`(${read})().then(postMessage);`);
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<script>window.first=(${read})();</script>` +
          (req.url === '/main'
            ? `<iframe src="${base.replace('127.0.0.1', 'localhost')}/frame"></iframe><a href="/popup" target="_blank">Popup</a>`
            : ''),
      );
    });
    await new Promise<void>((r) => fixture.listen(0, r));
    base = `http://127.0.0.1:${(fixture.address() as any).port}`;
    const m = new BrowserManager({
      ...config(),
      dataDir: dir,
      recordVideo: false,
      allowPrivate: true,
    });
    await m.init();
    const call = (name: string, args: any = {}) => m.execute('alice', name, args);
    try {
      const profiles = await call('list_device_profiles');
      assert.equal(profiles.length, 2);
      const i = await call('create_instance', { device_profile_id: 'macos-arm-chrome155' });
      const ids = { instance_id: i.instance_id, page_id: i.pages[0].page_id };
      assert.equal(i.browser_mode, 'chromium_new_headless');
      assert.equal(i.viewport.width, 1653);
      assert.equal(i.user_agent_metadata.fullVersion, '155.0.8059.85');
      await call('navigate', { ...ids, url: base + '/main' });
      const p = m.instances.get(i.instance_id)!.pages.get(ids.page_id)!.page;
      const check = (v: any) => {
        assert.equal(v.ua, profiles[0].profile.user_agent);
        assert.equal(v.platform, 'MacIntel');
        assert.deepEqual(v.languages, ['zh', 'en-US', 'en']);
        assert.equal(v.cpu, 18);
        assert.equal(v.hints.platform, 'macOS');
        assert.equal(v.hints.platformVersion, '26.4.1');
        assert.equal(v.hints.architecture, 'arm');
        assert.ok(
          v.hints.fullVersionList.some(
            (b: any) => b.brand === 'Chromium' && b.version === '155.0.8059.85',
          ),
        );
      };
      check(await p.evaluate('window.first'));
      for (const frame of p.frames()) {
        await frame.waitForFunction('window.first');
        check(await frame.evaluate('window.first'));
      }
      const popupPromise = p.waitForEvent('popup');
      await p.getByText('Popup', { exact: true }).click();
      const popup = await popupPromise;
      await popup.waitForLoadState();
      check(await popup.evaluate('window.first'));
      const worker = await p.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const w = new Worker('/worker.js');
            w.onmessage = (e) => {
              w.terminate();
              resolve(e.data);
            };
            w.onerror = (e) => {
              w.terminate();
              reject(new Error(e.message));
            };
          }),
      );
      check(worker);
      const layout = await p.evaluate(() => ({
        screen: [screen.width, screen.height],
        viewport: [innerWidth, innerHeight],
        locale: new Intl.DateTimeFormat().resolvedOptions().locale,
        tz: new Intl.DateTimeFormat().resolvedOptions().timeZone,
        pdf: navigator.pdfViewerEnabled,
        webdriver: navigator.webdriver,
      }));
      assert.deepEqual(layout.screen, [1920, 1080]);
      assert.deepEqual(layout.viewport, [1653, 947]);
      assert.equal(layout.locale, 'en-US');
      assert.equal(layout.tz, 'Asia/Shanghai');
      assert.equal(layout.pdf, true);
      assert.equal(layout.webdriver, true);
      await p.evaluate('fetch("/echo")');
      for (const path of ['/main', '/popup', '/frame', '/echo']) {
        const r = seen.find((r) => r.path === path)!;
        assert.ok(r);
        assert.equal(r.headers['accept-language'], 'zh,en-US;q=0.9,en;q=0.8');
        assert.match(String(r.headers['sec-ch-ua']), /"Chromium";v="155"/);
      }
      const echo = seen.find((r) => r.path === '/echo')!.headers;
      assert.equal(echo['sec-ch-ua-platform-version'], '"26.4.1"');
      assert.equal(echo['sec-ch-ua-arch'], '"arm"');
      assert.match(String(echo['sec-ch-ua-full-version-list']), /155\.0\.8059\.85/);
      const verified = await call('verify_device_profile', ids);
      assert.ok(
        verified.fields
          .filter((f: any) => f.mode === 'emulated')
          .every((f: any) => f.status === 'match'),
        JSON.stringify(
          verified.fields.filter((f: any) => f.mode === 'emulated' && f.status !== 'match'),
        ),
      );
      assert.equal(verified.fields.find((f: any) => f.field === 'webdriver').status, 'mismatch');
      for (const name of ['canvas_2d', 'audio_processing', 'dedicated_worker', 'pdf_viewer'])
        assert.equal(verified.capabilities.find((c: any) => c.name === name).status, 'passed');
      assert.equal(
        verified.capabilities.find((c: any) => c.name === 'pdf_viewer').method,
        'execution',
      );
      await assert.rejects(m.execute('bob', 'verify_device_profile', ids), {
        code: 'INSTANCE_NOT_FOUND',
      });
      const details = await m.adminInstanceDetails(i.instance_id);
      assert.equal(details.instance.environment?.device_profile?.navigator_platform, 'MacIntel');
      await call('close_instance', { instance_id: i.instance_id });
      const history = await call('inspect_instance', { instance_id: i.instance_id, probe: false });
      assert.equal(
        history.instance.environment.device_verification.summary.mismatched,
        verified.summary.mismatched,
      );
      assert.equal(history.instance.environment.device_profile.name, profiles[0].profile.name);
      const native = await call('create_instance', {});
      assert.equal(native.device_profile, null);
      assert.notEqual(
        (await m.instances.get(native.instance_id)!.context.newPage()).viewportSize()!.width,
        1653,
      );
    } finally {
      await m.shutdown();
      await new Promise<void>((r) => fixture.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
