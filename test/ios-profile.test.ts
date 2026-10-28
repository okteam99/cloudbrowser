import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deviceProfileSchema, profilePlatform } from '../src/device-profile.js';
import { DeviceProfileStore } from '../src/device-profiles.js';
import { BrowserManager } from '../src/browser.js';
import { config } from '../src/config.js';

const ua =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1';
const profile = () =>
  deviceProfileSchema.parse({
    name: 'iOS fixture',
    operating_system: 'iOS',
    user_agent: ua,
    navigator_platform: 'iPhone',
    client_hints: null,
    viewport: { width: 420, height: 716 },
    screen: { width: 420, height: 912 },
    device_scale_factor: 3,
    mobile: true,
    touch: true,
    languages: ['en-SG'],
    http_accept_language: 'en-SG,en-GB;q=0.9,en;q=0.8',
    locale: 'en-SG',
    timezone: 'Asia/Singapore',
    hardware_concurrency: 4,
    expectations: { device_memory: null },
    web_observables: {
      navigator: {
        device_memory: null,
        webdriver: false,
        max_touch_points: 5,
        vendor: 'Apple Computer, Inc.',
      },
    },
  });

test('iOS profiles with absent Client Hints validate, select by OS, reject ambiguous defaults and survive restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-ios-profiles-'));
  try {
    const store = new DeviceProfileStore(dir);
    await store.init();
    const original = store.snapshot();
    const p = profile();
    assert.equal(profilePlatform(p), 'iOS');
    for (const change of [
      { operating_system: 'Android' },
      { http_accept_language: 'en-SG\n' },
      { touch: false },
    ])
      assert.equal(deviceProfileSchema.safeParse({ ...p, ...change }).success, false);
    const entry = { profile_id: 'ios-fixture', enabled: true, is_default: true, profile: p };
    const next = await store.update({
      ...original,
      profiles: [
        ...original.profiles.map((p) =>
          p.profile.operating_system === 'iOS' ? { ...p, is_default: false } : p,
        ),
        entry,
      ],
    });
    assert.equal(store.list({ platform: 'iOS' }).length, 2);
    assert.equal(store.defaultForUserAgent(ua)?.profile_id, entry.profile_id);
    assert.equal(store.get(entry.profile_id).default_for_platform, true);
    assert.throws(() =>
      store.update({
        ...next,
        profiles: [...next.profiles, { ...entry, profile_id: 'duplicate-ios' }],
      }),
    );
    const restored = new DeviceProfileStore(dir);
    await restored.init();
    assert.deepEqual(restored.get(entry.profile_id).profile, p);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('iPhone identity suppresses UA-CH in page, worker and HTTP while preserving separate Accept-Language and five-touch native emulation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-ios-browser-'));
  const requests: { url: string; headers: http.IncomingHttpHeaders }[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url!, headers: req.headers });
    if (req.url === '/no-worker') res.setHeader('Content-Security-Policy', "worker-src 'none'");
    res.setHeader('Accept-CH', 'Sec-CH-UA, Sec-CH-UA-Platform, Sec-CH-UA-Full-Version-List');
    if (req.url === '/worker.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(
        'postMessage({ua:navigator.userAgent,platform:navigator.platform,hints:typeof navigator.userAgentData,memory:typeof navigator.deviceMemory,languages:[...navigator.languages]})',
      );
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<meta name="viewport" content="width=device-width,initial-scale=1"><script>window.first={hints:typeof navigator.userAgentData,memory:typeof navigator.deviceMemory,touch:navigator.maxTouchPoints}</script><body>iOS fixture',
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const manager = new BrowserManager({
    ...config(),
    dataDir: dir,
    recordVideo: false,
    allowPrivate: true,
  });
  await manager.init();
  try {
    const p = profile();
    const catalog = manager.deviceProfiles.snapshot();
    await manager.deviceProfiles.update({
      ...catalog,
      profiles: [
        ...catalog.profiles.map((p) =>
          p.profile.operating_system === 'iOS' ? { ...p, is_default: false } : p,
        ),
        { profile_id: 'ios-fixture', enabled: true, is_default: true, profile: p },
      ],
    });
    for (const mode of ['explicit', 'ua_only']) {
      const i = await manager.execute(
        'alice',
        'create_instance',
        mode === 'explicit' ? { device_profile_id: 'ios-fixture' } : { user_agent: ua },
      );
      const ids = { instance_id: i.instance_id, page_id: i.pages[0].page_id };
      assert.equal(i.device_profile_id, 'ios-fixture');
      assert.equal(i.user_agent_metadata, null);
      assert.equal(i.device_profile_source, mode === 'explicit' ? 'explicit_id' : 'ua_default');
      await manager.execute('alice', 'navigate', { ...ids, url: base });
      const page = manager.instances.get(i.instance_id)!.pages.get(ids.page_id)!.page;
      const values = (
        await manager.execute('alice', 'evaluate', {
          ...ids,
          script:
            '({first:window.first,ua:navigator.userAgent,platform:navigator.platform,vendor:navigator.vendor,languages:[...navigator.languages],touch:navigator.maxTouchPoints,width:innerWidth,height:innerHeight,dpr:devicePixelRatio})',
        })
      ).value;
      assert.deepEqual(values, {
        first: { hints: 'undefined', memory: 'undefined', touch: 5 },
        ua,
        platform: 'iPhone',
        vendor: 'Apple Computer, Inc.',
        languages: ['en-SG'],
        touch: 5,
        width: 420,
        height: 716,
        dpr: 3,
      });
      const worker = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const worker = new Worker('/worker.js');
            worker.onmessage = (e) => {
              worker.terminate();
              resolve(e.data);
            };
          }),
      );
      assert.deepEqual(worker, {
        ua,
        platform: 'iPhone',
        hints: 'undefined',
        memory: 'undefined',
        languages: ['en-SG'],
      });
      await page.evaluate(() =>
        fetch('/custom-language', { headers: { 'Accept-Language': 'fr' } }).then((r) => r.text()),
      );
      await manager.execute('alice', 'navigate', { ...ids, action: 'reload' });
      assert.equal(await page.evaluate(() => navigator.maxTouchPoints), 5);
      if (mode === 'explicit') {
        await manager.execute('alice', 'navigate', { ...ids, url: base + '/no-worker' });
        const report = await manager.execute('alice', 'verify_device_profile', ids);
        assert.equal(
          report.fields.find(
            (field: any) => field.scope === 'worker' && field.field === 'client_hints',
          ).status,
          'unavailable',
        );
      }
      await manager.execute('alice', 'close_instance', { instance_id: i.instance_id });
      const history = await manager.execute('alice', 'get_instance_details', {
        instance_id: i.instance_id,
      });
      assert.equal(history.instance.environment.os, 'iOS');
      assert.equal(history.instance.environment.user_agent_metadata, null);
    }
    assert.ok(requests.length >= 6);
    for (const { url, headers } of requests) {
      assert.equal(headers['user-agent'], ua);
      assert.equal(
        headers['accept-language'],
        url === '/custom-language' ? 'fr' : p.http_accept_language,
      );
      assert.ok(Object.keys(headers).every((key) => !key.startsWith('sec-ch-ua')));
    }
  } finally {
    await manager.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
