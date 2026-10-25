import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserManager } from '../src/browser.js';
import { config, createSchema } from '../src/config.js';
import {
  deviceProfileSchema,
  listDeviceProfiles,
  applyProfileUserAgent,
  profileMetadata,
} from '../src/device-profile.js';
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

test('explicit UA replaces all hints while preserving other profile values and leaving templates unchanged', () => {
  const original = listDeviceProfiles()[0].profile;
  const old = structuredClone(original);
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Safari/537.36 Edg/130.0.2849.68';
  const changed = applyProfileUserAgent(original, ua);
  assert.equal(changed.user_agent, ua);
  assert.deepEqual(profileMetadata(changed), userAgentMetadata({ userAgent: ua }));
  const { user_agent, client_hints, ...rest } = changed;
  const { user_agent: oldUa, client_hints: oldHints, ...oldRest } = old;
  assert.deepEqual(rest, oldRest);
  assert.deepEqual(original, old);
  assert.deepEqual(applyProfileUserAgent(original), old);
  const opaque = applyProfileUserAgent(original, 'CustomAgent/1.0');
  assert.equal(opaque.client_hints, null);
  assert.equal(profileMetadata(opaque), undefined);
});

for (const mode of ['profile', 'explicit_ua', 'auto_ua'] as const)
  test(
    `complete profile (${mode}) applies before first script and request across tabs, popups, frames and Worker`,
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
        const override =
          mode === 'profile'
            ? undefined
            : profiles[0].profile.user_agent.replace('155.0.0.0', '130.0.6723.58');
        const major = mode === 'profile' ? '155' : '130';
        const fullVersion = mode === 'profile' ? '155.0.8059.85' : '130.0.6723.58';
        const expectedProfile =
          mode === 'profile'
            ? profiles[0].profile
            : applyProfileUserAgent(profiles[0].profile, override);
        const i = await call('create_instance', {
          ...(mode === 'auto_ua' ? {} : { device_profile_id: 'macos-arm-chrome155' }),
          ...(override ? { user_agent: override } : {}),
        });
        assert.equal(i.device_profile_id, 'macos-arm-chrome155');
        assert.equal(i.device_profile_source, mode === 'auto_ua' ? 'ua_default' : 'explicit_id');
        assert.deepEqual(i.device_profile, expectedProfile);
        const ids = { instance_id: i.instance_id, page_id: i.pages[0].page_id };
        assert.equal(i.browser_mode, 'chromium_new_headless');
        assert.equal(i.viewport.width, 1653);
        assert.equal(i.user_agent_metadata.fullVersion, fullVersion);
        await call('navigate', { ...ids, url: base + '/main' });
        const p = m.instances.get(i.instance_id)!.pages.get(ids.page_id)!.page;
        const check = (v: any) => {
          assert.equal(v.ua, override ?? profiles[0].profile.user_agent);
          assert.equal(v.platform, 'MacIntel');
          assert.deepEqual(v.languages, ['zh', 'en-US', 'en']);
          assert.equal(v.cpu, 18);
          assert.equal(v.hints.platform, 'macOS');
          assert.equal(v.hints.platformVersion, mode === 'profile' ? '26.4.1' : '');
          assert.equal(v.hints.architecture, mode === 'profile' ? 'arm' : '');
          assert.ok(
            v.hints.fullVersionList.some(
              (b: any) => b.brand === 'Chromium' && b.version === fullVersion,
            ),
          );
        };
        check(await p.evaluate('window.first'));
        for (let n = 0; n < 3; n++) check((await call('evaluate', { ...ids, script: read })).value);
        for (const frame of p.frames()) {
          await frame.waitForFunction('window.first');
          check(await frame.evaluate('window.first'));
        }
        const popupPromise = p.waitForEvent('popup');
        await p.getByText('Popup', { exact: true }).click();
        const popup = await popupPromise;
        await popup.waitForLoadState();
        check(await popup.evaluate('window.first'));
        const popupId = [...m.instances.get(i.instance_id)!.pages].find(
          ([, v]) => v.page === popup,
        )![0];
        check(
          (await call('evaluate', { instance_id: i.instance_id, page_id: popupId, script: read }))
            .value,
        );
        await call('close_page', { instance_id: i.instance_id, page_id: popupId });
        check((await call('evaluate', { ...ids, script: read })).value);
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
          assert.ok(String(r.headers['sec-ch-ua']).includes(`"Chromium";v="${major}"`));
          assert.equal(r.headers['user-agent'], override ?? profiles[0].profile.user_agent);
        }
        const echo = seen.find((r) => r.path === '/echo')!.headers;
        assert.equal(echo['sec-ch-ua-platform-version'], mode === 'profile' ? '"26.4.1"' : '""');
        assert.equal(echo['sec-ch-ua-arch'], mode === 'profile' ? '"arm"' : '""');
        assert.ok(String(echo['sec-ch-ua-full-version-list']).includes(fullVersion));
        assert.deepEqual(
          (await call('get_device_profile', { profile_id: 'macos-arm-chrome155' })).profile,
          profiles[0].profile,
        );
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
        check((await call('evaluate', { ...ids, script: read })).value);
        await assert.rejects(m.execute('bob', 'verify_device_profile', ids), {
          code: 'INSTANCE_NOT_FOUND',
        });
        const details = await m.adminInstanceDetails(i.instance_id);
        assert.equal(details.instance.environment?.device_profile?.navigator_platform, 'MacIntel');
        await call('close_instance', { instance_id: i.instance_id });
        const history = await call('inspect_instance', {
          instance_id: i.instance_id,
          probe: false,
        });
        assert.equal(
          history.instance.environment.device_verification.summary.mismatched,
          verified.summary.mismatched,
        );
        assert.equal(history.instance.environment.device_profile.name, profiles[0].profile.name);
        assert.deepEqual(history.instance.environment.device_profile, expectedProfile);
        assert.equal(
          history.instance.environment.user_agent,
          override ?? profiles[0].profile.user_agent,
        );
        assert.equal(history.instance.environment.user_agent_metadata.fullVersion, fullVersion);
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

