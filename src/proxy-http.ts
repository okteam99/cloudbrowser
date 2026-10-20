import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Proxy } from './config.js';
import { createGateway, type NetworkPolicy } from './network.js';
import { ToolError } from './errors.js';

export const proxyCurlSchema = z
  .object({
    proxy_id: z.string().min(1).max(128),
    url: z.string().url().max(8192),
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).default('GET'),
    headers: z
      .record(
        z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
        z
          .string()
          .max(8192)
          .refine((s) => !/[\r\n\0]/.test(s)),
      )
      .refine(
        (h) =>
          Object.keys(h).length <= 50 &&
          !Object.keys(h).some((k) =>
            /^(proxy-authorization|proxy-connection|content-length|transfer-encoding)$/i.test(k),
          ),
        'Maximum 50 headers; proxy/hop framing headers are reserved.',
      )
      .default({}),
    body: z
      .string()
      .max(65536)
      .refine((s) => !s.includes('\0') && Buffer.byteLength(s) <= 65536)
      .optional(),
    follow_redirects: z.boolean().default(false),
    timeout_ms: z.number().int().min(1000).max(60000).default(15000),
    max_bytes: z.number().int().min(1).max(1048576).default(65536),
    response_encoding: z.enum(['text', 'base64']).default('text'),
  })
  .strict()
  .refine((v) => !(v.method === 'HEAD' && v.body !== undefined), 'HEAD cannot include a body');

// curl config is passed through stdin, never a shell or command-line credentials. -q ignores ~/.curlrc.
const quote = (value: string) =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/\v/g, '\\v')}"`;
export async function proxyCurl(policy: NetworkPolicy, proxy: Proxy, input: unknown) {
  const a = proxyCurlSchema.parse(input);
  await policy.url(a.url);
  const dir = await mkdtemp(join(tmpdir(), 'cloudbrowser-http-'));
  let gateway: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    gateway = await createGateway(policy, proxy);
    const headersFile = join(dir, 'headers');
    const options = [
      `url = ${quote(a.url)}`,
      `proxy = ${quote(`http://127.0.0.1:${gateway.port}`)}`,
      'noproxy = ""',
      'silent',
      'globoff',
      'proto = "=http,https"',
      'proto-redir = "=http,https"',
      `max-time = ${a.timeout_ms / 1000}`,
      'connect-timeout = 10',
      `dump-header = ${quote(headersFile)}`,
      'write-out = "%{stderr}%{json}"',
      ...(a.method === 'HEAD'
        ? ['head', 'output = "/dev/null"']
        : [`request = ${quote(a.method)}`]),
      ...(a.follow_redirects ? ['location', 'max-redirs = 5'] : []),
      ...Object.entries(a.headers).map(([key, value]) => `header = ${quote(`${key}: ${value}`)}`),
      ...(a.body === undefined ? [] : [`data-raw = ${quote(a.body)}`]),
    ];
    const result = await new Promise<{ body: Buffer; meta: any }>((resolve, reject) => {
      const child = spawn('curl', ['-q', '--config', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let size = 0,
        stderr = '',
        tooLarge = false,
        expired = false;
      const timer = setTimeout(() => {
        expired = true;
        child.kill('SIGKILL');
      }, a.timeout_ms + 1000);
      child.stdin.on('error', () => {});
      child.stdout.on('data', (part: Buffer) => {
        size += part.length;
        if (size > a.max_bytes) {
          tooLarge = true;
          child.kill('SIGKILL');
        } else chunks.push(part);
      });
      child.stderr.on('data', (part) => {
        if (stderr.length < 262144) stderr += part.toString();
      });
      child.once('error', () => {
        clearTimeout(timer);
        reject(new ToolError('CURL_UNAVAILABLE', 'curl executable is unavailable.'));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (tooLarge)
          return reject(
            new ToolError(
              'RESPONSE_TOO_LARGE',
              'HTTP response exceeds max_bytes; request stopped.',
            ),
          );
        if (expired || code === 28)
          return reject(
            new ToolError(
              'TIMEOUT',
              'HTTP request timed out. A write request may already have reached its destination; inspect before retrying.',
            ),
          );
        if (code !== 0)
          return reject(
            new ToolError(
              'HTTP_REQUEST_FAILED',
              `curl failed (exit ${code ?? 'signal'}). Check proxy, DNS, TLS and destination; no direct fallback is used.`,
            ),
          );
        try {
          resolve({ body: Buffer.concat(chunks), meta: JSON.parse(stderr) });
        } catch {
          reject(new ToolError('HTTP_REQUEST_FAILED', 'Unable to read curl response metadata.'));
        }
      });
      child.stdin.end(options.join('\n') + '\n');
    });
    const rawHeaders = await readFile(headersFile, 'utf8');
    const blocks = rawHeaders.trim().split(/\r?\n\r?\n/);
    const last = blocks.reverse().find((block) => /^HTTP\//.test(block)) ?? '';
    const headers = last
      .split(/\r?\n/)
      .slice(1)
      .flatMap((line) => {
        const colon = line.indexOf(':');
        return colon < 1
          ? []
          : [{ name: line.slice(0, colon).toLowerCase(), value: line.slice(colon + 1).trim() }];
      });
    return {
      proxy_id: a.proxy_id,
      status_code: result.meta.http_code,
      final_url: result.meta.url_effective,
      elapsed_ms: Math.round(result.meta.time_total * 1000),
      redirect_count: result.meta.num_redirects,
      headers,
      bytes: result.body.length,
      encoding: a.response_encoding,
      body: result.body.toString(a.response_encoding === 'base64' ? 'base64' : 'utf8'),
    };
  } finally {
    await gateway?.close(true).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}
