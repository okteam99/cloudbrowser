import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import type { BrowserManager } from './browser.js';
import { WebAuth } from './auth.js';
import { createMcpServer, type Dispatch } from './mcp.js';
import { definitions } from './tools.js';
import { invokeTool, failedCall, toolHttpStatus } from './tool-api.js';
import { toolCatalog, toolOpenApi } from './api-schema.js';
import { dashboard, loginPage, sharePage } from './web-ui.js';
import { publicError } from './errors.js';
import { frameMedia, liveMedia, videoMedia } from './media.js';
import { ZodError } from 'zod';
import { ToolError } from './errors.js';
import { instanceLoginTarget } from './instance-details.js';
import {
  instanceDocument,
  instanceDocumentHtml,
  instanceDocumentMarkdown,
} from './instance-document.js';

function body(req: IncomingMessage, limit = 1048576): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        reject(new ToolError('REQUEST_TOO_LARGE', 'JSON body exceeds the size limit.'));
      } else chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('Request aborted')));
  });
}
const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
};
const docsRoot = fileURLToPath(new URL('../', import.meta.url));
const documents: Record<string, string> = {
  'README.md': 'README.md',
  'mcp-api.md': 'docs/mcp-api.md',
  'mcp-tools.json': 'docs/mcp-tools.json',
  'agent-workflow.md': 'docs/agent-workflow.md',
};
export function requestOriginMatchesHost(origin: string, host?: string) {
  if (!host) return false;
  try {
    const source = new URL(origin);
    const target = new URL(`${source.protocol}//${host}`);
    return (
      ['http:', 'https:'].includes(source.protocol) &&
      source.origin === origin &&
      !target.username &&
      !target.password &&
      target.pathname === '/' &&
      !target.search &&
      !target.hash &&
      source.origin === target.origin
    );
  } catch {
    return false;
  }
}
export async function startWeb(manager: BrowserManager, cfg: Config, dispatch: Dispatch) {
  if (cfg.webPort === 0) return undefined;
  if (!cfg.webPassword || !cfg.baseUrl)
    throw Error(
      'BASE_URL and WEB_PASSWORD are required for web mode. Use WEB_PORT=0 for stdio-only mode.',
    );
  const base = new URL(cfg.baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw Error('BASE_URL must be an absolute HTTP(S) URL without credentials, query or fragment.');
  const baseUrl = base.href.replace(/\/$/, '');
  cfg.baseUrl = baseUrl;
  const prefix = base.pathname.replace(/\/$/, '');
  const auth = new WebAuth();
  await auth.init(cfg.dataDir, cfg.webPassword);
  manager.logs.registerSecret(auth.token);
  const streams = new Set<ServerResponse>();
  const server = http.createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url ?? '/', base);
    } catch {
      json(res, { error: 'Invalid request URL' }, 400);
      return;
    }
    let path = requestUrl.pathname;
    if (prefix && path === prefix) path = '/';
    else if (prefix && path.startsWith(prefix + '/')) path = path.slice(prefix.length);
    const session = auth.cookie(req.headers.cookie);
    const bearer = auth.bearer(req.headers.authorization);
    const queryToken = requestUrl.searchParams.get('access_token');
    const queryAllowed =
      ['GET', 'HEAD'].includes(req.method ?? '') &&
      /^(?:\/instances\/ins_[a-f0-9-]{36}|\/api\/instances\/ins_[a-f0-9-]{36}(?:\/(?:logs|navigation|frame|live))?|\/api\/recordings\/rec_[a-f0-9-]{36}\/video)$/.test(
        path,
      );
    const queryAuthenticated = queryAllowed && !!queryToken && auth.bearer(`Bearer ${queryToken}`);
    const authorized = Boolean(session || bearer || queryAuthenticated);
    if (queryAllowed) {
      if (queryAuthenticated && !session) res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('x-robots-tag', 'noindex, nofollow');
    }
    try {
      if (path === '/docs/agent-guide.md' && ['GET', 'HEAD'].includes(req.method ?? '')) {
        // Only static, generic documentation is public. Never interpolate deployment credentials or state.
        const files = [
          'docs/agent-connection.md',
          'docs/http-api.md',
          'docs/mcp-api.md',
          'docs/agent-workflow.md',
        ];
        const parts = await Promise.all(
          files.map((file) => readFile(`${docsRoot}${file}`, 'utf8')),
        );
        const guide = parts.join('\n\n---\n\n');
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('content-length', Buffer.byteLength(guide));
        res.end(req.method === 'HEAD' ? undefined : guide);
        return;
      }
      if (req.headers.origin && !requestOriginMatchesHost(req.headers.origin, req.headers.host)) {
        json(res, { error: 'Origin not allowed' }, 403);
        return;
      }
      if (path.startsWith('/assets/') && req.method === 'GET') {
        const files: Record<string, string> = {
          '/assets/app.js': 'application/javascript; charset=utf-8',
          '/assets/app.css': 'text/css; charset=utf-8',
          '/assets/getting-started.svg': 'image/svg+xml',
        };
        const mime = Object.hasOwn(files, path) ? files[path] : undefined;
        if (!mime) {
          json(res, { error: 'Not found' }, 404);
          return;
        }
        const gzip = (req.headers['accept-encoding'] ?? '')
          .split(',')
          .some((part) => /^gzip(?:;q=(?!0(?:\.0*)?$)[\d.]+)?$/.test(part.trim()));
        const content = await readFile(
          fileURLToPath(new URL(`./public/${path.slice(8)}${gzip ? '.gz' : ''}`, import.meta.url)),
        );
        res.setHeader('vary', 'Accept-Encoding');
        if (gzip) res.setHeader('content-encoding', 'gzip');
        res.setHeader('content-type', mime);
        res.end(content);
        return;
      }
      if (path === '/healthz') {
        json(res, { status: 'ok', version: '0.17.0' });
        return;
      }
      const toolRoute = /^\/api\/tools\/([^/]+)$/.exec(path);
      if (toolRoute) {
        let operationId: string = randomUUID();
        const reply = (result: ReturnType<typeof failedCall>, status = toolHttpStatus(result)) => {
          res.setHeader('x-operation-id', operationId);
          json(res, result, status);
        };
        if (!bearer) {
          res.setHeader('www-authenticate', 'Bearer realm="cloudbrowser"');
          reply(failedCall(operationId, 'UNAUTHORIZED', 'Bearer token required.'), 401);
          return;
        }
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST');
          reply(failedCall(operationId, 'METHOD_NOT_ALLOWED', 'Use POST.'), 405);
          return;
        }
        const key = req.headers['idempotency-key'];
        if (key !== undefined) {
          if (
            typeof key !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)
          ) {
            reply(failedCall(operationId, 'INVALID_ARGUMENT', 'Idempotency-Key must be a UUID.'));
            return;
          }
          operationId = key.toLowerCase();
        }
        if (
          req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json'
        ) {
          reply(
            failedCall(
              operationId,
              'UNSUPPORTED_MEDIA_TYPE',
              'Use Content-Type: application/json.',
            ),
          );
          return;
        }
        try {
          const args = JSON.parse(await body(req));
          reply(await invokeTool('web', toolRoute[1], args, dispatch, operationId));
        } catch (error) {
          if (error instanceof SyntaxError)
            reply(failedCall(operationId, 'INVALID_ARGUMENT', 'Malformed JSON body.'));
          else if (error instanceof ToolError)
            reply(failedCall(operationId, error.code, error.message));
          else
            reply({
              operation_id: operationId,
              status: 'unknown',
              data: null,
              error: publicError(error),
            });
        }
        return;
      }
      if (path === '/mcp') {
        if (!bearer) {
          res.setHeader('www-authenticate', 'Bearer realm="cloudbrowser"');
          json(res, { error: 'Bearer token required' }, 401);
          return;
        }
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST');
          json(res, { error: 'Use MCP Streamable HTTP POST' }, 405);
          return;
        }
        const parsed = JSON.parse(await body(req));
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const mcp = createMcpServer('web', dispatch);
        await mcp.connect(transport);
        res.once('close', () => {
          void transport.close();
          void mcp.close();
        });
        await transport.handleRequest(req, res, parsed);
        return;
      }
      if (path === '/login' && req.method === 'POST') {
        const form = new URLSearchParams(await body(req, 8192));
        const returnTo = instanceLoginTarget(form.get('return_to'), prefix);
        const pass = form.get('password') ?? '';
        if (pass.length > 1024) {
          json(res, { error: 'Invalid password' }, 400);
          return;
        }
        const result = auth.login(req.socket.remoteAddress ?? 'unknown', pass);
        if (result.session) {
          res.setHeader(
            'set-cookie',
            `browser_session=${result.session}; HttpOnly; SameSite=Strict; Path=${prefix || ''}/; Max-Age=86400${base.protocol === 'https:' ? '; Secure' : ''}`,
          );
          res.statusCode = 303;
          res.setHeader('location', returnTo ?? `${prefix}/`);
          res.end();
        } else {
          res.statusCode = result.limited ? 429 : 401;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(
            loginPage(
              prefix,
              result.limited ? '尝试过多，请在 10 分钟后重试。' : '密码不正确。',
              returnTo,
            ),
          );
        }
        return;
      }
      if (path === '/' && req.method === 'GET') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(session ? dashboard(prefix, session) : loginPage(prefix));
        return;
      }
      const detailPage = /^\/instances\/(ins_[a-f0-9-]{36})$/.exec(path);
      if (detailPage && req.method === 'GET') {
        const format =
          requestUrl.searchParams.get('format') ??
          (req.headers.accept?.includes('application/json')
            ? 'json'
            : req.headers.accept?.includes('text/markdown')
              ? 'markdown'
              : 'html');
        if (!['html', 'json', 'markdown'].includes(format)) {
          json(res, { error: 'Invalid detail format' }, 400);
          return;
        }
        if (!authorized) {
          if (format !== 'html') json(res, { error: 'Authentication required' }, 401);
          else {
            res.statusCode = queryToken ? 401 : 200;
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.end(
              loginPage(
                prefix,
                queryToken ? 'access_token 无效或已失效，请登录。' : '',
                `${prefix}${path}`,
              ),
            );
          }
          return;
        }
        try {
          const doc = await instanceDocument(manager, detailPage[1], baseUrl);
          if (format === 'json') json(res, doc);
          else if (format === 'markdown') {
            res.setHeader('content-type', 'text/markdown; charset=utf-8');
            res.end(instanceDocumentMarkdown(doc));
          } else {
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.end(
              dashboard(prefix, session ?? '', {
                instance_id: detailPage[1],
                access_token: !session && queryAuthenticated ? queryToken! : undefined,
                summary: instanceDocumentHtml(doc),
              }),
            );
          }
        } catch (error) {
          if (!(error instanceof ToolError) || error.code !== 'INSTANCE_NOT_FOUND') throw error;
          if (format !== 'html') json(res, { error: publicError(error) }, 404);
          else {
            res.statusCode = 404;
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.end(
              dashboard(prefix, session ?? '', {
                instance_id: detailPage[1],
                access_token: !session && queryAuthenticated ? queryToken! : undefined,
                summary: '<main><h1>实例不存在或历史记录已过期</h1></main>',
              }),
            );
          }
        }
        return;
      }
      const shared = /^\/share\/([A-Za-z0-9_-]{43})(?:\/(media|status|frame))?$/.exec(path);
      if (shared && ['GET', 'HEAD'].includes(req.method ?? '')) {
        res.setHeader('referrer-policy', 'no-referrer');
        res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive');
        const grant = manager.shares.resolve(shared[1]);
        const allowed = () => Boolean(manager.shares.resolve(shared[1]));
        let state: 'live' | 'ready' | 'ended' | 'unavailable' = 'unavailable';
        if (grant?.kind === 'live') {
          const instance = manager.instances.get(grant.resource_id);
          state =
            instance &&
            instance.owner === grant.owner &&
            !instance.closing &&
            !instance.crashed &&
            manager.recordings.active.has(instance.id)
              ? 'live'
              : 'ended';
        } else if (grant) {
          const recording = await manager.recordings.get(grant.resource_id).catch(() => null);
          if (
            recording &&
            recording.meta.owner === grant.owner &&
            !['recording', 'finalizing'].includes(recording.meta.status) &&
            (await stat(recording.path).catch(() => null))?.size
          )
            state = 'ready';
        }
        if (!grant || !allowed()) {
          if (!shared[2]) {
            res.statusCode = 404;
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.end(req.method === 'HEAD' ? undefined : sharePage(prefix));
          } else json(res, { error: 'Share link unavailable' }, 404);
          return;
        }
        const view = {
          kind: grant.kind,
          state,
          expires_at: grant.expires_at,
          media_url: `${prefix}/share/${shared[1]}/media`,
          frame_url: grant.kind === 'live' ? `${prefix}/share/${shared[1]}/frame` : undefined,
          status_url: `${prefix}/share/${shared[1]}/status`,
        };
        if (shared[2] === 'status') json(res, view);
        else if (!shared[2]) {
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(req.method === 'HEAD' ? undefined : sharePage(prefix, view));
        } else if (shared[2] === 'frame') {
          if (grant.kind !== 'live' || req.method !== 'GET') json(res, { error: 'Not found' }, 404);
          else if (state !== 'live') json(res, { error: 'Live stream ended' }, 410);
          else frameMedia(manager, res, grant.resource_id);
        } else if (!['live', 'ready'].includes(state))
          json(res, { error: state === 'ended' ? 'Live stream ended' : 'Media unavailable' }, 410);
        else if (grant.kind === 'live') {
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('allow', 'GET');
            res.end();
          } else liveMedia(manager, cfg, res, streams, grant.resource_id, allowed);
        } else await videoMedia(manager, req, res, grant.resource_id, allowed);
        return;
      }
      if (!authorized) {
        json(res, { error: 'Authentication required' }, 401);
        return;
      }
      if (path === '/api/tools' || path === '/api/openapi.json') {
        if (req.method !== 'GET') {
          res.setHeader('allow', 'GET');
          json(res, { error: 'Use GET' }, 405);
        } else
          json(
            res,
            path === '/api/tools' ? await toolCatalog(baseUrl) : await toolOpenApi(baseUrl),
          );
        return;
      }
      if (path === '/api/settings') {
        if (req.method === 'GET') {
          json(res, {
            storage: manager.settings.storage(),
            usage: await manager.artifacts.usage(),
          });
          return;
        }
        if (req.method !== 'PUT') {
          json(res, { error: 'Method not allowed' }, 405);
          return;
        }
        if (!bearer && (!session || req.headers['x-csrf-token'] !== session)) {
          json(res, { error: 'Invalid session' }, 403);
          return;
        }
        try {
          const input = JSON.parse(await body(req, 4096));
          const storage = await manager.settings.updateStorage(input);
          json(res, { storage, usage: await manager.artifacts.usage() });
        } catch (e) {
          if (e instanceof ZodError || e instanceof SyntaxError)
            json(res, { error: 'Invalid storage settings' }, 400);
          else throw e;
        }
        return;
      }
      if (path === '/api/settings/device-profiles') {
        if (req.method === 'GET') {
          json(res, manager.deviceProfiles.snapshot());
          return;
        }
        if (req.method !== 'PUT') {
          res.setHeader('allow', 'GET, PUT');
          json(res, { error: 'Method not allowed' }, 405);
          return;
        }
        if (!bearer && (!session || req.headers['x-csrf-token'] !== session)) {
          json(res, { error: 'Invalid session' }, 403);
          return;
        }
        try {
          json(res, await manager.deviceProfiles.update(JSON.parse(await body(req))));
        } catch (e) {
          if (e instanceof ZodError)
            json(
              res,
              {
                error: 'Invalid device profiles',
                issues: e.issues
                  .slice(0, 20)
                  .map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
              },
              400,
            );
          else if (e instanceof SyntaxError) json(res, { error: 'Invalid JSON' }, 400);
          else if (e instanceof ToolError)
            json(res, { error: publicError(e) }, e.code === 'REQUEST_TOO_LARGE' ? 413 : 409);
          else throw e;
        }
        return;
      }
      if (path === '/api/proxy-health' && req.method === 'GET') {
        json(res, manager.proxyHealth.status());
        return;
      }
      const proxyRoute = /^\/api\/proxies(?:\/([^/]+))?$/.exec(path);
      if (proxyRoute) {
        if (req.method === 'GET' && !proxyRoute[1]) {
          json(res, manager.proxies.list());
          return;
        }
        if (!['POST', 'PUT', 'DELETE'].includes(req.method ?? '')) {
          json(res, { error: 'Method not allowed' }, 405);
          return;
        }
        if (!bearer && (!session || req.headers['x-csrf-token'] !== session)) {
          json(res, { error: 'Invalid session' }, 403);
          return;
        }
        if (proxyRoute[1] === 'check' && req.method === 'POST') {
          json(res, manager.proxyHealth.requestAll(), 202);
          return;
        }
        const id = proxyRoute[1] ? decodeURIComponent(proxyRoute[1]) : undefined;
        if ((req.method === 'POST' && id) || (req.method !== 'POST' && !id)) {
          json(res, { error: 'Invalid proxy route' }, 400);
          return;
        }
        try {
          if (req.method === 'DELETE') json(res, await manager.proxies.remove(id!));
          else {
            const input = JSON.parse(await body(req, 16384));
            const saved = await manager.proxies.save(input, id);
            manager.logs.registerSecret(saved.username, false);
            manager.logs.registerSecret(saved.password, false);
            json(res, saved, req.method === 'POST' ? 201 : 200);
          }
        } catch (e) {
          if (e instanceof ZodError || e instanceof SyntaxError)
            json(res, { error: 'Invalid proxy fields' }, 400);
          else if (e instanceof ToolError)
            json(res, { error: e.message }, e.code === 'PROXY_NOT_FOUND' ? 404 : 409);
          else throw e;
        }
        return;
      }
      if (path === '/logout' && req.method === 'POST') {
        const form = new URLSearchParams(await body(req, 8192));
        if (!session || form.get('csrf') !== session) {
          json(res, { error: 'Invalid session' }, 403);
          return;
        }
        auth.logout(session);
        res.setHeader(
          'set-cookie',
          `browser_session=; HttpOnly; SameSite=Strict; Path=${prefix || ''}/; Max-Age=0${base.protocol === 'https:' ? '; Secure' : ''}`,
        );
        res.statusCode = 303;
        res.setHeader('location', `${prefix}/`);
        res.end();
        return;
      }
      if (path === '/api/connection' && req.method === 'GET') {
        const mcpUrl = `${baseUrl}/mcp`;
        const mcp_config = {
          mcpServers: {
            cloudbrowser: {
              type: 'http',
              url: mcpUrl,
              headers: { Authorization: `Bearer ${auth.token}` },
            },
          },
        };
        const agent_guide_url = `${baseUrl}/docs/agent-guide.md`;
        const agent_instructions = `请接入以下远程浏览器 MCP，先阅读公开文档并发现可用工具，再按我的要求操作浏览器。\nMCP（Streamable HTTP）：${mcpUrl}\n认证请求头：Authorization: Bearer ${auth.token}\n公开文档：${agent_guide_url}`;
        json(res, {
          base_url: baseUrl,
          mcp_url: mcpUrl,
          mcp_config,
          agent_instructions,
          agent_guide_url,
          api_base_url: `${baseUrl}/api`,
          openapi_url: `${baseUrl}/api/openapi.json`,
          api_instructions: `请接入以下远程浏览器 HTTP API，先阅读同一份 MCP & API 公开文档并获取接口列表，再按我的要求操作浏览器。\nAPI：${baseUrl}/api\n认证请求头：Authorization: Bearer ${auth.token}\n公开文档：${agent_guide_url}`,
          tool_count: Object.keys(definitions).length,
          live_transport: 'frames',
          max_instances: cfg.maxInstances,
        });
        return;
      }
      if (path.startsWith('/docs/') && req.method === 'GET') {
        const name = path.slice(6),
          file = documents[name];
        if (typeof file !== 'string') {
          json(res, { error: 'Not found' }, 404);
          return;
        }
        res.setHeader(
          'content-type',
          name.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
        );
        res.end(await readFile(`${docsRoot}${file}`));
        return;
      }
      if (path === '/api/instances' && req.method === 'GET') {
        json(res, { max_instances: cfg.maxInstances, instances: manager.adminInstances() });
        return;
      }
      const instanceDetail = /^\/api\/instances\/(ins_[a-f0-9-]{36})$/.exec(path);
      if (instanceDetail && req.method === 'GET') {
        try {
          json(res, await manager.adminInstanceDetails(instanceDetail[1]));
        } catch (error) {
          if (error instanceof ToolError && error.code === 'INSTANCE_NOT_FOUND')
            json(res, { error: publicError(error) }, 404);
          else throw error;
        }
        return;
      }
      const instanceLogs = /^\/api\/instances\/(ins_[a-f0-9-]{36})\/logs$/.exec(path);
      const instanceNavigation = /^\/api\/instances\/(ins_[a-f0-9-]{36})\/navigation$/.exec(path);
      if (instanceNavigation && req.method === 'GET') {
        const parsed = definitions.list_navigation_events.schema.safeParse({
          instance_id: instanceNavigation[1],
          page_id: requestUrl.searchParams.get('page_id') ?? undefined,
          after_seq: requestUrl.searchParams.has('after_seq')
            ? Number(requestUrl.searchParams.get('after_seq'))
            : undefined,
          limit: requestUrl.searchParams.has('limit')
            ? Number(requestUrl.searchParams.get('limit'))
            : 100,
        });
        if (!parsed.success) {
          json(res, { error: 'Invalid navigation query' }, 400);
          return;
        }
        try {
          json(res, await manager.logs.adminNavigation(instanceNavigation[1], parsed.data));
        } catch (error) {
          if (error instanceof ToolError && error.code === 'INSTANCE_NOT_FOUND')
            json(res, { error: publicError(error) }, 404);
          else throw error;
        }
        return;
      }
      if (instanceLogs && req.method === 'GET') {
        const parsed = definitions.get_logs.schema.safeParse({
          instance_id: instanceLogs[1],
          component: requestUrl.searchParams.get('component') ?? undefined,
          level: requestUrl.searchParams.get('level') ?? undefined,
          after_seq: requestUrl.searchParams.has('after_seq')
            ? Number(requestUrl.searchParams.get('after_seq'))
            : undefined,
          limit: requestUrl.searchParams.has('limit')
            ? Number(requestUrl.searchParams.get('limit'))
            : 200,
        });
        if (!parsed.success) {
          json(res, { error: 'Invalid log query' }, 400);
          return;
        }
        try {
          json(res, await manager.logs.adminInstanceLogs(instanceLogs[1], parsed.data));
        } catch (error) {
          if (error instanceof ToolError && error.code === 'INSTANCE_NOT_FOUND')
            json(res, { error: publicError(error) }, 404);
          else throw error;
        }
        return;
      }
      if (path === '/api/recordings' && req.method === 'GET') {
        json(res, await manager.recordings.list());
        return;
      }
      const frame = /^\/api\/instances\/(ins_[a-f0-9-]{36})\/frame$/.exec(path);
      if (frame && req.method === 'GET') {
        frameMedia(manager, res, frame[1]);
        return;
      }
      const live = /^\/api\/instances\/(ins_[a-f0-9-]{36})\/live$/.exec(path);
      const allowed = () =>
        Boolean(
          auth.cookie(req.headers.cookie) ||
          auth.bearer(req.headers.authorization) ||
          (queryAllowed && queryToken && auth.bearer(`Bearer ${queryToken}`)),
        );
      if (live && req.method === 'GET') {
        liveMedia(manager, cfg, res, streams, live[1], allowed);
        return;
      }
      const video = /^\/api\/recordings\/(rec_[a-f0-9-]{36})\/video$/.exec(path);
      if (video && ['GET', 'HEAD'].includes(req.method ?? '')) {
        await videoMedia(manager, req, res, video[1], allowed);
        return;
      }
      json(res, { error: 'Not found' }, 404);
    } catch (error) {
      if (!res.headersSent) json(res, { error: publicError(error) }, 500);
      else res.destroy();
    }
  });
  server.requestTimeout = 180000;
  // cloudflared retains idle origin sockets for 90s by default. Let the proxy
  // retire them before Node does, avoiding reset races on non-retriable MCP POSTs.
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.webPort, '0.0.0.0', resolve);
  });
  process.stderr.write(
    `Web and MCP listening on port ${cfg.webPort}; public BASE_URL configured.\n`,
  );
  return {
    server,
    close: async () => {
      for (const r of streams) r.end();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
