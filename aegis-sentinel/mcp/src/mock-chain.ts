// Mock chain behind the chain-state MCP server (AEGIS_CHAIN_MODE=mock).
// Simulates the guarded token's storage, the MPC signer, and the target chain. No network calls
// and no real signatures. All policy (gate, payload, mitigation lifecycle) runs in the pure core.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, bytesToUint, concatBytes } from '../../src/core/bytes';
import type { GuardedEntry } from '../../src/core/config';
import { computePostState, evaluate, type TokenState } from '../../src/core/invariants/engine';
import { DEFAULT_MITIGATION_CONFIG, initialMachine, step, type Command, type MitigationEvent, type MitigationMachine } from '../../src/core/mitigation/fsm';
import { approveSignRequest } from '../../src/core/mitigation/gate';
import { encodeEip1559Signed, encodeEip1559Unsigned, formatPauseIntent } from '../../src/core/mitigation/payload';
import type { Allowlist, EcdsaSignature, EvmPrefetch, PauseIntent } from '../../src/core/mitigation/types';
import type { InvariantReading } from '../../src/core/model';
import type { BroadcastResult, ChainReadout, MitigationStatus, WirePayload } from '../../src/core/wire';

export interface MockTiming {
  readonly breachAtMs?: number;
  readonly signatureMs: number;
  readonly broadcastMs: number;
  readonly confirmMs: number;
}

interface FixtureEvent {
  readonly at_ms: number;
  readonly kind: 'rawSetBalance';
  readonly account: string;
  readonly balance: string;
  readonly note?: string;
}

interface ContractFixture {
  readonly start_block: string;
  readonly block_time_ms: number;
  readonly prefetch: { readonly nonce: string; readonly max_fee_per_gas: string; readonly max_priority_fee_per_gas: string };
  readonly total_supply: string;
  readonly holders: Readonly<Record<string, string>>;
  readonly timeline: readonly FixtureEvent[];
}

export interface ChainFixture {
  readonly contracts: Readonly<Record<string, ContractFixture>>;
}

interface Record_ {
  readonly mitigationId: string;
  readonly breachId: string;
  readonly t0Detected: number;
  readonly intent: PauseIntent;
  readonly payloadHash: string;
  nearTxHash?: string;
  targetTxHash?: string;
  error?: string;
}

interface ContractState {
  readonly entry: GuardedEntry;
  readonly fx: ContractFixture;
  readonly prefetch: EvmPrefetch;
  readonly timeline: readonly FixtureEvent[];
  token: TokenState;
  paused: boolean;
  applied: number;
  breach?: { readonly id: string; readonly detectedAtMs: number };
  machine: MitigationMachine;
  record?: Record_;
}

const MOCK_MPC = 'v1.signer-prod.testnet';
const keccak = (b: Uint8Array) => bytesToHex(keccak_256(b));

export class MockChain {
  private readonly contracts = new Map<string, ContractState>();
  private readonly allowlist: Allowlist;
  private readonly startedAt: number;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private tick?: ReturnType<typeof setInterval>;

  constructor(
    entries: readonly GuardedEntry[],
    fixture: ChainFixture,
    private readonly timing: MockTiming,
    private readonly log: (msg: string) => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.startedAt = now();
    this.allowlist = new Map(entries.map((e) => [e.guarded.contractId, e.guarded] as const));
    for (const entry of entries) {
      const fx = fixture.contracts[entry.guarded.contractId];
      if (!fx) throw new Error(`mock-chain fixture has no entry for ${entry.guarded.contractId}`);
      const timeline = fx.timeline.map((e, i) => (i === 0 && timing.breachAtMs !== undefined ? { ...e, at_ms: timing.breachAtMs } : e));
      this.contracts.set(entry.guarded.contractId, {
        entry,
        fx,
        timeline,
        prefetch: { nonce: BigInt(fx.prefetch.nonce), maxFeePerGas: BigInt(fx.prefetch.max_fee_per_gas), maxPriorityFeePerGas: BigInt(fx.prefetch.max_priority_fee_per_gas) },
        token: { balances: new Map(Object.entries(fx.holders).map(([a, v]) => [a.toLowerCase(), BigInt(v)])), totalSupply: BigInt(fx.total_supply) },
        paused: false,
        applied: 0,
        machine: initialMachine(entry.guarded.contractId),
      });
    }
  }

  start(): void {
    this.advance();
    this.tick = setInterval(() => this.advance(), 20);
  }

