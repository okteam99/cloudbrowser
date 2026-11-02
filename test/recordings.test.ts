import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { BrowserManager } from '../src/browser.js';
import { config } from '../src/config.js';
import { RecordingStore } from '../src/recordings.js';
import { recordingSeek } from '../web/recording-timing.js';

test('wall-clock seeking maps dropped frames without compressing the instance timeline', () => {
  const timing = { recorded: true, fps: 4, frame_offsets_ms: [500, 750, 1000, 2250, 2500] };
  assert.deepEqual(recordingSeek(2250, timing), { seconds: 0.75, sampled: 2250, gap: false });
  assert.equal(recordingSeek(1800, timing)?.gap, true);
  assert.equal(recordingSeek(0, timing)?.gap, true);
  assert.equal(recordingSeek(4000, timing)?.gap, true);
  assert.equal(recordingSeek(500, { recorded: false, frame_offsets_ms: [] }), null);
});

test('all tabs record independently at 4 FPS, preserve timing and play after one tab closes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-tab-recordings-'));
  const cfg = { ...config(), dataDir: dir, recordVideo: true };
  assert.equal(cfg.videoFps, 4);
  assert.equal(cfg.videoQuality, 75);
  assert.equal(cfg.videoWidth, 1280);
  assert.equal(cfg.videoHeight, 1280);
  const m = new BrowserManager(cfg);
  await m.init();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const i = await m.execute('qa', 'create_instance', { viewport: { width: 800, height: 600 } });
    const instance = m.instances.get(i.instance_id)!;
    const a = i.pages[0].page_id;
    const b = (await m.execute('qa', 'create_page', { instance_id: i.instance_id })).page_id;
    const pa = instance.pages.get(a)!.page,
      pb = instance.pages.get(b)!.page;
    await pa.setContent(
      '<title>Red background tab</title><body style="background:rgb(255,0,0)">RED</body>',
    );
    await pb.setContent(
      '<title>Blue foreground tab</title><body style="background:rgb(0,0,255)">BLUE</body>',
    );
    await m.execute('qa', 'select_page', { instance_id: i.instance_id, page_id: b });
    await sleep(1400);
    const session = m.recordings.active.get(i.instance_id)!;
    const ra = session.pages.get(a)!,
      rb = session.pages.get(b)!;
    assert.ok(ra.meta.frames >= 4);
    assert.ok(rb.meta.frames >= 4);
    for (const [r, color] of [
      [ra, 0],
      [rb, 2],
    ] as const) {
      const stats = await sharp(r.latest!.bytes).stats();
      assert.ok(stats.channels[color].mean > 240);
      assert.ok(stats.channels[color === 0 ? 2 : 0].mean < 15);
      assert.equal(r.meta.width, 800);
      assert.equal(r.meta.height, 600);
    }
    assert.equal(session.latest?.page_id, b);
    // Inject a slow sample only on the background tab; the other tab must continue independently.
    const original = pa.screenshot.bind(pa);
    let delayed = false;
    pa.screenshot = (async (...args: any[]) => {
      if (!delayed) {
        delayed = true;
        await sleep(1000);
      }
      return original(...args);
    }) as any;
    await sleep(1600);
    pa.screenshot = original;
    await m.execute('qa', 'close_page', { instance_id: i.instance_id, page_id: b });
    const bt = await m.recordings.timeline(rb.meta.id);
    assert.equal(rb.meta.status, 'completed');
    assert.ok(rb.meta.bytes > 0);
    assert.equal(bt.complete, true);
    assert.equal(bt.frame_offsets_ms.length, rb.meta.frames);
    assert.equal(session.latest?.page_id, a);
    const before = ra.meta.frames;
    await sleep(600);
    assert.ok(ra.meta.frames > before);
    assert.equal(rb.meta.frames, bt.frame_offsets_ms.length);
    await m.execute('qa', 'close_instance', { instance_id: i.instance_id });
    const rows = await m.recordings.list();
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map((r) => r.page_id)), new Set([a, b]));
    for (const row of rows) {
      assert.equal(row.status, 'completed');
      assert.equal(row.schema_version, 2);
      assert.equal(row.instance_created_at, i.created_at);
      const timing = await m.recordings.timeline(row.id);
      assert.equal(timing.complete, true);
      assert.ok(timing.frame_offsets_ms.every((v, n, all) => !n || v >= all[n - 1]));
      const viewer = await chromium.launch({ headless: true, channel: 'chromium' });
      try {
        const page = await viewer.newPage();
        const encoded = (await readFile(m.recordings.path(row.id))).toString('base64');
        await page.setContent(`<video muted src="data:video/webm;base64,${encoded}"></video>`);
        await page.waitForFunction(() => document.querySelector('video')!.readyState >= 2);
        const decoded = await page.evaluate(() => {
          const v = document.querySelector('video')!;
          return { width: v.videoWidth, height: v.videoHeight, duration: v.duration };
        });
        assert.equal(decoded.width, 800);
        assert.equal(decoded.height, 600);
        assert.ok(decoded.duration > 1);
      } finally {
        await viewer.close();
      }
    }
    const at = await m.recordings.timeline(ra.meta.id);
    assert.ok(
      at.frame_offsets_ms.some((v, n, all) => n && v - all[n - 1] > 700),
      'Real sampling gap must survive encoding',
    );
    // Legacy metadata remains a separate mixed recording, even while reading newer per-tab records.
    const legacy = { ...rows[0], id: `rec_${randomUUID()}` };
    delete legacy.page_id;
    delete legacy.schema_version;
    delete legacy.timing_available;
    await writeFile(m.recordings.path(legacy.id, 'json'), JSON.stringify(legacy));
    await copyFile(m.recordings.path(rows[0].id), m.recordings.path(legacy.id));
    const restarted = new RecordingStore(cfg);
    await restarted.init();
    assert.equal((await restarted.list()).length, 3);
    assert.equal((await restarted.timeline(legacy.id)).recorded, false);
    assert.deepEqual((await restarted.timeline(ra.meta.id)).frame_offsets_ms, at.frame_offsets_ms);
    const closed = await m.execute('qa', 'get_instance_details', { instance_id: i.instance_id });
    assert.equal(closed.recordings.filter((r: any) => r.page_id).length, 2);
    assert.ok(
      closed.links.recordings.some(
        (r: any) => r.page_id === a && r.timing_url.endsWith('access_token='),
      ),
    );
    restarted.cfg = { ...cfg, retentionHours: 0 };
    await restarted.clean();
    assert.deepEqual(await readdir(join(dir, 'recordings')), []);
  } finally {
    await m.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('4 FPS recording does not disrupt mobile clicks and popups on pages without viewport meta', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-recording-mobile-'));
  const m = new BrowserManager({ ...config(), dataDir: dir, recordVideo: true });
  await m.init();
  try {
    const i = await m.execute('qa', 'create_instance', {
      device_profile_id: 'android-pixel8-chrome155',
    });
    const ids = { instance_id: i.instance_id, page_id: i.pages[0].page_id };
    const p = m.instances.get(i.instance_id)!.pages.get(ids.page_id)!.page;
    await p.setContent(
      '<iframe srcdoc="first"></iframe><iframe srcdoc="second"></iframe><a target="_blank" href="about:blank">Popup</a>',
    );
    await new Promise((r) => setTimeout(r, 600));
    for (let n = 0; n < 3; n++) {
      const popup = p.waitForEvent('popup', { timeout: 5000 });
      await m.execute('qa', 'interact', { ...ids, action: 'click', target: { text: 'Popup' } });
      const created = await popup;
      await created.close();
      await m.execute('qa', 'select_page', ids);
    }
    assert.ok(m.recordings.active.get(i.instance_id)!.pages.get(ids.page_id)!.meta.frames >= 2);
    await m.execute('qa', 'close_instance', { instance_id: i.instance_id });
  } finally {
    await m.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
