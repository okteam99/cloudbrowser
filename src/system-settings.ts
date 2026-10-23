import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';

export const storageSettingsSchema = z
  .object({
    max_data_bytes: z.number().int().min(1048576).max(Number.MAX_SAFE_INTEGER),
    screenshot_retention_days: z.number().int().min(1).max(365),
  })
  .strict();
export type StorageSettings = z.infer<typeof storageSettingsSchema>;
const documentSchema = z.object({ version: z.literal(1), storage: storageSettingsSchema }).strict();

export class SystemSettings {
  private pending: Promise<unknown> = Promise.resolve();
  private file: string;
  constructor(private cfg: Config) {
    this.file = join(cfg.dataDir, 'system-settings.json');
  }
  storage(): StorageSettings {
    return {
      max_data_bytes: this.cfg.dataLimit,
      screenshot_retention_days: this.cfg.screenshotRetentionDays,
    };
  }
  private apply(value: StorageSettings) {
    this.cfg.dataLimit = value.max_data_bytes;
    this.cfg.screenshotRetentionDays = value.screenshot_retention_days;
  }
  async init() {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    this.apply(documentSchema.parse(JSON.parse(raw)).storage);
  }
  updateStorage(raw: unknown): Promise<StorageSettings> {
    const value = storageSettingsSchema.parse(raw);
    const work = this.pending.then(async () => {
      await writeFile(this.file + '.tmp', JSON.stringify({ version: 1, storage: value }), {
        mode: 0o600,
      });
      await rename(this.file + '.tmp', this.file);
      this.apply(value);
      return this.storage();
    });
    this.pending = work.catch(() => {});
    return work;
  }
}
