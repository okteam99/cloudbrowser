import { z } from 'zod';
import type { Artifacts } from './artifacts.js';
import { ToolError } from './errors.js';
const cookie = z
  .object({
    name: z.string(),
    value: z.string(),
    domain: z.string(),
    path: z.string(),
    expires: z.number(),
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(['Strict', 'Lax', 'None']),
    partitionKey: z.string().optional(),
  })
  .strict();
const stateSchema = z
  .object({
    cookies: z.array(cookie).max(3000),
    origins: z
      .array(
        z
          .object({
            origin: z.string().url(),
            localStorage: z
              .array(z.object({ name: z.string(), value: z.string() }).strict())
              .max(10000),
            indexedDB: z.array(z.record(z.unknown())).optional(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export const storageLimit = 2097152;
export async function readStorageState(artifacts: Artifacts, owner: string, id: string) {
  const meta = await artifacts.get(owner, id, 0, 0);
  if (meta.size > storageLimit)
    throw new ToolError('STORAGE_STATE_TOO_LARGE', 'Login state exceeds 2 MiB.');
  const chunks: Buffer[] = [];
  for (let n = 0; n < meta.size; n += 262144)
    chunks.push(Buffer.from((await artifacts.get(owner, id, n, 262144)).data_base64, 'base64'));
  try {
    return stateSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))) as any;
  } catch {
    throw new ToolError('INVALID_STORAGE_STATE', 'Artifact is not a valid browser storage state.');
  }
}
export async function deadline<T>(
  work: Promise<T>,
  ms: number,
  message = 'Operation exceeded its time limit.',
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new ToolError('TIMEOUT', message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