test(
  'CDP watchdog reuse preserves a foreign platform through evaluate, verification and reload',
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-profile-watchdog-'));
    const server = http.createServer((q, r) => {
      r.setHeader('Content-Type', 'text/html');
      r.end('<meta name="viewport" content="width=device-width,initial-scale=1"><h1>Fixture</h1>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const m = new BrowserManager({
      ...config(),
      dataDir: dir,
      recordVideo: false,
      allowPrivate: true,
    });
    await m.init();
    const call = (name: string, args: any) => m.execute('alice', name, args);
    try {
      const original = listDeviceProfiles()[1].profile;
      const override = original.user_agent.replace('155.0.0.0', '130.0.6723.58');
      const i = await call('create_instance', { device_profile: original, user_agent: override });
      assert.equal(i.device_profile_source, 'inline');
      assert.equal(i.user_agent, override);
      assert.equal(i.user_agent_metadata.fullVersion, '130.0.6723.58');
      const ids = { instance_id: i.instance_id, page_id: i.pages[0].page_id };
      await call('navigate', { ...ids, url: `http://127.0.0.1:${(server.address() as any).port}` });
      const entry = m.instances.get(i.instance_id)!.pages.get(ids.page_id)!;
      for (let n = 0; n < 3; n++)
        assert.equal(
          (await call('evaluate', { ...ids, script: 'navigator.platform' })).value,
          'Linux armv81',
        );
      assert.equal(entry.watchdogs.size, 1);
      const report = await call('verify_device_profile', ids);
      assert.equal(
        report.fields.find((f: any) => f.scope === 'page' && f.field === 'navigator_platform')
          .status,
        'match',
      );
      assert.equal(
        (await call('evaluate', { ...ids, script: 'navigator.platform' })).value,
        'Linux armv81',
      );
      await call('navigate', { ...ids, action: 'reload' });
      assert.equal(
        (await call('evaluate', { ...ids, script: 'navigator.platform' })).value,
        'Linux armv81',
      );
      const afterReload = await call('verify_device_profile', ids);
      assert.ok(
        afterReload.fields
          .filter((f: any) => f.mode === 'emulated')
          .every((f: any) => f.status === 'match'),
        JSON.stringify(
          afterReload.fields.filter((f: any) => f.mode === 'emulated' && f.status !== 'match'),
        ),
      );
      await call('close_instance', { instance_id: i.instance_id });
      assert.equal(entry.watchdogs.size, 0);
    } finally {
      await m.shutdown();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
