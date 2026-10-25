import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP stdio discovery, operation lookup, artifact transfer, reconnect and principal isolation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-protocol-'));
  const socket = join(dir, 'service.sock');
  const env = {
    ...process.env,
    DATA_DIR: dir,
    MCP_SOCKET: socket,
    WEB_PORT: '0',
    RECORD_VIDEO: 'false',
  };
  const daemon = spawn(process.execPath, ['dist/cli.js', 'daemon'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let logs = '';
  daemon.stderr.on('data', (x) => (logs += x));
  const connect = async (owner: string) => {
    const c = new Client({ name: 'test', version: '1.0.0' });
    await c.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['dist/cli.js', 'stdio'],
        env: { ...env, MCP_PRINCIPAL: owner } as Record<string, string>,
      }),
    );
    return c;
  };
  let a: Client | undefined, b: Client | undefined;
  let shutdownId: string | undefined;
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) {
      try {
        await access(socket);
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    assert.ok(ready, logs);
    a = await connect('alice');
    const tools = await a.listTools();
    assert.equal(tools.tools.length, 45);
    for (const [name, required] of [
      ['create_instance', ['proxy_id', 'user_agent', 'viewport', 'task_description']],
      ['proxy_curl', ['proxy_id', 'url', 'headers', 'body', 'timeout_ms']],
      ['check_proxy', ['proxy_id', 'proxy', 'check_url']],
      ['evaluate', ['instance_id', 'page_id', 'script', 'arg', 'frame_id', 'timeout_ms']],
      ['pointer', ['action', 'x', 'y', 'to_x', 'to_y', 'modifiers']],
      ['create_instance', ['storage_state_id']],
      ['get_network_request', ['instance_id', 'page_id', 'request_id', 'include_body']],
    ] as const) {
      const schema = tools.tools.find((t) => t.name === name)!.inputSchema;
      for (const key of required)
        assert.ok(schema.properties?.[key], `${name} must advertise ${key}`);
    }
    const call = async (c: Client, name: string, args: any = {}) => {
      const r: any = await c.callTool({ name, arguments: args });
      return JSON.parse(r.content[0].text);
    };
    assert.equal(
      (await call(a, 'create_instance', { proxy_id: 'x', proxy_ref: 'y' })).error.code,
      'INVALID_ARGUMENT',
    );
    const created = await call(a, 'create_instance', { viewport: { width: 390, height: 844 } });
    assert.equal(created.status, 'succeeded');
    const i = created.data.instance_id;
    const screenshotResponse: any = await a.callTool({
      name: 'screenshot',
      arguments: { instance_id: i, page_id: created.data.pages[0].page_id },
    });
    assert.ok(
      screenshotResponse.content.some(
        (c: any) => c.type === 'image' && c.mimeType === 'image/jpeg',
      ),
    );
    assert.equal(JSON.parse(screenshotResponse.content[0].text).data.mime, 'image/png');
    const inspected = await call(a, 'inspect_instance', { instance_id: i, probe: true });
    assert.equal(inspected.data.responsiveness.status, 'responsive');
    assert.ok(
      (await call(a, 'get_logs', { instance_id: i })).data.entries.some(
        (r: any) => r.code === 'instance_created',
      ),
    );
    const op = await call(a, 'get_operation', { operation_id: created.operation_id });
    assert.equal(op.data.data.instance_id, i);
    const recent = await call(a, 'list_operations', {});
    assert.ok(recent.data.some((x: any) => x.operation_id === created.operation_id));
    const put = await call(a, 'put_artifact', {
      name: 'test.txt',
      data_base64: Buffer.from('authorized upload').toString('base64'),
    });
    assert.equal(put.status, 'succeeded');
    const get = await call(a, 'get_artifact', { artifact_id: put.data.id });
    assert.equal(Buffer.from(get.data.data_base64, 'base64').toString(), 'authorized upload');
    await a.close();
    a = await connect('alice');
    assert.equal((await call(a, 'list_instances')).data[0].instance_id, i);
    b = await connect('bob');
    assert.deepEqual((await call(b, 'list_instances')).data, []);
    assert.equal(
      (await call(b, 'get_artifact', { artifact_id: put.data.id })).error.code,
      'ARTIFACT_NOT_FOUND',
    );
    assert.equal(
      (await call(b, 'get_operation', { operation_id: created.operation_id })).error.code,
      'OPERATION_NOT_FOUND',
    );
    assert.equal((await call(a, 'close_instance', { instance_id: i })).status, 'succeeded');
    assert.equal(
      (await call(a, 'inspect_instance', { instance_id: i, probe: false })).data.instance
        .close_reason,
      'requested',
    );
    assert.equal((await call(b, 'get_logs', { instance_id: i })).error.code, 'INSTANCE_NOT_FOUND');
    shutdownId = (await call(a, 'create_instance')).data.instance_id;
  } finally {
    await a?.close();
    await b?.close();
    if (daemon.exitCode === null) {
      const ended = new Promise<void>((r) => daemon.once('exit', () => r()));
      daemon.kill('SIGTERM');
      await ended;
    }
    if (shutdownId) {
      const state = JSON.parse(
        await readFile(join(dir, 'diagnostics/instances', shutdownId + '.json'), 'utf8'),
      );
      assert.equal(state.close_reason, 'service_shutdown');
      const events = (await readFile(join(dir, 'diagnostics/events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s));
      const processExit = events.find(
        (e: any) => e.instance_id === shutdownId && e.code === 'browser_process_exited',
      );
      assert.ok(processExit);
      assert.equal(processExit.fields.expected, true);
    }
    await rm(dir, { recursive: true, force: true });
  }
});
