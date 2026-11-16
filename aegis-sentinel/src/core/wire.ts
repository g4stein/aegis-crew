// Wire formats (trust boundary). Pure: validate untrusted JSON into core types and back.
// bigint values travel as decimal strings. Field names follow .kiro/mcp/chain-state-mcp.json.
import type { InvariantReading, LogEvent, Mitigation, MitigationState, SentinelSnapshot, ContractSnapshot, FeedSource } from './model';
import { err, ok, type Result } from './result';

type Obj = Record<string, unknown>;
type R<T> = Result<T, string>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const DEC = /^-?[0-9]+$/;
const UDEC = /^[0-9]+$/;
const HEX = /^0x[0-9a-fA-F]*$/;
const MIT_STATES: readonly MitigationState[] = ['none', 'pending_signature', 'signed', 'broadcast', 'confirmed', 'failed', 'refused'];

function field<T>(o: Obj, k: string, at: string, check: (v: unknown) => v is T, what: string): R<T> {
  const v = o[k];
  return check(v) ? ok(v) : err(`${at}.${k}: expected ${what}`);
}
function opt<T>(o: Obj, k: string, at: string, check: (v: unknown) => v is T, what: string): R<T | undefined> {
  return o[k] === undefined ? ok(undefined) : field(o, k, at, check, what);
}
const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isDec = (v: unknown): v is string => typeof v === 'string' && DEC.test(v) && v.length <= 80;
const isUDec = (v: unknown): v is string => typeof v === 'string' && UDEC.test(v) && v.length <= 80;
const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);

/** Collects results; returns the first error. */
function all<T>(rs: R<T>[]): R<T[]> {
  const out: T[] = [];
  for (const r of rs) {
    if (!r.ok) return r;
    out.push(r.value);
  }
  return ok(out);
}

/** Drops undefined values, so optional fields are absent rather than `undefined`. */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// ---- Chain readout: get_contract_invariants ---------------------------------------------

export interface ChainMitigation {
  readonly state: MitigationState;
  readonly mitigationId?: string;
  readonly signatureTimeoutMs?: number;
}

export interface ChainContractStatus {
  readonly contractId: string;
  readonly chain: string;
  readonly address: string;
  readonly blockNumber: bigint;
  readonly paused: boolean;
  readonly invariants: readonly InvariantReading[];
  readonly mitigation: ChainMitigation;
}

export interface ChainReadout {
  readonly readAtMs: number;
  readonly contracts: readonly ChainContractStatus[];
}

function decodeReading(v: unknown, at: string): R<InvariantReading> {
  if (!isObj(v)) return err(`${at}: expected object`);
  const id = field(v, 'id', at, isStr, 'string');
  const requirement = field(v, 'requirement', at, isStr, 'string');
  const status = field(v, 'status', at, (x): x is 'holding' | 'breached' => x === 'holding' || x === 'breached', '"holding" | "breached"');
  const expected = field(v, 'expected', at, isDec, 'decimal string');
  const observed = field(v, 'observed', at, isDec, 'decimal string');
  const label = opt(v, 'label', at, isStr, 'string');
  const breachId = opt(v, 'breach_id', at, isStr, 'string');
  const detectedAtMs = opt(v, 'detected_at_ms', at, isInt, 'integer');
  for (const r of [id, requirement, status, expected, observed, label, breachId, detectedAtMs]) if (!r.ok) return r;
  return ok(
    compact({
      id: (id as { value: string }).value,
      requirement: (requirement as { value: string }).value,
      label: (label as { value: string | undefined }).value ?? (id as { value: string }).value,
      status: (status as { value: 'holding' | 'breached' }).value,
      expected: BigInt((expected as { value: string }).value),
      observed: BigInt((observed as { value: string }).value),
      breachId: (breachId as { value: string | undefined }).value,
      detectedAtMs: (detectedAtMs as { value: number | undefined }).value,
    }),
  );
}

function encodeReading(r: InvariantReading): Obj {
  return compact({
    id: r.id,
    requirement: r.requirement,
    label: r.label,
    status: r.status,
    expected: r.expected.toString(),
    observed: r.observed.toString(),
    breach_id: r.breachId,
    detected_at_ms: r.detectedAtMs,
  });
}

