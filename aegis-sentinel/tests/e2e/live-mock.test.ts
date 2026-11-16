// End-to-end: runtime -> MCP stdio -> chain-state server (mock) -> pause confirmed.
// Not part of tests/pbt: it spawns processes and opens a local port. Run: npm run test:e2e
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpChainClient } from '../../src/adapters/chain/mcp-chain-client';
import { decodeSnapshot } from '../../src/core/wire';
import type { SentinelSnapshot } from '../../src/core/model';

const SENTINEL = resolve(import.meta.dirname, '../..');
const PORT = 18_000 + Math.floor(Math.random() * 2_000);
const BASE = `http://127.0.0.1:${PORT}`;
const FAST = { AEGIS_MOCK_BREACH_AT_MS: '1200', AEGIS_MOCK_SIGNATURE_MS: '400', AEGIS_MOCK_BROADCAST_MS: '100', AEGIS_MOCK_CONFIRM_MS: '400' };

let runtime: ChildProcess | undefined;
let stderr = '';

async function snapshot(): Promise<SentinelSnapshot | undefined> {
  try {
    const r = await fetch(`${BASE}/api/snapshot`);
    const d = decodeSnapshot(await r.json());
    return d.ok ? d.value : undefined;
  } catch {
    return undefined;
  }
}

