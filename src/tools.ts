import { z } from 'zod';
import { createSchema, proxySchema } from './config.js';
import { proxyCurlSchema } from './proxy-http.js';
const id = z.string().min(1).max(100);
const target = z
  .object({
    ref: id.optional(),
    role: z.string().max(64).optional(),
    name: z.string().max(512).optional(),
    text: z.string().max(1024).optional(),
    css: z.string().max(1024).optional(),
    frame: z.string().max(1024).optional(),
  })
  .strict()
  .refine(
    (t) => [t.ref, t.role, t.text, t.css].filter((x) => x !== undefined).length === 1,
    'Exactly one of ref, role, text, css is required',
  );
const instance = { instance_id: id };
const page = { ...instance, page_id: id };
export const definitions: Record<
  string,
  { description: string; schema: z.ZodTypeAny; readOnly?: boolean }
> = {
  get_logs: {
    description:
      'Query durable, bounded, redacted service/browser/page/operation/recorder/tunnel events. Survives instance closure and manager restart when the data volume is preserved. Only this principal and generic service events are visible. No raw console text, credentials, request bodies or arbitrary file paths. Omit after_seq for recent events; use returned next_after_seq to read newer events.',
    schema: z
      .object({
        instance_id: id.optional(),
        operation_id: z.string().uuid().optional(),
        component: z
          .enum(['service', 'browser', 'page', 'operation', 'recorder', 'tunnel'])
          .optional(),
        level: z.enum(['info', 'warn', 'error']).optional(),
        since: z.string().datetime({ offset: true }).optional(),
        after_seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .strict(),
    readOnly: true,
  },
  inspect_instance: {
    description:
      'Inspect a live, busy, crashed or retained historical instance without taking its action lock. Returns exit/close reason, current operation and elapsed time, frame/encoder health, resource metrics and recent warnings. Optional bounded renderer probe does not cancel or retry actions. A timeout or SIGKILL alone does not prove OOM.',
    schema: z
      .object({
        instance_id: id,
        probe: z.boolean().default(true),
        timeout_ms: z.number().int().min(100).max(5000).default(1500),
      })
      .strict(),
    readOnly: true,
  },
  create_share_link: {
    description:
      'Create an expiring public read-only viewer URL for one owned live instance or finalized recording. Anyone with this link can see its content without login; it grants no browser control or access to other resources. Returns URL once. Default 24 hours, maximum 30 days. Requires web mode.',
    schema: z
      .object({
        kind: z.enum(['live', 'recording']),
        instance_id: id.optional(),
        recording_id: id.optional(),
        expires_in_seconds: z.number().int().min(1).max(2592000).default(86400),
      })
      .strict()
      .refine(
        (a) =>
          a.kind === 'live'
            ? Boolean(a.instance_id) && !a.recording_id
            : Boolean(a.recording_id) && !a.instance_id,
        'live requires only instance_id; recording requires only recording_id',
      ),
  },
  list_share_links: {
    description:
      'List retained share metadata for this principal, including expiry and revocation status. Secret URLs are returned only at creation.',
    schema: z.object({}).strict(),
    readOnly: true,
  },
  revoke_share_link: {
    description:
      'Revoke an owned public share link. Subsequent requests are denied and connected live viewers are disconnected within one second. Already downloaded content cannot be recalled.',
    schema: z.object({ share_id: z.string().regex(/^shr_[a-f0-9-]{36}$/) }).strict(),
  },
  list_recordings: {
    description:
      'List retained recordings for this principal, optionally filtered by instance. Playback URLs require web login or the MCP Bearer token.',
    schema: z.object({ instance_id: z.string().optional() }),
    readOnly: true,
  },
  list_operations: {
    description:
      'List recent operation IDs and statuses for this principal after reconnect, including running actions. Does not expose arguments.',
    schema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    readOnly: true,
  },
  get_operation: {
    description:
      'Query a recent operation after a transport timeout. Retained in daemon memory until restart or eviction (500 calls).',
    schema: z.object({ operation_id: z.string().uuid() }),
    readOnly: true,
  },
  put_artifact: {
    description:
      'Store an authorized local file as base64, up to 512 KiB decoded per call. Returns artifact reference for upload_file.',
    schema: z.object({
      name: z.string().min(1).max(200),
      mime: z.string().max(128).default('application/octet-stream'),
      data_base64: z
        .string()
        .max(699052)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    }),
  },
  health: {
    description: 'Read service health and capacity.',
    schema: z.object({}),
    readOnly: true,
  },
  list_proxies: {
    description:
      'List platform proxies with proxy_id, name, declared country, protocol, server, enabled status and authentication flag; no credentials. Enabled proxies are configured candidates, not guaranteed live or geolocated. Defaults to enabled only. Use proxy_id in create_instance, check_proxy or proxy_curl.',
    schema: z
      .object({
        country: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .optional(),
        protocol: z.enum(['socks5', 'http', 'https']).optional(),
        enabled_only: z.boolean().default(true),
      })
      .strict(),
    readOnly: true,
  },
  proxy_curl: {
    description:
      'Send one HTTP(S) request through a saved enabled proxy_id using curl, without a browser or shell. Supports methods, headers, UTF-8 body, bounded response and optional redirects. Returns HTTP status, response headers/body and elapsed time, including 4xx/5xx. No direct fallback; private destinations remain blocked unless enabled by the operator. No automatic retry; writes may succeed even when a timeout is returned. Output can contain destination secrets: handle appropriately.',
    schema: proxyCurlSchema,
  },
  check_proxy: {
    description:
      'Launch a temporary isolated browser through the selected proxy and query an IP endpoint; always cleans up. Does not assert country.',
    schema: z
      .object({
        proxy: proxySchema.optional(),
        proxy_id: z.string().min(1).max(128).optional(),
        proxy_ref: id.optional(),
        check_url: z.string().url().optional(),
      })
      .refine(
        (v) => [v.proxy, v.proxy_id, v.proxy_ref].filter((x) => x !== undefined).length === 1,
        'Specify exactly one proxy, proxy_id or proxy_ref',
      ),
  },
  create_instance: {
    description:
      'Create an isolated Chromium instance with fixed UA, viewport and optional authenticated HTTP/SOCKS5 proxy. Use proxy_id from list_proxies, inline proxy, or legacy proxy_ref (mutually exclusive). No direct fallback. No proxy means explicit direct mode.',
    schema: createSchema,
  },
  list_instances: {
    description: 'List live instances owned by this MCP principal.',
    schema: z.object({}),
    readOnly: true,
  },
  get_instance: {
    description: 'Read instance configuration without proxy secrets.',
    schema: z.object(instance),
    readOnly: true,
  },
  close_instance: {
    description: 'Close instance and all pages; artifacts survive until retention expiry.',
    schema: z.object(instance),
  },
  verify_environment: {
    description:
      'Open temporary page through instance proxy to read actual IP response and device attributes. Default endpoint: api.ipify.org. Country requires independent verification.',
    schema: z.object({ ...instance, check_url: z.string().url().optional() }),
    readOnly: true,
  },
  create_page: {
    description: 'Create a page inheriting instance proxy and device settings.',
    schema: z.object({ ...instance, url: z.string().url().optional() }),
  },
  list_pages: {
    description: 'List page IDs, URLs, titles, pending dialogs. Popups appear automatically.',
    schema: z.object(instance),
    readOnly: true,
  },
  close_page: { description: 'Close a page.', schema: z.object(page) },
  navigate: {
    description: 'Navigate, reload, back or forward. HTTP success is not a business pass.',
    schema: z
      .object({
        ...page,
        action: z.enum(['goto', 'reload', 'back', 'forward']).default('goto'),
        url: z.string().url().optional(),
      })
      .refine((a) => a.action !== 'goto' || Boolean(a.url), 'goto requires url'),
  },
  snapshot: {
    description:
      'Read accessible page tree and original-node element references. Refresh after changes. Optional frame CSS selects an iframe.',
    schema: z.object({
      ...page,
      frame: z.string().max(1024).optional(),
      limit: z.number().int().min(1).max(200).default(80),
    }),
    readOnly: true,
  },
  interact: {
    description:
      'Click/fill/press/select/check/hover/scroll using ref or exact role/name, text, CSS; optional frame CSS. Never blindly retry a timed-out write.',
    schema: z
      .object({
        ...page,
        action: z.enum(['click', 'fill', 'press', 'select', 'check', 'hover', 'scroll']),
        target: target.optional(),
        value: z.string().max(100000).optional(),
        checked: z.boolean().optional(),
        delta_x: z.number().min(-10000).max(10000).optional(),
        delta_y: z.number().min(-10000).max(10000).optional(),
      })
      .superRefine((a, c) => {
        if (a.action !== 'scroll' && !a.target)
          c.addIssue({ code: 'custom', message: 'target required' });
        if (['fill', 'press', 'select'].includes(a.action) && a.value === undefined)
          c.addIssue({ code: 'custom', message: 'value required' });
      }),
  },
  wait_for: {
    description: 'Wait for one element state, URL glob or known download ID. No fixed sleeps.',
    schema: z
      .object({
        ...page,
        target: target.optional(),
        url: z.string().max(4096).optional(),
        download_id: id.optional(),
        state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional(),
        timeout_ms: z.number().int().min(100).max(60000).optional(),
      })
      .refine(
        (a) => [a.target, a.url, a.download_id].filter((x) => x !== undefined).length === 1,
        'Specify one wait condition',
      ),
    readOnly: true,
  },
  handle_dialog: {
    description:
      'Accept or dismiss a JavaScript dialog. Business authorization remains the caller responsibility.',
    schema: z.object({ ...page, accept: z.boolean(), text: z.string().max(1000).optional() }),
  },
  screenshot: {
    description: 'Capture PNG and return artifact metadata. get_artifact retrieves its bytes.',
    schema: z.object({ ...page, full_page: z.boolean().default(false) }),
    readOnly: true,
  },
  get_diagnostics: {
    description:
      'Read bounded redacted navigation/HTTP errors, console categories and downloads for a live or disconnected instance even while busy. Use get_logs and inspect_instance for retained postmortem history. No response bodies or console strings are retained.',
    schema: z.object({ ...instance, limit: z.number().int().min(1).max(300).default(100) }),
    readOnly: true,
  },
  list_downloads: {
    description: 'List downloads, status, errors and completed artifact metadata.',
    schema: z.object(instance),
    readOnly: true,
  },
  get_artifact: {
    description:
      'Read owner-authorized artifact as a bounded base64 chunk. Screenshots also return MCP image content when fetched completely.',
    schema: z.object({
      artifact_id: id,
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(0).max(524288).default(262144),
    }),
    readOnly: true,
  },
  upload_file: {
    description:
      'Upload a previously captured/downloaded owner-authorized artifact via a file input. Arbitrary server paths are forbidden.',
    schema: z.object({ ...page, target, artifact_id: id }),
  },
};
