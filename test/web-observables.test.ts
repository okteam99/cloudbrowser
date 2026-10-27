import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserManager } from '../src/browser.js';
import { config } from '../src/config.js';
import { deviceProfileSchema, listDeviceProfiles } from '../src/device-profile.js';

const observables = {
  navigator: { device_memory: 16, webdriver: false, pdf_viewer_enabled: true, max_touch_points: 0 },
  screen: {
    available_width: 1700,
    available_height: 1000,
    color_depth: 30,
    pixel_depth: 30,
    orientation: 'landscape-primary',
    orientation_angle: 0,
  },
  window: { outer_width: 1653, outer_height: 1034 },
  media: { 'prefers-color-scheme: dark': true, 'color-gamut: p3': true },
  connection: { type: null, effective_type: '4g', downlink: 10, rtt: 300, save_data: false },
  battery: {
    status: 'measured',
    value: { charging: false, level: 0.2, charging_time: null, discharging_time: 4740 },
  },
  voices: [{ name: 'Reference voice', lang: 'en-US', local_service: true, default: true }],
  web_share: true,
  hardware: {
    bluetooth: {
      api_supported: true,
      availability: { status: 'reported', value: true },
      granted_devices: { status: 'unsupported' },
    },
    media_devices: {
      api_supported: true,
      enumeration: {
        status: 'reported',
        value: {
          count: 3,
          truncated: false,
          devices: [
            { kind: 'audioinput', label: null, device_id: null, group_id: null },
            { kind: 'videoinput', label: null, device_id: null, group_id: null },
            { kind: 'audiooutput', label: null, device_id: null, group_id: null },
          ],
        },
      },
    },
    usb: {
      api_supported: true,
      granted_devices: { status: 'reported', value: { count: 0, truncated: false, devices: [] } },
    },
    hid: {
      api_supported: true,
      granted_devices: { status: 'reported', value: { count: 0, truncated: false, devices: [] } },
    },
    serial: {
      api_supported: true,
      granted_ports: { status: 'reported', value: { count: 0, truncated: false, devices: [] } },
    },
    permissions: {
      camera: { status: 'reported', value: { state: 'prompt' } },
      'speaker-selection': {
        status: 'unavailable',
        error_name: 'TypeError',
        error: 'Reference speaker selection unavailable',
      },
    },
    audio_output: {
      parameters: {
        status: 'reported',
        value: {
          sample_rate: 44100,
          state: 'suspended',
          base_latency_seconds: 0.0058,
          output_latency_seconds: 0,
          max_channels: 2,
          channel_count: 2,
          audible_output: false,
        },
      },
    },
  },
};

test('observable profiles validate bounded outcomes and do not infer behavior from missing measurements', () => {
  const base = listDeviceProfiles()[0].profile;
  assert.ok(deviceProfileSchema.safeParse({ ...base, web_observables: observables }).success);
  for (const change of [
    { navigator: { device_memory: -1 } },
    { hardware: { bluetooth: { api_supported: true, availability: { status: 'timeout' } } } },
    {
      hardware: {
        usb: {
          api_supported: true,
          granted_devices: {
            status: 'reported',
            value: { count: 4, truncated: false, devices: [] },
          },
        },
      },
    },
    { unexpected: true },
  ])
    assert.equal(
      deviceProfileSchema.safeParse({ ...base, web_observables: change }).success,
      false,
    );
});

