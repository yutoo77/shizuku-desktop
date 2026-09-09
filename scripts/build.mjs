import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { buildNative } from './build-native.mjs';
await mkdir('dist', { recursive: true });
await buildNative();
await build({ entryPoints: ['src/main.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: 'dist/main.cjs' });
await build({ entryPoints: ['src/preload.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: 'dist/preload.cjs' });
await build({ entryPoints: ['src/renderer.ts', 'src/controls.ts'], bundle: true, platform: 'browser', format: 'esm', outdir: 'dist', minify: true });
for (const file of ['index.html', 'controls.html', 'style.css']) await copyFile(`src/${file}`, `dist/${file}`);
