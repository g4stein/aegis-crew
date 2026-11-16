// Aegis Guard mirror (Requirements 2.5, 2.7–2.10, 2.12). Pure.
// Same checks, in the same order, as contracts/aegis-guard/src/lib.rs. The mock chain runs
// this mirror so LIVE-MOCK exercises the guard's rules without a NEAR node.
// Conformance: tests/pbt/guard.pbt.test.ts replays tests/vectors/aegis-guard.json, which the
// Rust contract's own unit tests generate and check.
//
// keccak256 is injected so the core imports no hashing library.
import { bytesToHex, hexToBytes } from './bytes';
import { encodeEip1559Signed, encodeEip1559Unsigned } from './mitigation/payload';
import { PAUSE_SELECTOR, type EcdsaSignature, type PauseIntent } from './mitigation/types';
import { err, ok, type Result } from './result';

export type Keccak = (bytes: Uint8Array) => Uint8Array;

export const ECDSA_DOMAIN_ID = 0;
export const GUARD_CHECKS = [
  'ids_valid',
  'allowlisted',
  'not_in_flight',
  'not_duplicate',
  'rate_limit',
  'fee_quote_present',
  'fee_quote_fresh',
  'target_is_allowlisted_address',
  'chain_matches',
  'calldata_is_pause_selector',
  'value_is_zero',
  'fee_within_cap',
  'guard_balance_covers_deposit',
] as const;

export type GuardRejection =
  | 'not_sentinel'
  | 'invalid_id'
  | 'not_allowlisted'
  | 'mitigation_in_flight'
  | 'duplicate_breach'
  | 'rate_limited'
  | 'no_fee_quote'
  | 'fee_quote_stale'
  | 'target_mismatch'
  | 'chain_mismatch'
  | 'selector_mismatch'
  | 'nonzero_value'
  | 'access_list_not_empty'
  | 'fee_quote_invalid'
  | 'fee_above_cap'
  | 'insufficient_balance';

export interface GuardConfig {
  readonly owner: string;
  readonly sentinel: string;
  readonly feeOracle: string;
  readonly mpcContract: string;
  readonly guardAccount: string;
  readonly signDepositYocto: bigint;
  readonly signGasTgas: number;
  readonly maxQuoteAgeBlocks: bigint;
}

export interface GuardEntry {
  readonly contractId: string;
  readonly chainId: bigint;
  readonly address: string;
  readonly derivationPath: string;
  readonly gasLimit: bigint;
  readonly maxFeePerGasCap: bigint;
  readonly maxPriorityFeePerGasCap: bigint;
  readonly minIntervalBlocks: bigint;
}

export interface FeeQuote {
  readonly nonce: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly quotedAtBlock: bigint;
}

export type GuardMitigationStatus = 'pending' | 'signed' | 'failed';

export interface GuardMitigation {
  readonly mitigationId: string;
  readonly contractId: string;
  readonly breachId: string;
  readonly status: GuardMitigationStatus;
  readonly requestedAtBlock: bigint;
  readonly intent: PauseIntent;
  readonly derivationPath: string;
  readonly unsignedTx: string;
  readonly payloadHash: string;
  readonly depositYocto: bigint;
  readonly signedTx?: string;
  readonly signedTxHash?: string;
  readonly error?: string;
}

export interface GuardState {
  readonly config: GuardConfig;
  readonly guarded: ReadonlyMap<string, GuardEntry>;
  readonly quotes: ReadonlyMap<string, FeeQuote>;
  readonly mitigations: ReadonlyMap<string, GuardMitigation>;
  readonly active: ReadonlyMap<string, string>;
  readonly lastRequestBlock: ReadonlyMap<string, bigint>;
}

export interface SignCall {
  readonly receiver: string;
  readonly method: 'sign';
  readonly depositYocto: bigint;
  readonly gasTgas: number;
  readonly args: { readonly request: { readonly path: string; readonly payload_v2: { readonly Ecdsa: string }; readonly domain_id: number } };
}

export interface PausePlan {
  readonly mitigationId: string;
  readonly entry: GuardEntry;
  readonly intent: PauseIntent;
  readonly unsignedTx: string;
  readonly payloadHash: string;
}

export function initialGuardState(config: GuardConfig, entries: readonly GuardEntry[]): GuardState {
  return {
    config,
    guarded: new Map(entries.map((e) => [e.contractId, { ...e, address: e.address.toLowerCase() }] as const)),
    quotes: new Map(),
    mitigations: new Map(),
    active: new Map(),
    lastRequestBlock: new Map(),
  };
}

