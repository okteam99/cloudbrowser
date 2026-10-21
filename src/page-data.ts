import type { Page, Request, Response, Frame } from 'playwright';
import { randomUUID } from 'node:crypto';
import { ToolError } from './errors.js';

// Bounded per-tab journals. Updating a record advances its cursor, so response updates are observable.
class Journal<T extends { id: string; seq: number }> {
  rows = new Map<string, T>();
  seq = 0;
  dropped = 0;
  evictedThrough = 0;
  private bytes = 0;
  private costs = new Map<string, number>();
  constructor(
    private maxEntries: number,
    private maxBytes: number,
  ) {}
  put(row: Omit<T, 'seq'> | T) {
    this.bytes -= this.costs.get(row.id) ?? 0;
    const next = { ...row, seq: ++this.seq } as T;
    const size = Buffer.byteLength(JSON.stringify(next));
    this.rows.delete(row.id);
    this.rows.set(row.id, next);
    this.costs.set(row.id, size);
    this.bytes += size;
    while (this.rows.size > this.maxEntries || this.bytes > this.maxBytes) {
      const first = this.rows.values().next().value!;
      this.evictedThrough = Math.max(this.evictedThrough, first.seq);
      this.rows.delete(first.id);
      this.bytes -= this.costs.get(first.id)!;
      this.costs.delete(first.id);
      this.dropped++;
    }
    return next;
  }
  patch(id: string, fields: Partial<T>) {
    const row = this.rows.get(id);
    if (row) this.put({ ...row, ...fields });
  }
  query(options: { after_seq?: number; limit?: number }, filter: (r: T) => boolean) {
    const all = [...this.rows.values()].filter(
      (r) => (options.after_seq === undefined || r.seq > options.after_seq) && filter(r),
    );
    const limit = options.limit ?? 100;
    const entries = options.after_seq === undefined ? all.slice(-limit) : all.slice(0, limit);
    return {
      entries,
      next_after_seq: entries.at(-1)?.seq ?? options.after_seq ?? this.seq,
      has_more: options.after_seq !== undefined && all.length > entries.length,
      history_truncated: options.after_seq !== undefined && options.after_seq < this.evictedThrough,
      dropped_entries: this.dropped,
    };
  }
}
export type Body = { encoding: 'utf8' | 'base64'; data: string; bytes: number; truncated: boolean };
export type NetworkEntry = {
  id: string;
  seq: number;
  time: string;
  updated_at: string;
  url: string;
  method: string;
  resource_type: string;
  frame_id?: string;
  navigation: boolean;
  redirect_from?: string;
  status: 'pending' | 'finished' | 'failed';
  status_code?: number;
  error?: string;
  request_headers: Record<string, string>;
  response_headers?: Record<string, string>;
  request_body: Body | null;
  response_body: Body | null;
  response_body_status: 'pending' | 'available' | 'too_large' | 'unavailable';
  body_error?: string;
  elapsed_ms?: number;
  response_bytes?: number;
  timing?: ReturnType<Request['timing']>;
  content_type?: string;
};
type ConsoleEntry = {
  id: string;
  seq: number;
  time: string;
  level: string;
  text: string;
  stack?: string;
  location?: { url: string; lineNumber: number; columnNumber: number };
  truncated: boolean;
};
const cut = (value: string, max = 16384) => value.slice(0, max);
function headers(values: Record<string, string>) {
  let remaining = 32768;
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(values).slice(0, 100)) {
    if (remaining <= 0) break;
    result[cut(name, 256)] = cut(value, remaining);
    remaining -= name.length + result[cut(name, 256)].length;
  }
  return result;
}
// A global queue bounds concurrent body reads, including across instances.
let capturing = 0;
const captures: (() => Promise<void>)[] = [];
function pumpCaptures() {
  while (capturing < 2 && captures.length) {
    const work = captures.shift()!;
    capturing++;
    void work()
      .catch(() => {})
      .finally(() => {
        capturing--;
        pumpCaptures();
      });
  }
}
function capture(work: () => Promise<void>) {
  if (captures.length >= 16) return false;
  captures.push(work);
  pumpCaptures();
  return true;
}
export class PageData {
  title = '';
  state = 'created';
  closed = false;
  readonly requests: Journal<NetworkEntry>;
  readonly console: Journal<ConsoleEntry>;
  private requestIds = new WeakMap<Request, string>();
  private frameIds = new WeakMap<Frame, string>();
  private disposed = false;
  constructor(
    readonly page: Page,
    private bodyLimit = 262144,
  ) {
    this.requests = new Journal(200, 4194304);
    this.console = new Journal(300, 1048576);
    const title = () => {
      const url = page.url();
      void page
        .title()
        .then((t) => {
          if (page.url() === url) this.title = cut(t, 4096);
        })
        .catch(() => {});
    };
    page.on('domcontentloaded', () => {
      this.state = 'domcontentloaded';
      title();
    });
    page.on('load', () => {
      this.state = 'load';
      title();
    });
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) {
        if (this.state === 'created') this.state = 'loading';
        title();
      }
    });
    page.on('close', () => {
      this.closed = true;
      this.state = 'closed';
    });
    page.on('crash', () => {
      this.state = 'crashed';
    });
    page.on('console', (m) =>
      this.console.put({
        id: `console_${randomUUID()}`,
        time: new Date().toISOString(),
        level: m.type(),
        text: cut(m.text()),
        location: m.location(),
        truncated: m.text().length > 16384,
      }),
    );
    page.on('pageerror', (e) =>
      this.console.put({
        id: `console_${randomUUID()}`,
        time: new Date().toISOString(),
        level: 'pageerror',
        text: cut(e.message),
        stack: cut(e.stack ?? '', 32768),
        truncated: e.message.length > 16384 || (e.stack?.length ?? 0) > 32768,
      }),
    );
  }
  frameId(frame: Frame) {
    if (!this.frameIds.has(frame)) this.frameIds.set(frame, `frame_${randomUUID()}`);
    return this.frameIds.get(frame)!;
  }
  frame(id: string) {
    const frame = this.page.frames().find((f) => this.frameId(f) === id);
    if (!frame) throw new ToolError('FRAME_NOT_FOUND', 'Unknown or detached frame.');
    return frame;
  }
  info(pageId: string, active: boolean) {
    return {
      page_id: pageId,
      url: this.page.url(),
      title: this.title,
      active,
      state: this.state,
      dialog: undefined as string | undefined,
      metadata_source: 'cached_events',
      frames: this.page
        .frames()
        .slice(0, 200)
        .map((f) => ({
          frame_id: this.frameId(f),
          parent_frame_id: f.parentFrame() ? this.frameId(f.parentFrame()!) : null,
          name: f.name(),
          url: f.url(),
        })),
    };
  }
  request(request: Request) {
    if (this.disposed || this.requestIds.has(request)) return;
    const id = `req_${randomUUID()}`;
    this.requestIds.set(request, id);
    try {
      if (request.isNavigationRequest() && request.frame() === this.page.mainFrame()) {
        this.state = 'loading';
        this.title = '';
      }
    } catch {}
    let frameId: string | undefined;
    try {
      frameId = this.frameId(request.frame());
    } catch {}
    const bytes = request.postDataBuffer();
    const time = new Date().toISOString();
    this.requests.put({
      id,
      time,
      updated_at: time,
      url: cut(request.url(), 16384),
      method: request.method(),
      resource_type: request.resourceType(),
      navigation: request.isNavigationRequest(),
      frame_id: frameId,
      redirect_from: request.redirectedFrom()
        ? this.requestIds.get(request.redirectedFrom()!)
        : undefined,
      status: 'pending',
      request_headers: headers(request.headers()),
      request_body: bytes ? this.body(bytes, true) : null,
      response_body: null,
      response_body_status: 'pending',
    });
    void request
      .allHeaders()
      .then((h) => this.patch(id, { request_headers: headers(h) }))
      .catch(() => {});
  }
  response(response: Response) {
    const id = this.requestIds.get(response.request());
    if (!id) return;
    this.patch(id, {
      status_code: response.status(),
      response_headers: headers(response.headers()),
      content_type: response.headers()['content-type'],
    });
    void response
      .allHeaders()
      .then((h) =>
        this.patch(id, { response_headers: headers(h), content_type: h['content-type'] }),
      )
      .catch(() => {});
  }
  finished(request: Request) {
    const id = this.requestIds.get(request);
    if (!id) return;
    this.patch(id, {
      status: 'finished',
      timing: request.timing(),
      elapsed_ms: Math.max(
        0,
        Date.now() - Date.parse(this.requests.rows.get(id)?.time ?? new Date().toISOString()),
      ),
    });
    const accepted = capture(async () => {
      if (this.disposed || !this.requests.rows.has(id)) return;
      try {
        const size = await request.sizes();
        this.patch(id, { response_bytes: size.responseBodySize });
        const response = await request.response();
        if (!response)
          return this.patch(id, { response_body_status: 'unavailable', body_error: 'NO_RESPONSE' });
        const h = response.headers();
        if (
          size.responseBodySize > this.bodyLimit ||
          Number(h['content-length'] ?? 0) > this.bodyLimit
        ) {
          this.patch(id, { response_body_status: 'too_large' });
          return;
        }
        // Avoid fetching large decoded compressed resources merely for diagnostics.
        if (h['content-encoding'] && size.responseBodySize > this.bodyLimit / 8) {
          this.patch(id, {
            response_body_status: 'too_large',
            body_error: 'COMPRESSED_RESOURCE_LIMIT',
          });
          return;
        }
        const bytes = await response.body();
        if (!this.disposed)
          this.patch(id, {
            response_body: this.body(
              bytes,
              /(?:text|json|javascript|xml|form-urlencoded)/i.test(h['content-type'] ?? ''),
            ),
            response_body_status: 'available',
          });
      } catch {
        this.patch(id, { response_body_status: 'unavailable', body_error: 'BODY_UNAVAILABLE' });
      }
    });
    if (!accepted)
      this.patch(id, { response_body_status: 'unavailable', body_error: 'CAPTURE_QUEUE_FULL' });
  }
  failed(request: Request) {
    const id = this.requestIds.get(request);
    if (id)
      this.patch(id, {
        status: 'failed',
        error: cut(request.failure()?.errorText ?? 'REQUEST_FAILED'),
        response_body_status: 'unavailable',
        elapsed_ms: Math.max(
          0,
          Date.now() - Date.parse(this.requests.rows.get(id)?.time ?? new Date().toISOString()),
        ),
      });
  }
  private patch(id: string, patch: Partial<NetworkEntry>) {
    if (!this.disposed) this.requests.patch(id, { ...patch, updated_at: new Date().toISOString() });
  }
  private body(bytes: Buffer, text: boolean): Body {
    const limited = bytes.subarray(0, this.bodyLimit);
    return {
      encoding: text ? 'utf8' : 'base64',
      data: limited.toString(text ? 'utf8' : 'base64'),
      bytes: bytes.length,
      truncated: bytes.length > this.bodyLimit,
    };
  }
  network(options: {
    after_seq?: number;
    limit?: number;
    url?: string;
    method?: string;
    resource_type?: string;
    status_code?: number;
    failed_only?: boolean;
  }) {
    const result = this.requests.query(
      options,
      (r) =>
        (!options.url || r.url.includes(options.url)) &&
        (!options.method || r.method === options.method) &&
        (!options.resource_type || r.resource_type === options.resource_type) &&
        (options.status_code === undefined || r.status_code === options.status_code) &&
        (!options.failed_only || r.status === 'failed'),
    );
    return {
      ...result,
      entries: result.entries.map(
        ({
          request_headers: _a,
          response_headers: _b,
          request_body: _c,
          response_body: _d,
          ...r
        }) => ({ ...r, request_id: r.id }),
      ),
    };
  }
  detail(id: string, includeBody: boolean) {
    const r = this.requests.rows.get(id);
    if (!r) throw new ToolError('REQUEST_NOT_FOUND', 'Unknown or evicted request.');
    const { request_body, response_body, ...rest } = r;
    return { ...rest, request_id: r.id, ...(includeBody ? { request_body, response_body } : {}) };
  }
  consoleLogs(options: { after_seq?: number; limit?: number; level?: string }) {
    return this.console.query(options, (r) => !options.level || r.level === options.level);
  }
  dispose() {
    this.disposed = true;
  }
}
