import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCloudflareTunnel, validateTunnelConfig, inferTunnelUrl } from '../src/tunnel.js';
import { config } from '../src/config.js';
import { Diagnostics } from '../src/diagnostics.js';

async function fake(path: string, mode = 'ready') {
  await writeFile(
    path,
    `#!/usr/bin/env node
+const http = require('node:http');
+const args = process.argv.slice(2);
+const mode = ${JSON.stringify(mode)};
+if (!args.includes('--no-autoupdate') || args.includes(process.env.TUNNEL_TOKEN || 'NEVER_PASS_TOKEN')) process.exit(2);
+if (mode === 'exit') process.exit(1);
+if (mode === 'hang') setInterval(() => {}, 1000);
+else {
+ const server = http.createServer((req, res) => {
+  if (mode === 'events' && req.url === '/emit') { process.stderr.write('2026-10-25T12:21:50Z ERR error="Unable to reach the origin service: connection reset by peer" connIndex=3 ingressRule=1 originService=http://localhost:8080\\n'); res.end('emitted'); return; }
+  if (req.url === '/ready') { res.statusCode = mode === 'unready' ? 503 : 200; res.end(); }
+  else if (req.url === '/quicktunnel') res.end(JSON.stringify({hostname: mode === 'evil' ? 'fixture.trycloudflare.com.evil.test' : 'sample-fixture.trycloudflare.com'}));
+  else res.end(JSON.stringify({version: 1, config: {ingress: [{hostname: 'fixed.example.com', service:'http://localhost:8080'}, ...(mode === 'multi' ? [{hostname:'alias.example.com',service:'http://127.0.0.1:8080'}] : []), {service:'http_status:404'}]}}));
+ });
+ server.listen(0, '127.0.0.1', () => {
+  process.stderr.write('Starting metrics server on 127.0.');
+  setTimeout(() => process.stderr.write('0.1:' + server.address().port + '/metrics\\n'), 10);
+  if (mode === 'events') require('node:fs').writeFileSync(process.argv[1]+'.port', String(server.address().port));
+ });
+}
`.replace(/^\+/gm, ''),
    { mode: 0o700 },
  );
}

