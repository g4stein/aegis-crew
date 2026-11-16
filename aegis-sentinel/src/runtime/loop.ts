// Sentinel runtime loop. Owns the 500 ms fast path (Requirement 2.1):
//   read_state -> evaluate -> encode -> gate -> submit_sign
// Every decision is a pure core function; this file only sequences calls through the
// ChainStateClient port. No LLM is involved.
//
// Environment-neutral: no Node or DOM APIs and no environment reads. Two hosts run it:
//   runtime/sentinel.ts               Node process, MCP stdio client, serves /api
//   adapters/feed/browser-runtime.ts  the dashboard tab, in-process mock chain (static hosting)
import { bytesToHex } from '../core/bytes';
import type { ChainStateClient, RuntimeHost } from '../core/chain';
import type { GuardedEntry } from '../core/config';
import { intentFromPayload, planFastPath, reevaluate } from '../core/fastpath';
import { approveSignRequest } from '../core/mitigation/gate';
import { encodeEip1559Unsigned } from '../core/mitigation/payload';
import type { Allowlist } from '../core/mitigation/types';
import type { ContractSnapshot, LogEvent, LogLevel, SentinelSnapshot } from '../core/model';
import { encodeSnapshot, type ChainContractStatus, type MitigationStatus } from '../core/wire';

export const BUDGET_MS = 500;
const MAX_STATE_AGE_MS = 2_000;
const MAX_EVENTS = 60;

export interface LoopOptions {
  readonly entries: readonly GuardedEntry[];
  readonly host: RuntimeHost;
  /** Opens a chain-state connection. Called at start and on every restart. */
  readonly connect: () => Promise<ChainStateClient>;
  /** Logged after each successful connect. */
  readonly connectedMessage: string;
  readonly pollMs: number;
  readonly now: () => number;
  readonly keccakHex: (bytes: Uint8Array) => string;
  /** Optional mirror of every log line (the Node host writes them to stderr). */
  readonly sink?: (level: LogLevel, message: string) => void;
}

interface Tracked {
  readonly mitigationId: string;
  readonly breachId: string;
  readonly t0: number;
  readonly signRequestSubmitted: number;
  readonly nearTxHash?: string;
  status?: MitigationStatus;
}

export class SentinelLoop {
  private client?: ChainStateClient;
  private readonly allowlist: Allowlist;
  private latest = new Map<string, { status: ChainContractStatus; readAtMs: number }>();
  private tracked = new Map<string, Tracked>();
  private submitted = new Set<string>();
  private noted = new Set<string>();
  private events: LogEvent[] = [];
  private seq = 0;
  private failures = 0;
  private snapshotJson = '';
  private readonly listeners = new Set<(json: string) => void>();
  private stopped = false;
  private wake?: () => void;

  constructor(private readonly opts: LoopOptions) {
    this.allowlist = new Map(opts.entries.map((e) => [e.guarded.contractId, e.guarded] as const));
  }

  log(level: LogLevel, message: string): void {
    this.seq += 1;
    this.events = [{ seq: this.seq, atMs: this.opts.now(), level, message }, ...this.events].slice(0, MAX_EVENTS);
    this.opts.sink?.(level, message);
  }

  private noteOnce(key: string, level: LogLevel, message: string): void {
    if (this.noted.has(key)) return;
    this.noted.add(key);
    this.log(level, message);
  }

  async connect(): Promise<void> {
    this.client = await this.opts.connect();
    this.log('info', this.opts.connectedMessage);
  }

  async restart(): Promise<void> {
    const old = this.client;
    this.client = undefined;
    await old?.close();
    this.latest = new Map();
    this.tracked = new Map();
    this.submitted = new Set();
    this.noted = new Set();
    this.failures = 0;
    this.log('info', 'restarting mock chain');
    await this.connect();
  }