  stop(): void {
    if (this.tick) clearInterval(this.tick);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // ---- get_contract_invariants -----------------------------------------------------------

  readout(): ChainReadout {
    this.advance();
    const now = this.now();
    return {
      readAtMs: now,
      contracts: [...this.contracts.values()].map((c) => ({
        contractId: c.entry.guarded.contractId,
        chain: c.entry.chain,
        address: c.entry.guarded.address,
        blockNumber: this.blockNumber(c, now),
        paused: c.paused,
        invariants: this.readings(c),
        mitigation: {
          state: c.machine.mitigation.state,
          ...(c.record ? { mitigationId: c.record.mitigationId } : {}),
          signatureTimeoutMs: DEFAULT_MITIGATION_CONFIG.signatureTimeoutMs,
        },
      })),
    };
  }

  // ---- broadcast_mitigation_payload ------------------------------------------------------

  broadcast(contractId: string, breachId: string, dryRun: boolean): BroadcastResult {
    this.advance();
    const refused = (refusalReason: NonNullable<BroadcastResult['refusalReason']>): BroadcastResult => ({ status: 'refused', contractId, refusalReason });
    const c = this.contracts.get(contractId);
    if (!c || !this.allowlist.has(contractId)) return refused('not_allowlisted');
    if (c.paused) return refused('already_paused');
    const state = c.machine.mitigation.state;
    if (state === 'pending_signature' || state === 'signed' || state === 'broadcast' || state === 'confirmed') return refused('mitigation_in_flight');
    if (!c.breach || c.breach.id !== breachId) return refused('breach_not_current');

    // The server builds the transaction; the caller cannot influence target, value, or calldata.
    const intent = formatPauseIntent(c.entry.guarded, c.prefetch);
    const gate = approveSignRequest(intent, this.allowlist);
    if (!gate.ok) return refused('not_allowlisted');
    const unsigned = encodeEip1559Unsigned(intent);
    if (!unsigned.ok) return refused('signer_unavailable');
    const payloadHash = keccak(unsigned.value);
    const payload: WirePayload = {
      chain: c.entry.chain,
      to: intent.to.toLowerCase(),
      data: intent.data,
      value: '0',
      nonce: intent.nonce.toString(),
      gasLimit: intent.gasLimit.toString(),
      maxFeePerGas: intent.maxFeePerGas.toString(),
      maxPriorityFeePerGas: intent.maxPriorityFeePerGas.toString(),
      unsignedTx: bytesToHex(unsigned.value),
      payloadHash,
    };
    const signRequest = { mpcContract: MOCK_MPC, derivationPath: c.entry.guarded.derivationPath };
    if (dryRun) return { status: 'dry_run', contractId, payload, signRequest, timings: { t0Detected: c.breach.detectedAtMs } };

    const now = this.now();
    const mitigationId = `mit_${breachId}`;
    c.record = { mitigationId, breachId, t0Detected: c.breach.detectedAtMs, intent, payloadHash };
    this.apply(c, { kind: 'breach_detected', breachId, readAtMs: now, nowMs: now });
    const submitted = c.machine.mitigation.timeline.signRequestSubmitted ?? now;
    this.log(`mitigation ${mitigationId}: sign request submitted ${submitted - c.record.t0Detected} ms after detection`);
    return {
      status: 'submitted',
      contractId,
      mitigationId,
      payload,
      signRequest: { ...signRequest, ...(c.record.nearTxHash ? { nearTxHash: c.record.nearTxHash } : {}) },
      timings: { t0Detected: c.record.t0Detected, signRequestSubmitted: submitted, detectToSubmit: submitted - c.record.t0Detected },
    };
  }

  // ---- get_mitigation_status ---------------------------------------------------------------

  status(mitigationId: string): MitigationStatus | undefined {
    this.advance();
    const c = [...this.contracts.values()].find((x) => x.record?.mitigationId === mitigationId);
    if (!c || !c.record) return undefined;
    const st = c.machine.mitigation.state;
    const state = st === 'none' || st === 'refused' ? 'failed' : st;
    const tl = c.machine.mitigation.timeline;
    return {
      mitigationId,
      contractId: c.entry.guarded.contractId,
      state,
      ...(c.record.targetTxHash ? { targetTxHash: c.record.targetTxHash } : {}),
      ...(c.record.error ? { error: c.record.error } : {}),
      timings: {
        t0Detected: c.record.t0Detected,
        ...(tl.signRequestSubmitted !== undefined ? { signRequestSubmitted: tl.signRequestSubmitted } : {}),
        ...(tl.signatureReceived !== undefined ? { signatureReceived: tl.signatureReceived } : {}),
        ...(tl.broadcast !== undefined ? { broadcast: tl.broadcast } : {}),
        ...(tl.confirmed !== undefined ? { confirmed: tl.confirmed } : {}),
      },
    };
  }

  // ---- internals ---------------------------------------------------------------------------

  private blockNumber(c: ContractState, now: number): bigint {
    return BigInt(c.fx.start_block) + BigInt(Math.floor((now - this.startedAt) / c.fx.block_time_ms));
  }

  private readings(c: ContractState): InvariantReading[] {
    return evaluate(c.token, c.entry.registry).map((r) =>
      r.status === 'breached' && c.breach ? { ...r, breachId: c.breach.id, detectedAtMs: c.breach.detectedAtMs } : r,
    );
  }

  /** Applies due fixture events, records breach detection, and lets the core check timeouts. */
  private advance(): void {
    const now = this.now();
    for (const c of this.contracts.values()) {
      while (c.applied < c.timeline.length && now - this.startedAt >= c.timeline[c.applied]!.at_ms) {
        const e = c.timeline[c.applied]!;
        c.token = computePostState(c.token, { kind: 'rawSetBalance', account: e.account.toLowerCase(), balance: BigInt(e.balance) });
        c.applied += 1;
        this.log(`mock chain: ${e.note ?? e.kind} (${c.entry.guarded.contractId})`);
      }
      const breached = evaluate(c.token, c.entry.registry).some((r) => r.status === 'breached');
      if (breached && !c.breach) {
        c.breach = { id: `brk_${c.entry.guarded.contractId}_${this.blockNumber(c, now).toString()}`, detectedAtMs: now };
        this.log(`mock chain: invariant breached on ${c.entry.guarded.contractId}, breach_id ${c.breach.id}`);
      } else if (!breached && c.breach && c.machine.mitigation.state === 'none') {
        c.breach = undefined;
      }
      if (c.machine.mitigation.state === 'pending_signature') this.apply(c, { kind: 'timeout', nowMs: now });
    }
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  /** Runs one state-machine step and carries out its commands against the mock signer and chain. */
  private apply(c: ContractState, e: MitigationEvent): void {
    const { next, commands } = step(c.machine, e, DEFAULT_MITIGATION_CONFIG);
    c.machine = next;
    for (const cmd of commands) this.execute(c, cmd);
  }

  private execute(c: ContractState, cmd: Command): void {
    const rec = c.record;
    if (!rec) return;
    switch (cmd.kind) {
      case 'submit_sign': {
        // Mock NEAR transaction calling aegis-guard.request_pause (which calls MPC sign).
        rec.nearTxHash = `mock_${keccak(concatBytes(new TextEncoder().encode(rec.payloadHash), Uint8Array.of(cmd.attempt))).slice(2, 46)}`;
        this.apply(c, { kind: 'sign_submitted', nearTxHash: rec.nearTxHash, nowMs: this.now() });
        this.later(this.timing.signatureMs, () => {
          const seed = new TextEncoder().encode(rec.payloadHash);
          const signature: EcdsaSignature = {
            yParity: 0,
            r: bytesToUint(keccak_256(concatBytes(seed, Uint8Array.of(0x72)))),
            s: bytesToUint(keccak_256(concatBytes(seed, Uint8Array.of(0x73)))),
          };
          this.log(`mock MPC: signature returned for ${rec.mitigationId} (not a real signature)`);
          this.apply(c, { kind: 'signature_received', signature, nowMs: this.now() });
        });
        return;
      }
      case 'broadcast': {
        const signed = encodeEip1559Signed(rec.intent, cmd.signature);
        if (!signed.ok) {
          rec.error = signed.error.message;
          return;
        }
        rec.targetTxHash = keccak(signed.value);
        this.later(this.timing.broadcastMs, () => {
          this.apply(c, { kind: 'broadcast', targetTxHash: rec.targetTxHash!, nowMs: this.now() });
          this.log(`mock chain: pause() broadcast ${rec.targetTxHash!.slice(0, 12)}…`);
          this.later(this.timing.confirmMs, () => {
            this.apply(c, { kind: 'confirmed', nowMs: this.now() });
            c.paused = true;
            this.apply(c, { kind: 'paused_observed', nowMs: this.now() });
            this.log(`mock chain: pause() confirmed, ${c.entry.guarded.contractId} paused`);
          });
        });
        return;
      }
      case 'alert':
        this.log(`mitigation ${rec.mitigationId}: ${cmd.reason}`);
        return;
      case 'reread_state':
        return;
    }
  }
}
