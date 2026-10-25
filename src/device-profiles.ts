import { createHash } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  deviceProfileIdSchema,
  deviceProfileSchema,
  listDeviceProfiles,
} from './device-profile.js';
import { ToolError } from './errors.js';
import { operatingSystem } from './browser-environment.js';

export const savedDeviceProfileSchema = z
  .object({
    profile_id: deviceProfileIdSchema,
    enabled: z.boolean().default(true),
    is_default: z.boolean().default(false),
    profile: deviceProfileSchema,
  })
  .strict();
export const deviceProfileCatalogSchema = z
  .array(savedDeviceProfileSchema)
  .max(100)
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    const defaults = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.profile_id))
        ctx.addIssue({
          code: 'custom',
          path: [index, 'profile_id'],
          message: 'Duplicate profile_id',
        });
      seen.add(item.profile_id);
      if (item.enabled && item.is_default) {
        const platform = item.profile.client_hints.platform;
        if (defaults.has(platform))
          ctx.addIssue({
            code: 'custom',
            path: [index, 'is_default'],
            message: 'Only one enabled default profile is allowed per operating system',
          });
        defaults.add(platform);
      }
    });
  });
export const updateDeviceProfilesSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    profiles: deviceProfileCatalogSchema,
  })
  .strict();
export const listDeviceProfilesSchema = z
  .object({
    platform: z.enum(['macOS', 'Windows', 'Linux', 'Android', 'Chrome OS']).optional(),
    query: z.string().trim().max(100).optional(),
    enabled_only: z.boolean().default(true),
  })
  .strict();
const documentSchema = z
  .object({ version: z.literal(1), profiles: deviceProfileCatalogSchema })
  .strict();
type Entry = z.infer<typeof savedDeviceProfileSchema>;

export class DeviceProfileStore {
  private records: Entry[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private file: string;
  constructor(dataDir: string) {
    this.file = join(dataDir, 'device-profiles.json');
  }
  async init() {
    try {
      this.records = documentSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))).profiles;
      await chmod(this.file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Seed once. An intentionally empty saved catalog stays empty across upgrades.
      const defaults = listDeviceProfiles().map(({ profile_id, profile }) => ({
        profile_id,
        enabled: true,
        is_default: true,
        profile,
      }));
      await this.persist(defaults);
      this.records = defaults;
    }
  }
  snapshot() {
    return { revision: this.revision(), profiles: structuredClone(this.records) };
  }
  private revision() {
    return createHash('sha256').update(JSON.stringify(this.records)).digest('hex');
  }
  private entry(record: Entry) {
    return {
      ...structuredClone(record),
      kind: 'configured',
      revision: this.revision(),
      default_for_platform:
        this.defaultRecord(record.profile.client_hints.platform)?.profile_id === record.profile_id,
    };
  }
  private defaultRecord(platform: string) {
    const candidates = this.records.filter(
      (r) => r.enabled && r.profile.client_hints.platform === platform,
    );
    return candidates.find((r) => r.is_default) ?? candidates[0];
  }
  defaultForUserAgent(ua: string) {
    const os = operatingSystem(ua);
    const record = os ? this.defaultRecord(os === 'ChromeOS' ? 'Chrome OS' : os) : undefined;
    return record ? this.entry(record) : undefined;
  }
  list(raw: unknown = {}) {
    const filter = listDeviceProfilesSchema.parse(raw);
    const query = filter.query?.toLowerCase();
    return this.records
      .filter(
        (r) =>
          (!filter.enabled_only || r.enabled) &&
          (!filter.platform || r.profile.client_hints.platform === filter.platform) &&
          (!query || `${r.profile_id} ${r.profile.name}`.toLowerCase().includes(query)),
      )
      .map((r) => this.entry(r));
  }
  get(id: string) {
    const record = this.records.find((r) => r.profile_id === id);
    if (!record)
      throw new ToolError(
        'DEVICE_PROFILE_NOT_FOUND',
        'Unknown device profile. Call list_device_profiles to choose an available profile_id.',
      );
    return this.entry(record);
  }
  resolve(id: string) {
    const record = this.get(id);
    if (!record.enabled)
      throw new ToolError(
        'DEVICE_PROFILE_DISABLED',
        'This device profile is disabled. Choose an enabled profile from list_device_profiles.',
      );
    return record.profile;
  }
  update(raw: unknown) {
    const input = updateDeviceProfilesSchema.parse(raw);
    const work = this.queue.then(async () => {
      if (input.revision !== this.revision())
        throw new ToolError(
          'DEVICE_PROFILES_CONFLICT',
          'Device profiles changed. Reload the current catalog before saving.',
        );
      await this.persist(input.profiles);
      this.records = input.profiles;
      return this.snapshot();
    });
    this.queue = work.catch(() => {});
    return work;
  }
  private async persist(profiles: Entry[]) {
    await writeFile(this.file + '.tmp', JSON.stringify({ version: 1, profiles }), { mode: 0o600 });
    await rename(this.file + '.tmp', this.file);
  }
}
