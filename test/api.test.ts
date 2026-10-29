import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { toolOpenApi } from '../src/api-schema.js';

test('OpenAPI input references resolve within their own tool components', async () => {
  const spec = await toolOpenApi('https://browser.example/prefix');
  assert.equal(spec.openapi, '3.1.1');
  assert.equal(Object.keys(spec.paths).length, 47);
  assert.equal(spec.servers[0].url, 'https://browser.example/prefix');
  let refs = 0;
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      refs++;
      let resolved: any = spec;
      for (const key of value.$ref.slice(2).split('/'))
        resolved = resolved?.[key.replaceAll('~1', '/').replaceAll('~0', '~')];
      assert.ok(resolved, value.$ref);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(spec);
  assert.ok(refs > 44);
});

test('HTTP tool API and MCP share instances, validation, idempotent actions, artifacts and logs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloudbrowser-api-'));
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as any).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const base = `http://127.0.0.1:${port}/browser`;
  const proc = spawn(process.execPath, ['dist/cli.js', 'daemon'], {
    env: {
      ...process.env,
      DATA_DIR: dir,
      MCP_SOCKET: join(dir, 'service.sock'),
      BASE_URL: base,
      WEB_PASSWORD: 'api-test-password',
      WEB_PORT: String(port),
      RECORD_VIDEO: 'false',
      MAX_INSTANCES: '2',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr!.on('data', (chunk) => (stderr += chunk));
  let client: Client | undefined;
  try {
    let ready = false;
    for (let n = 0; n < 150; n++) {
      try {
        if ((await fetch(base + '/healthz')).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, stderr);
    const { token } = JSON.parse(await readFile(join(dir, 'web-auth.json'), 'utf8'));
    assert.ok(token);
    const auth = { Authorization: `Bearer ${token}` };
    const headers = { ...auth, 'Content-Type': 'application/json' };
    const request = async (name: string, args: any = {}, extra: Record<string, string> = {}) => {
      const response = await fetch(`${base}/api/tools/${name}`, {
        method: 'POST',
        headers: { ...headers, ...extra },
        body: JSON.stringify(args),
      });
      const result: any = await response.json();
      assert.equal(response.headers.get('x-operation-id'), result.operation_id);
      return { response, result };
    };
    const connection: any = await (await fetch(base + '/api/connection', { headers: auth })).json();
    assert.equal(connection.api_base_url, base + '/api');
    assert.equal(connection.openapi_url, base + '/api/openapi.json');
    assert.equal(
      connection.agent_instructions.split('\n').at(-1),
      connection.api_instructions.split('\n').at(-1),
    );
    const guide = await fetch(connection.agent_guide_url, {
      headers: { Origin: 'https://agent.example' },
    });
    assert.equal(guide.status, 200);
    const markdown = await guide.text();
    for (const phrase of [
      'HTTP API 调用说明',
      '/api/tools/{工具名}',
      'tools/list',
      'Idempotency-Key',
      'access_token=',
      'get_network_request',
      'get_instance_details',
    ])
      assert.ok(markdown.includes(phrase), phrase);
    assert.ok(!markdown.includes(token));
    assert.ok(!markdown.includes('api-test-password'));
    assert.equal((await fetch(base + '/api/tools')).status, 401);
    assert.equal((await fetch(base + '/api/openapi.json')).status, 401);
    assert.equal(
      (
        await fetch(base + '/api/tools/health?access_token=' + token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );
    const login = await fetch(base + '/login', {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({ password: 'api-test-password' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.equal(
      (
        await fetch(base + '/api/tools/health', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );
    assert.equal((await fetch(base + '/api/tools', { headers: { Cookie: cookie } })).status, 200);
    assert.equal(
      (
        await fetch(base + '/api/tools/health', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://evil.example' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal((await fetch(base + '/api/tools/health', { headers: auth })).status, 405);
    assert.equal(
      (await fetch(base + '/api/tools/health', { method: 'POST', headers: auth, body: '{}' }))
        .status,
      415,
    );
    assert.equal(
      (await fetch(base + '/api/tools/health', { method: 'POST', headers, body: '{' })).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + '/api/tools/health', {
          method: 'POST',
          headers,
          body: JSON.stringify({ oversize: 'x'.repeat(1048576) }),
        })
      ).status,
      413,
    );
    assert.equal((await request('__proto__')).response.status, 404);
    assert.equal(
      (await request('navigate', { instance_id: 'x', page_id: 'y' })).result.error.code,
      'INVALID_ARGUMENT',
    );
    assert.equal(
      (await request('health', {}, { 'Idempotency-Key': 'invalid' })).response.status,
      400,
    );
    client = new Client({ name: 'api-interop-test', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: auth } }),
    );
    const mcpCall = async (name: string, args: any = {}) =>
      (await client!.callTool({ name, arguments: args })).structuredContent as any;
    const catalog: any = await (await fetch(base + '/api/tools', { headers: auth })).json();
    const mcpTools = await client.listTools();
    assert.deepEqual(
      catalog.tools.map((t: any) => t.name),
      mcpTools.tools.map((t) => t.name),
    );
    for (const tool of catalog.tools) {
      assert.deepEqual(
        tool.inputSchema,
        mcpTools.tools.find((t) => t.name === tool.name)!.inputSchema,
      );
      assert.equal(tool.url, `${base}/api/tools/${tool.name}`);
    }
    const op = randomUUID();
    const profilePath = base + '/api/settings/device-profiles';
    assert.equal((await fetch(profilePath)).status, 401);
    assert.equal((await fetch(profilePath, { method: 'PUT', body: '{}' })).status, 401);
    assert.equal(
      (await fetch(profilePath, { method: 'PUT', headers: { Cookie: cookie }, body: '{}' })).status,
      403,
    );
    const initialProfiles = await (await fetch(profilePath, { headers })).json();
    const customProfile = {
      profile_id: 'api-test-android',
      enabled: true,
      profile: { ...initialProfiles.profiles[1].profile, name: 'API saved Android' },
    };
    const saveProfiles = async (document: any) =>
      fetch(profilePath, { method: 'PUT', headers, body: JSON.stringify(document) });
    assert.equal(
      (await saveProfiles({ ...initialProfiles, profiles: [customProfile, customProfile] })).status,
      400,
    );
    const savedResponse = await saveProfiles({ ...initialProfiles, profiles: [customProfile] });
    assert.equal(savedResponse.status, 200);
    const savedProfiles = await savedResponse.json();
    assert.equal((await saveProfiles(initialProfiles)).status, 409);
    const filtered = await mcpCall('list_device_profiles', { platform: 'Android' });
    assert.deepEqual(
      filtered.data.map((p: any) => p.profile_id),
      [customProfile.profile_id],
    );
    assert.deepEqual(
      (await mcpCall('get_device_profile', { profile_id: customProfile.profile_id })).data.profile,
      customProfile.profile,
    );
    assert.equal(
      (await request('get_device_profile', { profile_id: 'unknown-profile' })).response.status,
      404,
    );
    assert.equal(
      (await request('create_instance', { device_profile_id: 'unknown-profile' })).response.status,
      404,
    );
    const profiled = await request('create_instance', {
      user_agent: customProfile.profile.user_agent.replace('155.0.0.0', '130.0.6723.58'),
      locale: 'pt-BR',
      timezone: 'America/Sao_Paulo',
      viewport: { width: 360, height: 780 },
      mobile: { touch: false, device_scale_factor: 3 },
    });
    assert.equal(profiled.response.status, 200, JSON.stringify(profiled.result));
    const profiledId = profiled.result.data.instance_id;
    assert.equal(profiled.result.data.device_profile_id, customProfile.profile_id);
    assert.equal(profiled.result.data.device_profile_source, 'ua_default');
    assert.equal(profiled.result.data.locale, 'pt-BR');
    assert.equal(profiled.result.data.timezone, 'America/Sao_Paulo');
    assert.equal(profiled.result.data.configuration_sources.locale, 'request');
    assert.deepEqual(profiled.result.data.viewport, { width: 360, height: 780 });
    assert.deepEqual(profiled.result.data.mobile, {
      enabled: true,
      touch: false,
      device_scale_factor: 3,
    });
    assert.equal(profiled.result.data.actual.device_scale_factor, 3);
    assert.equal(profiled.result.data.actual.touch_points, 0);
    assert.equal(profiled.result.data.locale_observation.language, 'pt-BR');
    assert.equal(profiled.result.data.user_agent_metadata.fullVersion, '130.0.6723.58');
    const effectiveProfile = profiled.result.data.device_profile;
    const measured = await mcpCall('evaluate', {
      instance_id: profiledId,
      page_id: profiled.result.data.pages[0].page_id,
      script:
        '({ua:navigator.userAgent,platform:navigator.platform,screenWidth:screen.width,touch:navigator.maxTouchPoints})',
    });
    assert.equal(
      measured.data.value.ua,
      customProfile.profile.user_agent.replace('155.0.0.0', '130.0.6723.58'),
    );
    assert.equal(measured.data.value.platform, customProfile.profile.navigator_platform);
    assert.equal(measured.data.value.screenWidth, 412);
    assert.equal(measured.data.value.touch, 0);
    const disabled = await (
      await saveProfiles({ ...savedProfiles, profiles: [{ ...customProfile, enabled: false }] })
    ).json();
    assert.deepEqual((await mcpCall('list_device_profiles')).data, []);
    assert.equal(
      (await mcpCall('get_device_profile', { profile_id: customProfile.profile_id })).data.enabled,
      false,
    );
    assert.equal(
      (await request('create_instance', { device_profile_id: customProfile.profile_id })).result
        .error.code,
      'DEVICE_PROFILE_DISABLED',
    );
    assert.equal((await saveProfiles({ ...disabled, profiles: [] })).status, 200);
    assert.deepEqual(
      (await mcpCall('get_instance', { instance_id: profiledId })).data.device_profile,
      effectiveProfile,
    );
    await mcpCall('close_instance', { instance_id: profiledId });
    const history = (await mcpCall('inspect_instance', { instance_id: profiledId, probe: false }))
      .data;
    assert.deepEqual(history.instance.environment.device_profile, effectiveProfile);
    assert.equal(history.instance.environment.device_profile_id, customProfile.profile_id);
    assert.equal(history.instance.environment.device_profile_source, 'ua_default');
    const detailArgs = { instance_id: profiledId };
    const aggregate = await request('get_instance_details', detailArgs);
    assert.equal(aggregate.response.status, 200);
    assert.equal(aggregate.result.data.current, null);
    assert.equal(aggregate.result.data.instance.status, 'closed');
    assert.equal(aggregate.result.data.navigation.recorded, true);
    assert.ok(aggregate.result.data.logs.entries.some((e: any) => e.code === 'instance_closed'));
    assert.deepEqual(
      (await mcpCall('get_instance_details', detailArgs)).data,
      aggregate.result.data,
    );
    const detailDocument = await (
      await fetch(`${base}/instances/${profiledId}?format=json`, { headers: auth })
    ).json();
    assert.deepEqual(aggregate.result.data, detailDocument);
    assert.ok(!JSON.stringify(detailDocument).includes(token));
    assert.equal(
      (await request('get_instance_details', { instance_id: `ins_${randomUUID()}` })).response
        .status,
      404,
    );
    assert.equal(
      (await request('get_instance_details', { ...detailArgs, owner: 'another-principal' }))
        .response.status,
      400,
    );
    const unmatched = await request('create_instance', {
      user_agent: customProfile.profile.user_agent,
      viewport: { width: 640, height: 480 },
    });
    assert.equal(unmatched.result.data.device_profile, null);
    assert.equal(unmatched.result.data.device_profile_source, 'ua_unmatched');
    assert.equal(unmatched.result.data.viewport.width, 640);
    assert.ok(
      unmatched.result.data.warnings.some((s: string) => s.includes('No enabled profile matches')),
    );
    await mcpCall('close_instance', { instance_id: unmatched.result.data.instance_id });
    const createArgs = {
      task_description: 'API 与 MCP 交替验收',
      viewport: { width: 640, height: 480 },
    };
    const calls = await Promise.all([
      request('create_instance', createArgs, { 'Idempotency-Key': op }),
      request('create_instance', createArgs, { 'Idempotency-Key': op }),
    ]);
    assert.equal(calls[0].response.status, 200, JSON.stringify(calls[0].result));
    assert.deepEqual(calls[0].result, calls[1].result);
    const created = calls[0].result.data;
    const id = created.instance_id;
    assert.equal(created.details_url, `${base}/instances/${id}?access_token=`);
    assert.equal((await mcpCall('list_instances')).data.length, 1);
    const replay = await request(
      'create_instance',
      { viewport: { height: 480, width: 640 }, task_description: createArgs.task_description },
      { 'Idempotency-Key': op },
    );
    assert.deepEqual(replay.result, calls[0].result);
    assert.equal(
      (
        await request(
          'create_instance',
          { task_description: 'different' },
          { 'Idempotency-Key': op },
        )
      ).response.status,
      409,
    );
    assert.equal(
      (await request('close_instance', { instance_id: id }, { 'Idempotency-Key': op })).result.error
        .code,
      'OPERATION_ID_CONFLICT',
    );
    const page_id = created.pages[0].page_id;
    const evaluated = await mcpCall('evaluate', {
      instance_id: id,
      page_id,
      script: 'document.body.innerHTML = "<h1>API and MCP</h1>"',
    });
    assert.equal(evaluated.status, 'succeeded', JSON.stringify(evaluated));
    const shot = await request('screenshot', { instance_id: id, page_id });
    assert.equal(shot.response.status, 200, JSON.stringify(shot.result));
    const artifact = await request('get_artifact', {
      artifact_id: shot.result.data.id,
      length: 524288,
    });
    assert.equal(artifact.result.data.mime, 'image/png');
    assert.ok(
      Buffer.from(artifact.result.data.data_base64, 'base64')
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    );
    assert.equal((await mcpCall('get_operation', { operation_id: op })).data.data.instance_id, id);
    const close = await request('close_instance', { instance_id: id });
    assert.equal(close.response.status, 200);
    const log = await request('get_logs', { instance_id: id, component: 'operation' });
    const entries = log.result.data.entries;
    for (const operation of [
      op,
      shot.result.operation_id,
      close.result.operation_id,
      evaluated.operation_id,
    ])
      assert.ok(
        entries.some((e: any) => e.operation_id === operation && e.code === 'operation_succeeded'),
        operation,
      );
    assert.equal(
      entries.filter((e: any) => e.operation_id === op && e.code === 'operation_succeeded').length,
      1,
    );
  } finally {
    await client?.close();
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  }
});
