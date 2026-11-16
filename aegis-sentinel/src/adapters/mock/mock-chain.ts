// Mock chain. Runs behind the chain-state MCP server (AEGIS_CHAIN_MODE=mock) and, for static
// hosting, inside the browser tab (adapters/mock/in-process-chain.ts). Environment-neutral:
// no Node or DOM APIs, so both hosts run the same code.
// Simulates the guarded token's storage, the Aegis Guard contract on NEAR, the MPC signer, and
// the target chain. No network calls and no real signatures. Every rule runs in the pure core:
// the guard mirror (core/guard.ts, conformance-tested against the Rust contract), the
// invariant engine, and the mitigation state machine.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes } from '../../core/bytes';
import type { GuardedEntry, GuardSettings } from '../../core/config';
import {
  GUARD_CHECKS,
  initialGuardState,
  onSignature,
  planPause,
  requestPause,
  toEcdsa,
  updateFeeQuote,
  type GuardRejection,
  type GuardState,
  type MpcSignResult,
} from '../../core/guard';
import { computePostState, evaluate, type TokenState } from '../../core/invariants/engine';
import { DEFAULT_MITIGATION_CONFIG, initialMachine, step, type Command, type MitigationEvent, type MitigationMachine } from '../../core/mitigation/fsm';
import { encodeEip1559Signed } from '../../core/mitigation/payload';
import type { EvmPrefetch, PauseIntent } from '../../core/mitigation/types';
import type { InvariantReading } from '../../core/model';
import type { BroadcastResult, ChainReadout, MitigationStatus, WirePayload } from '../../core/wire';

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
  /** Mock NEAR chain: starting height and guard account balance (yoctoNEAR). */
  readonly near?: { readonly start_block?: string; readonly guard_balance_yocto?: string };
  readonly contracts: Readonly<Record<string, ContractFixture>>;
}

interface Record_ {
  readonly mitigationId: string;
  readonly breachId: string;
  readonly t0Detected: number;
  readonly intent: PauseIntent;
  readonly payloadHash: string;
  nearTxHash?: string;
  guardSignedTx?: string;
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

const NEAR_BLOCK_MS = 1_000;
const keccakBytes = (b: Uint8Array) => keccak_256(b);
const keccak = (b: Uint8Array) => bytesToHex(keccak_256(b));
const utf8 = (s: string) => new TextEncoder().encode(s);
const yocto = (v: bigint) => `${v.toString()} yoctoNEAR`;

export class MockChain {
  private readonly contracts = new Map<string, ContractState>();
  private readonly startedAt: number;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private tick?: ReturnType<typeof setInterval>;
  private guard: GuardState;
  private guardBalance: bigint;
  private readonly nearStart: bigint;
  private lastQuoteBlock = -1n;