test('Quick Tunnel reads loopback readiness and URL, isolates credentials and cleans up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-tunnel-test-'));
  let tunnel: Awaited<ReturnType<typeof startCloudflareTunnel>> | undefined;
  try {
    const path = join(dir, 'cloudflared');
    await fake(path);
    const cfg = {
      ...config(),
      quickTunnel: true,
      cfTunnelToken: undefined,
      baseUrl: undefined,
      webPort: 8080,
      webPassword: 'test-password',
      cloudflared: path,
      tunnelStartupTimeout: 2000,
    };
    tunnel = await startCloudflareTunnel(cfg);
    assert.equal(tunnel.url, 'https://sample-fixture.trycloudflare.com');
    await tunnel.close();
    await tunnel.exited;
    tunnel = undefined;
    assert.throws(() => validateTunnelConfig({ ...cfg, baseUrl: 'https://example.com' }), /either/);
    assert.throws(() => validateTunnelConfig({ ...cfg, webPassword: undefined }), /WEB_PASSWORD/);
    assert.throws(() => validateTunnelConfig({ ...cfg, webPort: 0 }), /WEB_PORT/);
    await assert.rejects(
      startCloudflareTunnel({ ...cfg, cloudflared: join(dir, 'missing') }),
      /Unable to start/,
    );
  } finally {
    await tunnel?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Named tunnel needs only token and auto-discovers its stable hostname; explicit BASE_URL overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-tunnel-named-'));
  try {
    const path = join(dir, 'cloudflared');
    await fake(path);
    const cfg = {
      ...config(),
      quickTunnel: false,
      cfTunnelToken: 'test-token-not-in-argv',
      baseUrl: undefined,
      webPort: 8080,
      webPassword: 'test-password',
      cloudflared: path,
      tunnelStartupTimeout: 2000,
    };
    for (let n = 0; n < 2; n++) {
      const tunnel = await startCloudflareTunnel(cfg);
      assert.equal(tunnel.url, 'https://fixed.example.com');
      await tunnel.close();
    }
    await fake(path, 'multi');
    const automatic = await startCloudflareTunnel(cfg);
    assert.equal(automatic.url, 'https://fixed.example.com');
    await automatic.close();
    const tunnel = await startCloudflareTunnel({
      ...cfg,
      baseUrl: 'https://chosen.example.com/browser',
    });
    assert.equal(tunnel.url, 'https://chosen.example.com/browser');
    await tunnel.close();
    assert.throws(
      () => validateTunnelConfig({ ...cfg, baseUrl: 'http://insecure.example.com' }),
      /HTTPS/,
    );
    assert.throws(() => validateTunnelConfig({ ...cfg, quickTunnel: true }), /mutually exclusive/);
    const routes = [{ hostname: 'one.example.com', service: 'http://localhost:8080' }];
    assert.equal(inferTunnelUrl({ ingress: routes }, 8080), 'https://one.example.com');
    const multiple = [...routes, { hostname: 'two.example.com', service: 'http://127.0.0.1:8080' }];
    assert.equal(inferTunnelUrl({ ingress: multiple }, 8080), 'https://one.example.com');
    assert.equal(
      inferTunnelUrl({ ingress: [...multiple].reverse() }, 8080),
      'https://two.example.com',
    );
    for (const ingress of [
      [],
      [{ hostname: '*.example.com', service: 'http://localhost:8080' }],
      [{ hostname: 'one.example.com', service: 'http://remote.test:8080' }],
    ])
      assert.throws(() => inferTunnelUrl({ ingress }, 8080), /BASE_URL/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Tunnel rejects early exit, unavailable readiness, deceptive URL and cancellation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-tunnel-errors-'));
  try {
    const path = join(dir, 'cloudflared');
    const cfg = {
      ...config(),
      quickTunnel: true,
      cfTunnelToken: undefined,
      baseUrl: undefined,
      webPort: 8080,
      webPassword: 'test-password',
      cloudflared: path,
      tunnelStartupTimeout: 500,
    };
    await fake(path, 'exit');
    await assert.rejects(
      startCloudflareTunnel({ ...cfg, tunnelStartupTimeout: 3000 }),
      /exited before/,
    );
    for (const mode of ['unready', 'evil']) {
      await fake(path, mode);
      await assert.rejects(startCloudflareTunnel(cfg), /timed out/);
    }
    await fake(path, 'hang');
    const controller = new AbortController();
    const starting = startCloudflareTunnel(
      { ...cfg, tunnelStartupTimeout: 2000 },
      controller.signal,
    );
    controller.abort();
    await assert.rejects(starting, /cancelled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tunnel origin errors emitted after readiness survive in queryable diagnostic history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-tunnel-diagnostics-'));
  let tunnel: Awaited<ReturnType<typeof startCloudflareTunnel>> | undefined;
  try {
    const path = join(dir, 'cloudflared');
    await fake(path, 'events');
    const cfg = {
      ...config(),
      dataDir: dir,
      quickTunnel: true,
      cfTunnelToken: undefined,
      baseUrl: undefined,
      webPort: 8080,
      webPassword: 'fixture-password',
      cloudflared: path,
      tunnelStartupTimeout: 2000,
    };
    const logs = new Diagnostics(cfg);
    await logs.init();
    let observed = false;
    tunnel = await startCloudflareTunnel(cfg, undefined, (event) => {
      logs.log({ component: 'tunnel', ...event });
      if (event.code === 'tunnel_origin_error') observed = true;
    });
    assert.equal(observed, false, 'The diagnostic should be emitted after startup settles');
    const port = Number(await readFile(path + '.port', 'utf8'));
    await fetch(`http://127.0.0.1:${port}/emit`);
    for (let n = 0; n < 100 && !observed; n++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(observed);
    await logs.flush();
    const restored = new Diagnostics(cfg);
    await restored.init();
    const events = await restored.query('web', { component: 'tunnel' });
    assert.equal(events.entries.length, 1);
    assert.equal(events.entries[0].code, 'tunnel_origin_error');
    assert.deepEqual(events.entries[0].fields, {
      source_time: '2026-10-25T12:21:50Z',
      connection_index: 3,
      ingress_rule: 1,
      reason: 'connection_reset',
      origin: 'http://localhost:8080',
    });
  } finally {
    await tunnel?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
