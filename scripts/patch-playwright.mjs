import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { userAgentMetadata, clientHintHeaders } from '../src/user-agent.js';

// Playwright 1.64.1 does not expose userAgentMetadata as a public context option.
// Its built-in hook already runs before navigation for every page and OOPIF,
// and for workers. Configure the selected identity before target scripts start.
// Fail closed on a dependency change instead of silently losing this behavior.
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('playwright-core/package.json'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (pkg.version !== '1.64.1')
  throw new Error('Review UA-CH compatibility patch for new Playwright version');
const file = join(root, 'lib/coreBundle.js');
const pristine = join(root, 'lib/coreBundle.cloudbrowser-original.js');
let source;
try {
  source = await readFile(pristine, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  source = await readFile(file, 'utf8');
  if (source.includes('/* cloudbrowser UA-CH compatibility */'))
    throw new Error('Run npm ci once to refresh the previous UA compatibility patch');
  await writeFile(pristine, source, { flag: 'wx' });
}
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
const requestHeaders = (headers, ua, profile) =>
  `headersObjectToArray(cloudbrowserClientHintHeaders(${headers}, ${ua}, ${profile}))`;
const contextUA = '(this._page || this._serviceWorker).browserContext._options.userAgent';
const contextProfile =
  '(this._page || this._serviceWorker).browserContext._options.cloudbrowserDeviceProfile';
replaceOnce(
  'route2 = new RouteImpl(requestPausedSessionInfo.session, requestPausedEvent.requestId);',
  `route2 = new RouteImpl(requestPausedSessionInfo.session, requestPausedEvent.requestId, ${contextUA}, requestPausedEvent.request.headers, ${contextProfile});`,
);
replaceOnce(
  'RouteImpl = class {\n      constructor(session, interceptionId) {\n        this._fulfilled = false;',
  'RouteImpl = class {\n      constructor(session, interceptionId, cloudbrowserUA, cloudbrowserHeaders, cloudbrowserProfile) {\n        this._cloudbrowserUA = cloudbrowserUA;\n        this._cloudbrowserProfile = cloudbrowserProfile;\n        this._cloudbrowserHeaders = cloudbrowserHeaders;\n        this._fulfilled = false;',
);
replaceOnce(
  'await this._session.send("Fetch.continueRequest", this._alreadyContinuedParams);',
  `await this._session.send("Fetch.continueRequest", { ...this._alreadyContinuedParams, headers: this._cloudbrowserUA ? ${requestHeaders('this._alreadyContinuedParams.headers ? Object.fromEntries(this._alreadyContinuedParams.headers.map(h => [h.name, h.value])) : this._cloudbrowserHeaders', 'this._cloudbrowserUA', 'this._cloudbrowserProfile')} : this._alreadyContinuedParams.headers });`,
);
replaceOnce(
  'requestPausedSessionInfo.session._sendMayFail("Fetch.continueRequest", { requestId: requestPausedEvent.requestId, headers: headersOverride });',
  `requestPausedSessionInfo.session._sendMayFail("Fetch.continueRequest", { requestId: requestPausedEvent.requestId, headers: ${contextUA} ? ${requestHeaders('headersOverride ? Object.fromEntries(headersOverride.map(h => [h.name, h.value])) : requestPausedEvent.request.headers', contextUA, contextProfile)} : headersOverride });`,
);
replaceOnce(
  '...alreadyContinuedParams,\n              requestId: event.requestId',
  `...alreadyContinuedParams,\n              headers: ${contextUA} ? ${requestHeaders('alreadyContinuedParams.headers ? Object.fromEntries(alreadyContinuedParams.headers.map(h => [h.name, h.value])) : event.request.headers', contextUA, contextProfile)} : alreadyContinuedParams.headers,\n              requestId: event.requestId`,
);
// Pass a bounded, validated profile through Playwright's local protocol. It is
// never carried in a URL, User-Agent string, or custom HTTP header.
replaceOnce(
  'scheme.BrowserNewContextParams = tObject({',
  'scheme.BrowserNewContextParams = tObject({\n      cloudbrowserDeviceProfile: tOptional(tAny),',
);
// Both page/OOPIF and service-worker UA initialization use these fields.
const uaFields =
  'acceptLanguage: options.locale,\n          userAgentMetadata: calculateUserAgentMetadata(options)';
if (patched.split(uaFields).length !== 3) throw new Error('Playwright UA override sites changed');
patched = patched.replaceAll(
  uaFields,
  'acceptLanguage: options.cloudbrowserDeviceProfile?.languages?.join(",") || options.locale,\n          platform: options.cloudbrowserDeviceProfile?.platform,\n          userAgentMetadata: calculateUserAgentMetadata(options)',
);
replaceOnce(
  'if (options.hasTouch)\n            promises2.push(this._client.send("Emulation.setTouchEmulationEnabled", { enabled: true }));',
  'if (options.cloudbrowserDeviceProfile?.hardwareConcurrency)\n            promises2.push(this._client.send("Emulation.setHardwareConcurrencyOverride", { hardwareConcurrency: options.cloudbrowserDeviceProfile.hardwareConcurrency }));\n          if (options.cloudbrowserDeviceProfile?.observables?.navigator?.webdriver !== undefined) promises2.push(this._client.send("Emulation.setAutomationOverride", { enabled: options.cloudbrowserDeviceProfile.observables.navigator.webdriver }));\n          if (options.hasTouch)\n            promises2.push(this._client.send("Emulation.setTouchEmulationEnabled", { enabled: true }));',
);
replaceOnce(
  'await this._client.send("Emulation.setEmulatedMedia", { media, features });',
  'const extra = this._crPage._browserContext._options.cloudbrowserDeviceProfile?.observables?.media; if (extra && extra["color-gamut: p3"] !== undefined) features.push({ name: "color-gamut", value: extra["color-gamut: p3"] ? "p3" : "srgb" });\n        await this._client.send("Emulation.setEmulatedMedia", { media, features });',
);
replaceOnce(
  'this._client.send("Emulation.setTouchEmulationEnabled", { enabled: true })',
  'this._client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: options.cloudbrowserDeviceProfile?.observables?.navigator?.max_touch_points || 1 })',
);
// Dedicated workers need target-scoped UA/language/CPU settings. Chromium does
// not apply the platform override to WorkerNavigator on Linux; fill that one
// declared property before worker scripts start. This is visible script
// emulation, not a claim that the Worker is a native macOS runtime.
replaceOnce(
  'session._sendMayFail("Runtime.runIfWaitingForDebugger");\n        session._sendMayFail("Target.setAutoAttach",',
  'const options = this._crPage._browserContext._options;\n        const profile = options.cloudbrowserDeviceProfile;\n        const configured = profile ? Promise.all([session.send("Emulation.setUserAgentOverride", { userAgent: options.userAgent, platform: profile.platform, acceptLanguage: profile.languages.join(","), userAgentMetadata: calculateUserAgentMetadata(options) }), ...(profile.hardwareConcurrency ? [session.send("Emulation.setHardwareConcurrencyOverride", { hardwareConcurrency: profile.hardwareConcurrency })] : [])]) : (async () => { let ua = options.userAgent; let metadata = calculateUserAgentMetadata(options); if (!ua) { let timer; let observed; try { observed = await Promise.race([(async()=>{const world = await this._client.send("Page.createIsolatedWorld", { frameId: this._targetId, worldName: "__cloudbrowser_worker_locale_native" }); return this._client.send("Runtime.evaluate", { contextId: world.executionContextId, expression: `(async()=>{const n=navigator;return {ua:n.userAgent,hints:n.userAgentData?await n.userAgentData.getHighEntropyValues(["fullVersionList","uaFullVersion","platformVersion","architecture","bitness","model","wow64","formFactors"]):null}})()`, awaitPromise: true, returnByValue: true });})(), new Promise((_, reject) => { timer=setTimeout(()=>reject(new Error("Native worker locale identity timed out")),2000); })]); } finally {clearTimeout(timer);} if (observed.exceptionDetails || !observed.result.value?.ua) throw new Error("Worker native identity unavailable"); const identity=observed.result.value; ua=identity.ua; const h=identity.hints; if(h) metadata={brands:h.brands,fullVersionList:h.fullVersionList,fullVersion:h.uaFullVersion || h.fullVersionList?.find(b=>b.brand==="Chromium")?.version || "",platform:h.platform || "",platformVersion:h.platformVersion || "",architecture:h.architecture || "",bitness:h.bitness || "",model:h.model || "",mobile:!!h.mobile,wow64:!!h.wow64,formFactors:h.formFactors}; } await session.send("Emulation.setUserAgentOverride", {userAgent:ua,acceptLanguage:options.locale,userAgentMetadata:metadata}); })();\n        configured.then(async () => { if (profile) { const result = await session.send("Runtime.evaluate", { expression: `if (navigator.platform !== ${JSON.stringify(profile.platform)}) Object.defineProperty(Object.getPrototypeOf(navigator), "platform", { get: () => ${JSON.stringify(profile.platform)}, configurable: true, enumerable: true }); true` }); if (result.exceptionDetails) throw new Error("Worker platform emulation failed"); if (profile.observablesScript) { const observed = await session.send("Runtime.evaluate", { expression: profile.observablesScript }); if (observed.exceptionDetails) throw new Error("Worker observable emulation failed"); } } }).catch(() => {}).finally(() => session._sendMayFail("Runtime.runIfWaitingForDebugger"));\n        session._sendMayFail("Target.setAutoAttach",',
);
await writeFile(file, patched);
console.log('Playwright UA-CH metadata now follows the configured UA.');