  constructor(
    entries: readonly GuardedEntry[],
    private readonly settings: GuardSettings,
    fixture: ChainFixture,
    private readonly timing: MockTiming,
    private readonly log: (msg: string) => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.startedAt = now();
    this.nearStart = BigInt(fixture.near?.start_block ?? '190000000');
    this.guardBalance = BigInt(fixture.near?.guard_balance_yocto ?? (5n * 10n ** 24n).toString());
    this.guard = initialGuardState(
      {
        owner: settings.owner,
        sentinel: settings.sentinel,
        feeOracle: settings.feeOracle,
        mpcContract: settings.mpcContract,
        guardAccount: settings.account,
        signDepositYocto: settings.signDepositYocto,
        signGasTgas: settings.signGasTgas,
        maxQuoteAgeBlocks: settings.maxQuoteAgeBlocks,
      },
      entries.map((e) => ({
        contractId: e.guarded.contractId,
        chainId: e.guarded.chainId,
        address: e.guarded.address,
        derivationPath: e.guarded.derivationPath,
        gasLimit: e.guarded.gasLimit,
        maxFeePerGasCap: e.limits.maxFeePerGasCap,
        maxPriorityFeePerGasCap: e.limits.maxPriorityFeePerGasCap,
        minIntervalBlocks: e.limits.minIntervalBlocks,
      })),
    );
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
    this.log(`aegis-guard (mock NEAR): ${settings.account}, balance ${yocto(this.guardBalance)}; sentinel ${settings.sentinel}; MPC ${settings.mpcContract}`);
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
    const refused = (refusalReason: NonNullable<BroadcastResult['refusalReason']>, guardReason?: GuardRejection): BroadcastResult => ({
      status: 'refused',
      contractId,
      refusalReason,
      ...(guardReason ? { guardReason } : {}),
    });
    const c = this.contracts.get(contractId);
    if (!c) return refused('not_allowlisted');
    if (c.paused) return refused('already_paused');
    const state = c.machine.mitigation.state;
    if (state === 'pending_signature' || state === 'signed' || state === 'broadcast' || state === 'confirmed') return refused('mitigation_in_flight');
    if (!c.breach || c.breach.id !== breachId) return refused('breach_not_current');

    // The guard builds the transaction; the caller passes only contract_id and breach_id.
    const block = this.nearBlock();
    const input = { contractId, breachId, blockHeight: block, availableYocto: this.guardBalance };
    const signRequest = (nearTxHash?: string) => ({
      mpcContract: this.settings.mpcContract,
      derivationPath: c.entry.guarded.derivationPath,
      guardContract: this.settings.account,
      depositYoctonear: this.settings.signDepositYocto.toString(),
      guardChecks: [...GUARD_CHECKS],
      ...(nearTxHash ? { nearTxHash } : {}),
    });

    if (dryRun) {
      const plan = planPause(this.guard, input, keccakBytes);
      if (!plan.ok) return refused('guard_rejected', plan.error);
      return { status: 'dry_run', contractId, payload: this.payload(c, plan.value.intent, plan.value.unsignedTx, plan.value.payloadHash), signRequest: signRequest(), timings: { t0Detected: c.breach.detectedAtMs } };
    }

    // request_pause, called by the Sentinel's function-call key (0 deposit).
    const r = requestPause(this.guard, { ...input, predecessor: this.settings.sentinel }, keccakBytes);
    if (!r.ok) {
      this.log(`aegis-guard: request_pause(${contractId}, ${breachId}) rejected: ${r.error}`);
      return refused('guard_rejected', r.error);
    }
    this.guard = r.value.state;
    const before = this.guardBalance;
    this.guardBalance -= r.value.signCall.depositYocto;
    const m = r.value.mitigation;
    this.log(
      `aegis-guard: request_pause(${contractId}, ${breachId}) accepted at NEAR block ${block}: ${GUARD_CHECKS.length} checks passed (allowlist, target, chain, selector 0x8456cb59, value 0, fee cap, rate limit, in-flight)`,
    );
    this.log(
      `aegis-guard: paid ${yocto(r.value.signCall.depositYocto)} sign deposit from guard balance (${yocto(before)} -> ${yocto(this.guardBalance)}); ${r.value.signCall.receiver}.sign(payload ${m.payloadHash.slice(0, 14)}…, path ${m.derivationPath}, domain ${r.value.signCall.args.request.domain_id}, ${r.value.signCall.gasTgas} TGas)`,
    );

    const now = this.now();
    c.record = { mitigationId: m.mitigationId, breachId, t0Detected: c.breach.detectedAtMs, intent: m.intent, payloadHash: m.payloadHash };
    this.apply(c, { kind: 'breach_detected', breachId, readAtMs: now, nowMs: now });
    const submitted = c.machine.mitigation.timeline.signRequestSubmitted ?? now;
    return {
      status: 'submitted',
      contractId,
      mitigationId: m.mitigationId,
      payload: this.payload(c, m.intent, m.unsignedTx, m.payloadHash),
      signRequest: signRequest(c.record.nearTxHash),
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

  private payload(c: ContractState, intent: PauseIntent, unsignedTx: string, payloadHash: string): WirePayload {
    return {
      chain: c.entry.chain,
      to: intent.to.toLowerCase(),
      data: intent.data,
      value: '0',
      nonce: intent.nonce.toString(),
      gasLimit: intent.gasLimit.toString(),
      maxFeePerGas: intent.maxFeePerGas.toString(),
      maxPriorityFeePerGas: intent.maxPriorityFeePerGas.toString(),
      unsignedTx,
      payloadHash,
    };
  }

  private nearBlock(): bigint {
    return this.nearStart + BigInt(Math.floor((this.now() - this.startedAt) / NEAR_BLOCK_MS));
  }

  private blockNumber(c: ContractState, now: number): bigint {
    return BigInt(c.fx.start_block) + BigInt(Math.floor((now - this.startedAt) / c.fx.block_time_ms));
  }

  private readings(c: ContractState): InvariantReading[] {
    return evaluate(c.token, c.entry.registry).map((r) =>
      r.status === 'breached' && c.breach ? { ...r, breachId: c.breach.id, detectedAtMs: c.breach.detectedAtMs } : r,
    );
  }

  /** Once per NEAR block the fee oracle posts the latest nonce and fees to the guard. */
  private postQuotes(): void {
    const block = this.nearBlock();
    if (block === this.lastQuoteBlock) return;
    this.lastQuoteBlock = block;
    for (const c of this.contracts.values()) {
      const r = updateFeeQuote(this.guard, {
        predecessor: this.settings.feeOracle,
        contractId: c.entry.guarded.contractId,
        nonce: c.prefetch.nonce,
        maxFeePerGas: c.prefetch.maxFeePerGas,
        maxPriorityFeePerGas: c.prefetch.maxPriorityFeePerGas,
        blockHeight: block,
      });
      if (r.ok) this.guard = r.value;
      else this.log(`aegis-guard: update_fee_quote rejected: ${r.error}`);
    }
  }

  /** Applies due fixture events, records breach detection, and lets the core check timeouts. */
  private advance(): void {
    const now = this.now();
    this.postQuotes();
    for (const c of this.contracts.values()) {
      while (c.applied < c.timeline.length && now - this.startedAt >= c.timeline[c.applied]!.at_ms) {
        const e = c.timeline[c.applied]!;
        c.token = computePostState(c.token, { kind: 'rawSetBalance', account: e.account.toLowerCase(), balance: BigInt(e.balance) });
        c.applied += 1;
        this.log(`mock chain: ${e.note ?? e.kind} (${c.entry.guarded.contractId})`);
      }
      const breached = evaluate(c.token, c.entry.registry).some((r) => r.status === 'breached');
      if (breached && !c.breach) {
        c.breach = { id: `brk_${this.blockNumber(c, now).toString()}`, detectedAtMs: now };
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

  /** Runs one state-machine step and carries out its commands against the mock guard, MPC, and chain. */
  private apply(c: ContractState, e: MitigationEvent): void {
    const { next, commands } = step(c.machine, e, DEFAULT_MITIGATION_CONFIG);
    c.machine = next;
    for (const cmd of commands) this.execute(c, cmd);
  }

  /**
   * Deterministic mock MPC response. The first byte of r is forced to 0x00 so every mock run
   * exercises the leading-zero-safe encoder (raw 32-byte encoding would be non-canonical).
   */
  private mockSignature(payloadHash: string): MpcSignResult {
    const seed = utf8(payloadHash);
    const r = keccak_256(concatBytes(seed, Uint8Array.of(0x72)));
    r[0] = 0x00;
    const s = keccak_256(concatBytes(seed, Uint8Array.of(0x73)));
    return { scheme: 'Secp256k1', big_r: { affine_point: `02${bytesToHex(r).slice(2)}` }, s: { scalar: bytesToHex(s).slice(2) }, recovery_id: 0 };
  }

  private execute(c: ContractState, cmd: Command): void {
    const rec = c.record;
    if (!rec) return;
    switch (cmd.kind) {
      case 'submit_sign': {
        if (cmd.attempt > 1) {
          // A retry is a new request_pause; the guard refuses it while the first is pending.
          this.log(`mitigation ${rec.mitigationId}: retry ${cmd.attempt} not sent; the guard rejects requests while a sign call is pending`);
          return;
        }
        rec.nearTxHash = `mock_${keccak(concatBytes(utf8(rec.payloadHash), Uint8Array.of(cmd.attempt))).slice(2, 46)}`;
        this.apply(c, { kind: 'sign_submitted', nearTxHash: rec.nearTxHash, nowMs: this.now() });
        this.later(this.timing.signatureMs, () => {
          const response = this.mockSignature(rec.payloadHash);
          const cb = onSignature(this.guard, rec.mitigationId, response, keccakBytes);
          if (!cb.ok || !cb.value.signedTx || response === 'failed' || response.scheme !== 'Secp256k1') {
            rec.error = cb.ok ? (cb.value.mitigation.error ?? 'no signed tx') : cb.error;
            this.log(`aegis-guard: on_signature failed for ${rec.mitigationId}: ${rec.error}`);
            return;
          }
          this.guard = cb.value.state;
          rec.guardSignedTx = cb.value.signedTx;
          const sig = toEcdsa(response.big_r.affine_point, response.s.scalar, response.recovery_id);
          if (!sig.ok) return;
          this.log(`aegis-guard: on_signature -> signed (mock MPC; r has a leading zero byte, encoded canonically as ${Math.ceil(sig.value.r.toString(16).length / 2)} bytes)`);
          this.apply(c, { kind: 'signature_received', signature: sig.value, nowMs: this.now() });
        });
        return;
      }
      case 'broadcast': {
        const signed = encodeEip1559Signed(rec.intent, cmd.signature);
        if (!signed.ok) {
          rec.error = signed.error.message;
          return;
        }
        // Defense in depth: the bytes broadcast must equal what the guard produced.
        const guardBytes = rec.guardSignedTx ? hexToBytes(rec.guardSignedTx) : undefined;
        if (!guardBytes || !guardBytes.ok || bytesToHex(guardBytes.value) !== bytesToHex(signed.value)) {
          rec.error = 'signed transaction differs from the guard output';
          this.log(`BUG: ${rec.error} (${rec.mitigationId})`);
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
