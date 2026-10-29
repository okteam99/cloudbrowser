import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { BrowserManager } from '../src/browser.js';
import { config, createSchema } from '../src/config.js';

test('partial device overrides retain omission through repeated MCP/API validation', () => {
  for (const mobile of [{ touch: false }, { device_scale_factor: 1 }, { enabled: false }, {}]) {
    const parsed = createSchema.parse(createSchema.parse({ mobile }));
    assert.deepEqual(parsed.mobile, mobile);
    assert.equal(Object.hasOwn(parsed, 'viewport'), false);
  }
});

test('explicit viewport and individual mobile fields reach the browser, screenshots and history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-device-overrides-'));
  const manager = new BrowserManager({
    ...config(),
    dataDir: dir,
    recordVideo: false,
    allowPrivate: true,
  });
  const server = http.createServer((req, res) => {
    res.setHeader(
      'Content-Type',
      req.url === '/worker.js'
        ? 'text/javascript'
        : req.url === '/echo'
          ? 'application/json'
          : 'text/html',
    );
    if (req.url === '/worker.js')
      res.end(
        'postMessage({ua:navigator.userAgent,platform:navigator.platform,hints:navigator.userAgentData?.toJSON()})',
      );
    else if (req.url === '/echo') res.end(JSON.stringify(req.headers));
    else
      res.end(
        '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><button style="width:100px;height:100px" onclick="window.clicked=true" ontouchstart="window.touched=true">Test</button>',
      );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  await manager.init();
  const mac = manager.deviceProfiles.get('macos-standard').profile;
  const phone = manager.deviceProfiles.get('iphone-standard').profile;
  const desktopUa = mac.user_agent.replace('Chrome/155.0.0.0', 'Chrome/156.0.8078.4');
  const cases = [
    {
      raw: { device_profile_id: 'macos-standard', viewport: { width: 1440, height: 900 } },
      size: [1440, 900],
      mobile: [false, false, 2],
    },
    {
      raw: { device_profile_id: 'iphone-standard', mobile: { touch: false } },
      size: [420, 716],
      mobile: [true, false, 3],
    },
    {
      raw: { device_profile_id: 'iphone-standard', mobile: { device_scale_factor: 1 } },
      size: [420, 716],
      mobile: [true, true, 1],
    },
    {
      raw: { device_profile_id: 'iphone-standard', mobile: { enabled: false } },
      size: [420, 716],
      mobile: [false, true, 3],
    },
    {
      raw: {
        user_agent: desktopUa,
        viewport: { width: 1300, height: 800 },
        mobile: { touch: true },
      },
      size: [1300, 800],
      mobile: [false, true, 2],
    },
    {
      raw: {
        device_profile: phone,
        viewport: { width: 1440, height: 1000 },
        mobile: { device_scale_factor: 1, enabled: false },
      },
      size: [1440, 1000],
      mobile: [false, true, 1],
    },
    {
      raw: { device_profile_id: 'iphone-standard', mobile: {} },
      size: [420, 716],
      mobile: [true, true, 3],
    },
    {
      raw: {
        device_profile_id: 'macos-standard',
        user_agent: desktopUa.replace(
          'Macintosh; Intel Mac OS X 10_15_7',
          'Windows NT 10.0; Win64; x64',
        ),
      },
      size: [1653, 913],
      mobile: [false, false, 2],
    },
    { raw: {}, size: [1280, 720], mobile: [false, false, 1] },
    { raw: { mobile: { touch: false } }, size: [1280, 720], mobile: [true, false, 1] },
  ];
  try {
    for (const { raw, size, mobile } of cases) {
      const i = await manager.execute(
        'qa',
        'create_instance',
        createSchema.parse(createSchema.parse(raw)),
      );
      const label = JSON.stringify(raw);
      assert.deepEqual(i.viewport, { width: size[0], height: size[1] }, label);
      assert.deepEqual(
        i.mobile,
        { enabled: mobile[0], touch: mobile[1], device_scale_factor: mobile[2] },
        label,
      );
      const ids = { instance_id: i.instance_id, page_id: i.pages[0].page_id };
      await manager.execute('qa', 'navigate', { ...ids, url: base });
      const page = manager.instances.get(i.instance_id)!.pages.get(ids.page_id)!.page;
      const actual = await page.evaluate(async () => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        touch: navigator.maxTouchPoints,
        coarse: matchMedia('(pointer: coarse)').matches,
        fine: matchMedia('(pointer: fine)').matches,
        hover: matchMedia('(hover: hover)').matches,
        screen: [screen.width, screen.height],
        available: [screen.availWidth, screen.availHeight],
        outer: [outerWidth, outerHeight],
        ua: navigator.userAgent,
        headers: await (await fetch('/echo')).json(),
      }));
      assert.deepEqual([actual.width, actual.height], size, label);
      assert.equal(actual.dpr, mobile[2], label);
      assert.equal(actual.touch > 0, mobile[1], label);
      assert.equal(actual.coarse, mobile[1], label);
      assert.equal(actual.fine, !mobile[1], label);
      assert.equal(actual.hover, !mobile[1], label);
      const pixels = await sharp(await page.screenshot()).metadata();
      assert.deepEqual(
        [pixels.width, pixels.height],
        size.map((n) => n * Number(mobile[2])),
        label,
      );
      if (mobile[1]) {
        await page.touchscreen.tap(40, 40);
        assert.equal(await page.evaluate('window.touched'), true, label);
      } else {
        await assert.rejects(page.touchscreen.tap(40, 40), /hasTouch/);
        await manager.execute('qa', 'pointer', { ...ids, action: 'click', x: 40, y: 40 });
        assert.equal(await page.evaluate('window.clicked'), true, label);
      }
      if ('device_profile' in raw) {
        assert.deepEqual(actual.screen, size);
        assert.deepEqual(actual.available, size);
        assert.deepEqual(actual.outer, size);
        assert.equal(i.configuration_sources.screen, 'expanded_for_viewport');
      }
      if ('user_agent' in raw) {
        assert.equal(actual.ua, raw.user_agent);
        assert.equal(actual.headers['user-agent'], raw.user_agent);
        if (raw.user_agent.includes('Windows')) {
          assert.equal(i.device_profile.navigator_platform, 'MacIntel');
          assert.equal(i.user_agent_metadata.platform, 'Windows');
          assert.ok(i.warnings.some((w: string) => w.includes('operating system differs')));
        }
        assert.match(actual.headers['sec-ch-ua'], /156/);
        const worker: any = await page.evaluate(
          () =>
            new Promise((resolve) => {
              const w = new Worker('/worker.js');
              w.onmessage = (e) => {
                w.terminate();
                resolve(e.data);
              };
            }),
        );
        assert.equal(worker.ua, raw.user_agent);
        assert.ok(
          worker.hints.brands.some((b: any) => b.brand === 'Chromium' && b.version === '156'),
        );
      }
      if (i.device_profile) {
        assert.deepEqual(i.device_profile.viewport, i.viewport);
        assert.equal(i.device_profile.touch, mobile[1]);
        assert.equal(i.device_profile.device_scale_factor, mobile[2]);
      }
      await manager.execute('qa', 'close_instance', { instance_id: i.instance_id });
      const history = await manager.execute('qa', 'get_instance_details', {
        instance_id: i.instance_id,
      });
      assert.deepEqual(history.instance.properties.viewport, i.viewport);
      assert.deepEqual(history.instance.properties.mobile, i.mobile);
      assert.deepEqual(history.instance.properties.configuration_sources, i.configuration_sources);
    }
    assert.deepEqual(manager.deviceProfiles.get('macos-standard').profile, mac);
    assert.deepEqual(manager.deviceProfiles.get('iphone-standard').profile, phone);
  } finally {
    await manager.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
