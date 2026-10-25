import { z } from 'zod';
import { userAgentMetadata } from './user-agent.js';

const size = z
  .object({
    width: z.number().int().min(240).max(3840),
    height: z.number().int().min(240).max(3840),
  })
  .strict();
const text = z
  .string()
  .max(128)
  .regex(/^[\x20-\x7e]*$/);
const version = z.string().regex(/^\d+\.\d+\.\d+\.\d+$/);
const brand = z
  .object({ brand: text.min(1), version: z.string().regex(/^\d+(?:\.\d+){0,3}$/) })
  .strict();
export const deviceProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    user_agent: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[\x20-\x7e]+$/),
    navigator_platform: text.min(1),
    client_hints: z
      .object({
        full_version: version,
        platform: z.enum(['macOS', 'Windows', 'Linux', 'Android', 'Chrome OS']),
        platform_version: text,
        architecture: z.enum(['arm', 'x86', '']),
        bitness: z.enum(['32', '64', '']),
        model: text.default(''),
        mobile: z.boolean(),
        wow64: z.boolean().default(false),
        form_factors: z
          .array(z.enum(['Desktop', 'Mobile', 'Tablet', 'Automotive', 'EInk', 'Watch', 'XR']))
          .min(1)
          .max(4),
        brands: z.array(brand).min(1).max(8).optional(),
        full_version_list: z.array(brand).min(1).max(8).optional(),
      })
      .strict(),
    viewport: size,
    screen: size,
    device_scale_factor: z.number().min(1).max(4).default(1),
    mobile: z.boolean().default(false),
    touch: z.boolean().default(false),
    languages: z
      .array(z.string().regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/))
      .min(1)
      .max(8),
    locale: z.string().min(1).max(64),
    timezone: z.string().min(1).max(128),
    hardware_concurrency: z.number().int().min(1).max(256).optional(),
    expectations: z
      .object({
        device_memory: z.number().min(0.25).max(64).optional(),
        webdriver: z.boolean().optional(),
        pdf_viewer: z.boolean().optional(),
        bluetooth: z.boolean().optional(),
        web_share: z.boolean().optional(),
        audio_sample_rate: z.number().int().min(8000).max(192000).optional(),
        speech_voices_min: z.number().int().min(0).max(1000).optional(),
        webgl: z.boolean().optional(),
      })
      .strict()
      .default({})
      .describe(
        'Observed capabilities to compare, not values to fabricate. Hardware, automation state and permissions remain real.',
      ),
  })
  .strict()
  .superRefine((p, ctx) => {
    const ua = userAgentMetadata({ userAgent: p.user_agent });
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (!ua) issue('device_profile requires a Chromium desktop/Android UA');
    else {
      if (ua.fullVersion.split('.')[0] !== p.client_hints.full_version.split('.')[0])
        issue('UA and client_hints full_version must have the same Chromium major version');
      if (ua.platform && ua.platform !== p.client_hints.platform)
        issue('UA and Client Hints platforms must agree');
      if (ua.mobile !== p.client_hints.mobile)
        issue('UA Mobile token and Client Hints mobile must agree');
    }
    if (p.viewport.width > p.screen.width || p.viewport.height > p.screen.height)
      issue('viewport must fit within screen');
    if (new Set(p.languages).size !== p.languages.length) issue('languages must be unique');
    try {
      new Intl.DateTimeFormat(p.locale, { timeZone: p.timezone });
    } catch {
      issue('Invalid locale or timezone');
    }
    if (!!p.client_hints.brands !== !!p.client_hints.full_version_list)
      issue('Provide brands and full_version_list together');
    if (p.client_hints.brands && p.client_hints.full_version_list) {
      const brands = p.client_hints.brands;
      const full = p.client_hints.full_version_list;
      if (
        new Set(brands.map((b) => b.brand)).size !== brands.length ||
        new Set(full.map((b) => b.brand)).size !== full.length
      )
        issue('Client Hint brand names must be unique');
      if (
        brands.length !== full.length ||
        brands.some(
          (b) => !full.some((f) => f.brand === b.brand && f.version.split('.')[0] === b.version),
        )
      )
        issue('Brand lists must have matching brands and major versions');
      if (!full.some((b) => b.brand === 'Chromium' && b.version === p.client_hints.full_version))
        issue('full_version_list must include the declared Chromium full version');
    }
  });