  onSnapshot(fn: (json: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  currentJson(): string {
    return this.snapshotJson;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      const started = this.opts.now();
      await this.pollOnce().catch((e: unknown) => this.log('critical', `poll failed: ${e instanceof Error ? e.message : String(e)}`));
      this.publish();
      if (this.stopped) break;
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.max(0, this.opts.pollMs - (this.opts.now() - started)));
        this.wake = () => {
          clearTimeout(t);
          r();
        };
      });
      this.wake = undefined;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    const c = this.client;
    this.client = undefined;
    await c?.close();
  }

  private async pollOnce(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const now = this.opts.now;

    // 1. read_state
    const read = await client.readState();
    if (!read.ok) {
      this.failures += 1;
      this.noteOnce(`read-fail-${this.failures > 5 ? 'many' : 'first'}`, 'critical', `read_state failed: ${read.error}`);
      if (this.failures === 5) await this.restart().catch(() => undefined);
      return;
    }
    this.failures = 0;
    const tRead = now();

    for (const status of read.value.contracts) {
      this.latest.set(status.contractId, { status, readAtMs: read.value.readAtMs });

      // 2. evaluate (pure). t0 is the moment the core reports the breach.
      const decision = planFastPath({ status, readAtMs: read.value.readAtMs, nowMs: now(), maxStateAgeMs: MAX_STATE_AGE_MS, submitted: this.submitted });
      const t0 = now();
      if (decision.kind === 'none') {
        if (decision.reason === 'no_breach_id') this.noteOnce(`nobid-${status.contractId}`, 'warn', `${status.contractId}: breach without breach_id; cannot request a pause`);
        continue;
      }
      if (decision.kind === 'reread') {
        this.noteOnce(`stale-${decision.breachId}`, 'warn', `${status.contractId}: state older than ${MAX_STATE_AGE_MS} ms; re-reading before mitigating (2.14)`);
        continue;
      }
      this.log('critical', `INVARIANT BREACHED ${decision.invariantId} on ${status.contractId} (breach ${decision.breachId})`);
      await this.fastPath(client, status.contractId, decision.breachId, t0, tRead);
    }

    // Mirror mitigation progress from the server (signature, broadcast, confirmation).
    for (const t of this.tracked.values()) {
      if (t.status?.state === 'confirmed' || t.status?.state === 'failed') continue;
      const s = await client.mitigationStatus(t.mitigationId);
      if (!s.ok) continue;
      const before = t.status?.state;
      t.status = s.value;
      if (before !== s.value.state) {
        const level: LogLevel = s.value.state === 'confirmed' ? 'info' : s.value.state === 'failed' ? 'critical' : 'warn';
        this.log(level, `${t.mitigationId}: ${s.value.state.replace('_', ' ')}${s.value.targetTxHash ? ` (target tx ${s.value.targetTxHash.slice(0, 12)}…)` : ''}`);
      }
    }
  }

  /** encode -> gate -> submit_sign. Refuses to submit if the server's payload does not check out. */
  private async fastPath(client: ChainStateClient, contractId: string, breachId: string, t0: number, tRead: number): Promise<void> {
    const now = this.opts.now;
    this.submitted.add(breachId);
    const dry = await client.requestPause(contractId, breachId, true);
    if (!dry.ok) {
      this.submitted.delete(breachId);
      this.log('critical', `dry run failed: ${dry.error}`);
      return;
    }
    if (dry.value.status === 'refused' || !dry.value.payload) {
      if (dry.value.refusalReason === 'breach_not_current') this.submitted.delete(breachId);
      const why = dry.value.refusalReason === 'guard_rejected' ? `Aegis Guard rejected: ${dry.value.guardReason ?? 'unknown'}` : (dry.value.refusalReason ?? 'no payload');
      this.log(dry.value.refusalReason === 'guard_rejected' ? 'critical' : 'warn', `server refused pause for ${contractId}: ${why}`);
      return;
    }
    const p = dry.value.payload;

    // 3. encode: rebuild the transaction from the server's fields and check its bytes and hash.
    const intent = intentFromPayload(contractId, p);
    if (!intent.ok) return this.log('critical', `refusing to submit: ${intent.error}`);
    const unsigned = encodeEip1559Unsigned(intent.value);
    if (!unsigned.ok) return this.log('critical', `refusing to submit: ${unsigned.error.message}`);
    if (bytesToHex(unsigned.value) !== p.unsignedTx.toLowerCase() || this.opts.keccakHex(unsigned.value) !== p.payloadHash.toLowerCase()) {
      return this.log('critical', 'refusing to submit: server payload does not match its own fields');
    }
    const tEncode = now();

    // 4. gate: the runtime's own allowlist, target, chain, selector, and value checks (2.8, 2.9).
    const gate = approveSignRequest(intent.value, this.allowlist);
    if (!gate.ok) return this.log('critical', `refusing to submit: gate ${gate.error.reason}`);
    const tGate = now();

    // 5. submit_sign
    const sub = await client.requestPause(contractId, breachId, false);
    const ack = now();
    if (!sub.ok) {
      this.submitted.delete(breachId);
      return this.log('critical', `submit failed: ${sub.error}`);
    }
    if (sub.value.status !== 'submitted' || !sub.value.mitigationId) {
      return this.log('critical', `server refused submission: ${sub.value.refusalReason ?? sub.value.status}${sub.value.guardReason ? ` (${sub.value.guardReason})` : ''}`);
    }
    if (sub.value.payload?.payloadHash !== p.payloadHash) this.log('critical', 'server signed a different payload than the one verified');

    this.tracked.set(contractId, {
      mitigationId: sub.value.mitigationId,
      breachId,
      t0,
      signRequestSubmitted: ack,
      ...(sub.value.signRequest?.nearTxHash ? { nearTxHash: sub.value.signRequest.nearTxHash } : {}),
    });
    const total = ack - t0;
    const stages = `read ${Math.max(0, t0 - tRead)} · encode ${tEncode - t0} · gate ${tGate - tEncode} · submit ${ack - tGate} ms`;
    this.log(total <= BUDGET_MS ? 'warn' : 'critical', `fast path detect-to-submit ${total} ms of ${BUDGET_MS} ms (${stages}); server detect-to-submit ${sub.value.timings?.detectToSubmit ?? '?'} ms`);
    const sr = sub.value.signRequest;
    if (sr?.guardContract) {
      this.log('warn', `${sr.guardContract} enforced ${sr.guardChecks?.length ?? 0} checks and paid ${sr.depositYoctonear ?? '?'} yoctoNEAR to ${sr.mpcContract ?? 'MPC'}.sign`);
    }
  }

  snapshot(): SentinelSnapshot {
    const contracts: ContractSnapshot[] = [];
    for (const { status, readAtMs } of this.latest.values()) {
      const t = this.tracked.get(status.contractId);
      const st = t?.status;
      contracts.push({
        contractId: status.contractId,
        chain: status.chain,
        address: status.address as `0x${string}`,
        blockNumber: status.blockNumber,
        readAtMs,
        paused: status.paused,
        invariants: reevaluate(status.invariants),
        mitigation: t
          ? {
              state: st?.state ?? 'pending_signature',
              id: t.mitigationId,
              attempts: 1,
              ...(t.nearTxHash ? { nearTxHash: t.nearTxHash } : {}),
              ...(st?.targetTxHash ? { targetTxHash: st.targetTxHash } : {}),
              timeline: {
                t0: t.t0,
                signRequestSubmitted: t.signRequestSubmitted,
                ...(st?.timings.signatureReceived ? { signatureReceived: st.timings.signatureReceived } : {}),
                ...(st?.timings.broadcast ? { broadcast: st.timings.broadcast } : {}),
                ...(st?.timings.confirmed ? { confirmed: st.timings.confirmed } : {}),
              },
            }
          : { state: status.mitigation.state, attempts: 0, timeline: {} },
      });
    }
    const p = this.opts.entries[0]?.provenance;
    return {
      network: `MOCK CHAIN / ${this.opts.entries[0]?.chain ?? '—'}`,
      mode: 'mock',
      budgetMs: BUDGET_MS,
      contracts,
      events: this.events,
      source: {
        kind: 'live-mock',
        link: 'open',
        host: this.opts.host,
        ...(p ? { invariantsFile: p.invariantsFile, invariantsSha256: p.invariantsSha256, sourceSha256: p.sourceSha256 } : {}),
      },
    };
  }

  private publish(): void {
    const json = JSON.stringify(encodeSnapshot(this.snapshot()));
    if (json === this.snapshotJson) return;
    this.snapshotJson = json;
    for (const l of this.listeners) l(json);
  }
}
