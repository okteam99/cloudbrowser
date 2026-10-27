import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserManager } from '../src/browser.js';
import { config } from '../src/config.js';
import { instanceDetailsUrl, instanceLoginTarget } from '../src/instance-details.js';
import { instanceDocument } from '../src/instance-document.js';

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
      device_profile: {
        ...m.deviceProfiles.resolve('android-pixel8-chrome155'),
        locale: 'pt-BR',
        timezone: 'America/Sao_Paulo',
      },
    });
    assert.equal(i.details_url, `${cfg.baseUrl}/instances/${i.instance_id}?access_token=`);
    const touched = m.instances.get(i.instance_id)!.touched;
    const data = await m.adminInstanceDetails(i.instance_id);
    assert.equal(data.current?.instance_id, i.instance_id);
    assert.equal(data.instance.properties?.viewport.width, 412);
    assert.equal(m.instances.get(i.instance_id)!.touched, touched);
    const aggregate = await m.execute('alice', 'get_instance_details', {
      instance_id: i.instance_id,
    });
    assert.deepEqual(aggregate, await instanceDocument(m, i.instance_id, cfg.baseUrl));
    assert.equal(aggregate.navigation.recorded, true);
    assert.ok(aggregate.logs.entries.some((e: any) => e.code === 'instance_created'));
    assert.equal(
      aggregate.links.live,
      `${cfg.baseUrl}/api/instances/${i.instance_id}/live?access_token=`,
    );
    assert.equal(m.instances.get(i.instance_id)!.touched, touched);
    await assert.rejects(m.execute('bob', 'get_instance_details', { instance_id: i.instance_id }), {
      code: 'INSTANCE_NOT_FOUND',
    });
    pending = m.execute('alice', 'evaluate', {
      instance_id: i.instance_id,
      page_id: i.pages[0].page_id,
      script: '() => new Promise(r => { window.releaseDetailsProbe = r; })',
    });
    const page = m.instances.get(i.instance_id)!.pages.get(i.pages[0].page_id)!.page;
    await page.waitForFunction(() => typeof (window as any).releaseDetailsProbe === 'function');
    const busy = await m.adminInstanceDetails(i.instance_id);
    assert.ok(busy.current?.busy);
    const busyAggregate = await m.execute('alice', 'get_instance_details', {
      instance_id: i.instance_id,
    });
    assert.ok(busyAggregate.current.busy);
    assert.equal(busyAggregate.current.active_operation.tool, 'evaluate');
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
    const closedAggregate = await m.execute('alice', 'get_instance_details', {
      instance_id: i.instance_id,
    });
    assert.deepEqual(closedAggregate, await instanceDocument(m, i.instance_id, cfg.baseUrl));
    assert.equal(closedAggregate.current, null);
    assert.equal(closedAggregate.links.live, null);
    assert.ok(closedAggregate.logs.entries.some((e: any) => e.code === 'instance_closed'));
    await assert.rejects(m.execute('bob', 'get_instance_details', { instance_id: i.instance_id }), {
      code: 'INSTANCE_NOT_FOUND',
    });
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
      const restoredAggregate = await restarted.execute('alice', 'get_instance_details', {
        instance_id: i.instance_id,
      });
      assert.equal(restoredAggregate.instance.status, 'closed');
      assert.equal(restoredAggregate.navigation.recorded, true);
      assert.ok(restoredAggregate.logs.entries.some((e: any) => e.code === 'instance_closed'));
      await assert.rejects(
        restarted.execute('bob', 'get_instance_details', { instance_id: i.instance_id }),
        { code: 'INSTANCE_NOT_FOUND' },
      );
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
    const aggregate = await m.execute('alice', 'get_instance_details', { instance_id: id });
    assert.equal(aggregate.logs, null);
    assert.equal(aggregate.navigation, null);
    assert.equal(aggregate.navigation_available, false);
    assert.equal(aggregate.recordings.length, 1);
    assert.equal(aggregate.links.recordings[0].recording_id, data.recordings[0].id);
    assert.ok(aggregate.links.recordings[0].url.endsWith('?access_token='));
    assert.ok(!JSON.stringify(aggregate).includes('owner'));
    await assert.rejects(m.execute('bob', 'get_instance_details', { instance_id: id }), {
      code: 'INSTANCE_NOT_FOUND',
    });
    await assert.rejects(
      m.execute('alice', 'get_instance_details', { instance_id: `ins_${randomUUID()}` }),
      { code: 'INSTANCE_NOT_FOUND' },
    );
    await assert.rejects(m.adminInstanceDetails(`ins_${randomUUID()}`), {
      code: 'INSTANCE_NOT_FOUND',
    });
  } finally {
    await m.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('aggregate details bound embedded history and expose cursors without adding polling events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloudbrowser-aggregate-history-'));
  const m = new BrowserManager({ ...config(), dataDir: dir, recordVideo: false });
  await m.init();
  try {
    const id = `ins_${randomUUID()}`;
    m.logs.register({
      instance_id: id,
      owner: 'alice',
      status: 'closed',
      created_at: new Date().toISOString(),
      navigation_since_seq: m.logs.sequence(),
    });
    for (let n = 0; n < 205; n++) {
      m.logs.log({
        owner: 'alice',
        instance_id: id,
        page_id: 'page-test',
        component: 'navigation',
        code: 'navigation_event',
        navigation: {
          kind: 'request',
          navigation_id: `nav-${n}`,
          hop_id: `hop-${n}`,
          url: `https://example.test/?step=${n}&value=unredacted`,
        },
      });
    }
    const before = m.logs.sequence();
    const doc = await m.execute('alice', 'get_instance_details', { instance_id: id });
    assert.equal(m.logs.sequence(), before);
    assert.equal(doc.logs.entries.length, 200);
    assert.equal(
      doc.logs.entries[0].navigation.url,
      'https://example.test/?step=5&value=unredacted',
    );
    assert.equal(doc.navigation.entries.length, 200);
    assert.equal(doc.navigation.entries[0].url, 'https://example.test/?step=0&value=unredacted');
    assert.equal(doc.navigation.has_more, true);
    const next = await m.execute('alice', 'list_navigation_events', {
      instance_id: id,
      after_seq: doc.navigation.next_after_seq,
    });
    assert.equal(next.entries.length, 5);
    assert.equal(next.has_more, false);
    const allLogs = await m.execute('alice', 'get_logs', {
      instance_id: id,
      after_seq: 0,
      limit: 200,
    });
    assert.equal(allLogs.entries[0].navigation.url, doc.navigation.entries[0].url);
    assert.equal(allLogs.has_more, true);
    const legacyId = `ins_${randomUUID()}`;
    m.logs.register({
      instance_id: legacyId,
      owner: 'alice',
      status: 'closed',
      created_at: new Date().toISOString(),
    });
    const legacy = await m.execute('alice', 'get_instance_details', { instance_id: legacyId });
    assert.equal(legacy.navigation.recorded, false);
    assert.deepEqual(legacy.navigation.entries, []);
  } finally {
    await m.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
