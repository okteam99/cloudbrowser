import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { userAgentMetadata, clientHintHeaders } from '../src/user-agent.js';

// Playwright 1.64.1 does not expose userAgentMetadata as a public context option.
// Its built-in hook already runs before navigation for every page and OOPIF,
// and for workers. Replace only its incomplete UA parser, not CDP lifecycle code.
// Fail closed on a dependency change instead of silently losing this behavior.
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('playwright-core/package.json'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (pkg.version !== '1.64.1')
  throw new Error('Review UA-CH compatibility patch for new Playwright version');
const file = join(root, 'lib/coreBundle.js');
const source = await readFile(file, 'utf8');
const start = source.indexOf('function calculateUserAgentMetadata(options) {');
const end = source.indexOf('\nvar kCrashingWebUIHosts', start);
if (start < 0 || end < 0) throw new Error('Playwright UA-CH hook not found');
const original = source.slice(start, end);
const marker = '/* cloudbrowser UA-CH compatibility */';
const checksum = createHash('sha256').update(original).digest('hex');
if (
  !original.includes(marker) &&
  checksum !== 'fa5685db391cf003acec06d2d9a92752a69d6db67dca22216a1f1cc3bfc65a1c'
)
  throw new Error('Playwright UA-CH hook changed; review before installing');
const replacement =
  userAgentMetadata
    .toString()
    .replace(
      'function userAgentMetadata(options) {',
      'function calculateUserAgentMetadata(options) {\n  ' + marker,
    ) +
  '\n' +
  clientHintHeaders
    .toString()
    .replace('function clientHintHeaders(', 'function cloudbrowserClientHintHeaders(')
    .replace('userAgentMetadata({', 'calculateUserAgentMetadata({');
let patched = source.slice(0, start) + replacement + source.slice(end);
function replaceOnce(before, after) {
  if (patched.includes(after)) return;
  if (patched.split(before).length !== 2)
    throw new Error('Playwright request hook changed; review UA-CH patch');
  patched = patched.replace(before, after);
}
// Chromium constructs popup request hints before the target UA override exists.
// Normalize only UA-CH at the native Fetch continuation, retaining per-hop
// browser headers. Do not save normalized headers in _alreadyContinuedParams:
// that would replay Cookie/Authorization or high-entropy opt-ins on redirects.
const requestHeaders = (headers, ua) =>
  `headersObjectToArray(cloudbrowserClientHintHeaders(${headers}, ${ua}))`;
const contextUA = '(this._page || this._serviceWorker).browserContext._options.userAgent';
replaceOnce(
  'route2 = new RouteImpl(requestPausedSessionInfo.session, requestPausedEvent.requestId);',
  `route2 = new RouteImpl(requestPausedSessionInfo.session, requestPausedEvent.requestId, ${contextUA}, requestPausedEvent.request.headers);`,
);
replaceOnce(
  'RouteImpl = class {\n      constructor(session, interceptionId) {\n        this._fulfilled = false;',
  'RouteImpl = class {\n      constructor(session, interceptionId, cloudbrowserUA, cloudbrowserHeaders) {\n        this._cloudbrowserUA = cloudbrowserUA;\n        this._cloudbrowserHeaders = cloudbrowserHeaders;\n        this._fulfilled = false;',
);
replaceOnce(
  'await this._session.send("Fetch.continueRequest", this._alreadyContinuedParams);',
  `await this._session.send("Fetch.continueRequest", { ...this._alreadyContinuedParams, headers: this._cloudbrowserUA ? ${requestHeaders('this._alreadyContinuedParams.headers ? Object.fromEntries(this._alreadyContinuedParams.headers.map(h => [h.name, h.value])) : this._cloudbrowserHeaders', 'this._cloudbrowserUA')} : this._alreadyContinuedParams.headers });`,
);
replaceOnce(
  'requestPausedSessionInfo.session._sendMayFail("Fetch.continueRequest", { requestId: requestPausedEvent.requestId, headers: headersOverride });',
  `requestPausedSessionInfo.session._sendMayFail("Fetch.continueRequest", { requestId: requestPausedEvent.requestId, headers: ${contextUA} ? ${requestHeaders('headersOverride ? Object.fromEntries(headersOverride.map(h => [h.name, h.value])) : requestPausedEvent.request.headers', contextUA)} : headersOverride });`,
);
replaceOnce(
  '...alreadyContinuedParams,\n              requestId: event.requestId',
  `...alreadyContinuedParams,\n              headers: ${contextUA} ? ${requestHeaders('alreadyContinuedParams.headers ? Object.fromEntries(alreadyContinuedParams.headers.map(h => [h.name, h.value])) : event.request.headers', contextUA)} : alreadyContinuedParams.headers,\n              requestId: event.requestId`,
);
await writeFile(file, patched);
console.log('Playwright UA-CH metadata now follows the configured UA.');
