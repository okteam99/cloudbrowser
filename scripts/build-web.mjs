import { build } from 'esbuild';
await build({
  entryPoints: ['web/main.tsx'],
  bundle: true,
  minify: true,
  target: ['es2022'],
  outfile: 'dist/public/app.js',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'eof',
  logLevel: 'info',
});

import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
await build({
  entryPoints: ['web/fingerprint-worker.ts'],
  bundle: true,
  minify: true,
  target: ['es2022'],
  outfile: 'dist/public/fingerprint-worker.js',
  logLevel: 'info',
});
await copyFile('docs/assets/getting-started.svg', 'dist/public/getting-started.svg');
for (const name of ['app.js', 'app.css', 'fingerprint-worker.js', 'getting-started.svg']) {
  const raw = await readFile(`dist/public/${name}`);
  await writeFile(`dist/public/${name}.gz`, gzipSync(raw, { level: 9 }));
}
