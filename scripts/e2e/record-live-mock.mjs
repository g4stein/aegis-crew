#!/usr/bin/env node
// Runs the real Sentinel runtime (which spawns the chain-state MCP server), and saves the
// /api/snapshot JSON at three moments: holding, breach in flight, contained.
// Output: .kiro/artifacts/live-mock/{01-holding,02-breach,03-contained}.json
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, '.kiro/artifacts/live-mock');
const port = String(19_000 + Math.floor(Math.random() * 500));
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ['--import', 'tsx', 'src/runtime/sentinel.ts'], {
  cwd: resolve(root, 'aegis-sentinel'),
  env: { ...process.env, AEGIS_RUNTIME_PORT: port, AEGIS_MOCK_BREACH_AT_MS: '2500', AEGIS_MOCK_SIGNATURE_MS: '1500', AEGIS_MOCK_BROADCAST_MS: '250', AEGIS_MOCK_CONFIRM_MS: '2000' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let log = '';
child.stderr.on('data', (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function snap() {
  try {
    return await (await fetch(`${base}/api/snapshot`)).json();
  } catch {
    return undefined;
  }
}
async function until(pred, label) {
  for (let i = 0; i < 400; i++) {
    const s = await snap();
    if (s && pred(s)) return s;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}\n${log}`);
}

try {
  mkdirSync(out, { recursive: true });
  const c = (s) => s.contracts?.[0];
  const holding = await until((s) => c(s) && c(s).invariants.every((i) => i.status === 'holding'), 'holding');
  writeFileSync(resolve(out, '01-holding.json'), JSON.stringify(holding, null, 2));
  const breach = await until((s) => c(s)?.mitigation.state === 'pending_signature', 'breach in flight');
  writeFileSync(resolve(out, '02-breach.json'), JSON.stringify(breach, null, 2));
  const contained = await until((s) => c(s)?.paused === true && c(s).mitigation.state === 'confirmed', 'contained');
  writeFileSync(resolve(out, '03-contained.json'), JSON.stringify(contained, null, 2));
  writeFileSync(resolve(out, 'runtime.log'), log.replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://127.0.0.1:<port>'));
  const tl = c(contained).mitigation.timeline;
  console.log(`recorded 3 snapshots; detect->submit ${tl.signRequestSubmitted - tl.t0} ms, detect->confirmed ${tl.confirmed - tl.t0} ms`);
} finally {
  child.kill('SIGTERM');
}
