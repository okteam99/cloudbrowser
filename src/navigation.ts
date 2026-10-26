import { randomUUID } from 'node:crypto';
import type { CDPSession, Page, Request, Response } from 'playwright';

export type NavigationEvent = {
  navigation_id: string;
  hop_id: string;
  parent_hop_id?: string;
  kind:
    | 'request'
    | 'redirect'
    | 'response'
    | 'committed'
    | 'loaded'
    | 'same_document'
    | 'external_protocol'
    | 'failed'
    | 'download'
    | 'capture_warning';
  url: string;
  to_url?: string;
  status?: number;
  method?: string;
  initiator?: string;
  error?: string;
  content_type?: string;
  filename?: string;
  elapsed_ms?: number;
  url_truncated?: boolean;
};
type Hop = {
  id: string;
  chain: string;
  parent?: string;
  url: string;
  started: number;
  pw: boolean;
  native: boolean;
  response: boolean;
  failed: boolean;
  committed: boolean;
  truncated: boolean;
};
type NativeRequest = { current: Hop; extra: Hop[]; pending: any[] };
const limit = 16384;
const external = (url: string) => /^(?!https?:|about:|data:|blob:)[a-z][a-z0-9+.-]*:/i.test(url);

// Top-level navigation only. Playwright observes early popup requests; native
// CDP supplies responses/intent redirects that never commit a document.
export class NavigationRecorder {
  ready = false;
  lastExternal?: string;
  private hops: Hop[] = [];
  private requests = new WeakMap<Request, Hop>();
  private native = new Map<string, NativeRequest>();
  private current?: Hop;
  private disposed = false;
  private pending = new Set<Promise<unknown>>();
  constructor(
    private page: Page,
    private emit: (event: NavigationEvent) => void,
  ) {
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || this.ready) return;
      this.commit(frame.url());
    });
    page.on('domcontentloaded', () => {
      if (this.current) this.write(this.current, 'loaded');
    });
    page.on('close', () => {
      this.disposed = true;
      this.native.clear();
      this.hops = [];
    });
  }
  begin() {
    this.lastExternal = undefined;
  }
  async flush() {
    await Promise.allSettled([...this.pending]);
  }
  private newHop(url: string, previous?: Hop): Hop {
    const hop: Hop = {
      id: `hop_${randomUUID()}`,
      chain: previous?.chain ?? `nav_${randomUUID()}`,
      parent: previous?.id,
      url: url.slice(0, limit),
      started: Date.now(),
      pw: false,
      native: false,
      response: false,
      failed: false,
      committed: false,
      truncated: url.length > limit,
    };
    this.hops.push(hop);
    if (this.hops.length > 128) this.hops.shift();
    this.current = hop;
    return hop;
  }
  private write(hop: Hop, kind: NavigationEvent['kind'], extra: Partial<NavigationEvent> = {}) {
    if (this.disposed) return;
    const rawUrl = extra.url ?? hop.url;
    const rawTo = extra.to_url;
    this.emit({
      ...extra,
      navigation_id: hop.chain,
      hop_id: hop.id,
      parent_hop_id: hop.parent,
      kind,
      elapsed_ms: Date.now() - hop.started,
      url: rawUrl.slice(0, limit),
      to_url: rawTo?.slice(0, limit),
      url_truncated:
        (extra.url === undefined ? hop.truncated : rawUrl.length > limit) ||
        (rawTo?.length ?? 0) > limit,
    });
  }
  private commit(url: string) {
    const hop = this.current?.url === url ? this.current : this.newHop(url);
    if (hop.committed) return;
    hop.committed = true;
    this.write(hop, 'committed');
  }
  request(request: Request) {
    if (this.requests.has(request) || !request.isNavigationRequest()) return;
    try {
      if (request.frame() !== this.page.mainFrame()) return;
    } catch {
      return;
    }
    // Initial popup requests may precede Page/Frame creation. Once the final
    // request has a main frame, recover its real linked predecessors from
    // Playwright's retained Request objects, without issuing another HTTP call.
    const chain: Request[] = [];
    let prior = request.redirectedFrom();
    while (prior && !this.requests.has(prior) && chain.length < 128) {
      chain.push(prior);
      prior = prior.redirectedFrom();
    }
    for (const old of chain.reverse()) {
      this.recordRequest(old);
      const reading = old
        .response()
        .then((response) => {
          if (response) this.response(response);
        })
        .catch(() => {});
      this.pending.add(reading);
      void reading.then(() => this.pending.delete(reading));
    }
    this.recordRequest(request);
  }
  private recordRequest(request: Request) {
    if (this.requests.has(request)) return;
    const previous = request.redirectedFrom()
      ? this.requests.get(request.redirectedFrom()!)
      : undefined;
    const hop =
      this.hops.find((h) => !h.pw && h.url === request.url()) ??
      this.newHop(request.url(), previous);
    const already = hop.native;
    hop.pw = true;
    this.current = hop;
    this.requests.set(request, hop);
    if (!already)
      this.write(hop, 'request', {
        method: request.method(),
        initiator: previous ? 'redirect' : 'browser',
      });
  }
  response(response: Response) {
    const hop = this.requests.get(response.request());
    if (hop) this.respond(hop, response.status(), response.headers());
  }
  failed(request: Request) {
    const hop = this.requests.get(request);
    if (hop && !hop.failed) {
      hop.failed = true;
      this.write(hop, 'failed', {
        error: request.failure()?.errorText.slice(0, 512) ?? 'REQUEST_FAILED',
      });
    }
  }
  download(url: string, filename: string) {
    const hop =
      [...this.hops].reverse().find((h) => h.url === url) ?? this.current ?? this.newHop(url);
    this.write(hop, 'download', { url, filename: filename.slice(0, 512) });
  }
  warning() {
    const hop = this.current ?? this.newHop(this.page.url());
    this.write(hop, 'capture_warning', {
      error: 'Native navigation observer unavailable; browser events may be incomplete.',
    });
  }
  private respond(hop: Hop, status: number, headers: Record<string, any>) {
    if (hop.response) return;
    hop.response = true;
    const lower = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    let target = lower.location;
    if (target) {
      try {
        target = new URL(target, hop.url).href;
      } catch {}
    }
    this.write(hop, status >= 300 && status < 400 && target ? 'redirect' : 'response', {
      status,
      to_url: target,
      content_type: lower['content-type']?.slice(0, 256),
    });
    if (target && external(target)) this.externalTarget(target, hop);
  }
  private externalTarget(url: string, previous?: Hop) {
    // The network event strips the fragment from intent URIs. Retain the full
    // Location (including app/fallback parameters), without marking it twice.
    if (
      this.lastExternal === url ||
      (this.lastExternal?.includes('#') &&
        !url.includes('#') &&
        this.lastExternal.split('#')[0] === url)
    )
      return;
    this.lastExternal = url.slice(0, limit);
    const hop =
      this.current?.url === url ? this.current : this.newHop(url, previous ?? this.current);
    this.write(hop, 'external_protocol', {
      initiator: 'browser',
      error: 'REQUIRES_EXTERNAL_HANDLER',
    });
  }
  private drain(state: NativeRequest) {
    while (state.extra.length && state.pending.length) {
      const hop = state.extra.shift()!;
      const response = state.pending.shift()!;
      this.respond(hop, response.statusCode, response.headers ?? {});
    }
  }
  async attach(session: CDPSession) {
    const tree = await session.send('Page.getFrameTree');
    let main = tree.frameTree.frame.id;
    session.on('Page.frameNavigated', ({ frame }) => {
      if (frame.parentId) return;
      main = frame.id;
      this.commit(frame.url);
    });
    session.on('Network.requestWillBeSent', (e) => {
      if (e.type !== 'Document' || e.frameId !== main || this.disposed) return;
      let state = this.native.get(e.requestId);
      let previous = state?.current;
      if (e.redirectResponse) {
        const redirect = e.redirectResponse;
        previous =
          previous ??
          [...this.hops].reverse().find((h) => h.url === redirect.url) ??
          this.newHop(redirect.url);
        this.respond(previous, e.redirectResponse.status, e.redirectResponse.headers);
        if (state && !e.redirectHasExtraInfo)
          state.extra = state.extra.filter((h) => h !== previous);
      }
      const hop =
        this.hops.find((h) => !h.native && h.url === e.request.url) ??
        this.newHop(e.request.url, previous);
      const already = hop.pw;
      hop.native = true;
      this.current = hop;
      if (!already)
        this.write(hop, 'request', {
          method: e.request.method,
          initiator: e.redirectResponse ? 'redirect' : e.initiator?.type,
        });
      if (external(e.request.url)) this.externalTarget(e.request.url, previous);
      if (!state) {
        state = { current: hop, extra: [], pending: [] };
        this.native.set(e.requestId, state);
      }
      state.current = hop;
      state.extra.push(hop);
      if (state.extra.length > 128) state.extra.shift();
      this.drain(state);
      if (this.native.size > 128) this.native.delete(this.native.keys().next().value!);
    });
    session.on('Network.responseReceived', (e) => {
      const state = this.native.get(e.requestId);
      if (state) {
        this.respond(state.current, e.response.status, e.response.headers);
        if (!e.hasExtraInfo) state.extra = state.extra.filter((h) => h !== state.current);
        this.drain(state);
      }
    });
    session.on('Network.responseReceivedExtraInfo', (e) => {
      const state = this.native.get(e.requestId);
      if (state) {
        state.pending.push(e);
        if (state.pending.length > 128) state.pending.shift();
        this.drain(state);
      }
    });
    session.on('Network.loadingFailed', (e) => {
      const hop = this.native.get(e.requestId)?.current;
      if (hop && !hop.failed) {
        hop.failed = true;
        this.write(hop, 'failed', { error: e.errorText.slice(0, 512) });
      }
    });
    session.on('Page.frameRequestedNavigation', (e) => {
      if (e.frameId === main && external(e.url)) this.externalTarget(e.url);
    });
    session.on('Page.navigatedWithinDocument', (e) => {
      if (e.frameId === main)
        this.write(this.current ?? this.newHop(e.url), 'same_document', {
          url: e.url,
          initiator: e.navigationType,
        });
    });
    await session.send('Page.enable');
    await session.send('Network.enable');
    this.ready = true;
  }
}