test('web-visible simulation is installed before page/frame/popup/worker code and preserves query semantics without hardware I/O', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloudbrowser-observables-'));
  const fixture = http.createServer((req, res) => {
    if (req.url === '/worker.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(
        'postMessage({memory:navigator.deviceMemory,platform:navigator.platform,rtt:navigator.connection.rtt})',
      );
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      '<!doctype html><style>body{--test:light;--gamut:srgb}@media(prefers-color-scheme:dark){body{--test:dark}}@media(color-gamut:p3){body{--gamut:p3}}</style><script>window.first={memory:navigator.deviceMemory,webdriver:navigator.webdriver,bluetooth:!!navigator.bluetooth}</script><body>fixture',
    );
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(fixture.address() as any).port}`;
  const manager = new BrowserManager({
    ...config(),
    dataDir: dir,
    recordVideo: false,
    allowPrivate: true,
  });
  await manager.init();
  try {
    const profile = deviceProfileSchema.parse({
      ...listDeviceProfiles()[0].profile,
      web_observables: observables,
    });
    const instance = await manager.execute('alice', 'create_instance', { device_profile: profile });
    const ids = { instance_id: instance.instance_id, page_id: instance.pages[0].page_id };
    await manager.execute('alice', 'navigate', { ...ids, url });
    const page = manager.instances.get(instance.instance_id)!.pages.get(ids.page_id)!.page;
    const inspect = async () =>
      page.evaluate(async () => {
        const n = navigator as any;
        const p = n.bluetooth.getAvailability();
        const permission = await n.permissions.query({ name: 'camera' });
        let events = 0;
        permission.addEventListener('change', () => events++);
        permission.dispatchEvent(new Event('change'));
        const media = await n.mediaDevices.enumerateDevices();
        const battery = await n.getBattery();
        const audio = new AudioContext();
        const audioBefore = { sampleRate: audio.sampleRate, baseLatency: audio.baseLatency };
        await audio.close();
        let rejected = '',
          typeError = '',
          illegal = '';
        try {
          await n.bluetooth.requestDevice({ acceptAllDevices: true });
        } catch (e: any) {
          rejected = e.name;
        }
        try {
          await n.permissions.query({ name: 'speaker-selection' });
        } catch (e: any) {
          typeError = e.name + ':' + e.message;
        }
        try {
          n.bluetooth.getAvailability.call({});
        } catch (e: any) {
          illegal = e.name;
        }
        return {
          first: (window as any).first,
          promise: p instanceof Promise,
          bluetooth: await p,
          noGetDevices: !('getDevices' in n.bluetooth),
          sameObject: n.bluetooth === n.bluetooth,
          permission: {
            state: permission.state,
            tag: Object.prototype.toString.call(permission),
            events,
          },
          media: media.map((d: any) => ({ ...d.toJSON(), tag: Object.prototype.toString.call(d) })),
          usb: await n.usb.getDevices(),
          hid: await n.hid.getDevices(),
          ports: await n.serial.getPorts(),
          battery: {
            charging: battery.charging,
            level: battery.level,
            time: battery.chargingTime === Infinity,
          },
          audio: audioBefore,
          audioClosed: audio.state,
          voice: speechSynthesis.getVoices()[0].name,
          outer: outerHeight,
          depth: screen.colorDepth,
          available: screen.availHeight,
          css: getComputedStyle(document.body).getPropertyValue('--test'),
          gamut: getComputedStyle(document.body).getPropertyValue('--gamut'),
          rejected,
          typeError,
          illegal,
        };
      });
    const actual = await inspect();
    assert.deepEqual(actual.first, { memory: 16, webdriver: false, bluetooth: true });
    assert.equal(actual.promise, true);
    assert.equal(actual.bluetooth, true);
    assert.equal(actual.noGetDevices, true);
    assert.equal(actual.sameObject, true);
    assert.deepEqual(actual.permission, {
      state: 'prompt',
      tag: '[object PermissionStatus]',
      events: 1,
    });
    assert.deepEqual(
      actual.media.map((d) => d.kind),
      ['audioinput', 'videoinput', 'audiooutput'],
    );
    assert.ok(
      actual.media.every(
        (d) =>
          d.label === '' &&
          d.deviceId === '' &&
          ['[object MediaDeviceInfo]', '[object InputDeviceInfo]'].includes(d.tag),
      ),
    );
    assert.deepEqual([actual.usb, actual.hid, actual.ports], [[], [], []]);
    assert.deepEqual(actual.battery, { charging: false, level: 0.2, time: true });
    assert.deepEqual(actual.audio, { sampleRate: 44100, baseLatency: 0.0058 });
    assert.equal(actual.audioClosed, 'closed');
    assert.equal(actual.voice, 'Reference voice');
    assert.equal(actual.outer, 1034);
    assert.equal(actual.depth, 30);
    assert.equal(actual.available, 1000);
    assert.equal(actual.css, 'dark');
    assert.equal(actual.gamut, 'p3');
    assert.equal(actual.rejected, 'NotSupportedError');
    assert.equal(actual.typeError, 'TypeError:Reference speaker selection unavailable');
    assert.equal(actual.illegal, 'TypeError');
    await page.evaluate(() => {
      const f = document.createElement('iframe');
      f.src = '/frame';
      document.body.append(f);
    });
    await page.waitForFunction(
      () => (document.querySelector('iframe')?.contentWindow as any)?.first,
    );
    assert.equal(await page.frames()[1].evaluate(() => (navigator as any).deviceMemory), 16);
    const popupPromise = page.waitForEvent('popup');
    await page.evaluate(() => window.open('/popup'));
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal((await popup.evaluate(() => (window as any).first)).webdriver, false);
    const worker = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const w = new Worker('/worker.js');
          w.onmessage = (e) => {
            w.terminate();
            resolve(e.data);
          };
        }),
    );
    assert.deepEqual(worker, { memory: 16, platform: profile.navigator_platform, rtt: 300 });
    await manager.execute('alice', 'navigate', { ...ids, action: 'reload' });
    assert.equal((await inspect()).bluetooth, true);
    const native = await manager.execute('bob', 'create_instance', {});
    const nativePage = manager.instances.get(native.instance_id)!.pages.values().next().value!.page;
    assert.equal(await nativePage.evaluate(() => navigator.webdriver), true);
    await manager.execute('alice', 'close_instance', { instance_id: instance.instance_id });
    const history = await manager.execute('alice', 'get_instance_details', {
      instance_id: instance.instance_id,
    });
    assert.deepEqual(
      history.instance.environment.device_profile.web_observables,
      profile.web_observables,
    );
  } finally {
    await manager.shutdown();
    await new Promise<void>((r) => fixture.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
