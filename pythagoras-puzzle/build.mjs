// Build: bundles src/ → dist/ (app.js + app.css) and copies public/.
// Usage: node build.mjs        (production)
//        node build.mjs --watch (rebuild on change; serve dist/ with any static server)
import { build, context } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
cpSync('public', 'dist', { recursive: true });
const opts = {
  entryPoints: { app: 'src/main.ts' },
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ['es2020'],
  outdir: 'dist',
  loader: { '.json': 'json' },
  logLevel: 'info',
};
if (process.argv.includes('--watch')) (await context(opts)).watch();
else await build(opts);
