// Development-only preview: run against a local service configured with ALLOW_PRIVATE_NETWORKS=true.
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const base = process.env.PREVIEW_BASE_URL ?? 'http://127.0.0.1:8765';
const password = process.env.PREVIEW_PASSWORD;
if (!password) throw Error('PREVIEW_PASSWORD required');
const fixture = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(
    '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#e8f2ff;font:18px system-ui;padding:30px;color:#13305c}h1{font-size:32px}button{padding:15px;border:0;border-radius:8px;background:#255cbb;color:white}article{background:white;border-radius:15px;padding:25px;margin-top:25px}</style><h1>Browser session</h1><p>Live page controlled through authenticated MCP</p><article><strong>Mobile viewport · 390 × 844</strong><p>HTTP transport connected. Video sampling at 2 FPS.</p><button onclick="this.textContent=\'Action completed\'">Run sample action</button></article>',
  );
});
await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
const login = await fetch(base + '/login', {
  method: 'POST',
  body: new URLSearchParams({ password }),
  redirect: 'manual',
});
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw Error('Preview login failed');
const info: any = await (
  await fetch(base + '/api/connection', { headers: { Cookie: cookie } })
).json();
const client = new Client({ name: 'preview', version: '1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(info.mcp_url), {
    requestInit: { headers: info.mcp_config.mcpServers['cloudbrowser'].headers },
  }),
);
const created: any = await client.callTool({
  name: 'create_instance',
  arguments: {
    viewport: { width: 390, height: 844 },
    mobile: { enabled: true, touch: true, device_scale_factor: 1 },
  },
});
const result = JSON.parse(created.content[0].text);
if (result.status !== 'succeeded') throw Error(JSON.stringify(result));
const i = result.data;
await client.callTool({
  name: 'navigate',
  arguments: {
    instance_id: i.instance_id,
    page_id: i.pages[0].page_id,
    url: process.env.PREVIEW_URL ?? `http://127.0.0.1:${(fixture.address() as any).port}`,
  },
});
console.log('Preview instance created:', i.instance_id);
if (process.env.PREVIEW_SHARE === 'true') {
  const shared: any = await client.callTool({
    name: 'create_share_link',
    arguments: { kind: 'live', instance_id: i.instance_id, expires_in_seconds: 3600 },
  });
  console.log('Public preview:', JSON.parse(shared.content[0].text).data.url);
}
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await client
    .callTool({ name: 'close_instance', arguments: { instance_id: i.instance_id } })
    .catch(() => {});
  await client.close();
  fixture.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
