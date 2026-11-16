// Adapter (browser): live-mock feed with the Sentinel runtime loop running in this tab.
// Used when no Node runtime is reachable (static hosting such as Vercel). It runs the same loop
// (runtime/loop.ts), the same mock chain and Aegis Guard mirror (adapters/mock/mock-chain.ts),
// and the same Forge invariants as `npm run runtime`. No network, no keys, no MCP process.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '../../core/bytes';
import type { LiveControls, SnapshotFeed } from '../../core/feed';
import type { SentinelSnapshot } from '../../core/model';
import { decodeSnapshot } from '../../core/wire';
import { BUDGET_MS, SentinelLoop } from '../../runtime/loop';
import { loadBundledConfig } from '../mock/bundled-config';
import { InProcessChainClient } from '../mock/in-process-chain';
import { MockChain, type MockTiming } from '../mock/mock-chain';

/** Same defaults as the chain-state MCP server (mcp/src/server.ts). */
export const DEFAULT_BROWSER_TIMING: MockTiming = { signatureMs: 6_400, broadcastMs: 250, confirmMs: 12_000 };

const keccakHex = (b: Uint8Array) => bytesToHex(keccak_256(b));

const placeholder = (link: 'connecting' | 'lost'): SentinelSnapshot => ({
  network: 'MOCK CHAIN',
  mode: 'mock',
  budgetMs: BUDGET_MS,
  contracts: [],
  events: [],
  source: { kind: 'live-mock', link, host: 'browser' },
});

export interface BrowserRuntimeOptions {
  readonly timing?: MockTiming;
  readonly pollMs?: number;
  readonly now?: () => number;
}

export class BrowserRuntimeFeed implements SnapshotFeed, LiveControls {
  private snapshot: SentinelSnapshot = placeholder('connecting');
  private readonly listeners = new Set<() => void>();
  private loop?: SentinelLoop;
  private off?: () => void;

  constructor(private readonly opts: BrowserRuntimeOptions = {}) {}

  current(): SentinelSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.loop) return;
    const now = this.opts.now ?? (() => Date.now());
    const cfg = loadBundledConfig();
    if (!cfg.ok) {
      this.snapshot = { ...placeholder('lost'), events: [{ seq: 1, atMs: now(), level: 'critical', message: `in-browser runtime: ${cfg.error}` }] };
      this.emit();
      return;
    }
    const { entries, settings, fixture } = cfg.value;
    const loop: SentinelLoop = new SentinelLoop({
      entries,
      host: 'browser',
      pollMs: this.opts.pollMs ?? 100,
      now,
      keccakHex,
      connectedMessage: 'in-browser runtime: mock chain, Aegis Guard mirror and mock MPC run in this tab (no MCP process, no keys)',
      connect: async () => {
        const chain = new MockChain(entries, settings, fixture, this.opts.timing ?? DEFAULT_BROWSER_TIMING, (line) => loop.log(line.includes('BUG') ? 'critical' : 'info', `chain: ${line}`), now);
        chain.start();
        return new InProcessChainClient(chain);
      },
    });
    for (const e of entries) {
      loop.log('info', `guarding ${e.guarded.contractId}: invariants from ${e.provenance.invariantsFile} (Forge, source sha256 ${e.provenance.sourceSha256.slice(0, 12)}…)`);
    }
    this.loop = loop;
    this.off = loop.onSnapshot((json) => {
      const d = decodeSnapshot(JSON.parse(json));
      if (!d.ok) return;
      this.snapshot = d.value;
      this.emit();
    });
    void loop.connect().then(() => loop.run());
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
    void this.loop?.stop();
    this.loop = undefined;
    this.snapshot = placeholder('connecting');
  }

  async restartMockChain(): Promise<void> {
    await this.loop?.restart();
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }
}
