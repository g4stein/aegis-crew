#!/usr/bin/env node
// Copies the built dashboard (aegis-sentinel/dist) to <repo>/dist on Vercel.
//
// Vercel looks for the output directory relative to the project's Root Directory, and project
// settings can override vercel.json. Publishing the same files at both aegis-sentinel/dist and
// <repo>/dist means the deploy works whether Root Directory is the repo root or aegis-sentinel,
// and whether the output directory setting is "dist" or "aegis-sentinel/dist".
//
// Runs only when VERCEL is set (Vercel sets VERCEL=1 during builds) or with --force, so local
// builds do not create a second copy. <repo>/dist is git-ignored.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'aegis-sentinel/dist');
const to = resolve(root, 'dist');

if (!process.env.VERCEL && !process.argv.includes('--force')) process.exit(0);
if (!existsSync(resolve(from, 'index.html'))) {
  console.error(`[vercel-dist] ${from}/index.html not found; build the dashboard first`);
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log('[vercel-dist] copied aegis-sentinel/dist -> dist');
