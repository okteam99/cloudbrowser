import test from 'node:test';
import assert from 'node:assert/strict';
import { operatingSystem } from '../src/browser-environment.js';

test('UA operating system uses advertised identity, including mobile and unknown custom UAs', () => {
  for (const [ua, expected] of [
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8)', 'Android'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iOS'],
    ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', 'iOS'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'macOS'],
    ['Mozilla/5.0 (X11; CrOS x86_64 15662.0.0)', 'ChromeOS'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'Linux'],
    ['CustomAgent/1.0', null],
    [null, null],
  ] as const)
    assert.equal(operatingSystem(ua), expected);
});
