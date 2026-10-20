import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const base = (process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const password = process.env.SMOKE_PASSWORD;
if (!password) throw Error('Set SMOKE_PASSWORD to the test deployment password.');
let client: Client | undefined, instance: string | undefined;
const shares: string[] = [];
const call = async (name: string, args: Record<string, unknown>) => {
  const result: any = await client!.callTool({ name, arguments: args });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 'succeeded', JSON.stringify(parsed));
  return parsed.data;
};
try {
  const login = await fetch(base + '/login', {
    method: 'POST',
    body: new URLSearchParams({ password }),
    redirect: 'manual',
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const info: any = await (
    await fetch(base + '/api/connection', { headers: { Cookie: cookie } })
  ).json();
  assert.equal(info.agent_instructions.split('\n').length, 4);
  assert.ok(
    info.agent_instructions.includes(
      info.mcp_config.mcpServers['cloudbrowser'].headers.Authorization,
    ),
  );
  const publicGuide = await fetch(info.agent_guide_url);
  assert.equal(publicGuide.status, 200);
  const guide = await publicGuide.text();
  assert.ok(guide.includes('create_instance'));
  assert.ok(
    !guide.includes(info.mcp_config.mcpServers['cloudbrowser'].headers.Authorization.slice(7)),
  );
  client = new Client({ name: 'http-smoke', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(info.mcp_url), {
      requestInit: { headers: info.mcp_config.mcpServers['cloudbrowser'].headers },
    }),
  );
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === 'list_recordings'));
  const created: any = await client.callTool({
    name: 'create_instance',
    arguments: { viewport: { width: 390, height: 844 } },
  });
  const result = JSON.parse(created.content[0].text);
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  instance = result.data.instance_id;
  const inspection = await call('inspect_instance', { instance_id: instance, probe: true });
  assert.equal(inspection.responsiveness.status, 'responsive');
  assert.ok(
    (await call('get_logs', { instance_id: instance })).entries.some(
      (r: any) => r.code === 'instance_created',
    ),
  );
  const readFrame = async (url: string, headers?: Record<string, string>) => {
    const signal = AbortSignal.timeout(15000);
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await fetch(url, { headers, signal });
      if (response.status === 204) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type')!, /image\/jpeg/);
      assert.ok(
        Buffer.from(await response.arrayBuffer())
          .subarray(0, 2)
          .equals(Buffer.from([255, 216])),
      );
      return;
    }
    throw Error('No live frame available');
  };
  await readFrame(`${base}/api/instances/${instance}/frame`, { Cookie: cookie });
  const sharedLive = await call('create_share_link', { kind: 'live', instance_id: instance });
  shares.push(sharedLive.share_id);
  assert.equal((await fetch(sharedLive.url)).status, 200);
  await readFrame(sharedLive.frame_url);
  const closed: any = await client.callTool({
    name: 'close_instance',
    arguments: { instance_id: instance },
  });
  assert.equal(JSON.parse(closed.content[0].text).status, 'succeeded');
  const history: any[] = (await (
    await fetch(base + '/api/recordings', { headers: { Cookie: cookie } })
  ).json()) as any[];
  const recording = history.find((r) => r.instance_id === instance);
  assert.equal(recording.status, 'completed', JSON.stringify(recording));
  const response = await fetch(`${base}/api/recordings/${recording.id}/video`, {
    headers: { Cookie: cookie, Range: 'bytes=0-3' },
  });
  assert.equal(response.status, 206);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString('hex'), '1a45dfa3');
  const sharedRecording = await call('create_share_link', {
    kind: 'recording',
    recording_id: recording.id,
  });
  shares.push(sharedRecording.share_id);
  const publicVideo = await fetch(sharedRecording.media_url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(publicVideo.status, 206);
  assert.equal(Buffer.from(await publicVideo.arrayBuffer()).toString('hex'), '1a45dfa3');
  await call('revoke_share_link', { share_id: sharedRecording.share_id });
  assert.equal((await fetch(sharedRecording.media_url)).status, 404);
  const postmortem = await call('inspect_instance', { instance_id: instance, probe: false });
  assert.equal(postmortem.instance.close_reason, 'requested');
  instance = undefined;
  console.log(
    `HTTP MCP smoke passed: ${tools.tools.length} tools, password login, authenticated connection, live JPEG, WebM playback, public share links and revocation`,
  );
} finally {
  for (const share_id of shares)
    await client?.callTool({ name: 'revoke_share_link', arguments: { share_id } }).catch(() => {});
  if (instance)
    await client
      ?.callTool({ name: 'close_instance', arguments: { instance_id: instance } })
      .catch(() => {});
  await client?.close();
}
