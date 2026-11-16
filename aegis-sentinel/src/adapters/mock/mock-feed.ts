// Mock snapshot feed for the demo dashboard. Adapter: owns timers and the clock.
// Plays a scripted breach -> mitigation -> containment sequence. No network, no signing.
import type { DemoControls, SnapshotFeed } from '../../core/feed';
import { formatAmount } from '../../core/format';
import type {
  ContractSnapshot,
  InvariantReading,
  LogEvent,
  LogLevel,
  Mitigation,
  SentinelSnapshot,
} from '../../core/model';

export interface Clock {
  now(): number;
}

const SUPPLY = 1_000_000n;
const MINTED_UNTRACKED = 500_000n;
const BLOCK_MS = 12_000;
const MAX_EVENTS = 40;

/** Offsets from t0 in ms. Signature latency reflects multi-block MPC signing. */
const SCRIPT = {
  signRequestSubmitted: 184,
  signatureReceived: 6_412,
  broadcast: 6_655,
  confirmed: 18_655,
} as const;

const CONTRACT = {
  contractId: 'legacy-token',
  chain: 'eip155:11155111',
  address: '0x000000000000000000000000000000000000ae61',
} as const;

const NEAR_TX = 'FkZr4b9wQd7c2Lm8XsVt1nPq6YhGj3eRuA5oKiB0WzE';
const TARGET_TX = '0x9a3f5c1e7b2d4a60c8e1f3b5d7092a4c6e8f0b1d3a5c7e9f1b3d5a7c9e1f3b5d';

const IDLE_MITIGATION: Mitigation = { state: 'none', attempts: 0, timeline: {} };

export class MockFeed implements SnapshotFeed, DemoControls {
  private snapshot: SentinelSnapshot;
  private readonly listeners = new Set<() => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private seq = 0;
  private readonly blockTimer: ReturnType<typeof setInterval>;

  constructor(private readonly clock: Clock = { now: () => Date.now() }) {
    this.snapshot = this.initial();
    this.blockTimer = setInterval(() => this.tickBlock(), BLOCK_MS);
  }

  current(): SentinelSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  simulateBreach(): void {
    const c = this.contract();
    if (c.paused || c.mitigation.state !== 'none') return;
    const t0 = this.clock.now();
    const breachId = `brk_${t0.toString(36)}`;

    this.updateContract(
      {
        invariants: [this.balanceInvariant(SUPPLY + MINTED_UNTRACKED, { breachId, detectedAtMs: t0 })],
        mitigation: { state: 'none', attempts: 0, timeline: { t0 } },
      },
      [
        ['critical', `INVARIANT BREACHED balance-conservation on ${CONTRACT.contractId}: \u03a3 balances exceeds totalSupply by ${formatAmount(MINTED_UNTRACKED)}`],
        ['info', 'Gate approved pause() intent for allowlisted target'],
      ],
    );

    this.at(t0 + SCRIPT.signRequestSubmitted, () =>
      this.updateMitigation(
        (m) => ({
          ...m,
          state: 'pending_signature',
          id: `mit_${t0.toString(36)}`,
          attempts: 1,
          nearTxHash: NEAR_TX,
          timeline: { ...m.timeline, signRequestSubmitted: t0 + SCRIPT.signRequestSubmitted },
        }),
        [['warn', `aegis-guard.request_pause submitted, NEAR tx ${NEAR_TX.slice(0, 10)}\u2026 (+${SCRIPT.signRequestSubmitted} ms)`]],
      ),
    );
    this.at(t0 + SCRIPT.signatureReceived, () =>
      this.updateMitigation(
        (m) => ({ ...m, state: 'signed', timeline: { ...m.timeline, signatureReceived: t0 + SCRIPT.signatureReceived } }),
        [['info', 'MPC signature received (secp256k1, domain 0)']],
      ),
    );
    this.at(t0 + SCRIPT.broadcast, () =>
      this.updateMitigation(
        (m) => ({
          ...m,
          state: 'broadcast',
          targetTxHash: TARGET_TX,
          timeline: { ...m.timeline, broadcast: t0 + SCRIPT.broadcast },
        }),
        [['warn', `pause() broadcast to ${CONTRACT.chain}, tx ${TARGET_TX.slice(0, 10)}\u2026`]],
      ),
    );
    this.at(t0 + SCRIPT.confirmed, () => {
      this.updateMitigation(
        (m) => ({ ...m, state: 'confirmed', timeline: { ...m.timeline, confirmed: t0 + SCRIPT.confirmed } }),
        [['info', 'pause() confirmed. paused() == true. Contract contained.']],
      );
      this.updateContract({ paused: true }, []);
    });
  }

  reset(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.updateContract(
      { paused: false, invariants: [this.balanceInvariant(SUPPLY)], mitigation: IDLE_MITIGATION },
      [['info', 'Demo reset. Monitoring resumed.']],
    );
  }

  dispose(): void {
    this.timers.forEach(clearTimeout);
    clearInterval(this.blockTimer);
    this.listeners.clear();
  }

  // ---- internals -----------------------------------------------------------

  private initial(): SentinelSnapshot {
    const now = this.clock.now();
    const contract: ContractSnapshot = {
      ...CONTRACT,
      blockNumber: 7_340_112n,
      readAtMs: now,
      paused: false,
      invariants: [this.balanceInvariant(SUPPLY)],
      mitigation: IDLE_MITIGATION,
    };
    return {
      network: 'NEAR testnet / Sepolia',
      mode: 'mock',
      budgetMs: 500,
      contracts: [contract],
      events: [this.event('info', 'Sentinel online. 1 guarded contract, 1 invariant registered.', now)],
      source: { kind: 'scripted', link: 'open' },
    };
  }

  private balanceInvariant(
    observed: bigint,
    breach?: { breachId: string; detectedAtMs: number },
  ): InvariantReading {
    return {
      id: 'balance-conservation',
      requirement: '1.2',
      label: '\u03a3 balanceOf = totalSupply',
      status: observed === SUPPLY ? 'holding' : 'breached',
      expected: SUPPLY,
      observed,
      ...(breach ?? {}),
    };
  }

  private contract(): ContractSnapshot {
    const c = this.snapshot.contracts[0];
    if (!c) throw new Error('MockFeed: no contract');
    return c;
  }

  private tickBlock(): void {
    const c = this.contract();
    this.updateContract({ blockNumber: c.blockNumber + 1n }, []);
  }

  private at(whenMs: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, Math.max(0, whenMs - this.clock.now())));
  }

  private event(level: LogLevel, message: string, atMs = this.clock.now()): LogEvent {
    this.seq += 1;
    return { seq: this.seq, atMs, level, message };
  }

  private updateMitigation(fn: (m: Mitigation) => Mitigation, events: [LogLevel, string][]): void {
    this.updateContract({ mitigation: fn(this.contract().mitigation) }, events);
  }

  private updateContract(patch: Partial<ContractSnapshot>, events: [LogLevel, string][]): void {
    const now = this.clock.now();
    const next: ContractSnapshot = { ...this.contract(), ...patch, readAtMs: now };
    const newEvents = events.map(([level, message]) => this.event(level, message, now));
    this.snapshot = {
      ...this.snapshot,
      contracts: [next],
      events: [...newEvents.reverse(), ...this.snapshot.events].slice(0, MAX_EVENTS),
    };
    this.listeners.forEach((l) => l());
  }
}