export function decodeChainReadout(v: unknown): R<ChainReadout> {
  const at = 'get_contract_invariants';
  if (!isObj(v)) return err(`${at}: expected object`);
  const readAtMs = field(v, 'read_at_ms', at, isInt, 'integer');
  const contracts = field(v, 'contracts', at, isArr, 'array');
  if (!readAtMs.ok) return readAtMs;
  if (!contracts.ok) return contracts;
  const decoded = all(
    contracts.value.map((c, i): R<ChainContractStatus> => {
      const cat = `${at}.contracts[${i}]`;
      if (!isObj(c)) return err(`${cat}: expected object`);
      const contractId = field(c, 'contract_id', cat, isStr, 'string');
      const chain = field(c, 'chain', cat, isStr, 'string');
      const address = field(c, 'address', cat, isHex, 'hex address');
      const block = field(c, 'block_number', cat, isUDec, 'decimal string');
      const paused = field(c, 'paused', cat, isBool, 'boolean');
      const invs = field(c, 'invariants', cat, isArr, 'array');
      const mit = field(c, 'mitigation', cat, isObj, 'object');
      for (const r of [contractId, chain, address, block, paused, invs, mit]) if (!r.ok) return r as R<never>;
      const m = (mit as { value: Obj }).value;
      const state = field(m, 'state', `${cat}.mitigation`, (x): x is MitigationState => MIT_STATES.includes(x as MitigationState), 'mitigation state');
      const mitigationId = opt(m, 'mitigation_id', `${cat}.mitigation`, isStr, 'string');
      const timeout = opt(m, 'signature_timeout_ms', `${cat}.mitigation`, isInt, 'integer');
      for (const r of [state, mitigationId, timeout]) if (!r.ok) return r as R<never>;
      const readings = all((invs as { value: unknown[] }).value.map((x, j) => decodeReading(x, `${cat}.invariants[${j}]`)));
      if (!readings.ok) return readings;
      return ok({
        contractId: (contractId as { value: string }).value,
        chain: (chain as { value: string }).value,
        address: (address as { value: string }).value,
        blockNumber: BigInt((block as { value: string }).value),
        paused: (paused as { value: boolean }).value,
        invariants: readings.value,
        mitigation: compact({
          state: (state as { value: MitigationState }).value,
          mitigationId: (mitigationId as { value: string | undefined }).value,
          signatureTimeoutMs: (timeout as { value: number | undefined }).value,
        }),
      });
    }),
  );
  if (!decoded.ok) return decoded;
  return ok({ readAtMs: readAtMs.value, contracts: decoded.value });
}

export function encodeChainReadout(r: ChainReadout): Obj {
  return {
    read_at_ms: r.readAtMs,
    contracts: r.contracts.map((c) => ({
      contract_id: c.contractId,
      chain: c.chain,
      address: c.address,
      block_number: c.blockNumber.toString(),
      paused: c.paused,
      invariants: c.invariants.map(encodeReading),
      mitigation: compact({ state: c.mitigation.state, mitigation_id: c.mitigation.mitigationId, signature_timeout_ms: c.mitigation.signatureTimeoutMs }),
    })),
  };
}

// ---- broadcast_mitigation_payload ----------------------------------------------------------

export type RefusalReason =
  | 'not_allowlisted'
  | 'breach_not_current'
  | 'already_paused'
  | 'mitigation_in_flight'
  | 'state_too_old'
  | 'signer_unavailable'
  | 'guard_rejected';

export interface WirePayload {
  readonly chain: string;
  readonly to: string;
  readonly data: string;
  readonly value: string;
  readonly nonce: string;
  readonly gasLimit: string;
  readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
  readonly unsignedTx: string;
  readonly payloadHash: string;
}

export interface BroadcastResult {
  readonly status: 'submitted' | 'dry_run' | 'refused';
  readonly contractId: string;
  readonly mitigationId?: string;
  readonly refusalReason?: RefusalReason;
  /** Set when refusalReason is guard_rejected: the Aegis Guard rejection code. */
  readonly guardReason?: string;
  readonly payload?: WirePayload;
  readonly signRequest?: {
    readonly mpcContract?: string;
    readonly derivationPath?: string;
    readonly nearTxHash?: string;
    readonly guardContract?: string;
    readonly depositYoctonear?: string;
    readonly guardChecks?: readonly string[];
  };
  readonly timings?: { readonly t0Detected?: number; readonly signRequestSubmitted?: number; readonly detectToSubmit?: number };
}

