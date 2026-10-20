import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
// Use --docker for an already-running cloudbrowser container.
const docker = process.argv.includes('--docker');
const transport = new StdioClientTransport(
  docker
    ? {
        command: 'docker',
        args: [
          'exec',
          '-i',
          process.env.SMOKE_CONTAINER ?? 'cloudbrowser',
          'node',
          'dist/cli.js',
          'stdio',
        ],
      }
    : {
        command: process.execPath,
        args: ['dist/cli.js', 'stdio'],
        env: { ...process.env } as Record<string, string>,
      },
);
const client = new Client({ name: 'cloudbrowser-smoke', version: '1.0.0' });
await client.connect(transport);
let activeInstance: string | undefined;
try {
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === 'create_instance'));
  const health = await client.callTool({ name: 'health', arguments: {} });
  assert.equal(health.isError, false);
  const r: any = await client.callTool({
    name: 'create_instance',
    arguments: { user_agent: 'MCP-Smoke/1.0', viewport: { width: 390, height: 844 } },
  });
  assert.equal(r.isError, false, JSON.stringify(r));
  const data = JSON.parse(r.content[0].text).data;
  activeInstance = data.instance_id;
  assert.equal(data.actual.user_agent, 'MCP-Smoke/1.0');
  const pages: any = await client.callTool({
    name: 'list_pages',
    arguments: { instance_id: data.instance_id },
  });
  assert.equal(pages.isError, false);
  if (process.env.SMOKE_URL) {
    const nav: any = await client.callTool({
      name: 'navigate',
      arguments: {
        instance_id: data.instance_id,
        page_id: data.pages[0].page_id,
        url: process.env.SMOKE_URL,
      },
    });
    assert.equal(nav.isError, false, JSON.stringify(nav));
    const snap: any = await client.callTool({
      name: 'snapshot',
      arguments: { instance_id: data.instance_id, page_id: data.pages[0].page_id },
    });
    assert.equal(snap.isError, false, JSON.stringify(snap));
    console.log('Navigation snapshot:', JSON.parse(snap.content[0].text).data.tree.slice(0, 500));
  }
  const close = await client.callTool({
    name: 'close_instance',
    arguments: { instance_id: data.instance_id },
  });
  assert.equal(close.isError, false);
  activeInstance = undefined;
  console.log(
    `MCP smoke passed: ${tools.tools.length} tools, health, browser UA/viewport, pages, close`,
  );
} finally {
  if (activeInstance)
    await client
      .callTool({ name: 'close_instance', arguments: { instance_id: activeInstance } })
      .catch(() => {});
  await client.close();
}
