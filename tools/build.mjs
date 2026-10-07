// Builds the extension into dist/ (load that folder with "Load unpacked").
// Usage: node tools/build.mjs [--watch]
import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url).pathname;
const out = `${root}dist`;
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: {
    // Content script (isolated world) and the page-world bridge are separate
    // scripts in manifest.json, so they are separate bundles.
    content: `${root}src/main.ts`,
    'page-bridge': `${root}src/page-bridge.ts`,
  },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: 'chrome114',
  // Kept readable on purpose: what runs in the browser is what you can read.
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
};

async function copyStatic() {
  const pkg = JSON.parse(await readFile(`${root}package.json`, 'utf8'));
  const manifest = JSON.parse(await readFile(`${root}src/manifest.json`, 'utf8'));
  manifest.version = pkg.version; // package.json is the one place the version lives
  await writeFile(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  await cp(`${root}src/panel.css`, `${out}/panel.css`);
  await cp(`${root}icons`, `${out}/icons`, { recursive: true });
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await copyStatic();
if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