export type DeviceProfile = z.infer<typeof deviceProfileSchema>;

const mac = deviceProfileSchema.parse({
  name: 'macOS ARM · Chrome 155 · desktop example',
  user_agent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  navigator_platform: 'MacIntel',
  client_hints: {
    full_version: '155.0.8059.85',
    platform: 'macOS',
    platform_version: '26.4.1',
    architecture: 'arm',
    bitness: '64',
    mobile: false,
    form_factors: ['Desktop'],
    brands: [
      { brand: 'Google Chrome', version: '155' },
      { brand: 'Chromium', version: '155' },
      { brand: 'Not(A:Brand', version: '24' },
    ],
    full_version_list: [
      { brand: 'Google Chrome', version: '155.0.8059.85' },
      { brand: 'Chromium', version: '155.0.8059.85' },
      { brand: 'Not(A:Brand', version: '24.0.0.0' },
    ],
  },
  screen: { width: 1920, height: 1080 },
  viewport: { width: 1653, height: 947 },
  languages: ['zh', 'en-US', 'en'],
  locale: 'en-US',
  timezone: 'Asia/Shanghai',
  hardware_concurrency: 18,
  expectations: {
    device_memory: 32,
    webdriver: false,
    pdf_viewer: true,
    bluetooth: true,
    web_share: true,
    audio_sample_rate: 48000,
    speech_voices_min: 9,
    webgl: true,
  },
});
const android = deviceProfileSchema.parse({
  name: 'Android 14 · Pixel 8 · Chrome 155 example',
  user_agent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
  navigator_platform: 'Linux armv81',
  client_hints: {
    full_version: '155.0.0.0',
    platform: 'Android',
    platform_version: '14',
    architecture: 'arm',
    bitness: '64',
    model: 'Pixel 8',
    mobile: true,
    form_factors: ['Mobile'],
  },
  screen: { width: 412, height: 915 },
  viewport: { width: 412, height: 915 },
  device_scale_factor: 2,
  mobile: true,
  touch: true,
  languages: ['en-US', 'en'],
  locale: 'en-US',
  timezone: 'UTC',
  hardware_concurrency: 8,
});
const templates = { 'macos-arm-chrome155': mac, 'android-pixel8-chrome155': android };
export const deviceProfileIds = ['macos-arm-chrome155', 'android-pixel8-chrome155'] as const;
export function listDeviceProfiles() {
  return Object.entries(templates).map(([profile_id, profile]) => ({
    profile_id,
    kind: 'example',
    profile: structuredClone(profile),
    note: 'A declared test environment, not a real device or browser-version installation. Clone profile into device_profile to customize.',
  }));
}
export function resolveDeviceProfile(options: {
  device_profile?: DeviceProfile;
  device_profile_id?: keyof typeof templates;
}) {
  return (
    options.device_profile ??
    (options.device_profile_id ? structuredClone(templates[options.device_profile_id]) : undefined)
  );
}
export function profileMetadata(profile: DeviceProfile) {
  const h = profile.client_hints;
  const inferred = userAgentMetadata({ userAgent: profile.user_agent })!;
  return {
    brands: h.brands ?? inferred.brands,
    fullVersionList:
      h.full_version_list ??
      inferred.fullVersionList.map((b) => ({
        ...b,
        version: ['Chromium', 'Google Chrome', 'HeadlessChrome'].includes(b.brand)
          ? h.full_version
          : b.version,
      })),
    fullVersion: h.full_version,
    platform: h.platform,
    platformVersion: h.platform_version,
    architecture: h.architecture,
    bitness: h.bitness,
    model: h.model,
    mobile: h.mobile,
    wow64: h.wow64,
    formFactors: h.form_factors,
  };
}
export function protocolProfile(profile: DeviceProfile) {
  return {
    metadata: profileMetadata(profile),
    platform: profile.navigator_platform,
    languages: profile.languages,
    hardwareConcurrency: profile.hardware_concurrency,
  };
}
export function acceptLanguage(languages: string[]) {
  return languages
    .map((language, i) => (i ? `${language};q=${(1 - i / 10).toFixed(1)}` : language))
    .join(',');
}