export function decodeBroadcastResult(v: unknown): R<BroadcastResult> {
  const at = 'broadcast_mitigation_payload';
  if (!isObj(v)) return err(`${at}: expected object`);
  const status = field(v, 'status', at, (x): x is BroadcastResult['status'] => x === 'submitted' || x === 'dry_run' || x === 'refused', 'status');
  const contractId = field(v, 'contract_id', at, isStr, 'string');
  const mitigationId = opt(v, 'mitigation_id', at, isStr, 'string');
  const reason = opt(v, 'refusal_reason', at, isStr, 'string');
  const guardReason = opt(v, 'guard_reason', at, isStr, 'string');
  for (const r of [status, contractId, mitigationId, reason, guardReason]) if (!r.ok) return r as R<never>;

  let payload: WirePayload | undefined;
  if (v.payload !== undefined) {
    if (!isObj(v.payload)) return err(`${at}.payload: expected object`);
    const p = v.payload;
    const pat = `${at}.payload`;
    const fields = {
      chain: field(p, 'chain', pat, isStr, 'string'),
      to: field(p, 'to', pat, isHex, 'hex'),
      data: field(p, 'data', pat, isHex, 'hex'),
      value: field(p, 'value', pat, isUDec, 'decimal string'),
      nonce: field(p, 'nonce', pat, isUDec, 'decimal string'),
      gasLimit: field(p, 'gas_limit', pat, isUDec, 'decimal string'),
      maxFeePerGas: field(p, 'max_fee_per_gas', pat, isUDec, 'decimal string'),
      maxPriorityFeePerGas: field(p, 'max_priority_fee_per_gas', pat, isUDec, 'decimal string'),
      unsignedTx: field(p, 'unsigned_tx', pat, isHex, 'hex'),
      payloadHash: field(p, 'payload_hash', pat, isHex, 'hex'),
    };
    for (const r of Object.values(fields)) if (!r.ok) return r as R<never>;
    payload = Object.fromEntries(Object.entries(fields).map(([k, r]) => [k, (r as { value: string }).value])) as unknown as WirePayload;
  }

  const sr = isObj(v.sign_request) ? v.sign_request : undefined;
  const tm = isObj(v.timings_ms) ? v.timings_ms : undefined;
  const num = (o: Obj | undefined, k: string) => (o && isInt(o[k]) ? (o[k] as number) : undefined);
  const s = (o: Obj | undefined, k: string) => (o && isStr(o[k]) ? (o[k] as string) : undefined);

  return ok(
    compact({
      status: (status as { value: BroadcastResult['status'] }).value,
      contractId: (contractId as { value: string }).value,
      mitigationId: (mitigationId as { value: string | undefined }).value,
      refusalReason: (reason as { value: string | undefined }).value as RefusalReason | undefined,
      guardReason: (guardReason as { value: string | undefined }).value,
      payload,
      signRequest: sr
        ? compact({
            mpcContract: s(sr, 'mpc_contract'),
            derivationPath: s(sr, 'derivation_path'),
            nearTxHash: s(sr, 'near_tx_hash'),
            guardContract: s(sr, 'guard_contract'),
            depositYoctonear: s(sr, 'deposit_yoctonear'),
            guardChecks: Array.isArray(sr.guard_checks) && sr.guard_checks.every(isStr) ? (sr.guard_checks as string[]) : undefined,
          })
        : undefined,
      timings: tm ? compact({ t0Detected: num(tm, 't0_detected'), signRequestSubmitted: num(tm, 'sign_request_submitted'), detectToSubmit: num(tm, 'detect_to_submit') }) : undefined,
    }),
  );
}

export function encodeBroadcastResult(b: BroadcastResult): Obj {
  return compact({
    status: b.status,
    contract_id: b.contractId,
    mitigation_id: b.mitigationId,
    refusal_reason: b.refusalReason,
    guard_reason: b.guardReason,
    payload: b.payload
      ? {
          chain: b.payload.chain,
          to: b.payload.to,
          data: b.payload.data,
          value: b.payload.value,
          nonce: b.payload.nonce,
          gas_limit: b.payload.gasLimit,
          max_fee_per_gas: b.payload.maxFeePerGas,
          max_priority_fee_per_gas: b.payload.maxPriorityFeePerGas,
          unsigned_tx: b.payload.unsignedTx,
          payload_hash: b.payload.payloadHash,
        }
      : undefined,
    sign_request: b.signRequest
      ? compact({
          mpc_contract: b.signRequest.mpcContract,
          derivation_path: b.signRequest.derivationPath,
          near_tx_hash: b.signRequest.nearTxHash,
          guard_contract: b.signRequest.guardContract,
          deposit_yoctonear: b.signRequest.depositYoctonear,
          guard_checks: b.signRequest.guardChecks,
        })
      : undefined,
    timings_ms: b.timings
      ? compact({ t0_detected: b.timings.t0Detected, sign_request_submitted: b.timings.signRequestSubmitted, detect_to_submit: b.timings.detectToSubmit })
      : undefined,
  });
}

