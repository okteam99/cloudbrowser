import type { Page, Browser } from 'playwright';
import sharp from 'sharp';
import { type AppliedDeviceProfile, profileMetadata } from './device-profile.js';
import { deadline } from './browser-state.js';

export type DeviceFieldCheck = {
  scope: 'page' | 'worker';
  field: string;
  expected: unknown;
  actual: unknown;
  status: 'match' | 'mismatch' | 'unavailable';
  mode: 'emulated' | 'expectation';
};
export type CapabilityCheck = {
  name: string;
  method: 'execution' | 'availability' | 'reported';
  status: 'passed' | 'failed' | 'unsupported' | 'blocked' | 'reported';
  details: Record<string, unknown>;
};
export type DeviceVerification = {
  checked_at: string;
  page_id: string;
  url: string;
  profile_name: string | null;
  browser_version: string;
  fields: DeviceFieldCheck[];
  capabilities: CapabilityCheck[];
  observed: Record<string, any>;
  summary: {
    matched: number;
    mismatched: number;
    unavailable: number;
    execution_passed: number;
    execution_failed: number;
  };
  notes: string[];
};

export async function verifyDeviceProfile(
  page: Page,
  pageId: string,
  browser: Browser,
  profile?: AppliedDeviceProfile,
): Promise<DeviceVerification> {
  const probe = async () => {
    const n = navigator as any;
    const bounded = async (promise: Promise<any>, ms = 1500) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Probe timeout')), ms);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const capabilities: any[] = [];
    const cap = (name: string, method: string, status: string, details: any = {}) =>
      capabilities.push({ name, method, status, details });
    const hints = n.userAgentData
      ? await bounded(
          n.userAgentData.getHighEntropyValues([
            'fullVersionList',
            'uaFullVersion',
            'platformVersion',
            'architecture',
            'bitness',
            'model',
            'wow64',
            'formFactors',
          ]),
        ).catch(() => n.userAgentData.toJSON())
      : null;
    const actual: Record<string, any> = {
      user_agent: n.userAgent,
      app_version: n.appVersion,
      navigator_platform: n.platform,
      language: n.language,
      languages: [...n.languages],
      hardware_concurrency: n.hardwareConcurrency,
      device_memory: n.deviceMemory ?? null,
      webdriver: n.webdriver,
      pdf_viewer: n.pdfViewerEnabled,
      viewport: { width: innerWidth, height: innerHeight },
      screen: { width: screen.width, height: screen.height },
      device_scale_factor: devicePixelRatio,
      touch: n.maxTouchPoints > 0,
      max_touch_points: n.maxTouchPoints,
      locale: new Intl.DateTimeFormat().resolvedOptions().locale,
      timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
      client_hints: hints,
      plugins: [...n.plugins].map((p: any) => p.name),
      web_share: typeof n.share === 'function' && typeof n.canShare === 'function',
    };
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const c = canvas.getContext('2d');
      if (!c) cap('canvas_2d', 'execution', 'unsupported');
      else {
        c.fillStyle = 'rgb(17,34,51)';
        c.fillRect(0, 0, 1, 1);
        const pixel = [...c.getImageData(0, 0, 1, 1).data];
        cap(
          'canvas_2d',
          'execution',
          JSON.stringify(pixel) === '[17,34,51,255]' ? 'passed' : 'failed',
          { pixel },
        );
      }
    } catch (e) {
      cap('canvas_2d', 'execution', 'blocked', { error: String(e) });
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const gl = canvas.getContext('webgl');
      actual.webgl = !!gl;
      if (!gl) cap('webgl', 'execution', 'unsupported');
      else {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = ext
          ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER);
        gl.clearColor(1, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const pixel = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        cap(
          'webgl',
          'execution',
          pixel[0] === 255 && pixel[3] === 255 && gl.getError() === gl.NO_ERROR
            ? 'passed'
            : 'failed',
          { renderer, pixel: [...pixel] },
        );
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    } catch (e) {
      actual.webgl = null;
      cap('webgl', 'execution', 'blocked', { error: String(e) });
    }
    let audio: AudioContext | undefined;
    try {
      audio = new AudioContext();
      actual.audio_sample_rate = audio.sampleRate;
      const offline = new OfflineAudioContext(1, 128, 48000);
      const oscillator = offline.createOscillator();
      oscillator.connect(offline.destination);
      oscillator.start();
      const rendered = await bounded(offline.startRendering());
      const nonzero = rendered.getChannelData(0).some((v: number) => v !== 0);
      cap('audio_processing', 'execution', nonzero ? 'passed' : 'failed', {
        default_sample_rate: audio.sampleRate,
        state: audio.state,
        rendered_frames: rendered.length,
        speaker_output_tested: false,
      });
    } catch (e) {
      actual.audio_sample_rate ??= null;
      cap('audio_processing', 'execution', 'blocked', { error: String(e) });
    } finally {
      if (audio) await bounded(audio.close()).catch(() => {});
    }
    actual.bluetooth = !!n.bluetooth;
    let bluetoothAvailable: boolean | null = null;
    if (n.bluetooth)
      bluetoothAvailable = await bounded(n.bluetooth.getAvailability()).catch(() => null);
    cap(
      'bluetooth',
      'availability',
      !n.bluetooth ? 'unsupported' : bluetoothAvailable === null ? 'blocked' : 'reported',
      {
        api_available: !!n.bluetooth,
        adapter_available: bluetoothAvailable,
        device_connection_tested: false,
      },
    );
    let voices = typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : [];
    if (typeof speechSynthesis !== 'undefined' && !voices.length) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          speechSynthesis.removeEventListener('voiceschanged', done);
          resolve();
        };
        const timer = setTimeout(done, 350);
        speechSynthesis.addEventListener('voiceschanged', done, { once: true });
      });
      voices = speechSynthesis.getVoices();
    }
    actual.speech_voices = voices.length;
    cap(
      'speech',
      'availability',
      typeof speechSynthesis === 'undefined' ? 'unsupported' : 'reported',
      {
        voice_count: voices.length,
        voices: voices.slice(0, 20).map((v) => ({ name: v.name, lang: v.lang })),
        speech_output_tested: false,
      },
    );
    cap('pdf_viewer', 'reported', n.pdfViewerEnabled ? 'reported' : 'unsupported', {
      pdf_viewer_enabled: n.pdfViewerEnabled,
      pdf_render_tested: false,
    });
    cap('web_share', 'availability', actual.web_share ? 'reported' : 'unsupported', {
      share_dialog_tested: false,
    });
    let worker: Worker | undefined;
    let blob: string | undefined;
    try {
      const source = `(async()=>{const n=navigator;let hints=null;try{hints=n.userAgentData?await n.userAgentData.getHighEntropyValues(['fullVersionList','uaFullVersion','platformVersion','architecture','bitness','model','wow64','formFactors']):null}catch{};postMessage({user_agent:n.userAgent,app_version:n.appVersion,navigator_platform:n.platform,language:n.language,languages:[...n.languages],hardware_concurrency:n.hardwareConcurrency,device_memory:n.deviceMemory??null,client_hints:hints})})()`;
      blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      worker = new Worker(blob);
      actual.worker = await bounded(
        new Promise((resolve, reject) => {
          worker!.onmessage = (e) => resolve(e.data);
          worker!.onerror = (e) => reject(new Error(e.message || 'Worker blocked'));
        }),
      );
      cap('dedicated_worker', 'execution', 'passed');
    } catch (e) {
      actual.worker = null;
      cap('dedicated_worker', 'execution', 'blocked', { error: String(e) });
    } finally {
      worker?.terminate();
      if (blob) URL.revokeObjectURL(blob);
    }
    const result = { ...actual, capabilities };
    if (JSON.stringify(result).length > 65536) throw new Error('Device observation exceeds 64 KiB');
    return result;
  };
  // tsx adds a function-name helper to nested callbacks; bind it locally when
  // serializing this controlled probe, without changing any page global.
  const observed: Record<string, any> = await deadline(
    page.evaluate(`((__name) => (${probe.toString()})())((value) => value)`),
    8000,
    'Device verification timed out.',
  );
  const pdf = await verifyPdfRenderer(browser);
  const pdfIndex = observed.capabilities.findIndex((c: CapabilityCheck) => c.name === 'pdf_viewer');
  observed.capabilities[pdfIndex] = {
    ...pdf,
    details: { ...pdf.details, reported_by_page: observed.pdf_viewer },
  };
  const fields: DeviceFieldCheck[] = [];
  const add = (
    scope: 'page' | 'worker',
    field: string,
    expected: unknown,
    actual: unknown,
    mode: 'emulated' | 'expectation' = 'emulated',
  ) => {
    fields.push({
      scope,
      field,
      expected,
      actual: actual ?? null,
      mode,
      status:
        actual === undefined || actual === null
          ? 'unavailable'
          : JSON.stringify(actual) === JSON.stringify(expected)
            ? 'match'
            : 'mismatch',
    });
  };
  if (profile) {
    const common = {
      user_agent: profile.user_agent,
      app_version: profile.user_agent.replace(/^Mozilla\//, ''),
      navigator_platform: profile.navigator_platform,
      language: profile.languages[0],
      languages: profile.languages,
      ...(profile.hardware_concurrency
        ? { hardware_concurrency: profile.hardware_concurrency }
        : {}),
    };
    const metadata = profileMetadata(profile);
    const wantedHints = metadata
      ? {
          brands: metadata.brands,
          fullVersionList: metadata.fullVersionList,
          uaFullVersion: metadata.fullVersion,
          platform: metadata.platform,
          platformVersion: metadata.platformVersion,
          architecture: metadata.architecture,
          bitness: metadata.bitness,
          model: metadata.model,
          mobile: metadata.mobile,
          wow64: metadata.wow64,
          formFactors: metadata.formFactors,
        }
      : {};
    for (const scope of ['page', 'worker'] as const) {
      const actual = scope === 'page' ? observed : observed.worker;
      for (const [field, expected] of Object.entries(common))
        add(scope, field, expected, actual?.[field]);
      for (const [field, expected] of Object.entries(wantedHints))
        add(scope, 'client_hints.' + field, expected, actual?.client_hints?.[field]);
      if (profile.expectations.device_memory !== undefined)
        add(
          scope,
          'device_memory',
          profile.expectations.device_memory,
          actual?.device_memory,
          'expectation',
        );
    }
    for (const [field, expected] of Object.entries({
      screen: profile.screen,
      viewport: profile.viewport,
      device_scale_factor: profile.device_scale_factor,
      touch: profile.touch,
      locale: profile.locale,
      timezone: profile.timezone,
    }))
      add('page', field, expected, observed[field]);
    for (const field of [
      'webdriver',
      'pdf_viewer',
      'bluetooth',
      'web_share',
      'audio_sample_rate',
      'webgl',
    ] as const)
      if (profile.expectations[field] !== undefined)
        add('page', field, profile.expectations[field], observed[field], 'expectation');
    if (profile.expectations.speech_voices_min !== undefined)
      fields.push({
        scope: 'page',
        field: 'speech_voices_min',
        expected: profile.expectations.speech_voices_min,
        actual: observed.speech_voices,
        mode: 'expectation',
        status:
          observed.speech_voices >= profile.expectations.speech_voices_min ? 'match' : 'mismatch',
      });
  }
  const capabilities = observed.capabilities as CapabilityCheck[];
  return {
    checked_at: new Date().toISOString(),
    page_id: pageId,
    url: page.url(),
    profile_name: profile?.name ?? null,
    browser_version: browser.version(),
    fields,
    capabilities,
    observed,
    summary: {
      matched: fields.filter((f) => f.status === 'match').length,
      mismatched: fields.filter((f) => f.status === 'mismatch').length,
      unavailable: fields.filter((f) => f.status === 'unavailable').length,
      execution_passed: capabilities.filter(
        (c) => c.method === 'execution' && c.status === 'passed',
      ).length,
      execution_failed: capabilities.filter(
        (c) => c.method === 'execution' && c.status !== 'passed',
      ).length,
    },
    notes: [
      ...(profile?.web_observables
        ? [
            'This profile explicitly simulates selected web-visible metadata and read API results. Read availability is not evidence of physical hardware; device I/O is disabled for configured hardware interfaces. GPU rendering and extension implementations remain native.',
          ]
        : []),
      'Field matches measure declared values, not physical hardware or human behavior. browser_version is the actual engine.',
      'Worker navigator.platform uses a bootstrap getter when Chromium does not apply its native platform override. Matching property values does not guarantee identical prototypes or implementation behavior.',
      'The inspected tab is not navigated. PDF is rendered in an isolated temporary page from generated local data with external network requests blocked. No permission prompts, audio output, Bluetooth connection or share dialog are triggered. Availability/reported checks do not prove the underlying function works.',
      'Client Hints may be unavailable outside secure contexts. CSP can block Worker probes; mobile page layout can change innerWidth/innerHeight.',
      ...(!profile
        ? ['No device profile was supplied; observations are returned without target comparisons.']
        : []),
    ],
  };
}

