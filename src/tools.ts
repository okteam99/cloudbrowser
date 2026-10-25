import { z } from 'zod';
import { createSchema, proxySchema } from './config.js';
import { proxyCurlSchema } from './proxy-http.js';
import { deviceProfileIdSchema } from './device-profile.js';
import { listDeviceProfilesSchema } from './device-profiles.js';
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
  list_device_profiles: {
    description:
      'List saved device profiles configured as JSON in console System Settings. Filter by platform or query (ID/name); defaults to enabled profiles. Each item includes profile_id, enabled, revision and complete profile. Pass profile_id to create_instance.device_profile_id. No browser is started. UA alone does not select a profile.',
    schema: listDeviceProfilesSchema,
    readOnly: true,
  },
  get_device_profile: {
    description:
      'Read one saved device profile by profile_id, including enabled status and complete JSON. Disabled profiles can be inspected but cannot create new instances. Select a profile by passing its ID to create_instance; there is no shared current selection. Updates apply only to future instances.',
    schema: z.object({ profile_id: deviceProfileIdSchema }).strict(),
    readOnly: true,
  },
  verify_device_profile: {
    description:
      'Compare the instance device profile with actual values in one live tab and a temporary dedicated Worker. Exercise Canvas/WebGL/audio processing and render a generated PDF in an isolated temporary page; inspect Bluetooth, speech and sharing availability without permission prompts. Does not navigate the inspected tab or send external probe requests. Returns mismatches and unavailable checks separately, retains the last report in instance history. A matching field does not prove a real device or human user.',
    schema: z.object({ ...page }).strict(),
    readOnly: true,
  },
  get_logs: {
    description:
      'Query durable, bounded service/browser/page/operation/recorder/tunnel events. Operation events retain full validated arguments, URLs and original error messages without redaction; filter component=operation for function call history. Survives instance closure and manager restart when the data volume is preserved. Only this principal and generic service events are visible. Logs require authentication and may contain credentials or input values in operation arguments. No arbitrary file access. Omit after_seq for recent events; use returned next_after_seq to read newer events.',
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
      'List retained recordings for this principal, optionally filtered by instance, including task description, details_url and captured environment (exit IP/source/time, configured country, OS and full UA) when recorded. details_url has an empty access_token= hint; log in or fill an existing MCP token to view. Playback URLs require authentication.',
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
      'List platform proxies with proxy_id, name, declared country, protocol, server, health status, latest check time/latency/error and authentication flag; no credentials. Checks run every 5 minutes by default. Use status=healthy for recent successful checks; a probe does not guarantee target-site access or country. Defaults to enabled only. Use proxy_id in create_instance, check_proxy or proxy_curl.',
    schema: z
      .object({
        country: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .optional(),
        protocol: z.enum(['socks5', 'http', 'https']).optional(),
        enabled_only: z.boolean().default(true),
        status: z.enum(['healthy', 'unhealthy', 'unknown', 'checking', 'disabled']).optional(),
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
      'Create an isolated Chromium instance. Select a saved device_profile_id from list_device_profiles/get_device_profile, or provide an inline device_profile (mutually exclusive); the full profile overrides individual device parameters and is frozen for this instance. Optional task_description is shown in console/history. UA alone generates Client Hints but does not select a profile or change the engine. Returns details_url (empty access_token= hint), actual browser_version, effective profile and user_agent_metadata. Optional authenticated HTTP/SOCKS5 proxy: use proxy_id from list_proxies, inline proxy, or legacy proxy_ref (mutually exclusive). No direct fallback. No proxy means explicit direct mode.',
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
      'Open temporary page through instance proxy to read actual IP response and device attributes, including page-visible low/high entropy Client Hints when allowed. Default endpoint: api.ipify.org. Country requires independent verification. Declared hints do not identify the actual engine: see get_instance.browser_version.',
    schema: z.object({ ...instance, check_url: z.string().url().optional() }),
    readOnly: true,
  },
  create_page: {
    description: 'Create a page inheriting instance proxy and device settings.',
    schema: z.object({ ...instance, url: z.string().url().optional() }),
  },
  list_pages: {
    description:
      'List live tabs with cached titles, URLs, active state, frames and pending dialogs, even while busy or unresponsive. Popups appear automatically.',
    schema: z.object(instance),
    readOnly: true,
  },
  close_page: { description: 'Close a page.', schema: z.object(page) },
  get_page: {
    description:
      'Read cached tab metadata, frame IDs, load state, pending dialog and reload-required flag without taking the action lock. Closed tab data is retained until instance closure or tab-history eviction.',
    schema: z.object(page).strict(),
    readOnly: true,
  },
  select_page: {
    description:
      'Select a live tab for browser focus, livestream and recording. Other operations still explicitly specify page_id.',
    schema: z.object(page).strict(),
  },
  evaluate: {
    description:
      'Execute a JavaScript expression or function in this tab or frame. A function receives arg; promises are awaited. Returns a JSON value with bounded output. This can change page state. On timeout, execution is interrupted and the page must be reloaded before further writes; asynchronous effects may already have happened.',
    schema: z
      .object({
        ...page,
        script: z.string().min(1).max(100000),
        arg: z.unknown().optional(),
        frame_id: id.optional(),
        timeout_ms: z.number().int().min(100).max(30000).default(5000),
        max_result_bytes: z.number().int().min(256).max(262144).default(65536),
      })
      .strict(),
  },
  read_element: {
    description:
      'Read one element as structured data: text, value, attributes, checked/selected/disabled state and viewport bounding box. Use snapshot to refresh stale refs.',
    schema: z
      .object({ ...page, target, max_text: z.number().int().min(1).max(60000).default(10000) })
      .strict(),
    readOnly: true,
  },
  list_network_requests: {
    description:
      'Query this tab network metadata, including successful fetch/XHR, navigation, redirects and failures. Captures start at page creation. Cursor advances on updates as well as new requests; merge by request_id. Per-tab history is bounded to 200 entries / 4 MiB. No browser action lock.',
    schema: z
      .object({
        ...page,
        after_seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        limit: z.number().int().min(1).max(200).default(100),
        url: z.string().max(4096).optional(),
        method: z.string().max(32).optional(),
        resource_type: z.string().max(64).optional(),
        status_code: z.number().int().min(100).max(599).optional(),
        failed_only: z.boolean().default(false),
      })
      .strict(),
    readOnly: true,
  },
  get_network_request: {
    description:
      'Read one captured request with raw request/response headers and optional bodies. Bodies are captured up to 256 KiB each; check body status, truncation and capture errors. Binary bodies use base64. Captured data is not redacted. Works while the instance is busy.',
    schema: z.object({ ...page, request_id: id, include_body: z.boolean().default(true) }).strict(),
    readOnly: true,
  },
  get_console_logs: {
    description:
      'Read original console text, location and page exceptions with stack traces for one tab, without the action lock. Includes log/info/warning/error, not just error categories. Bounded to 300 entries / 1 MiB; inspect truncated and dropped_entries.',
    schema: z
      .object({
        ...page,
        after_seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        limit: z.number().int().min(1).max(200).default(100),
        level: z.string().max(64).optional(),
      })
      .strict(),
    readOnly: true,
  },
  pointer: {
    description:
      'Mouse operations in viewport CSS pixels: click, double_click, right_click, move, down, up, drag and wheel. Drag uses x/y to to_x/to_y; modifiers and mouse buttons supported. The active tab is selected for recording.',
    schema: z
      .object({
        ...page,
        action: z.enum([
          'click',
          'double_click',
          'right_click',
          'move',
          'down',
          'up',
          'drag',
          'wheel',
        ]),
        x: z.number().finite().min(0).max(3840).optional(),
        y: z.number().finite().min(0).max(3840).optional(),
        to_x: z.number().finite().min(0).max(3840).optional(),
        to_y: z.number().finite().min(0).max(3840).optional(),
        button: z.enum(['left', 'right', 'middle']).default('left'),
        steps: z.number().int().min(1).max(100).default(12),
        modifiers: z
          .array(z.enum(['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift']))
          .max(4)
          .default([]),
        delta_x: z.number().min(-10000).max(10000).default(0),
        delta_y: z.number().min(-10000).max(10000).default(600),
      })
      .strict()
      .superRefine((a, c) => {
        if (!['up', 'wheel'].includes(a.action) && (a.x === undefined || a.y === undefined))
          c.addIssue({ code: 'custom', message: 'x and y required' });
        if (a.action === 'drag' && (a.to_x === undefined || a.to_y === undefined))
          c.addIssue({ code: 'custom', message: 'drag requires to_x and to_y' });
      }),
  },
  keyboard: {
    description:
      'Page-level keyboard press, key down/up or text insertion at the focused element. Supports combinations such as ControlOrMeta+A and Tab without locating an element.',
    schema: z
      .object({
        ...page,
        action: z.enum(['press', 'down', 'up', 'type']),
        value: z.string().min(1).max(100000),
      })
      .strict(),
  },
  save_storage_state: {
    description:
      'Save instance cookies, localStorage and optionally IndexedDB as a private owner-authorized artifact. Returns storage_state_id for create_instance or restore_storage_state. SessionStorage and browser extensions are not included.',
    schema: z.object({ ...instance, indexed_db: z.boolean().default(false) }).strict(),
  },
  restore_storage_state: {
    description:
      'Replace cookies and origin storage from an owned saved storage_state_id. Existing pages should be explicitly reloaded to use the restored login. New instances can instead pass storage_state_id to create_instance.',
    schema: z.object({ ...instance, storage_state_id: id }).strict(),
  },
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
    description:
      'Capture this tab, full page, one element or viewport clip. Returns the original PNG artifact plus an inline image preview in MCP. Preview dimensions may be scaled; pointer coordinates remain viewport CSS pixels.',
    schema: z
      .object({
        ...page,
        full_page: z.boolean().default(false),
        target: target.optional(),
        clip: z
          .object({
            x: z.number().min(0),
            y: z.number().min(0),
            width: z.number().min(1).max(3840),
            height: z.number().min(1).max(3840),
          })
          .optional(),
      })
      .strict()
      .refine(
        (a) => [a.full_page, a.target, a.clip].filter(Boolean).length <= 1,
        'Use at most one full_page, target or clip',
      ),
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
