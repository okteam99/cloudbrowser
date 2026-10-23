import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserManager } from '../src/browser.js';
import { config } from '../src/config.js';
import { instanceDetailsUrl, instanceLoginTarget } from '../src/instance-details.js';

test('instance links include only an empty token hint; post-login destinations must be exact local instance paths', () => {
  const id = 'ins_12345678-1234-4234-8234-123456789abc';
  assert.equal(
    instanceDetailsUrl('https://primary.test/browser/', id),
    `https://primary.test/browser/instances/${id}?access_token=`,
  );
  assert.equal(instanceDetailsUrl(undefined, id), undefined);
  assert.equal(
    instanceLoginTarget(`/browser/instances/${id}`, '/browser'),
    `/browser/instances/${id}`,
  );
  for (const target of [
    `https://evil.test/instances/${id}`,
    `//evil.test/instances/${id}`,
    `/instances/${id}`,
    `/browser/instances/${id}/more`,
    `/browser/instances/${id}?redirect=https://evil.test`,
    `/browser/instances/${id}\r\nLocation: https://evil.test`,
  ])
    assert.equal(instanceLoginTarget(target, '/browser'), undefined);
});

test('instance details are read-only while busy and preserve properties, tabs, and stable links after close and restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloudbrowser-instance-details-'));
  const cfg = {
    ...config(),
    dataDir: dir,
    recordVideo: false,
    baseUrl: 'https://primary.test/browser',
  };
  const m = new BrowserManager(cfg);
  await m.init();
  let pending: Promise<unknown> | undefined;
  try {
    const i = await m.execute('alice', 'create_instance', {
      task_description: '详情回溯',
      user_agent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)',
      viewport: { width: 412, height: 915 },
      locale: 'pt-BR',
      timezone: 'America/Sao_Paulo',
    });
    assert.equal(i.details_url, `${cfg.baseUrl}/instances/${i.instance_id}?access_token=`);
    const touched = m.instances.get(i.instance_id)!.touched;
    const data = await m.adminInstanceDetails(i.instance_id);
    assert.equal(data.current?.instance_id, i.instance_id);
    assert.equal(data.instance.properties?.viewport.width, 412);
    assert.equal(m.instances.get(i.instance_id)!.touched, touched);
    pending = m.execute('alice', 'evaluate', {
      instance_id: i.instance_id,
      page_id: i.pages[0].page_id,
      script: '() => new Promise(r => { window.releaseDetailsProbe = r; })',
    });
    const page = m.instances.get(i.instance_id)!.pages.get(i.pages[0].page_id)!.page;
    await page.waitForFunction(() => typeof (window as any).releaseDetailsProbe === 'function');
    const busy = await m.adminInstanceDetails(i.instance_id);
    assert.ok(busy.current?.busy);
    await page.evaluate(() => (window as any).releaseDetailsProbe(1));
    await pending;
    pending = undefined;
    await m.execute('alice', 'close_instance', { instance_id: i.instance_id });
    const closed = await m.adminInstanceDetails(i.instance_id);
    assert.equal(closed.current, null);
    assert.equal(closed.instance.status, 'closed');
    assert.equal(closed.instance.properties?.locale, 'pt-BR');
    assert.equal(closed.instance.properties?.timezone, 'America/Sao_Paulo');
    assert.equal(closed.instance.environment?.os, 'Android');
    assert.equal(closed.pages[0].url, 'about:blank');
    assert.ok(!JSON.stringify(closed).includes('owner'));
    await assert.rejects(
      m.execute('bob', 'inspect_instance', { instance_id: i.instance_id, probe: false }),
      { code: 'INSTANCE_NOT_FOUND' },
    );
    await m.shutdown();
    const restarted = new BrowserManager(cfg);
    await restarted.init();
    try {
      const restored = await restarted.adminInstanceDetails(i.instance_id);
      assert.deepEqual(
        restored.instance.properties,
        JSON.parse(JSON.stringify(closed.instance.properties)),
      );
      assert.equal(restored.details_url, i.details_url);
      assert.equal(restored.logs_available, true);
    } finally {
      await restarted.shutdown();
    }
  } finally {
    await pending?.catch(() => {});
    await m.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('recording-only history remains viewable when the diagnostic record expires; expired logs are marked unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloudbrowser-recording-detail-'));
  const m = new BrowserManager({ ...config(), dataDir: dir, recordVideo: false });
  await m.init();
  try {
    const id = `ins_${randomUUID()}`;
    await m.recordings.persist({
      id: `rec_${randomUUID()}`,
      instance_id: id,
      owner: 'alice',
      created_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      task_description: '仅保留录屏',
      status: 'completed',
      frames: 2,
      fps: 2,
      width: 640,
      height: 480,
      bytes: 100,
    });
    const data = await m.adminInstanceDetails(id);
    assert.equal(data.logs_available, false);
    assert.equal(data.instance.task_description, '仅保留录屏');
    assert.equal(data.current, null);
    assert.equal(data.recordings.length, 1);
    await assert.rejects(m.adminInstanceDetails(`ins_${randomUUID()}`), {
      code: 'INSTANCE_NOT_FOUND',
    });
  } finally {
    await m.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
