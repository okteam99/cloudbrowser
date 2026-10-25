/**
 * @typedef {{brands: {brand:string,version:string}[], fullVersionList:{brand:string,version:string}[], fullVersion:string, platform:string, platformVersion:string, architecture:string, bitness:string, model:string, mobile:boolean, wow64:boolean, formFactors:string[]}} UserAgentMetadata
 */
/**
 * Native Chromium UA-CH metadata for the identity declared by a custom UA.
 * Kept self-contained: the pinned Playwright compatibility patch embeds this
 * function at its existing pre-navigation page/frame/worker initialization hook.
 * Unknown values stay empty rather than falling back to the host's identity.
 * @param {{userAgent?: string, cloudbrowserDeviceProfile?: {metadata:UserAgentMetadata}}} options
 * @returns {UserAgentMetadata | undefined}
 */
export function userAgentMetadata(options) {
  if (options.cloudbrowserDeviceProfile) return options.cloudbrowserDeviceProfile.metadata;
  const ua = options.userAgent;
  if (!ua) return undefined;
  const chrome = ua.match(/\b(HeadlessChrome|Chrome|Chromium)\/(\d+(?:\.\d+){0,3})\b/);
  // Safari/Firefox/iOS and opaque custom UAs do not advertise Chromium hints.
  if (!chrome || /\b(?:iPhone|iPad|iPod|CriOS|FxiOS)\b/.test(ua)) return undefined;
  const version = (/** @type {string} */ v) =>
    v.split('.').concat(['0', '0', '0']).slice(0, 4).join('.');
  const fullVersion = version(chrome[2]);
  const brands = [{ brand: 'Chromium', version: chrome[2].split('.')[0] }];
  const fullVersionList = [{ brand: 'Chromium', version: fullVersion }];
  const edge = ua.match(/\b(?:Edg|EdgA)\/(\d+(?:\.\d+){0,3})\b/);
  const opera = ua.match(/\bOPR\/(\d+(?:\.\d+){0,3})\b/);
  const brand = edge
    ? 'Microsoft Edge'
    : opera
      ? 'Opera'
      : chrome[1] === 'HeadlessChrome'
        ? 'HeadlessChrome'
        : chrome[1] === 'Chrome'
          ? 'Google Chrome'
          : null;
  if (brand) {
    const v = edge?.[1] ?? opera?.[1] ?? chrome[2];
    brands.push({ brand, version: v.split('.')[0] });
    fullVersionList.push({ brand, version: version(v) });
  }
  let platform = '',
    platformVersion = '',
    model = '';
  const android = ua.match(/Android\s+(\d+(?:\.\d+){0,2})/);
  const mac = ua.match(/Mac OS X\s+(\d+(?:[_.]\d+){0,2})/);
  const cros = ua.match(/CrOS\s+\S+\s+(\d+(?:\.\d+){0,2})/);
  if (android) {
    platform = 'Android';
    platformVersion = android[1];
    const tail = ua.slice(ua.indexOf(android[0]) + android[0].length).split(')')[0];
    model =
      tail
        .split(';')
        .map((s) => s.trim())
        .find((s) => s && !/^(?:wv|U|[a-z]{2}(?:[-_][a-z]{2})?)$/i.test(s)) ?? '';
    model = model.replace(/\s+Build\/.*$/, '').trim();
    // Reduced Android UAs contain K instead of the actual device model.
    if (model === 'K') model = '';
  } else if (/Windows/.test(ua)) {
    platform = 'Windows';
    // Windows NT 10.0 cannot distinguish Windows 10/11 or their UA-CH versions.
  } else if (cros) {
    platform = 'Chrome OS';
    platformVersion = cros[1];
  } else if (mac) {
    platform = 'macOS';
    // This token is frozen on modern macOS, including Apple Silicon.
    platformVersion = mac[1] === '10_15_7' ? '' : mac[1].replaceAll('_', '.');
  } else if (/Linux/.test(ua)) platform = 'Linux';
  const arm = /\b(?:arm\w*|aarch64)\b/i.test(ua);
  const x86 = /\b(?:x86(?:_64)?|x64|Win64|WOW64|i[3-6]86)\b/i.test(ua);
  const bits64 = /\b(?:x86_64|x64|Win64|WOW64|aarch64|arm64)\b/i.test(ua);
  return {
    brands,
    fullVersionList,
    fullVersion,
    platform,
    platformVersion,
    model,
    mobile: /\bMobile\b/.test(ua),
    formFactors: [/\bMobile\b/.test(ua) ? 'Mobile' : android ? 'Tablet' : 'Desktop'],
    architecture: arm ? 'arm' : x86 ? 'x86' : '',
    bitness: bits64 ? '64' : /\b(?:i[3-6]86|x86|armv7\w*)\b/i.test(ua) ? '32' : '',
    wow64: /\bWOW64\b/.test(ua),
  };
}

/**
 * Popup navigation headers can be composed before Playwright initializes its
 * target. Normalize already-present UA-CH headers at native Fetch continuation.
 * Do not add high-entropy hints without opt-in or hints to insecure requests.
 * @param {Record<string, string>} headers
 * @param {string | undefined} ua
 * @param {{metadata:UserAgentMetadata} | undefined} [profile]
 */
export function clientHintHeaders(headers, ua, profile) {
  if (!ua) return headers;
  const hints = userAgentMetadata({ userAgent: ua, cloudbrowserDeviceProfile: profile });
  const next = { ...headers };
  const serialize = (/** @type {{brand: string, version: string}[]} */ brands) =>
    brands.map((b) => `${JSON.stringify(b.brand)};v=${JSON.stringify(b.version)}`).join(', ');
  /** @type {Record<string, string>} */
  const values = hints
    ? {
        'sec-ch-ua': serialize(hints.brands),
        'sec-ch-ua-full-version-list': serialize(hints.fullVersionList),
        'sec-ch-ua-full-version': JSON.stringify(hints.fullVersion),
        'sec-ch-ua-mobile': hints.mobile ? '?1' : '?0',
        'sec-ch-ua-platform': JSON.stringify(hints.platform),
        'sec-ch-ua-platform-version': JSON.stringify(hints.platformVersion),
        'sec-ch-ua-model': JSON.stringify(hints.model),
        'sec-ch-ua-arch': JSON.stringify(hints.architecture),
        'sec-ch-ua-bitness': JSON.stringify(hints.bitness),
        'sec-ch-ua-wow64': hints.wow64 ? '?1' : '?0',
        'sec-ch-ua-form-factors': hints.formFactors.map((v) => JSON.stringify(v)).join(', '),
      }
    : {};
  for (const key of Object.keys(next)) {
    const lower = key.toLowerCase();
    if (lower === 'sec-ch-ua' || lower.startsWith('sec-ch-ua-')) {
      if (values[lower] !== undefined) next[key] = values[lower];
      else delete next[key];
    }
  }
  return next;
}
