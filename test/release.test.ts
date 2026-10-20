import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('release dry-run uses fixed Docker Hub namespace, timestamp tag and multiarch without exposing token', () => {
  const result = spawnSync('bash', ['scripts/publish-docker.sh', '--dry-run'], {
    env: {
      ...process.env,
      RELEASE_TAG: '20261020123456',
      DOCKERHUB_TOKEN: 'test-secret-never-print',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bdpgogoup\/cloudbrowser:20261020123456/);
  assert.match(result.stdout, /linux\/amd64,linux\/arm64/);
  assert.match(result.stdout, /--push/);
  assert.ok(!result.stdout.includes('test-secret-never-print'));
  assert.equal(
    spawnSync('bash', ['scripts/publish-docker.sh', '--dry-run'], {
      env: { ...process.env, RELEASE_TAG: 'bad-tag' },
      encoding: 'utf8',
    }).status,
    2,
  );
});

test('release pins README to the published tag and rolls back after a failed push', async () => {
  const { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'browser-release-'));
  try {
    await mkdir(join(dir, 'scripts'));
    await mkdir(join(dir, 'bin'));
    await copyFile('scripts/publish-docker.sh', join(dir, 'scripts/publish-docker.sh'));
    await writeFile(
      join(dir, 'bin/docker'),
      '#!/bin/sh\nif [ "$1" = buildx ] && [ "$2" = build ] && [ "$MOCK_PUSH_FAIL" = 1 ]; then exit 1; fi\nexit 0\n',
      { mode: 0o700 },
    );
    const original = 'docker run bdpgogoup/cloudbrowser:20261020100000\n';
    const env = {
      ...process.env,
      PATH: join(dir, 'bin') + ':' + process.env.PATH,
      RELEASE_TAG: '20261020123456',
      DOCKERHUB_TOKEN: '',
    };
    await writeFile(join(dir, 'README.md'), original);
    const success = spawnSync('bash', [join(dir, 'scripts/publish-docker.sh')], {
      env,
      encoding: 'utf8',
    });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(
      await readFile(join(dir, 'README.md'), 'utf8'),
      'docker run bdpgogoup/cloudbrowser:20261020123456\n',
    );
    assert.match(success.stdout, /docker run -d --init \\\n/);
    await writeFile(join(dir, 'README.md'), original);
    const failure = spawnSync('bash', [join(dir, 'scripts/publish-docker.sh')], {
      env: { ...env, MOCK_PUSH_FAIL: '1' },
      encoding: 'utf8',
    });
    assert.equal(failure.status, 1);
    assert.equal(await readFile(join(dir, 'README.md'), 'utf8'), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
