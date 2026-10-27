import { collectHardware } from './hardware-probes.js';

export async function bounded<T>(promise: Promise<T>, ms = 2500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('检测超时')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function navigatorInfo(n: any) {
  let hints: any = { status: 'unsupported', low: null, high: null };
  if (n.userAgentData) {
    const low = {
      brands: n.userAgentData.brands,
      mobile: n.userAgentData.mobile,
      platform: n.userAgentData.platform,
    };
    try {
      const high = await bounded(
        n.userAgentData.getHighEntropyValues([
          'fullVersionList',
          'platformVersion',
          'architecture',
          'bitness',
          'model',
          'wow64',
          'formFactors',
        ]),
      );
      hints = { status: 'reported', low, high };
    } catch {
      hints = { status: 'unavailable', low, high: null };
    }
  }
  return {
    user_agent: n.userAgent,
    app_version: n.appVersion,
    platform: n.platform,
    vendor: n.vendor ?? null,
    product: n.product,
    product_sub: n.productSub ?? null,
    language: n.language,
    languages: [...n.languages],
    hardware_concurrency: n.hardwareConcurrency,
    device_memory: n.deviceMemory ?? null,
    max_touch_points: n.maxTouchPoints ?? null,
    webdriver: n.webdriver ?? null,
    cookie_enabled: n.cookieEnabled ?? null,
    do_not_track: n.doNotTrack ?? null,
    global_privacy_control: n.globalPrivacyControl ?? null,
    pdf_viewer_enabled: n.pdfViewerEnabled ?? null,
    client_hints: hints,
  };
}
async function hash(bytes: Uint8Array) {
  if (!crypto.subtle) throw new Error('当前环境不支持 SHA-256（需安全上下文）');
  const result = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return [...new Uint8Array(result)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function probe(run: () => unknown | Promise<unknown>) {
  try {
    return { status: 'measured', value: await bounded(Promise.resolve().then(run)) };
  } catch (error) {
    return { status: 'unavailable', error: error instanceof Error ? error.message : String(error) };
  }
}
async function canvasInfo() {
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = 96;
  const c = canvas.getContext('2d');
  if (!c) throw new Error('Canvas 2D 不可用');
  c.fillStyle = '#f1f5ff';
  c.fillRect(0, 0, 360, 96);
  c.fillStyle = '#2463eb';
  c.fillRect(14.5, 10.5, 137, 47);
  c.font = '18px Arial, sans-serif';
  c.textBaseline = 'alphabetic';
  c.fillStyle = '#192844';
  c.fillText('cloudbrowser · 设备检测 🌐', 8.25, 68.75);
  c.globalCompositeOperation = 'multiply';
  c.fillStyle = 'rgba(250,90,60,.7)';
  c.beginPath();
  c.arc(210.5, 37.5, 26.5, 0, Math.PI * 2);
  c.fill();
  const pixels = c.getImageData(0, 0, canvas.width, canvas.height).data;
  return {
    algorithm: 'SHA-256',
    recipe: 'cloudbrowser-canvas-v1',
    width: canvas.width,
    height: canvas.height,
    hash: await hash(new Uint8Array(pixels.buffer)),
  };
}
function graphicsInfo(kind: 'webgl' | 'webgl2') {
  const gl = document.createElement('canvas').getContext(kind) as
    WebGLRenderingContext | WebGL2RenderingContext | null;
  if (!gl) throw new Error(`${kind} 不可用`);
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      shading_language_version: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      unmasked_vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
      unmasked_renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      max_texture_size: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      max_renderbuffer_size: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      extensions: gl.getSupportedExtensions(),
    };
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
async function audioInfo() {
  if (typeof OfflineAudioContext === 'undefined') throw new Error('OfflineAudioContext 不可用');
  const context = new OfflineAudioContext(1, 5000, 44100);
  const oscillator = context.createOscillator();
  oscillator.type = 'triangle';
  oscillator.frequency.value = 10000;
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -50;
  compressor.knee.value = 40;
  compressor.ratio.value = 12;
  compressor.attack.value = 0;
  compressor.release.value = 0.25;
  oscillator.connect(compressor);
  compressor.connect(context.destination);
  oscillator.start();
  try {
    const buffer = await context.startRendering();
    const samples = buffer.getChannelData(0);
    return {
      algorithm: 'SHA-256',
      recipe: 'cloudbrowser-audio-v1-float32',
      sample_rate: buffer.sampleRate,
      frames: buffer.length,
      hash: await hash(new Uint8Array(samples.buffer)),
      audible_output: false,
    };
  } finally {
    oscillator.disconnect();
    compressor.disconnect();
  }
}
async function workerInfo(base: string) {
  const worker = new Worker(`${base}/assets/fingerprint-worker.js`);
  try {
    return await bounded(
      new Promise((resolve, reject) => {
        worker.onmessage = (e) =>
          e.data?.error ? reject(new Error(e.data.error)) : resolve(e.data);
        worker.onerror = () => reject(new Error('Worker 不可用'));
      }),
    );
  } finally {
    worker.terminate();
  }
}
export async function collectFingerprint(base: string) {
  const n = navigator as any;
  const [identity, request, canvas, webgl, webgl2, audio, worker, battery, hardware] =
    await Promise.all([
      navigatorInfo(n),
      probe(async () => {
        const r = await fetch(`${base}/fingerprint/request`, {
          credentials: 'omit',
          cache: 'no-store',
          signal: AbortSignal.timeout(4000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      probe(canvasInfo),
      probe(() => graphicsInfo('webgl')),
      probe(() => graphicsInfo('webgl2')),
      probe(audioInfo),
      probe(() => workerInfo(base)),
      probe(async () => {
        if (!n.getBattery) throw new Error('Battery API 不支持');
        const b = await n.getBattery();
        return {
          charging: b.charging,
          level: b.level,
          charging_time: Number.isFinite(b.chargingTime) ? b.chargingTime : null,
          discharging_time: Number.isFinite(b.dischargingTime) ? b.dischargingTime : null,
        };
      }),
      collectHardware(),
    ]);
  const connection = n.connection ?? n.mozConnection ?? n.webkitConnection;
  return {
    schema_version: 2,
    collected_at: new Date().toISOString(),
    navigator: identity,
    request,
    screen: {
      width: screen.width,
      height: screen.height,
      available_width: screen.availWidth,
      available_height: screen.availHeight,
      color_depth: screen.colorDepth,
      pixel_depth: screen.pixelDepth,
      orientation: screen.orientation?.type ?? null,
      orientation_angle: screen.orientation?.angle ?? null,
    },
    window: {
      inner_width: innerWidth,
      inner_height: innerHeight,
      outer_width: outerWidth,
      outer_height: outerHeight,
      device_pixel_ratio: devicePixelRatio,
      visual_viewport: visualViewport
        ? {
            width: visualViewport.width,
            height: visualViewport.height,
            scale: visualViewport.scale,
          }
        : null,
    },
    intl: {
      ...Intl.DateTimeFormat().resolvedOptions(),
      timezone_offset_minutes: new Date().getTimezoneOffset(),
      local_time: new Date().toString(),
      number_locale: Intl.NumberFormat().resolvedOptions().locale,
    },
    media: Object.fromEntries(
      [
        'prefers-color-scheme: dark',
        'prefers-reduced-motion: reduce',
        'pointer: coarse',
        'pointer: fine',
        'hover: hover',
        'color-gamut: p3',
        'forced-colors: active',
      ].map((q) => [q, matchMedia(`(${q})`).matches]),
    ),
    plugins: [...navigator.plugins].map((p) => ({
      name: p.name,
      filename: p.filename,
      description: p.description,
    })),
    mime_types: [...navigator.mimeTypes].map((m) => ({ type: m.type, suffixes: m.suffixes })),
    capabilities: {
      secure_context: isSecureContext,
      webgpu: !!n.gpu,
      bluetooth: !!n.bluetooth,
      web_share: typeof n.share === 'function',
      webrtc: typeof RTCPeerConnection === 'function',
      media_devices: !!n.mediaDevices,
      geolocation: !!n.geolocation,
      service_worker: !!n.serviceWorker,
      storage: !!n.storage,
      permissions: !!n.permissions,
      indexed_db: typeof indexedDB !== 'undefined',
      speech_synthesis: typeof speechSynthesis !== 'undefined',
    },
    connection: connection
      ? {
          type: connection.type ?? null,
          effective_type: connection.effectiveType,
          downlink: connection.downlink,
          rtt: connection.rtt,
          save_data: connection.saveData,
        }
      : null,
    voices:
      typeof speechSynthesis !== 'undefined'
        ? speechSynthesis
            .getVoices()
            .slice(0, 100)
            .map((v) => ({
              name: v.name,
              lang: v.lang,
              local_service: v.localService,
              default: v.default,
            }))
        : [],
    canvas,
    audio,
    webgl,
    webgl2,
    worker,
    battery,
    hardware,
    webrtc: {
      tested: false,
      note: '仅检查 API 可用性；未连接 STUN/TURN，未检测 WebRTC 公网出口。HTTP 来源 IP 不能替代 WebRTC 出口检测。',
    },
    notes: [
      '完整检测报告仅在当前页面生成，不提交服务端保存。本站接口读取本次 HTTP 请求的 IP、UA 和 Client Hints，返回内容不包含 Cookie、Authorization 或 URL 查询参数。',
      '散列仅用于比较本检测配方的输出，不是唯一设备 ID，也不代表真人或机器人判定。',
      'UA、Client Hints 和硬件信息是网页可见值，可能受模拟、隐私策略及浏览器限制；本页无法据此证明真实内核或物理设备。',
      '不申请相机、麦克风、位置或蓝牙权限，不播放声音，不连接第三方检测服务。',
    ],
  };
}
export type FingerprintReport = Awaited<ReturnType<typeof collectFingerprint>>;
export function fingerprintFindings(r: FingerprintReport) {
  const findings: string[] = [];
  const request = r.request.status === 'measured' ? (r.request.value as any) : null;
  if (request?.headers['user-agent'] && request.headers['user-agent'] !== r.navigator.user_agent)
    findings.push('HTTP User-Agent 与 navigator.userAgent 不一致。');
  const ua = r.navigator.user_agent.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1];
  const full = r.navigator.client_hints.high?.fullVersionList?.find(
    (b: any) => b.brand === 'Chromium',
  )?.version;
  if (ua && full && full.split('.')[0] !== ua)
    findings.push('UA 与 Client Hints 的 Chromium 主版本不一致。');
  if (full && /^\d+\.0\.0\.0$/.test(full))
    findings.push(
      'Client Hints 的完整版本也以 .0.0.0 结尾，无法从中得知具体构建号；可能来自配置覆盖或浏览器限制。UA 字符串中的 .0.0.0 本身是正常缩减格式。',
    );
  if (r.navigator.webdriver === true)
    findings.push('navigator.webdriver 为 true：网页可读取自动化控制标志。');
  const worker = r.worker.status === 'measured' ? (r.worker.value as any) : null;
  if (worker && worker.platform !== r.navigator.platform)
    findings.push('页面与 Worker 的 navigator.platform 不一致。');
  if (worker && worker.user_agent !== r.navigator.user_agent)
    findings.push('页面与 Worker 的 User-Agent 不一致。');
  return findings;
}
