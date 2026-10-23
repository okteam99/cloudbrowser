import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebAuth } from '../src/auth.js';
import { config } from '../src/config.js';
import { requestOriginMatchesHost } from '../src/web.js';
import { chromium, type Browser } from 'playwright';

const freePort = async () => {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
};
const stop = async (p: ChildProcess) => {
  if (p.exitCode !== null) return;
  const end = new Promise<void>((r) => p.once('exit', () => r()));
  p.kill('SIGTERM');
  await end;
};
test('default concurrency is 10 and password changes rotate persisted MCP token', async () => {
  assert.equal(config().maxInstances, 10);
  assert.equal(requestOriginMatchesHost('https://alias.example', 'alias.example'), true);
  assert.equal(requestOriginMatchesHost('https://alias.example', 'alias.example:443'), true);
  assert.equal(requestOriginMatchesHost('http://localhost:8080', 'localhost:8080'), true);
  for (const [origin, host] of [
    ['https://attacker.example', 'alias.example'],
    ['null', 'alias.example'],
    ['https://alias.example/path', 'alias.example'],
    ['https://alias.example', 'user@alias.example'],
    ['https://alias.example', 'alias.example/other'],
    ['https://alias.example', undefined],
  ])
    assert.equal(requestOriginMatchesHost(origin!, host), false);
  const dir = await mkdtemp(join(tmpdir(), 'mcp-auth-'));
  try {
    const a = new WebAuth();
    await a.init(dir, 'old-password');
    const token = a.token;
    assert.ok(a.login('a', 'old-password').session);
    assert.equal(a.login('a', 'wrong').session, undefined);
    const b = new WebAuth();
    await b.init(dir, 'old-password');
    assert.equal(b.token, token);
    const c = new WebAuth();
    await c.init(dir, 'new-password');
    assert.notEqual(c.token, token);
    assert.equal(c.bearer('Bearer ' + token), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('password web portal, BASE_URL prefix, authenticated HTTP MCP, live JPEG and persistent video playback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-web-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/browser`;
  const fixture = http.createServer((req, res) => {
    if (req.url === '/ip') {
      res.setHeader('content-type', 'application/json');
      res.end('{"ip":"8.8.4.4"}');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Live fixture</title><h1>Live recording test</h1><button onclick="document.body.style.background=\'green\'">Change</button>',
    );
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  const fixtureUrl = `http://127.0.0.1:${(fixture.address() as any).port}`;
  let logs = '';
  const start = async () => {
    const p = spawn(process.execPath, ['dist/cli.js', 'daemon'], {
      env: {
        ...process.env,
        DATA_DIR: dir,
        MCP_SOCKET: join(dir, 'service.sock'),
        BASE_URL: base,
        WEB_PASSWORD: 'test-password-123',
        WEB_PORT: String(port),
        ALLOW_PRIVATE_NETWORKS: 'true',
        PROXY_CHECK_URL: fixtureUrl,
        MAX_INSTANCES: '1',
        RECORD_VIDEO: 'true',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    p.stderr!.on('data', (c) => (logs += c));
    let ready = false;
    for (let n = 0; n < 100; n++) {
      try {
        if ((await fetch(base + '/healthz')).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ready, logs);
    return p;
  };
  let proc = await start();
  let client: Client | undefined;
  let viewer: Browser | undefined;
  try {
    const invalid = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: 'http://[' }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.end();
    });
    assert.equal(invalid, 400);
    const root = await fetch(base);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /访问密码/);
    assert.equal((await fetch(base + '/api/connection')).status, 401);
    assert.equal((await fetch(base + '/api/proxies')).status, 401);
    assert.equal((await fetch(base + '/api/proxy-health')).status, 401);
    assert.equal((await fetch(base + '/api/settings')).status, 401);
    assert.equal((await fetch(base + '/api/settings', { method: 'PUT', body: '{}' })).status, 401);
    assert.equal((await fetch(base + '/mcp', { method: 'POST', body: '{}' })).status, 401);
    const publicGuide = await fetch(base + '/docs/agent-guide.md', {
      headers: { Origin: 'https://agent.example' },
    });
    assert.equal(publicGuide.status, 200);
    assert.equal(publicGuide.headers.get('access-control-allow-origin'), '*');
    assert.match(publicGuide.headers.get('content-type')!, /text\/plain/);
    const guideText = await publicGuide.text();
    for (const name of [
      'tools/list',
      'create_instance',
      'create_share_link',
      'upload_file',
      'close_instance',
    ])
      assert.ok(guideText.includes(name));
    assert.ok(!guideText.includes('test-password-123'));
    const guideHead = await fetch(base + '/docs/agent-guide.md', { method: 'HEAD' });
    assert.equal(guideHead.status, 200);
    assert.equal(Number(guideHead.headers.get('content-length')), Buffer.byteLength(guideText));
    assert.equal(await guideHead.text(), '');
    assert.equal((await fetch(base + '/docs/mcp-api.md')).status, 401);
    assert.equal((await fetch(base + '/docs/mcp-tools.json')).status, 401);
    assert.equal((await fetch(base + '/docs/agent-guide.md', { method: 'POST' })).status, 401);

    assert.equal(
      (
        await fetch(base + '/login', {
          method: 'POST',
          body: new URLSearchParams({ password: 'wrong' }),
          redirect: 'manual',
        })
      ).status,
      401,
    );
    const login = await fetch(base + '/login', {
      method: 'POST',
      body: new URLSearchParams({ password: 'test-password-123' }),
      redirect: 'manual',
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const headers = { Cookie: cookie };
    const defaults = await (await fetch(base + '/api/settings', { headers })).json();
    assert.equal(defaults.storage.max_data_bytes, 200 * 1024 ** 3);
    assert.equal(defaults.storage.screenshot_retention_days, 7);
    assert.equal(
      (await fetch(base + '/api/settings', { method: 'PUT', headers, body: '{}' })).status,
      403,
    );
    const aliasRequest = (
      path: string,
      method = 'GET',
      data?: string,
      origin = 'https://console-alias.example',
    ) =>
      new Promise<{ status: number; body: string; cookie?: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/browser' + path,
            method,
            headers: {
              Host: 'console-alias.example',
              Origin: origin,
              ...headers,
              'content-type': 'application/x-www-form-urlencoded',
            },
          },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () =>
              resolve({ status: res.statusCode!, body, cookie: res.headers['set-cookie']?.[0] }),
            );
          },
        );
        req.on('error', reject);
        req.end(data);
      });
    const aliasLogin = await aliasRequest(
      '/login',
      'POST',
      new URLSearchParams({ password: 'test-password-123' }).toString(),
    );
    assert.equal(aliasLogin.status, 303);
    assert.ok(aliasLogin.cookie?.includes('HttpOnly'));
    const aliasConnection = await aliasRequest('/api/connection');
    assert.equal(aliasConnection.status, 200);
    assert.equal(
      JSON.parse(aliasConnection.body).base_url,
      base,
      'Link generation keeps BASE_URL as the primary URL',
    );
    assert.equal(
      (
        await aliasRequest(
          '/login',
          'POST',
          new URLSearchParams({ password: 'test-password-123' }).toString(),
          'https://untrusted.example',
        )
      ).status,
      403,
    );
    assert.equal(
      (await fetch(base + '/api/proxies', { method: 'POST', headers, body: '{}' })).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + '/api/proxies', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://untrusted.example' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.match(await (await fetch(base + '/', { headers })).text(), /正在加载浏览器控制台/);
    assert.equal((await fetch(base + '/assets/app.js')).status, 200);
    assert.equal((await fetch(base + '/assets/app.css')).status, 200);
    assert.equal((await fetch(base + '/assets/not-found.js')).status, 404);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      await page.goto(base + '/');
      await page.getByLabel('访问密码').fill('test-password-123');
      await page.getByRole('button', { name: /^登\s*录$/, exact: true }).click();
      await page.getByRole('button', { name: '复制 Agent 接入信息' }).waitFor({ timeout: 5000 });
      await page.getByRole('menuitem', { name: '系统设置' }).click();
      await page.getByLabel('产物存储配额（GB）', { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel('产物存储配额（GB）', { exact: true }).inputValue(),
        '200',
      );
      assert.equal(await page.getByLabel('截图保留天数', { exact: true }).inputValue(), '7');
      await page.getByLabel('产物存储配额（GB）', { exact: true }).fill('201');
      await page.getByLabel('截图保留天数', { exact: true }).fill('9');
      await page.getByRole('button', { name: '保存设置' }).click();
      await page.getByText('存储设置已保存并生效', { exact: true }).waitFor();
      await page.reload();
      await page.getByLabel('产物存储配额（GB）', { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel('产物存储配额（GB）', { exact: true }).inputValue(),
        '201',
      );
      await page.getByRole('menuitem', { name: 'MCP 接入' }).click();
      await page.getByLabel('MCP 地址', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('MCP 地址', { exact: true }).inputValue(), base + '/mcp');
      assert.ok(
        (await page.locator('#config').innerText()).includes('••••••••'),
        'Token should be masked by default',
      );
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.getByRole('button', { name: '复制 MCP 配置' }).click();
      const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
      assert.equal(copied.mcpServers['cloudbrowser'].url, base + '/mcp');
      assert.match(copied.mcpServers['cloudbrowser'].headers.Authorization, /^Bearer [\w-]+$/);
      await page.getByRole('button', { name: '复制 Agent 接入信息', exact: true }).click();
      const copiedGuide = await page.evaluate(() => navigator.clipboard.readText());
      assert.equal(copiedGuide.split('\n').length, 4);
      assert.ok(copiedGuide.includes(copied.mcpServers['cloudbrowser'].headers.Authorization));
      assert.ok(copiedGuide.endsWith(base + '/docs/agent-guide.md'));
      assert.ok(copiedGuide.includes(base + '/mcp'));
      assert.equal(
        await page.getByRole('link', { name: '查看公开接入文档' }).getAttribute('href'),
        base + '/docs/agent-guide.md',
      );
      assert.ok(
        !guideText.includes(copied.mcpServers['cloudbrowser'].headers.Authorization.split(' ')[1]),
      );

      await page.getByRole('heading', { name: '一步，把云浏览器连接到你的 Agent' }).waitFor();
      await page.getByRole('menuitem', { name: '代理管理' }).click();
      await page.getByRole('button', { name: '添加代理' }).click();
      await page.getByLabel('名称（可选）').fill('美国 · UI 测试代理');
      await page.getByLabel('服务器 IP / 域名').fill('203.0.113.2');
      await page.getByLabel('用户名', { exact: true }).fill('ui-user');
      const password = page.getByLabel('密码（明文）', { exact: true });
      assert.equal(await password.getAttribute('type'), 'text');
      await password.fill('ui-proxy-password');
      await page.getByRole('button', { name: '保存代理' }).click();
      await page.getByText('ui-proxy-password', { exact: true }).waitFor();
      assert.equal(await page.locator('.proxy-name').innerText(), 'UI 测试代理');
      assert.match(await page.locator('.proxy-id').innerText(), /^proxy_.+\.\.\..+$/);
      const fullProxyId = await page
        .locator('.proxy-table .ant-table-row')
        .getAttribute('data-row-key');
      await page.getByRole('button', { name: '复制代理 ID UI 测试代理', exact: true }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), fullProxyId);
      assert.ok(
        (await page.locator('.proxy-table tbody .ant-table-row').boundingBox())!.height <= 60,
        'Proxy row should remain compact',
      );
      await page.getByRole('button', { name: '编辑代理 UI 测试代理', exact: true }).click();
      assert.equal(await page.getByLabel('服务器 IP / 域名').inputValue(), '203.0.113.2');
      await page.getByLabel('密码（明文）', { exact: true }).fill('ui-proxy-updated');
      await page.getByRole('button', { name: '保存代理' }).click();
      await page.getByText('ui-proxy-updated', { exact: true }).waitFor();
      await page.getByRole('switch', { name: '启用代理 UI 测试代理', exact: true }).click();
      await page.waitForFunction(async (base) => {
        const rows = await (await fetch(base + '/api/proxies')).json();
        return rows.length === 1 && rows[0].enabled === false;
      }, base);
      await page.getByLabel('筛选状态', { exact: true }).click();
      await page
        .locator('.ant-select-dropdown')
        .filter({ visible: true })
        .getByText('已停用', { exact: true })
        .click();
      await page.getByText('显示 1 / 1', { exact: true }).waitFor();
      await page.getByLabel('搜索代理', { exact: true }).fill('missing-proxy');
      await page.getByText('没有符合筛选条件的代理', { exact: true }).waitFor();
      await page.getByRole('button', { name: '重置筛选', exact: true }).click();
      await page.getByText('ui-proxy-updated', { exact: true }).waitFor();
      await page.getByRole('switch', { name: '启用代理 UI 测试代理', exact: true }).click();
      await page.waitForFunction(
        async (base) => (await (await fetch(base + '/api/proxies')).json())[0]?.enabled === true,
        base,
      );
      await page.getByRole('menuitem', { name: '使用文档' }).click();
      await page.locator('.markdown-body').waitFor();
      const deployment = page.locator('.markdown-body pre').first();
      assert.match(await deployment.innerText(), /bdpgogoup\/cloudbrowser:\d{14}/);
      assert.ok(
        (await deployment.innerText()).split('\n').length > 5,
        'Deployment command should use readable shell continuations',
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: '打开导航' }).waitFor();
      await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        'Mobile layout must not overflow horizontally',
      );
      assert.ok(
        await deployment.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        'Deployment command must wrap without horizontal clipping',
      );
      await page.getByRole('button', { name: '打开导航' }).click();
      await page.getByRole('menuitem', { name: '实时实例' }).click();
      await page.getByText('选择一个实例开始观看', { exact: true }).waitFor();
    } finally {
      await browser.close();
    }

    const connection: any = await (await fetch(base + '/api/connection', { headers })).json();
    assert.equal(connection.mcp_url, base + '/mcp');
    assert.equal(connection.max_instances, 1);
    assert.equal(connection.agent_guide_url, base + '/docs/agent-guide.md');
    assert.equal(connection.agent_instructions.split('\n').length, 4);
    assert.ok(connection.agent_instructions.length < 700);
    assert.equal((connection.agent_instructions.match(/https?:\/\/\S+/g) ?? []).length, 2);
    assert.ok(connection.agent_instructions.includes(connection.agent_guide_url));
    const auth = connection.mcp_config.mcpServers['cloudbrowser'].headers;
    assert.ok(auth.Authorization.startsWith('Bearer '));
    assert.ok(!connection.mcp_url.includes(auth.Authorization.slice(7)));
    assert.equal(
      (
        await fetch(base + '/api/connection', {
          headers: { ...headers, Origin: 'https://evil.test' },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(base + '/docs/mcp-api.md', { headers })).status, 200);
    client = new Client({ name: 'web-test', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.mcp_url), {
        requestInit: { headers: auth },
      }),
    );
    assert.equal((await client.listTools()).tools.length, 42);
    const savedList: any = await client.callTool({
      name: 'list_proxies',
      arguments: { protocol: 'socks5', country: 'US' },
    });
    const savedProxies = JSON.parse(savedList.content[0].text).data;
    assert.equal(savedProxies.length, 1);
    assert.equal(savedProxies[0].name, 'UI 测试代理');
    assert.ok(savedProxies[0].proxy_id.startsWith('proxy_'));
    assert.ok(
      !JSON.stringify(savedProxies).includes('ui-user') &&
        !JSON.stringify(savedProxies).includes('ui-proxy-updated'),
    );
    const proxyFailure = await client.callTool({
      name: 'proxy_curl',
      arguments: { proxy_id: 'unknown', url: 'https://example.com/' },
    });
    assert.equal(proxyFailure.isError, true);
    const call = async (name: string, args: any = {}) => {
      const r: any = await client!.callTool({ name, arguments: args });
      return JSON.parse(r.content[0].text);
    };
    const taskDescription = '验证移动端页面与下载流程 <任务目标>';
    const result = await call('create_instance', {
      task_description: taskDescription,
      viewport: { width: 390, height: 844 },
      mobile: { enabled: true, touch: true, device_scale_factor: 2 },
    });
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    const id = result.data.instance_id;
    assert.equal(result.data.task_description, taskDescription);
    const logUrl = `${base}/api/instances/${id}/logs`;
    assert.equal((await fetch(logUrl)).status, 401);
    assert.equal((await fetch(logUrl + '?limit=201', { headers })).status, 400);
    assert.equal((await fetch(logUrl + '?component=wrong', { headers })).status, 400);
    assert.equal(
      (
        await fetch(`${base}/api/instances/ins_00000000-0000-0000-0000-000000000099/logs`, {
          headers,
        })
      ).status,
      404,
    );
    const ids = { instance_id: id, page_id: result.data.pages[0].page_id };
    assert.equal((await call('create_instance')).error.code, 'INSTANCE_LIMIT');
    await call('navigate', { ...ids, url: fixtureUrl + '/?token=complete-url#original' });
    await call('screenshot', ids);
    await call('interact', { ...ids, action: 'click', target: { role: 'button', name: 'Change' } });
    viewer = await chromium.launch({ headless: true });
    const viewerContext = await viewer.newContext({ viewport: { width: 1280, height: 900 } });
    await viewerContext.addCookies([
      { name: 'browser_session', value: cookie.split('=')[1], url: base + '/' },
    ]);
    const viewerPage = await viewerContext.newPage();
    viewerPage.setDefaultTimeout(10000);
    await viewerPage.goto(base + '/#instances');
    await viewerPage.getByRole('button', { name: /^观看实例/ }).click();
    await viewerPage.waitForFunction(
      () => {
        const image = document.querySelector('.live-image') as HTMLImageElement;
        return image?.naturalWidth > 0 && getComputedStyle(image).visibility === 'visible';
      },
      undefined,
      { timeout: 10000 },
    );

    assert.equal(
      await viewerPage.locator('.live-instance-task .instance-task-full').innerText(),
      taskDescription,
    );
    await viewerPage.getByRole('button', { name: `查看实例日志 ${id}`, exact: true }).click();
    const logDrawer = viewerPage.getByRole('dialog', { name: /实例调用日志/ });
    await logDrawer.getByText(taskDescription, { exact: true }).waitFor();
    await logDrawer.getByText('navigate', { exact: true }).waitFor();
    await logDrawer.getByText('screenshot', { exact: true }).waitFor();
    const navigateRow = logDrawer.locator('.ant-table-row').filter({ hasText: 'navigate' });
    await navigateRow.locator('.ant-table-row-expand-icon').click();
    await logDrawer
      .locator('.instance-log-detail pre')
      .filter({ hasText: 'complete-url#original' })
      .waitFor();
    await logDrawer.locator('.ant-drawer-close').click();
    assert.equal(
      await viewerPage.locator('.instance-proxy-address').innerText(),
      '直连（未使用代理）',
    );
    assert.equal(await viewerPage.locator('.instance-egress').innerText(), '未检测');
    assert.ok(
      (await viewerPage.locator('.instance-user-agent').innerText()).includes(
        result.data.actual.user_agent,
      ),
    );
    await viewerContext.grantPermissions(['clipboard-read', 'clipboard-write']);
    await viewerPage.getByRole('button', { name: '复制 UA', exact: true }).click();
    assert.equal(
      await viewerPage.evaluate(() => navigator.clipboard.readText()),
      result.data.actual.user_agent,
    );
    await call('verify_environment', { instance_id: id, check_url: fixtureUrl + '/ip' });
    await viewerPage.waitForFunction(
      () => document.querySelector('.instance-egress')?.textContent?.trim() === '8.8.4.4',
    );
    assert.ok((await viewerPage.locator('.instance-environment').innerText()).includes('8.8.4.4'));

    const liveShare = (await call('create_share_link', { kind: 'live', instance_id: id })).data;
    assert.ok(liveShare.url.startsWith(base + '/share/'));
    assert.equal(liveShare.access, 'public_read_only');
    assert.equal(
      (
        await call('create_share_link', {
          kind: 'recording',
          recording_id: result.data.recording_id,
        })
      ).error.code,
      'RECORDING_NOT_READY',
    );
    const publicContext = await viewer.newContext({ viewport: { width: 390, height: 844 } });
    const publicPage = await publicContext.newPage();
    const protectedRequests: string[] = [];
    publicPage.on('request', (r) => {
      if (new URL(r.url()).pathname.includes('/api/')) protectedRequests.push(r.url());
    });
    await publicPage.goto(liveShare.url);
    await publicPage.getByText('仅可观看').waitFor();
    await publicPage.waitForFunction(
      () =>
        (document.querySelector('.public-viewer-media img') as HTMLImageElement)?.naturalWidth > 0,
    );
    assert.equal(await publicPage.locator('nav').count(), 0);
    assert.deepEqual(protectedRequests, []);
    assert.equal(
      await publicPage
        .locator('body')
        .evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    const publicHtml = await fetch(liveShare.url);
    assert.equal(publicHtml.headers.get('referrer-policy'), 'no-referrer');
    assert.match(publicHtml.headers.get('x-robots-tag')!, /noindex/);
    assert.ok(!(await publicHtml.text()).includes(auth.Authorization));
    const publicFrame = await fetch(liveShare.frame_url);
    assert.equal(publicFrame.status, 200);
    assert.equal(
      Buffer.from(await publicFrame.arrayBuffer())
        .subarray(0, 2)
        .toString('hex'),
      'ffd8',
    );
    const shareToken = liveShare.url.split('/').at(-1)!;
    assert.equal(
      (
        await fetch(base + '/api/connection', {
          headers: { Authorization: `Bearer ${shareToken}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + '/mcp', {
          method: 'POST',
          headers: { Authorization: `Bearer ${shareToken}` },
          body: '{}',
        })
      ).status,
      401,
    );
    assert.equal((await fetch(base + '/share/' + 'a'.repeat(43))).status, 404);
    assert.equal(
      (await fetch(base + '/share/' + 'a'.repeat(43) + '/media', { headers: auth })).status,
      404,
    );
    const revokeShare = (await call('create_share_link', { kind: 'live', instance_id: id })).data;
    const publicLive = await fetch(revokeShare.media_url, { signal: AbortSignal.timeout(5000) });
    const publicReader = publicLive.body!.getReader();
    assert.equal((await publicReader.read()).done, false);
    assert.equal(
      (await call('revoke_share_link', { share_id: revokeShare.share_id })).data.status,
      'revoked',
    );
    while (!(await publicReader.read()).done) {
      /* Drain already buffered frames until the connection closes. */
    }
    assert.equal((await fetch(revokeShare.media_url)).status, 404);
    assert.equal((await fetch(revokeShare.frame_url)).status, 404);
    assert.ok(
      (await call('list_share_links')).data.some((s: any) => s.share_id === liveShare.share_id),
    );

    const api: any = await (await fetch(base + '/api/instances', { headers })).json();
    assert.equal(api.instances[0].instance_id, id);
    const abort = new AbortController();
    const liveDeadline = setTimeout(() => abort.abort(), 10000);
    liveDeadline.unref();
    const live = await fetch(`${base}/api/instances/${id}/live`, { headers, signal: abort.signal });
    assert.match(live.headers.get('content-type')!, /multipart/);
    const reader = live.body!.getReader();
    let captured = Buffer.alloc(0);
    for (let n = 0; n < 10; n++) {
      const item = await reader.read();
      captured = Buffer.concat([captured, Buffer.from(item.value ?? [])]);
      if (captured.includes(Buffer.from([255, 216]))) break;
    }
    assert.ok(captured.includes(Buffer.from([255, 216])), 'Live stream must contain JPEG data');
    abort.abort();
    clearTimeout(liveDeadline);
    const beforeWait: any = await (await fetch(base + '/api/instances', { headers })).json();
    const pendingWait = call('wait_for', {
      ...ids,
      target: { css: '#never-present' },
      timeout_ms: 2500,
    });
    await new Promise((r) => setTimeout(r, 1500));
    const duringWait: any = await (await fetch(base + '/api/instances', { headers })).json();
    assert.ok(
      duringWait.instances[0].live_frame_at > beforeWait.instances[0].live_frame_at,
      'Live sampling must continue while Agent waits',
    );
    assert.equal((await pendingWait).error.code, 'TIMEOUT');

    await call('close_instance', { instance_id: id });
    const loggedCalls = await (
      await fetch(logUrl + '?component=operation&limit=200', { headers })
    ).json();
    assert.equal(loggedCalls.instance.task_description, taskDescription);
    assert.ok(
      loggedCalls.entries.some(
        (e: any) => e.code === 'operation_succeeded' && e.fields.tool === 'close_instance',
      ),
    );
    assert.ok(
      loggedCalls.entries.every((e: any) => e.component === 'operation' && !('owner' in e)),
    );
    const newerCalls = await (
      await fetch(logUrl + '?after_seq=' + loggedCalls.next_after_seq, { headers })
    ).json();
    assert.deepEqual(newerCalls.entries, []);

    let history: any[] = [];
    for (let n = 0; n < 20; n++) {
      history = (await (await fetch(base + '/api/recordings', { headers })).json()) as any[];
      if (history[0]?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(history[0].task_description, taskDescription);
    assert.equal(history[0].status, 'completed', JSON.stringify(history));
    assert.ok(history[0].frames >= 2);
    assert.ok(history[0].bytes > 0);
    assert.equal(history[0].fps, 2);
    assert.equal(history[0].environment.user_agent, result.data.actual.user_agent);
    assert.equal(history[0].environment.egress.ip, '8.8.4.4');
    assert.equal(history[0].environment.egress.source, 'instance_check');
    assert.equal(history[0].environment.country, null);
    assert.ok(history[0].environment.os);
    const playback = `${base}/api/recordings/${history[0].id}/video`;
    assert.equal((await fetch(playback)).status, 401);
    const part = await fetch(playback, { headers: { ...headers, Range: 'bytes=0-3' } });
    assert.equal(part.status, 206);
    assert.equal(Buffer.from(await part.arrayBuffer()).toString('hex'), '1a45dfa3');
    assert.equal((await call('list_recordings')).data[0].id, history[0].id);
    assert.equal(((await (await fetch(liveShare.url + '/status')).json()) as any).state, 'ended');
    assert.equal((await fetch(liveShare.media_url)).status, 410);
    const recordingShare = (
      await call('create_share_link', {
        kind: 'recording',
        recording_id: history[0].id,
        expires_in_seconds: 3600,
      })
    ).data;
    const sharedPart = await fetch(recordingShare.media_url, { headers: { Range: 'bytes=0-3' } });
    assert.equal(sharedPart.status, 206);
    assert.equal(Buffer.from(await sharedPart.arrayBuffer()).toString('hex'), '1a45dfa3');
    const sharedHead = await fetch(recordingShare.media_url, { method: 'HEAD' });
    assert.equal(sharedHead.status, 200);
    assert.equal(Number(sharedHead.headers.get('content-length')), history[0].bytes);
    await publicPage.goto(recordingShare.url);
    await publicPage.getByRole('heading', { name: '操作录像' }).waitFor();
    await publicPage.waitForFunction(() => (document.querySelector('video')?.videoWidth ?? 0) > 0);
    const expiring = (
      await call('create_share_link', {
        kind: 'recording',
        recording_id: history[0].id,
        expires_in_seconds: 1,
      })
    ).data;
    assert.equal((await fetch(expiring.url + '/status')).status, 200);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await fetch(expiring.url + '/status')).status, 404);
    await call('revoke_share_link', { share_id: recordingShare.share_id });
    await publicPage.getByText('链接已失效、已过期或已撤销').waitFor({ timeout: 10000 });
    assert.equal(await publicPage.locator('video').count(), 0);
    await publicContext.close();
    const persistentShare = (
      await call('create_share_link', { kind: 'recording', recording_id: history[0].id })
    ).data;

    await viewerPage.getByRole('menuitem', { name: '历史录屏' }).click();
    await viewerPage.getByLabel('搜索录像', { exact: true }).fill('移动端页面');
    await viewerPage.locator('.history-egress').getByText('8.8.4.4', { exact: true }).waitFor();
    await viewerPage
      .getByRole('button', { name: `查看完整 UA ${history[0].id}`, exact: true })
      .click();
    await viewerPage
      .locator('.history-user-agent')
      .getByText(result.data.actual.user_agent, { exact: true })
      .waitFor();
    await viewerPage
      .getByRole('button', { name: `查看完整 UA ${history[0].id}`, exact: true })
      .click();
    await viewerPage.getByRole('button', { name: `查看实例日志 ${id}`, exact: true }).click();
    await logDrawer.getByText('close_instance', { exact: true }).waitFor();
    await logDrawer.getByText('wait_for', { exact: true }).waitFor();
    await logDrawer.getByLabel('筛选调用结果').click();
    await viewerPage.locator('.ant-select-dropdown').getByText('失败', { exact: true }).click();
    await logDrawer.getByText('TIMEOUT', { exact: true }).waitFor();
    assert.equal(await logDrawer.getByText('close_instance', { exact: true }).count(), 0);
    await logDrawer.getByRole('tab', { name: '全部事件' }).click();
    await logDrawer.getByText('instance_closed', { exact: true }).waitFor();
    await logDrawer.locator('.ant-drawer-close').click();
    await viewerPage.getByRole('button', { name: '播放录像' }).click();
    await viewerPage.getByLabel('历史录像播放器').waitFor();
    await viewerPage.waitForFunction(
      () => {
        const video = document.querySelector('video');
        return video !== null && video.videoWidth > 0;
      },
      undefined,
      { timeout: 10000 },
    );
    await viewer.close();
    viewer = undefined;
    const recordingsBefore = history.length;
    await client.close();
    client = undefined;
    await stop(proc);
    proc = await start();
    const persistedProxies = await (await fetch(base + '/api/proxies', { headers: auth })).json();
    assert.equal(persistedProxies[0].password, 'ui-proxy-updated');
    assert.equal(
      (
        await fetch(base + '/api/proxies/' + persistedProxies[0].proxy_id, {
          method: 'DELETE',
          headers: auth,
        })
      ).status,
      200,
    );
    assert.deepEqual(await (await fetch(base + '/api/proxies', { headers: auth })).json(), []);
    assert.equal(
      (await fetch(base + '/api/connection', { headers })).status,
      401,
      'Sessions expire on restart',
    );
    const restoredLogs = await (
      await fetch(logUrl + '?component=operation', { headers: auth })
    ).json();
    const restoredSettings = await (await fetch(base + '/api/settings', { headers: auth })).json();
    assert.equal(restoredSettings.storage.max_data_bytes, 201 * 1024 ** 3);
    assert.equal(restoredSettings.storage.screenshot_retention_days, 9);
    assert.equal(
      (
        await fetch(base + '/api/settings', {
          method: 'PUT',
          headers: auth,
          body: JSON.stringify({ max_data_bytes: -1, screenshot_retention_days: 7 }),
        })
      ).status,
      400,
    );
    assert.equal(restoredLogs.instance.task_description, taskDescription);
    assert.ok(restoredLogs.entries.some((e: any) => e.fields?.tool === 'close_instance'));
    const persisted = await fetch(base + '/api/recordings', { headers: auth });
    assert.equal(persisted.status, 200);
    const restoredRecordings = (await persisted.json()) as any[];
    assert.equal(restoredRecordings.length, recordingsBefore);
    assert.deepEqual(restoredRecordings[0].environment, history[0].environment);
    assert.deepEqual(restoredLogs.instance.environment, history[0].environment);
    const resumedClient = new Client({ name: 'diagnostic-reconnect', version: '1' });
    try {
      await resumedClient.connect(
        new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
          requestInit: { headers: auth },
        }),
      );
      const logs: any = await resumedClient.callTool({
        name: 'get_logs',
        arguments: { instance_id: id, limit: 100 },
      });
      assert.ok(
        JSON.parse(logs.content[0].text).data.entries.some(
          (r: any) => r.code === 'instance_closed',
        ),
      );
      const state: any = await resumedClient.callTool({
        name: 'inspect_instance',
        arguments: { instance_id: id, probe: false },
      });
      assert.equal(JSON.parse(state.content[0].text).data.instance.close_reason, 'requested');
    } finally {
      await resumedClient.close();
    }
    const range = await fetch(playback, { headers: { ...auth, Range: 'bytes=999999999999-' } });
    assert.equal(range.status, 416);
    assert.equal((await fetch(persistentShare.media_url, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(recordingShare.media_url)).status, 404);
    assert.equal((await fetch(liveShare.media_url)).status, 410);
  } finally {
    await viewer?.close();
    await client?.close();
    await stop(proc);
    await new Promise<void>((r) => fixture.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