const CONTRACT_ID = /^[a-z0-9-]{1,64}$/;
const BREACH_ID = /^[A-Za-z0-9_-]{1,63}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const guardMitigationId = (contractId: string, breachId: string) => `${contractId}_${breachId}`;

/** On-chain enforcement of the built transaction. Same order as `enforce` in the contract. */
export function enforceIntent(entry: GuardEntry, tx: PauseIntent): Result<void, GuardRejection> {
  if (!ADDRESS.test(entry.address) || tx.to.toLowerCase() !== entry.address.toLowerCase()) return err('target_mismatch');
  if (tx.chainId !== entry.chainId) return err('chain_mismatch');
  if (tx.data.toLowerCase() !== PAUSE_SELECTOR) return err('selector_mismatch');
  if (tx.value !== 0n) return err('nonzero_value');
  if (tx.maxPriorityFeePerGas > tx.maxFeePerGas) return err('fee_quote_invalid');
  if (tx.maxFeePerGas > entry.maxFeePerGasCap || tx.maxPriorityFeePerGas > entry.maxPriorityFeePerGasCap) return err('fee_above_cap');
  return ok(undefined);
}

function intentFor(entry: GuardEntry, q: FeeQuote): PauseIntent {
  return {
    contractId: entry.contractId,
    chainId: entry.chainId,
    nonce: q.nonce,
    maxFeePerGas: q.maxFeePerGas,
    maxPriorityFeePerGas: q.maxPriorityFeePerGas,
    gasLimit: entry.gasLimit,
    to: entry.address.toLowerCase(),
    value: 0n,
    data: PAUSE_SELECTOR,
  };
}

export interface PlanInput {
  readonly contractId: string;
  readonly breachId: string;
  readonly blockHeight: bigint;
  /** Guard balance minus storage cost, in yoctoNEAR. */
  readonly availableYocto: bigint;
}

/** Every check `request_pause` runs except the caller check. Reads state only. */
export function planPause(s: GuardState, i: PlanInput, keccak: Keccak): Result<PausePlan, GuardRejection> {
  if (!CONTRACT_ID.test(i.contractId) || !BREACH_ID.test(i.breachId)) return err('invalid_id');
  const entry = s.guarded.get(i.contractId);
  if (!entry) return err('not_allowlisted');
  if (s.active.has(i.contractId)) return err('mitigation_in_flight');
  const id = guardMitigationId(i.contractId, i.breachId);
  if (s.mitigations.has(id)) return err('duplicate_breach');
  const last = s.lastRequestBlock.get(i.contractId);
  if (last !== undefined && i.blockHeight - last < entry.minIntervalBlocks) return err('rate_limited');
  const q = s.quotes.get(i.contractId);
  if (!q) return err('no_fee_quote');
  if (i.blockHeight - q.quotedAtBlock > s.config.maxQuoteAgeBlocks) return err('fee_quote_stale');
  const intent = intentFor(entry, q);
  const enforced = enforceIntent(entry, intent);
  if (!enforced.ok) return enforced;
  if (i.availableYocto < s.config.signDepositYocto) return err('insufficient_balance');
  const unsigned = encodeEip1559Unsigned(intent);
  if (!unsigned.ok) return err('fee_quote_invalid');
  return ok({ mitigationId: id, entry, intent, unsignedTx: bytesToHex(unsigned.value), payloadHash: bytesToHex(keccak(unsigned.value)) });
}

export function updateFeeQuote(
  s: GuardState,
  i: { readonly predecessor: string; readonly contractId: string; readonly nonce: bigint; readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint; readonly blockHeight: bigint },
): Result<GuardState, string> {
  if (i.predecessor !== s.config.feeOracle) return err('only the fee oracle');
  if (!s.guarded.has(i.contractId)) return err('not_allowlisted');
  const quotes = new Map(s.quotes);
  quotes.set(i.contractId, { nonce: i.nonce, maxFeePerGas: i.maxFeePerGas, maxPriorityFeePerGas: i.maxPriorityFeePerGas, quotedAtBlock: i.blockHeight });
  return ok({ ...s, quotes });
}

export interface RequestOutcome {
  readonly state: GuardState;
  readonly mitigation: GuardMitigation;
  readonly signCall: SignCall;
}

