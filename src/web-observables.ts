import { z } from 'zod';

const finite = z.number().finite();
const text = z.string().max(1024);
const list = z.array(text).max(128);
const scalar = z.union([z.null(), z.boolean(), finite, text]);
const flat = z.record(z.string().max(100), scalar);
const value = z.union([scalar, z.array(scalar).max(128), flat, z.array(flat).max(128)]);
const outcome = (data: z.ZodTypeAny) =>
  z.discriminatedUnion('status', [
    z.object({ status: z.literal('reported'), value: data }),
    z.object({ status: z.literal('measured'), value: data }),
    z.object({ status: z.literal('unsupported') }),
    z.object({
      status: z.enum(['blocked', 'unavailable']),
      error_name: z.enum([
        'TypeError',
        'SecurityError',
        'NotAllowedError',
        'NotFoundError',
        'NotSupportedError',
        'InvalidStateError',
        'AbortError',
        'Error',
      ]),
      error: text,
    }),
  ]);
const devices = z
  .object({
    count: z.number().int().min(0).max(128),
    truncated: z.literal(false),
    devices: z.array(z.record(value)).max(128),
  })
  .refine((d) => d.count === d.devices.length, 'Device count must match the complete device list');
const hardware = z.object({
  bluetooth: z
    .object({
      api_supported: z.boolean(),
      availability: outcome(z.boolean()).optional(),
      granted_devices: outcome(devices).optional(),
    })
    .optional(),
  media_devices: z
    .object({ api_supported: z.boolean(), enumeration: outcome(devices).optional() })
    .optional(),
  usb: z
    .object({ api_supported: z.boolean(), granted_devices: outcome(devices).optional() })
    .optional(),
  hid: z
    .object({ api_supported: z.boolean(), granted_devices: outcome(devices).optional() })
    .optional(),
  serial: z
    .object({ api_supported: z.boolean(), granted_ports: outcome(devices).optional() })
    .optional(),
  gamepads: z.object({ enumeration: outcome(devices) }).optional(),
  audio_output: z
    .object({
      parameters: outcome(
        z.object({
          sample_rate: z.number().int().min(8000).max(192000),
          state: text,
          base_latency_seconds: finite.nullable(),
          output_latency_seconds: finite.nullable(),
          max_channels: z.number().int().min(1).max(32),
          channel_count: z.number().int().min(1).max(32),
          audible_output: z.boolean(),
        }),
      ),
    })
    .optional(),
  webgpu: z.object({ adapter: outcome(z.record(value)) }).optional(),
  sensors: z
    .object({
      constructors: z.record(
        z.enum([
          'Accelerometer',
          'LinearAccelerationSensor',
          'GravitySensor',
          'Gyroscope',
          'Magnetometer',
          'AbsoluteOrientationSensor',
          'RelativeOrientationSensor',
          'AmbientLightSensor',
          'DeviceMotionEvent',
          'DeviceOrientationEvent',
        ]),
        z.boolean(),
      ),
      motion_permission_request_supported: z.boolean(),
      orientation_permission_request_supported: z.boolean(),
      nfc_api_supported: z.boolean(),
      midi_api_supported: z.boolean(),
    })
    .optional(),
  permissions: z
    .record(
      z.enum([
        'camera',
        'microphone',
        'speaker-selection',
        'geolocation',
        'accelerometer',
        'gyroscope',
        'magnetometer',
        'ambient-light-sensor',
        'midi',
        'notifications',
      ]),
      outcome(z.object({ state: z.enum(['granted', 'prompt', 'denied']) })),
    )
    .optional(),
});
const graphics = z.object({
  vendor: text,
  renderer: text,
  version: text,
  shading_language_version: text,
  unmasked_vendor: text.nullable(),
  unmasked_renderer: text.nullable(),
  max_texture_size: z.number().int().positive(),
  max_renderbuffer_size: z.number().int().positive(),
  extensions: list,
});
export const webObservablesSchema = z
  .object({
    reference: z
      .object({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        captured_at: z.string().datetime(),
        label: z.string().max(200),
        notes: z.array(text).max(20),
      })
      .optional(),
    navigator: z
      .object({
        device_memory: finite.min(0.25).max(1024).optional(),
        webdriver: z.boolean().optional(),
        pdf_viewer_enabled: z.boolean().optional(),
        max_touch_points: z.number().int().min(0).max(16).optional(),
        vendor: text.optional(),
        product_sub: text.optional(),
      })
      .strict()
      .optional(),
    screen: z
      .object({
        available_width: z.number().int().positive(),
        available_height: z.number().int().positive(),
        color_depth: z.number().int().min(1).max(64),
        pixel_depth: z.number().int().min(1).max(64),
        orientation: z.enum([
          'landscape-primary',
          'landscape-secondary',
          'portrait-primary',
          'portrait-secondary',
        ]),
        orientation_angle: z.number().int().min(0).max(359),
      })
      .optional(),
    window: z
      .object({
        outer_width: z.number().int().positive(),
        outer_height: z.number().int().positive(),
      })
      .optional(),
    media: z
      .record(
        z.enum([
          'prefers-color-scheme: dark',
          'prefers-reduced-motion: reduce',
          'pointer: coarse',
          'pointer: fine',
          'hover: hover',
          'color-gamut: p3',
          'forced-colors: active',
        ]),
        z.boolean(),
      )
      .optional(),
    connection: z
      .object({
        type: text.nullable(),
        effective_type: z.enum(['slow-2g', '2g', '3g', '4g']),
        downlink: finite.min(0),
        rtt: finite.min(0),
        save_data: z.boolean(),
      })
      .nullable()
      .optional(),
    battery: outcome(
      z.object({
        charging: z.boolean(),
        level: finite.min(0).max(1),
        charging_time: finite.nonnegative().nullable(),
        discharging_time: finite.nonnegative().nullable(),
      }),
    ).optional(),
    voices: z
      .array(z.object({ name: text, lang: text, local_service: z.boolean(), default: z.boolean() }))
      .max(128)
      .optional(),
    web_share: z.boolean().optional(),
    hardware: hardware.optional(),
    webgl: graphics.optional(),
    webgl2: graphics.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (Buffer.byteLength(JSON.stringify(data)) > 131072)
      ctx.addIssue({
        code: 'custom',
        message: 'Web observable configuration must be at most 128 KiB',
      });
  })
  .describe(
    'Explicit, per-instance simulation of web-visible metadata and read APIs. Omitted fields remain native. Configured hardware APIs never perform real device I/O. Native rendering outputs remain measured, not replaced with expected hashes.',
  );
export type WebObservables = z.infer<typeof webObservablesSchema>;