async function verifyPdfRenderer(browser: Browser): Promise<CapabilityCheck> {
  // A deterministic blue rectangle proves the PDF engine actually paints the
  // document, rather than accepting a navigator flag or an empty viewer shell.
  const stream = '0 0 1 rg\n0 0 300 300 re f\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let doc = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 0; n < objects.length; n++) {
    offsets.push(Buffer.byteLength(doc));
    doc += `${n + 1} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(doc);
  doc +=
    'xref\n0 5\n0000000000 65535 f \n' +
    offsets.map((n) => String(n).padStart(10, '0') + ' 00000 n \n').join('') +
    `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const context = await browser.newContext({
    viewport: { width: 640, height: 640 },
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  try {
    await context.route('**/*', (r) =>
      /^https?:/.test(r.request().url()) ? r.abort() : r.continue(),
    );
    const page = await context.newPage();
    await page.goto('data:application/pdf;base64,' + Buffer.from(doc).toString('base64'), {
      waitUntil: 'domcontentloaded',
      timeout: 5000,
    });
    let blue = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const raw = await sharp(await page.screenshot({ timeout: 1500 }))
        .removeAlpha()
        .raw()
        .toBuffer();
      blue = 0;
      for (let pixel = 0; pixel < raw.length; pixel += 3)
        if (raw[pixel] < 20 && raw[pixel + 1] < 20 && raw[pixel + 2] > 230) blue++;
      if (blue >= 10000) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return {
      name: 'pdf_viewer',
      method: 'execution',
      status: blue >= 10000 ? 'passed' : 'failed',
      details: {
        pdf_render_tested: true,
        blue_pixels: blue,
        scope: 'isolated_local_pdf',
        external_requests: false,
      },
    };
  } catch (error) {
    return {
      name: 'pdf_viewer',
      method: 'execution',
      status: 'failed',
      details: { pdf_render_tested: true, error: String(error).slice(0, 1000) },
    };
  } finally {
    await context.close().catch(() => {});
  }
}
