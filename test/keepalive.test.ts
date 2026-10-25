import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test(
  'an MCP POST can reuse an origin connection after the former five-second idle boundary',
  { timeout: 20000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-keepalive-'));
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as any).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const proc = spawn(process.execPath, ['dist/cli.js', 'daemon'], {
      env: {
        ...process.env,
        DATA_DIR: dir,
        MCP_SOCKET: join(dir, 'service.sock'),
        BASE_URL: `http://127.0.0.1:${port}`,
        WEB_PORT: String(port),
        WEB_PASSWORD: 'keepalive-fixture',
        RECORD_VIDEO: 'false',
      },
      stdio: 'ignore',
    });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      let ready = false;
      for (let n = 0; n < 100; n++) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(ready);
      const { token } = JSON.parse(await readFile(join(dir, 'web-auth.json'), 'utf8'));
      const request = (id: number) =>
        new Promise<{ status: number; port: number; result: any }>((resolve, reject) => {
          let localPort: number;
          const req = http.request(
            {
              host: '127.0.0.1',
              port,
              path: '/mcp',
              method: 'POST',
              agent,
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json, text/event-stream',
                'Content-Type': 'application/json',
              },
            },
            (res) => {
              let text = '';
              res.on('data', (chunk) => {
                text += chunk;
              });
              res.on('end', () => {
                try {
                  resolve({ status: res.statusCode!, port: localPort, result: JSON.parse(text) });
                } catch (e) {
                  reject(e);
                }
              });
            },
          );
          req.on('socket', (socket) => {
            if (socket.connecting)
              socket.once('connect', () => {
                localPort = socket.localPort!;
              });
            else localPort = socket.localPort!;
          });
          req.on('error', reject);
          req.setTimeout(3000, () => req.destroy(Error('MCP reply deadline')));
          req.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              method: 'tools/call',
              params: { name: 'health', arguments: {} },
            }),
          );
        });
      const first = await request(1);
      assert.equal(first.status, 200);
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal(Object.values(agent.freeSockets).flat().length, 1);
      // Hold the proxy-side event loop while the separate origin process advances.
      // This deterministically exposes a stale pooled socket with the old 5s
      // origin timeout, without replaying any mutating browser operation.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
      const second = await request(2);
      assert.equal(second.status, 200);
      assert.equal(
        second.port,
        first.port,
        'The origin must not close the pooled socket before the proxy',
      );
      assert.equal(second.result.result.structuredContent.status, 'succeeded');
    } finally {
      agent.destroy();
      if (proc.exitCode === null) {
        const end = new Promise((r) => proc.once('exit', r));
        proc.kill('SIGTERM');
        await end;
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
);