async function waitFor(pred: (s: SentinelSnapshot) => boolean, timeoutMs: number): Promise<SentinelSnapshot> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await snapshot();
    if (s && pred(s)) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out; runtime stderr:\n${stderr.slice(-3000)}`);
}

describe('live-mock pipeline', () => {
  beforeAll(() => {
    runtime = spawn(process.execPath, ['--import', 'tsx', 'src/runtime/sentinel.ts'], {
      cwd: SENTINEL,
      env: { ...process.env, ...FAST, AEGIS_RUNTIME_PORT: String(PORT), AEGIS_CHAIN_MODE: 'mock' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    runtime.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  });
  afterAll(() => {
    runtime?.kill('SIGTERM');
  });

  it('starts holding, with the registry taken from the Forge output', async () => {
    const s = await waitFor((x) => x.contracts.length > 0, 20_000);
    expect(s.source?.kind).toBe('live-mock');
    expect(s.source?.invariantsFile).toBe('aegis-forge/output/legacy-vault.invariants.json');
    expect(s.contracts[0]!.contractId).toBe('legacy-vault');
    expect(s.contracts[0]!.invariants.find((i) => i.id === 'balance-conservation')?.label).toBe('Σ balanceOf = totalSupply');
  }, 30_000);

  it('detects the breach and submits a sign request within 500 ms of t0 (Req 2.1, 2.4)', async () => {
    const s = await waitFor((x) => x.contracts[0]?.mitigation.timeline.signRequestSubmitted !== undefined, 20_000);
    const tl = s.contracts[0]!.mitigation.timeline;
    expect(tl.t0).toBeDefined();
    const latency = tl.signRequestSubmitted! - tl.t0!;
    expect(latency).toBeGreaterThanOrEqual(0);
    expect(latency).toBeLessThanOrEqual(500);
    process.stderr.write(`    fast path detect-to-submit: ${latency} ms\n`);
  }, 30_000);

  it('runs the mitigation to a confirmed pause and stops (Req 2.2, 2.13)', async () => {
    const s = await waitFor((x) => x.contracts[0]?.paused === true && x.contracts[0]!.mitigation.state === 'confirmed', 20_000);
    const c = s.contracts[0]!;
    const tl = c.mitigation.timeline;
    expect([tl.t0, tl.signRequestSubmitted, tl.signatureReceived, tl.broadcast, tl.confirmed].every((t) => t !== undefined)).toBe(true);
    expect(tl.signatureReceived!).toBeGreaterThanOrEqual(tl.signRequestSubmitted!);
    expect(tl.confirmed!).toBeGreaterThanOrEqual(tl.broadcast!);
    expect(c.mitigation.targetTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(stderr.match(/fast path detect-to-submit/g)?.length).toBe(1);
  }, 30_000);

  it('routes the request through the Aegis Guard, which pays the deposit (Req 2.5, 2.7)', () => {
    expect(stderr).toMatch(/aegis-guard: request_pause\(legacy-vault, brk_\d+\) accepted at NEAR block \d+: 13 checks passed/);
    expect(stderr).toMatch(/paid 1 yoctoNEAR sign deposit from guard balance \(5000000000000000000000000 yoctoNEAR -> 4999999999999999999999999 yoctoNEAR\)/);
    expect(stderr).toMatch(/v1\.signer-prod\.testnet\.sign\(payload 0x[0-9a-f]{12}…, path aegis\/legacy-vault\/eip155:11155111, domain 0, 50 TGas\)/);
    expect(stderr).toMatch(/on_signature -> signed \(mock MPC; r has a leading zero byte, encoded canonically/);
    expect(stderr).toMatch(/aegis-guard\.testnet enforced 13 checks and paid 1 yoctoNEAR/);
    expect(stderr).not.toMatch(/BUG:/);
  });

  it('rejects restart requests without the custom header', async () => {
    const r = await fetch(`${BASE}/api/restart`, { method: 'POST' });
    expect(r.status).toBe(403);
  });
});

describe('chain-state MCP server contract', () => {
  const client = new McpChainClient({ env: { ...FAST, AEGIS_MOCK_BREACH_AT_MS: '300' } });
  beforeAll(async () => client.connect(), 30_000);
  afterAll(async () => client.close());

  it('refuses unknown contracts and stale breach IDs', async () => {
    const unknown = await client.requestPause('not-guarded', 'brk_x', true);
    expect(unknown.ok && unknown.value).toMatchObject({ status: 'refused', refusalReason: 'not_allowlisted' });
    const stale = await client.requestPause('legacy-vault', 'brk_bogus', true);
    expect(stale.ok && stale.value).toMatchObject({ status: 'refused', refusalReason: 'breach_not_current' });
  });

  it('builds only pause() to the allowlisted target, and dry runs change nothing', async () => {
    await new Promise((r) => setTimeout(r, 600));
    const read = await client.readState();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const breach = read.value.contracts[0]!.invariants.find((i) => i.status === 'breached');
    expect(breach?.breachId).toBeDefined();
    const dry = await client.requestPause('legacy-vault', breach!.breachId!, true);
    expect(dry.ok && dry.value.status).toBe('dry_run');
    if (!dry.ok) return;
    expect(dry.value.payload).toMatchObject({ to: '0x000000000000000000000000000000000000ae61', data: '0x8456cb59', value: '0', chain: 'eip155:11155111' });
    const after = await client.readState();
    expect(after.ok && after.value.contracts[0]!.mitigation.state).toBe('none');
    expect(dry.value.signRequest).toMatchObject({ guardContract: 'aegis-guard.testnet', depositYoctonear: '1' });
    expect(dry.value.signRequest?.guardChecks).toHaveLength(13);
  });
});

describe('Aegis Guard rejections over MCP', () => {
  // Fee quotes above the guard's cap (200 gwei) must be refused on-chain, not just by the runtime.
  const dir = mkdtempSync(join(tmpdir(), 'aegis-fx-'));
  const fixture = JSON.parse(readFileSync(resolve(SENTINEL, 'mcp/fixtures/mock-chain.json'), 'utf8')) as { contracts: Record<string, { prefetch: Record<string, string> }> };
  fixture.contracts['legacy-vault']!.prefetch.max_fee_per_gas = '250000000000';
  const path = join(dir, 'high-fee.json');
  writeFileSync(path, JSON.stringify(fixture));
  const client = new McpChainClient({ env: { ...FAST, AEGIS_MOCK_BREACH_AT_MS: '200', AEGIS_MOCK_FIXTURE: path } });
  beforeAll(async () => client.connect(), 30_000);
  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses with guard_rejected / fee_above_cap and signs nothing', async () => {
    await new Promise((r) => setTimeout(r, 500));
    const read = await client.readState();
    const breach = read.ok ? read.value.contracts[0]!.invariants.find((i) => i.status === 'breached') : undefined;
    expect(breach?.breachId).toBeDefined();
    for (const dryRun of [true, false]) {
      const r = await client.requestPause('legacy-vault', breach!.breachId!, dryRun);
      expect(r.ok && r.value).toMatchObject({ status: 'refused', refusalReason: 'guard_rejected', guardReason: 'fee_above_cap' });
    }
    const after = await client.readState();
    expect(after.ok && after.value.contracts[0]!.mitigation.state).toBe('none');
  });
});