// ---- get_mitigation_status ---------------------------------------------------------------

export interface MitigationStatus {
  readonly mitigationId: string;
  readonly contractId?: string;
  readonly state: Exclude<MitigationState, 'none' | 'refused'>;
  readonly targetTxHash?: string;
  readonly error?: string;
  readonly timings: {
    readonly t0Detected?: number;
    readonly signRequestSubmitted?: number;
    readonly signatureReceived?: number;
    readonly broadcast?: number;
    readonly confirmed?: number;
  };
}

const STATUS_STATES = ['pending_signature', 'signed', 'broadcast', 'confirmed', 'failed'] as const;

export function decodeMitigationStatus(v: unknown): R<MitigationStatus> {
  const at = 'get_mitigation_status';
  if (!isObj(v)) return err(`${at}: expected object`);
  const id = field(v, 'mitigation_id', at, isStr, 'string');
  const state = field(v, 'state', at, (x): x is MitigationStatus['state'] => (STATUS_STATES as readonly unknown[]).includes(x), 'state');
  const contractId = opt(v, 'contract_id', at, isStr, 'string');
  const target = opt(v, 'target_tx_hash', at, isHex, 'hex');
  const error = opt(v, 'error', at, isStr, 'string');
  for (const r of [id, state, contractId, target, error]) if (!r.ok) return r as R<never>;
  const tm = isObj(v.timings_ms) ? v.timings_ms : {};
  const num = (k: string) => (isInt(tm[k]) ? (tm[k] as number) : undefined);
  return ok(
    compact({
      mitigationId: (id as { value: string }).value,
      contractId: (contractId as { value: string | undefined }).value,
      state: (state as { value: MitigationStatus['state'] }).value,
      targetTxHash: (target as { value: string | undefined }).value,
      error: (error as { value: string | undefined }).value,
      timings: compact({
        t0Detected: num('t0_detected'),
        signRequestSubmitted: num('sign_request_submitted'),
        signatureReceived: num('signature_received'),
        broadcast: num('broadcast'),
        confirmed: num('confirmed'),
      }),
    }),
  );
}

export function encodeMitigationStatus(s: MitigationStatus): Obj {
  return compact({
    mitigation_id: s.mitigationId,
    contract_id: s.contractId,
    state: s.state,
    target_tx_hash: s.targetTxHash,
    error: s.error,
    timings_ms: compact({
      t0_detected: s.timings.t0Detected,
      sign_request_submitted: s.timings.signRequestSubmitted,
      signature_received: s.timings.signatureReceived,
      broadcast: s.timings.broadcast,
      confirmed: s.timings.confirmed,
    }),
  });
}

// ---- Dashboard snapshot (runtime -> browser over SSE) ------------------------------------------

export function encodeSnapshot(s: SentinelSnapshot): Obj {
  return compact({
    network: s.network,
    mode: s.mode,
    budget_ms: s.budgetMs,
    source: s.source,
    events: s.events,
    contracts: s.contracts.map((c) => ({
      contract_id: c.contractId,
      chain: c.chain,
      address: c.address,
      block_number: c.blockNumber.toString(),
      read_at_ms: c.readAtMs,
      paused: c.paused,
      invariants: c.invariants.map(encodeReading),
      mitigation: compact({
        state: c.mitigation.state,
        id: c.mitigation.id,
        attempts: c.mitigation.attempts,
        near_tx_hash: c.mitigation.nearTxHash,
        target_tx_hash: c.mitigation.targetTxHash,
        timeline: compact({ ...c.mitigation.timeline }),
      }),
    })),
  });
}

const TIMELINE_KEYS = ['t0', 'signRequestSubmitted', 'signatureReceived', 'broadcast', 'confirmed'] as const;