/** `request_pause(contract_id, breach_id)`. On rejection the state is unchanged. */
export function requestPause(s: GuardState, i: PlanInput & { readonly predecessor: string }, keccak: Keccak): Result<RequestOutcome, GuardRejection> {
  if (i.predecessor !== s.config.sentinel) return err('not_sentinel');
  const plan = planPause(s, i, keccak);
  if (!plan.ok) return plan;
  const p = plan.value;
  const mitigation: GuardMitigation = {
    mitigationId: p.mitigationId,
    contractId: i.contractId,
    breachId: i.breachId,
    status: 'pending',
    requestedAtBlock: i.blockHeight,
    intent: p.intent,
    derivationPath: p.entry.derivationPath,
    unsignedTx: p.unsignedTx,
    payloadHash: p.payloadHash,
    depositYocto: s.config.signDepositYocto,
  };
  const mitigations = new Map(s.mitigations);
  mitigations.set(p.mitigationId, mitigation);
  const active = new Map(s.active);
  active.set(i.contractId, p.mitigationId);
  const lastRequestBlock = new Map(s.lastRequestBlock);
  lastRequestBlock.set(i.contractId, i.blockHeight);
  const signCall: SignCall = {
    receiver: s.config.mpcContract,
    method: 'sign',
    depositYocto: s.config.signDepositYocto,
    gasTgas: s.config.signGasTgas,
    args: { request: { path: p.entry.derivationPath, payload_v2: { Ecdsa: p.payloadHash.slice(2) }, domain_id: ECDSA_DOMAIN_ID } },
  };
  return ok({ state: { ...s, mitigations, active, lastRequestBlock }, mitigation, signCall });
}

/** MPC `sign` response (near/mpc SignatureResponse JSON), or `'failed'` for a failed promise. */
export type MpcSignResult =
  | { readonly scheme: 'Secp256k1'; readonly big_r: { readonly affine_point: string }; readonly s: { readonly scalar: string }; readonly recovery_id: number }
  | { readonly scheme: 'Ed25519'; readonly signature: unknown }
  | 'failed';

/** Same conversion as `to_ecdsa` in the contract. */
export function toEcdsa(bigR: string, s: string, recoveryId: number): Result<EcdsaSignature, string> {
  const point = hexToBytes(`0x${bigR.replace(/^0x/, '')}`);
  if (!point.ok || point.value.length !== 33) return err('bad_big_r');
  const sb = hexToBytes(`0x${s.replace(/^0x/, '')}`);
  if (!sb.ok || sb.value.length !== 32) return err('bad_s');
  const prefix = point.value[0];
  const parity = prefix === 0x02 ? 0 : prefix === 0x03 ? 1 : -1;
  if (parity < 0) return err('bad_big_r_prefix');
  if (recoveryId !== parity) return err('recovery_id_mismatch');
  let r = 0n;
  for (const b of point.value.subarray(1)) r = (r << 8n) | BigInt(b);
  let sv = 0n;
  for (const b of sb.value) sv = (sv << 8n) | BigInt(b);
  return ok({ yParity: parity as 0 | 1, r, s: sv });
}

export interface SignatureOutcome {
  readonly state: GuardState;
  readonly mitigation: GuardMitigation;
  readonly signedTx?: string;
}

/** `on_signature` callback. Builds the signed transaction with the canonical encoder. */
export function onSignature(s: GuardState, mitigationId: string, result: MpcSignResult, keccak: Keccak): Result<SignatureOutcome, string> {
  const m = s.mitigations.get(mitigationId);
  if (!m) return err('unknown mitigation');
  if (m.status !== 'pending') return err('mitigation is not pending');
  let sig: Result<EcdsaSignature, string>;
  if (result === 'failed') sig = err('mpc_sign_failed');
  else if (result.scheme === 'Secp256k1') sig = toEcdsa(result.big_r.affine_point, result.s.scalar, result.recovery_id);
  else sig = err('unexpected_ed25519_signature');

  let next: GuardMitigation;
  let signedTx: string | undefined;
  if (sig.ok) {
    const signed = encodeEip1559Signed(m.intent, sig.value);
    if (!signed.ok) return err(signed.error.message);
    signedTx = bytesToHex(signed.value);
    next = { ...m, status: 'signed', signedTx, signedTxHash: bytesToHex(keccak(signed.value)) };
  } else {
    next = { ...m, status: 'failed', error: sig.error };
  }
  const mitigations = new Map(s.mitigations);
  mitigations.set(mitigationId, next);
  const active = new Map(s.active);
  active.delete(m.contractId);
  return ok({ state: { ...s, mitigations, active }, mitigation: next, ...(signedTx ? { signedTx } : {}) });
}
