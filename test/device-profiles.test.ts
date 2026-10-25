import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceProfileStore } from '../src/device-profiles.js';

test('saved profile catalog validates, filters, rejects stale writes and persists empty catalogs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-device-catalog-'));
  try {
    const store = new DeviceProfileStore(dir);
    await store.init();
    const original = store.snapshot();
    assert.equal(original.profiles.length, 2);
    assert.equal((await stat(join(dir, 'device-profiles.json'))).mode & 0o777, 0o600);
    const android = store.list({ platform: 'Android' });
    assert.equal(android.length, 1);
    assert.equal(store.list({ query: 'pixel' }).length, 1);
    const custom = {
      ...original.profiles[1],
      profile_id: 'team-android',
      profile: { ...android[0].profile, name: '团队 Android' },
    };
    const saved = await store.update({ ...original, profiles: [custom] });
    assert.deepEqual(store.get(custom.profile_id).profile, custom.profile);
    assert.throws(() => store.get('missing'), { code: 'DEVICE_PROFILE_NOT_FOUND' });
    const clone = store.resolve(custom.profile_id);
    clone.name = 'should not mutate store';
    assert.equal(store.resolve(custom.profile_id).name, '团队 Android');
    for (const profiles of [
      [custom, custom],
      [{ ...custom, profile_id: '../invalid' }],
      [{ ...custom, profile: { ...custom.profile, timezone: 'invalid/zone' } }],
      [
        {
          ...custom,
          profile: {
            ...custom.profile,
            client_hints: { ...custom.profile.client_hints, full_version: '130.0.0.0' },
          },
        },
      ],
      [{ ...custom, unknown: true }],
    ])
      assert.throws(() => store.update({ ...saved, profiles }));
    assert.deepEqual(store.snapshot(), saved);
    await assert.rejects(store.update(original), { code: 'DEVICE_PROFILES_CONFLICT' });
    const results = await Promise.allSettled([
      store.update({ ...saved, profiles: [{ ...custom, enabled: false }] }),
      store.update({ ...saved, profiles: [] }),
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal(store.list().length, 0);
    assert.equal(store.list({ enabled_only: false }).length, 1);
    assert.equal(store.get(custom.profile_id).enabled, false);
    assert.throws(() => store.resolve(custom.profile_id), { code: 'DEVICE_PROFILE_DISABLED' });
    const restarted = new DeviceProfileStore(dir);
    await restarted.init();
    assert.deepEqual(restarted.snapshot(), store.snapshot());
    await restarted.update({ ...restarted.snapshot(), profiles: [] });
    const empty = new DeviceProfileStore(dir);
    await empty.init();
    assert.deepEqual(empty.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed catalog writes retain saved values, and corrupt JSON is never replaced with defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-device-catalog-failure-'));
  try {
    const store = new DeviceProfileStore(dir);
    await store.init();
    const before = store.snapshot();
    const file = join(dir, 'device-profiles.json');
    const persisted = await readFile(file, 'utf8');
    await mkdir(file + '.tmp');
    await assert.rejects(store.update({ ...before, profiles: [] }));
    assert.deepEqual(store.snapshot(), before);
    assert.equal(await readFile(file, 'utf8'), persisted);
    await rm(file + '.tmp', { recursive: true });
    await store.update({ ...before, profiles: [] });
    await writeFile(file, '{broken');
    await assert.rejects(new DeviceProfileStore(dir).init());
    assert.equal(await readFile(file, 'utf8'), '{broken');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
