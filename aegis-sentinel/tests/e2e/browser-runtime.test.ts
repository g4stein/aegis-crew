// End-to-end: the in-tab runtime (static hosting) runs the same pipeline as `npm run runtime`.
// Runs in Node with the browser adapters; no DOM is needed because the feed is plain TypeScript.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserRuntimeFeed } from '../../src/adapters/feed/browser-runtime';
import type { SentinelSnapshot } from '../../src/core/model';

const REPO = resolve(import.meta.dirname, '../../..');
const feed = new BrowserRuntimeFeed({ timing: { breachAtMs: 300, signatureMs: 200, broadcastMs: 50, confirmMs: 200 }, pollMs: 20 });

async function waitFor(pred: (s: SentinelSnapshot) => boolean, timeoutMs: number): Promise<SentinelSnapshot> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = feed.current();
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out; last events:\n${feed.current().events.map((e) => e.message).join('\n')}`);
}

const messages = () => feed.current().events.map((e) => e.message).join('\n');

describe('in-tab runtime (static hosting)', () => {
  feed.start();
  afterAll(() => feed.stop());

  it('loads the Forge invariants with the same sha256 the Node runtime reports', async () => {
    const s = await waitFor((x) => x.contracts.length > 0, 5_000);
    expect(s.source).toMatchObject({ kind: 'live-mock', link: 'open', host: 'browser', invariantsFile: 'aegis-forge/output/legacy-vault.invariants.json' });
    const bytes = readFileSync(resolve(REPO, 'aegis-forge/output/legacy-vault.invariants.json'));
    expect(s.source?.invariantsSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(s.contracts[0]!.invariants.every((i) => i.status === 'holding')).toBe(true);
  });

  it('detects the breach and submits within the 500 ms budget (Req 2.1)', async () => {
    const s = await waitFor((x) => x.contracts[0]?.mitigation.timeline.signRequestSubmitted !== undefined, 5_000);
    const tl = s.contracts[0]!.mitigation.timeline;
    expect(tl.signRequestSubmitted! - tl.t0!).toBeLessThanOrEqual(500);
  });

  it('runs to a confirmed pause through the Aegis Guard mirror (Req 2.2, 2.5, 2.7)', async () => {
    const s = await waitFor((x) => x.contracts[0]?.paused === true && x.contracts[0]!.mitigation.state === 'confirmed', 5_000);
    expect(s.contracts[0]!.mitigation.targetTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    const log = messages();
    expect(log).toMatch(/chain: aegis-guard: request_pause\(legacy-vault, brk_\d+\) accepted at NEAR block \d+: 13 checks passed/);
    expect(log).toMatch(/on_signature -> signed \(mock MPC; r has a leading zero byte, encoded canonically/);
    expect(log).toMatch(/aegis-guard\.testnet enforced 13 checks and paid 1 yoctoNEAR/);
    expect(log.match(/fast path detect-to-submit/g)?.length).toBe(1);
    expect(log).not.toMatch(/BUG:|refusing to submit/);
  });

  it('restarts the mock chain from the dashboard control', async () => {
    await feed.restartMockChain();
    const s = await waitFor((x) => x.contracts[0]?.paused === false, 5_000);
    expect(s.contracts[0]!.mitigation.state).toBe('none');
  });
});
