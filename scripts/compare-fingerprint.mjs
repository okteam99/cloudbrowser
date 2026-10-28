import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const [referencePath, actualPath, ...extra] = process.argv.slice(2);
if (!referencePath || !actualPath || extra.length) {
  console.error('Usage: node scripts/compare-fingerprint.mjs <reference.json> <actual.json>');
  process.exit(2);
}
try {
  const [reference, actual] = await Promise.all(
    [referencePath, actualPath].map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
  );
  if (
    !reference ||
    typeof reference !== 'object' ||
    Array.isArray(reference) ||
    !actual ||
    typeof actual !== 'object' ||
    Array.isArray(actual)
  )
    throw new Error('Both inputs must be JSON objects.');
  let compared = 0,
    matched = 0;
  const differences = [];
  function walk(expected, observed, present, path) {
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      for (const [key, value] of Object.entries(expected)) {
        const exists =
          present &&
          observed !== null &&
          typeof observed === 'object' &&
          !Array.isArray(observed) &&
          Object.hasOwn(observed, key);
        walk(value, exists ? observed[key] : undefined, exists, path ? `${path}.${key}` : key);
      }
    } else {
      compared++;
      if (present && isDeepStrictEqual(expected, observed)) matched++;
      else
        differences.push({
          path,
          status: present ? 'mismatch' : 'missing',
          expected,
          ...(present ? { actual: observed } : {}),
        });
    }
  }
  walk(reference, actual, true, '');
  if (!compared) throw new Error('Reference has no comparable fields.');
  console.log(
    JSON.stringify(
      {
        reference: referencePath,
        actual: actualPath,
        compared,
        matched,
        differences,
        scope:
          'Only fields present in the reference are checked. Arrays are compared as complete ordered values. Additional actual fields are unverified; missing values do not equal null.',
      },
      null,
      2,
    ),
  );
  process.exitCode = differences.length ? 1 : 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