export function decodeSnapshot(v: unknown): R<SentinelSnapshot> {
  const at = 'snapshot';
  if (!isObj(v)) return err(`${at}: expected object`);
  const network = field(v, 'network', at, isStr, 'string');
  const mode = field(v, 'mode', at, (x): x is 'mock' | 'live' => x === 'mock' || x === 'live', '"mock" | "live"');
  const budget = field(v, 'budget_ms', at, isInt, 'integer');
  const contracts = field(v, 'contracts', at, isArr, 'array');
  const events = field(v, 'events', at, isArr, 'array');
  for (const r of [network, mode, budget, contracts, events]) if (!r.ok) return r as R<never>;

  let source: FeedSource | undefined;
  if (v.source !== undefined) {
    if (!isObj(v.source)) return err(`${at}.source: expected object`);
    const kind = v.source.kind;
    const link = v.source.link;
    if ((kind !== 'scripted' && kind !== 'live-mock') || (link !== 'connecting' && link !== 'open' && link !== 'lost')) return err(`${at}.source: bad kind or link`);
    source = compact<FeedSource>({
      kind: kind as FeedSource['kind'],
      link: link as FeedSource['link'],
      host: v.source.host === 'node' || v.source.host === 'browser' ? v.source.host : undefined,
      invariantsFile: isStr(v.source.invariantsFile) ? v.source.invariantsFile : undefined,
      invariantsSha256: isStr(v.source.invariantsSha256) ? v.source.invariantsSha256 : undefined,
      sourceSha256: isStr(v.source.sourceSha256) ? v.source.sourceSha256 : undefined,
    });
  }

  const evs = all(
    (events as { value: unknown[] }).value.map((e, i): R<LogEvent> => {
      const eat = `${at}.events[${i}]`;
      if (!isObj(e) || !isInt(e.seq) || !isInt(e.atMs) || !isStr(e.message) || !['info', 'warn', 'critical'].includes(e.level as string)) return err(`${eat}: bad event`);
      return ok({ seq: e.seq, atMs: e.atMs, level: e.level as LogEvent['level'], message: e.message });
    }),
  );
  if (!evs.ok) return evs;

  const cs = all(
    (contracts as { value: unknown[] }).value.map((c, i): R<ContractSnapshot> => {
      const cat = `${at}.contracts[${i}]`;
      if (!isObj(c)) return err(`${cat}: expected object`);
      const contractId = field(c, 'contract_id', cat, isStr, 'string');
      const chain = field(c, 'chain', cat, isStr, 'string');
      const address = field(c, 'address', cat, (x): x is `0x${string}` => isHex(x), 'hex');
      const block = field(c, 'block_number', cat, isUDec, 'decimal string');
      const readAt = field(c, 'read_at_ms', cat, isInt, 'integer');
      const paused = field(c, 'paused', cat, isBool, 'boolean');
      const invs = field(c, 'invariants', cat, isArr, 'array');
      const mit = field(c, 'mitigation', cat, isObj, 'object');
      for (const r of [contractId, chain, address, block, readAt, paused, invs, mit]) if (!r.ok) return r as R<never>;
      const m = (mit as { value: Obj }).value;
      if (!MIT_STATES.includes(m.state as MitigationState) || !isInt(m.attempts)) return err(`${cat}.mitigation: bad state or attempts`);
      const tl = isObj(m.timeline) ? m.timeline : {};
      const timeline: Record<string, number> = {};
      for (const k of TIMELINE_KEYS) if (tl[k] !== undefined) {
        if (!isInt(tl[k])) return err(`${cat}.mitigation.timeline.${k}: expected integer`);
        timeline[k] = tl[k] as number;
      }
      const readings = all((invs as { value: unknown[] }).value.map((x, j) => decodeReading(x, `${cat}.invariants[${j}]`)));
      if (!readings.ok) return readings;
      const mitigation: Mitigation = compact({
        state: m.state as MitigationState,
        attempts: m.attempts,
        id: isStr(m.id) ? m.id : undefined,
        nearTxHash: isStr(m.near_tx_hash) ? m.near_tx_hash : undefined,
        targetTxHash: isStr(m.target_tx_hash) ? m.target_tx_hash : undefined,
        timeline,
      });
      return ok({
        contractId: (contractId as { value: string }).value,
        chain: (chain as { value: string }).value,
        address: (address as { value: `0x${string}` }).value,
        blockNumber: BigInt((block as { value: string }).value),
        readAtMs: (readAt as { value: number }).value,
        paused: (paused as { value: boolean }).value,
        invariants: readings.value,
        mitigation,
      });
    }),
  );
  if (!cs.ok) return cs;

  return ok(
    compact({
      network: (network as { value: string }).value,
      mode: (mode as { value: 'mock' | 'live' }).value,
      budgetMs: (budget as { value: number }).value,
      contracts: cs.value,
      events: evs.value,
      source,
    }),
  );
}
