import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Artifacts } from '../src/artifacts.js';
import { config } from '../src/config.js';

test('a full artifact quota frees whole oldest artifacts for incoming writes without leaving orphan files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloudbrowser-quota-'));
  try {
    const store = new Artifacts({ ...config(), dataDir: dir, dataLimit: 1048576 });
    await store.init();
    const old = await store.save(
      'alice',
      'one',
      'old.png',
      'image/png',
      Buffer.alloc(1044480),
      'screenshot',
    );
    const fresh = await store.save(
      'alice',
      'two',
      'new.png',
      'image/png',
      Buffer.alloc(8192),
      'screenshot',
    );
    assert.equal((await store.get('alice', fresh.id)).size, 8192);
    await assert.rejects(store.get('alice', old.id), { code: 'ARTIFACT_NOT_FOUND' });
    assert.deepEqual(
      (await readdir(join(dir, 'artifacts'))).sort(),
      [`${fresh.id}.bin`, `${fresh.id}.json`].sort(),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('screenshot expiry is independent of other artifact retention and is applied after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloudbrowser-expiry-'));
  const cfg = { ...config(), dataDir: dir, retentionHours: 24 * 30, screenshotRetentionDays: 7 };
  try {
    const store = new Artifacts(cfg);
    await store.init();
    const screen = await store.save(
      'alice',
      'one',
      's.png',
      'image/png',
      Buffer.from('s'),
      'screenshot',
    );
    const preview = await store.save(
      'alice',
      'one',
      'p.jpg',
      'image/jpeg',
      Buffer.from('p'),
      'screenshot_preview',
    );
    const download = await store.save(
      'alice',
      'one',
      'file.bin',
      'application/octet-stream',
      Buffer.from('d'),
      'download',
    );
    for (const a of [screen, preview, download]) {
      const path = join(dir, 'artifacts', a.id + '.json');
      const meta = JSON.parse(await readFile(path, 'utf8'));
      meta.created_at = new Date(Date.now() - 8 * 86400000).toISOString();
      await writeFile(path, JSON.stringify(meta));
    }
    const restarted = new Artifacts(cfg);
    await restarted.init();
    await restarted.clean();
    await assert.rejects(restarted.get('alice', screen.id), { code: 'ARTIFACT_NOT_FOUND' });
    await assert.rejects(restarted.get('alice', preview.id), { code: 'ARTIFACT_NOT_FOUND' });
    assert.equal((await restarted.get('alice', download.id)).size, 1);
    assert.equal((await readdir(join(dir, 'artifacts'))).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('screenshot batches reserve space together; an oversized batch cannot destroy existing evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloudbrowser-batch-'));
  try {
    const store = new Artifacts({ ...config(), dataDir: dir, dataLimit: 1048576 });
    await store.init();
    const old = await store.save(
      'alice',
      'one',
      'old',
      'text/plain',
      Buffer.alloc(1000000),
      'download',
    );
    await assert.rejects(
      store.saveBatch('alice', 'two', [
        { name: 'original', mime: 'image/png', bytes: Buffer.alloc(600000), kind: 'screenshot' },
        {
          name: 'preview',
          mime: 'image/jpeg',
          bytes: Buffer.alloc(600000),
          kind: 'screenshot_preview',
        },
      ]),
      { code: 'STORAGE_LIMIT' },
    );
    assert.equal((await store.get('alice', old.id)).size, 1000000);
    const batch = await store.saveBatch('alice', 'two', [
      { name: 'original', mime: 'image/png', bytes: Buffer.alloc(600000), kind: 'screenshot' },
      {
        name: 'preview',
        mime: 'image/jpeg',
        bytes: Buffer.alloc(300000),
        kind: 'screenshot_preview',
      },
    ]);
    assert.equal((await store.get('alice', batch[0].id)).size, 600000);
    assert.equal((await store.get('alice', batch[1].id)).size, 300000);
    const concurrent = await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        store.save('alice', 'three', String(n), 'text/plain', Buffer.alloc(10000), 'upload'),
      ),
    );
    await Promise.all(Array.from({ length: 10 }, () => store.clean()));
    for (const a of concurrent) assert.equal((await store.get('alice', a.id)).size, 10000);
    const files = await readdir(join(dir, 'artifacts'));
    for (const file of files)
      assert.ok(
        files.includes(file.replace(/\.(json|bin)$/, file.endsWith('.json') ? '.bin' : '.json')),
      );
    const usage = await store.usage();
    assert.ok(usage.bytes <= 1048576);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('storage settings use 200 GiB / seven days defaults, persist atomically and override deployment defaults after restart', async () => {
  const { SystemSettings } = await import('../src/system-settings.js');
  const dir = await mkdtemp(join(tmpdir(), 'cloudbrowser-settings-'));
  try {
    assert.equal(config().dataLimit, 200 * 1024 ** 3);
    assert.equal(config().screenshotRetentionDays, 7);
    const cfg = { ...config(), dataDir: dir };
    const settings = new SystemSettings(cfg);
    await settings.init();
    await settings.updateStorage({
      max_data_bytes: 300 * 1024 ** 3,
      screenshot_retention_days: 14,
    });
    assert.equal(cfg.dataLimit, 300 * 1024 ** 3);
    assert.equal(cfg.screenshotRetentionDays, 14);
    const persisted = await readFile(join(dir, 'system-settings.json'), 'utf8');
    for (const value of [
      { max_data_bytes: 0, screenshot_retention_days: 7 },
      { max_data_bytes: 214748364800, screenshot_retention_days: 0 },
      { max_data_bytes: 214748364800, screenshot_retention_days: 7, extra: true },
    ]) {
      assert.throws(() => settings.updateStorage(value));
      assert.equal(await readFile(join(dir, 'system-settings.json'), 'utf8'), persisted);
    }
    const rebootCfg = { ...config(), dataDir: dir, dataLimit: 1048576, screenshotRetentionDays: 1 };
    const restored = new SystemSettings(rebootCfg);
    await restored.init();
    assert.equal(rebootCfg.dataLimit, 300 * 1024 ** 3);
    assert.equal(rebootCfg.screenshotRetentionDays, 14);
    assert.equal((await stat(join(dir, 'system-settings.json'))).mode & 0o777, 0o600);
    await mkdir(join(dir, 'system-settings.json.tmp'));
    await assert.rejects(
      restored.updateStorage({ max_data_bytes: 400 * 1024 ** 3, screenshot_retention_days: 30 }),
    );
    assert.equal(rebootCfg.dataLimit, 300 * 1024 ** 3);
    assert.equal(await readFile(join(dir, 'system-settings.json'), 'utf8'), persisted);
    await rm(join(dir, 'system-settings.json.tmp'), { recursive: true });
    await Promise.all([
      restored.updateStorage({ max_data_bytes: 201 * 1024 ** 3, screenshot_retention_days: 8 }),
      restored.updateStorage({ max_data_bytes: 202 * 1024 ** 3, screenshot_retention_days: 9 }),
    ]);
    assert.equal(restored.storage().screenshot_retention_days, 9);
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, 'system-settings.json'), 'utf8')).storage,
      restored.storage(),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
