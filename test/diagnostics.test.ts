import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserManager } from '../src/browser.js';
import { config } from '../src/config.js';

test('page diagnostics remain readable while an instance is busy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-busy-diag-'));
  const manager = new BrowserManager({ ...config(), dataDir: dir, recordVideo: false });
  await manager.init();
  let pending: Promise<unknown> | undefined;
  let id: string | undefined;
  try {
    const i = await manager.execute('alice', 'create_instance', {});
    id = i.instance_id;
    pending = manager
      .execute('alice', 'wait_for', {
        instance_id: id,
        page_id: i.pages[0].page_id,
        target: { css: '#not-present' },
        timeout_ms: 1000,
      })
      .catch(() => {});
    const diagnostic = await manager.execute('alice', 'get_diagnostics', {
      instance_id: id,
      limit: 100,
    });
    assert.ok(Array.isArray(diagnostic.events));
  } finally {
    if (id) await manager.close('alice', id).catch(() => {});
    await pending;
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('durable logs rotate, resume after partial writes, redact known secrets and isolate owners', async () => {
  const { Diagnostics } = await import('../src/diagnostics.js');
  const { readFile, readdir, stat, appendFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'mcp-journal-'));
  const cfg = {
    ...config(),
    dataDir: dir,
    maxLogBytes: 65536,
    webPassword: 'private-web-password',
    logRetentionHours: 168,
  };
  const id = 'ins_00000000-0000-0000-0000-000000000001';
  try {
    const log = new Diagnostics(cfg);
    await log.init();
    log.register({
      instance_id: id,
      owner: 'alice',
      created_at: new Date().toISOString(),
      status: 'active',
      last_operation: {
        operation_id: '00000000-0000-4000-8000-000000000001',
        tool: 'navigate',
        started_at: new Date().toISOString(),
        status: 'running',
      },
    });
    log.registerSecret('proxy-secret');
    for (let n = 0; n < 500; n++)
      log.log({
        owner: n % 2 ? 'alice' : 'bob',
        instance_id: n % 2 ? id : undefined,
        component: 'page',
        level: n % 3 ? 'info' : 'error',
        code: 'request_failed',
        fields: {
          tool: 'navigate',
          filler: 'x'.repeat(250),
          error: 'private-web-password proxy-secret Authorization: Bearer never-save-this',
        },
      });
    log.log({ component: 'service', level: 'info', code: 'manager_ready' });
    await log.flush();
    const files = (await readdir(join(dir, 'diagnostics'))).filter((s) => s.endsWith('.jsonl'));
    assert.ok(files.length > 1);
    let bytes = 0;
    for (const file of files) {
      const path = join(dir, 'diagnostics', file);
      bytes += (await stat(path)).size;
      const text = await readFile(path, 'utf8');
      for (const secret of ['private-web-password', 'proxy-secret', 'never-save-this'])
        assert.ok(!text.includes(secret));
    }
    assert.ok(bytes <= cfg.maxLogBytes);
    assert.equal(
      log.url('https://user:pass@example.com/script.js?token=private#fragment'),
      'https://example.com/script.js',
    );
    const result = await log.query('alice', { instance_id: id, limit: 3, after_seq: 0 });
    assert.equal(result.entries.length, 3);
    assert.equal(result.has_more, true);
    assert.equal(result.history_truncated, true);
    assert.ok(result.entries.every((r) => r.instance_id === id && !('owner' in r)));
    const more = await log.query('alice', {
      instance_id: id,
      limit: 3,
      after_seq: result.next_after_seq,
    });
    assert.ok(more.entries.every((r) => r.seq > result.next_after_seq));
    await assert.rejects(log.query('bob', { instance_id: id, limit: 10 }), {
      code: 'INSTANCE_NOT_FOUND',
    });
    const warnings = await log.query('alice', { level: 'error', limit: 200 });
    assert.ok(warnings.entries.every((r) => r.level === 'error' && r.instance_id === id));
    assert.deepEqual(
      (await log.query('alice', { since: '2100-01-01T00:00:00Z', limit: 10 })).entries,
      [],
    );
    await appendFile(join(dir, 'diagnostics/events.jsonl'), '{"interrupted_write":');
    const restored = new Diagnostics(cfg);
    await restored.init();
    assert.equal(restored.get('alice', id).status, 'interrupted');
    assert.equal(restored.get('alice', id).close_reason, 'manager_interrupted');
    assert.equal(restored.get('alice', id).last_operation?.status, 'interrupted');
    const resumed = await restored.query('alice', { instance_id: id, limit: 200 });
    assert.ok(resumed.entries.some((r) => r.code === 'instance_interrupted_on_restart'));
    restored.log({
      owner: 'alice',
      component: 'operation',
      level: 'info',
      code: 'operation_started',
    });
    await restored.flush();
    assert.equal(
      (await restored.query('alice', { limit: 1 })).entries[0].code,
      'operation_started',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('browser process crash remains inspectable after cleanup and restart without logging page secrets', async () => {
  const http = await import('node:http');
  const { readFile, readdir } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'mcp-crash-diag-'));
  const fixture = http.createServer((_req, res) =>
    res.end(
      '<script>console.error("PAGE_SECRET_SHOULD_NOT_BE_SAVED");setTimeout(()=>{throw new TypeError("PAGE_SECRET_SHOULD_NOT_BE_SAVED")},10)</script><h1>diagnostic fixture</h1>',
    ),
  );
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const cfg = { ...config(), dataDir: dir, recordVideo: false, allowPrivate: true };
  const manager = new BrowserManager(cfg);
  await manager.init();
  try {
    const i = await manager.execute('alice', 'create_instance', {});
    const id = i.instance_id;
    await manager.execute('alice', 'navigate', {
      instance_id: id,
      page_id: i.pages[0].page_id,
      action: 'goto',
      url: `http://127.0.0.1:${(fixture.address() as any).port}/?secret=QUERY_SECRET_SHOULD_NOT_BE_SAVED`,
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      const rows = await manager.execute('alice', 'get_logs', { instance_id: id, limit: 100 });
      if (rows.entries.some((r: any) => r.code === 'page_error')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const child = manager.instances.get(id)!.server.process();
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill('SIGKILL');
    await exited;
    await manager.sweep();
    const info = await manager.execute('alice', 'inspect_instance', {
      instance_id: id,
      probe: false,
    });
    assert.equal(info.live, null);
    assert.equal(info.instance.exit_signal, 'SIGKILL');
    assert.equal(info.instance.close_reason, 'browser_disconnected');
    const logs = await manager.execute('alice', 'get_logs', { instance_id: id, limit: 100 });
    assert.ok(
      logs.entries.some(
        (r: any) =>
          r.code === 'browser_process_exited' &&
          r.fields.signal === 'SIGKILL' &&
          r.fields.expected === false,
      ),
    );
    assert.ok(
      logs.entries.some((r: any) => r.code === 'page_error' && r.fields.error_name === 'TypeError'),
    );
    assert.ok(logs.entries.some((r: any) => r.code === 'instance_closed'));
    for (const name of (await readdir(join(dir, 'diagnostics'))).filter((s) =>
      s.endsWith('.jsonl'),
    )) {
      const content = await readFile(join(dir, 'diagnostics', name), 'utf8');
      assert.ok(!content.includes('PAGE_SECRET_SHOULD_NOT_BE_SAVED'));
      const pageRows = content
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row) => row.component === 'page');
      assert.ok(!JSON.stringify(pageRows).includes('QUERY_SECRET_SHOULD_NOT_BE_SAVED'));
      const operationRows = content
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row) => row.component === 'operation');
      assert.ok(JSON.stringify(operationRows).includes('QUERY_SECRET_SHOULD_NOT_BE_SAVED'));
    }
    await manager.shutdown();
    const restarted = new BrowserManager(cfg);
    await restarted.init();
    try {
      assert.equal(
        (await restarted.execute('alice', 'inspect_instance', { instance_id: id, probe: false }))
          .instance.exit_signal,
        'SIGKILL',
      );
      await assert.rejects(
        restarted.execute('bob', 'inspect_instance', { instance_id: id, probe: false }),
        { code: 'INSTANCE_NOT_FOUND' },
      );
      await assert.rejects(restarted.execute('bob', 'get_logs', { instance_id: id, limit: 10 }), {
        code: 'INSTANCE_NOT_FOUND',
      });
    } finally {
      await restarted.shutdown();
    }
  } finally {
    await manager.shutdown();
    await new Promise<void>((r) => fixture.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('a frozen renderer can be probed with a deadline and closed without waiting indefinitely', async () => {
  const http = await import('node:http');
  const dir = await mkdtemp(join(tmpdir(), 'mcp-frozen-diag-'));
  const fixture = http.createServer((_req, res) =>
    res.end('<button onclick="while(true){}">Freeze</button>'),
  );
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  const manager = new BrowserManager({
    ...config(),
    dataDir: dir,
    recordVideo: false,
    allowPrivate: true,
    timeout: 15000,
  });
  await manager.init();
  let pending: Promise<unknown> | undefined;
  try {
    const i = await manager.execute('alice', 'create_instance', {});
    await manager.execute('alice', 'navigate', {
      instance_id: i.instance_id,
      page_id: i.pages[0].page_id,
      action: 'goto',
      url: `http://127.0.0.1:${(fixture.address() as any).port}`,
    });
    pending = manager
      .execute('alice', 'interact', {
        instance_id: i.instance_id,
        page_id: i.pages[0].page_id,
        action: 'click',
        target: { role: 'button', name: 'Freeze' },
      })
      .catch(() => {});
    let info: any;
    for (let n = 0; n < 20; n++) {
      info = await manager.execute('alice', 'inspect_instance', {
        instance_id: i.instance_id,
        probe: true,
        timeout_ms: 150,
      });
      if (info.responsiveness.status === 'unresponsive') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(info.responsiveness.status, 'unresponsive');
    assert.ok(info.findings.includes('renderer_probe_timed_out'));
    assert.ok(
      (await manager.execute('alice', 'get_logs', { instance_id: i.instance_id, limit: 100 }))
        .entries.length > 0,
    );
    assert.ok(
      Array.isArray(
        (
          await manager.execute('alice', 'get_diagnostics', {
            instance_id: i.instance_id,
            limit: 10,
          })
        ).events,
      ),
    );
    const before = Date.now();
    await manager.close('alice', i.instance_id);
    assert.ok(Date.now() - before < 10000);
    await pending;
    assert.equal(
      (
        await manager.execute('alice', 'inspect_instance', {
          instance_id: i.instance_id,
          probe: false,
        })
      ).instance.close_reason,
      'requested',
    );
  } finally {
    await manager.shutdown();
    await pending;
    await new Promise<void>((r) => fixture.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('lifetime expiry is enforced while busy and idle cleanup is recorded as a normal reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-expiry-diag-'));
  const manager = new BrowserManager({ ...config(), dataDir: dir, recordVideo: false });
  await manager.init();
  let pending: Promise<unknown> | undefined;
  try {
    const i = await manager.execute('alice', 'create_instance', { max_lifetime_seconds: 60 });
    pending = manager
      .execute('alice', 'wait_for', {
        instance_id: i.instance_id,
        page_id: i.pages[0].page_id,
        target: { css: '#missing' },
        timeout_ms: 60000,
      })
      .catch(() => {});
    manager.instances.get(i.instance_id)!.created -= 61000;
    await manager.sweep();
    await pending;
    assert.equal(
      (
        await manager.execute('alice', 'inspect_instance', {
          instance_id: i.instance_id,
          probe: false,
        })
      ).instance.close_reason,
      'max_lifetime',
    );
    const idle = await manager.execute('alice', 'create_instance', { idle_timeout_seconds: 30 });
    manager.instances.get(idle.instance_id)!.touched -= 31000;
    await manager.sweep();
    assert.equal(
      (
        await manager.execute('alice', 'inspect_instance', {
          instance_id: idle.instance_id,
          probe: false,
        })
      ).instance.close_reason,
      'idle_timeout',
    );
  } finally {
    await manager.shutdown();
    await pending;
    await rm(dir, { recursive: true, force: true });
  }
});

test('encoder failure is available as a structured diagnostic after instance closure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-encoder-diag-'));
  const manager = new BrowserManager({
    ...config(),
    dataDir: dir,
    recordVideo: true,
    ffmpeg: join(dir, 'missing-ffmpeg'),
  });
  await manager.init();
  try {
    const i = await manager.execute('alice', 'create_instance', {});
    await manager.close('alice', i.instance_id);
    const logs = await manager.execute('alice', 'get_logs', {
      instance_id: i.instance_id,
      component: 'recorder',
      limit: 100,
    });
    assert.ok(
      logs.entries.some(
        (r: any) => r.code === 'encoder_unavailable' && r.fields.error_code === 'ENOENT',
      ),
    );
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('closing a short-lived instance still finalizes at least one recorded frame', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-short-recording-'));
  const manager = new BrowserManager({ ...config(), dataDir: dir, recordVideo: true });
  await manager.init();
  try {
    const i = await manager.execute('alice', 'create_instance', {});
    await manager.close('alice', i.instance_id);
    const meta = (await manager.recordings.list()).find((r) => r.instance_id === i.instance_id)!;
    assert.equal(meta.status, 'completed');
    assert.ok(meta.frames >= 1 && meta.bytes > 0);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('event bursts have a bounded queue and report dropped events without losing a service warning', async () => {
  const { Diagnostics } = await import('../src/diagnostics.js');
  const dir = await mkdtemp(join(tmpdir(), 'mcp-log-burst-'));
  const log = new Diagnostics({ ...config(), dataDir: dir, maxLogBytes: 65536 });
  await log.init();
  try {
    log.log({
      owner: 'alice',
      component: 'operation',
      level: 'info',
      code: 'operation_started',
      arguments: { value: 'x'.repeat(65536) },
    });
    await log.flush();
    assert.equal(log.droppedEvents, 1);
    for (let n = 0; n < 5000; n++)
      log.log({ owner: 'alice', component: 'page', level: 'warn', code: 'console' });
    log.log({ component: 'service', level: 'error', code: 'memory_pressure' });
    const result = await log.query('alice', { limit: 200 });
    assert.ok(result.dropped_events >= 4000);
    assert.ok(result.entries.some((r) => r.code === 'memory_pressure'));
  } finally {
    await log.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test('task objectives and complete per-instance function calls survive closure and restart', async () => {
  const http = await import('node:http');
  const { createSchema } = await import('../src/config.js');
  const fixture = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<input id="password" type="password">');
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(join(tmpdir(), 'mcp-call-history-'));
  const cfg = { ...config(), dataDir: dir, recordVideo: true, allowPrivate: true };
  const manager = new BrowserManager(cfg);
  await manager.init();
  const task = '验证登录与下载，保留每一步调用记录';
  assert.equal(createSchema.safeParse({ task_description: '  ' }).success, false);
  assert.equal(createSchema.safeParse({ task_description: 'x'.repeat(1001) }).success, false);
  try {
    const i = await manager.execute('alice', 'create_instance', {
      task_description: '  ' + task + '  ',
    });
    const id = i.instance_id;
    const args = { instance_id: id, page_id: i.pages[0].page_id };
    assert.equal(i.task_description, task);
    const url = `http://127.0.0.1:${(fixture.address() as any).port}/?token=full-query#section`;
    await manager.execute('alice', 'navigate', { ...args, action: 'goto', url });
    manager.logs.registerSecret('full-input-password');
    await manager.execute('alice', 'interact', {
      ...args,
      action: 'fill',
      target: { css: '#password' },
      value: 'full-input-password',
    });
    await manager.execute('alice', 'screenshot', args);
    await assert.rejects(
      manager.execute('alice', 'wait_for', {
        ...args,
        target: { css: '#missing' },
        timeout_ms: 100,
      }),
      /Timeout/i,
    );
    await manager.execute('alice', 'close_instance', { instance_id: id });
    const options = { instance_id: id, component: 'operation', limit: 200 };
    const calls = await manager.execute('alice', 'get_logs', options);
    for (const tool of [
      'create_instance',
      'navigate',
      'interact',
      'screenshot',
      'close_instance',
    ]) {
      const start = calls.entries.find(
        (r: any) => r.code === 'operation_started' && r.fields.tool === tool,
      );
      const end = calls.entries.find(
        (r: any) => r.code === 'operation_succeeded' && r.fields.tool === tool,
      );
      assert.ok(start && end, tool);
      assert.equal(start.operation_id, end.operation_id);
      assert.ok(end.fields.elapsed_ms >= 0);
    }
    assert.equal(calls.entries.find((r: any) => r.arguments?.url)?.arguments.url, url);
    assert.ok(calls.entries.some((r: any) => r.arguments?.value === 'full-input-password'));
    assert.ok(
      calls.entries.some(
        (r: any) =>
          r.code === 'operation_failed' &&
          r.fields.error_code === 'TIMEOUT' &&
          r.fields.error_message.includes('#missing'),
      ),
    );
    await assert.rejects(manager.execute('bob', 'get_logs', options), {
      code: 'INSTANCE_NOT_FOUND',
    });
    assert.equal(
      (await manager.logs.adminInstanceLogs(id, { limit: 200 })).instance.task_description,
      task,
    );
    assert.equal((await manager.recordings.list())[0].task_description, task);
    await manager.shutdown();
    const restored = new BrowserManager(cfg);
    await restored.init();
    try {
      assert.equal(
        (await restored.execute('alice', 'inspect_instance', { instance_id: id, probe: false }))
          .instance.task_description,
        task,
      );
      assert.equal((await restored.recordings.list())[0].task_description, task);
      assert.ok(
        (
          await restored.logs.adminInstanceLogs(id, { component: 'operation', limit: 200 })
        ).entries.some((r) => r.arguments?.value === 'full-input-password'),
      );
    } finally {
      await restored.shutdown();
    }
  } finally {
    await manager.shutdown();
    await new Promise<void>((r) => fixture.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
