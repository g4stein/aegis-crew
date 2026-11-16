// Fast-path decisions for the Sentinel runtime (Requirements 2.1, 2.12–2.14). Pure.
// The runtime reads chain state, calls these functions, and acts. No LLM is involved.
import { hexToBytes } from './bytes';
import { IN_FLIGHT_STATES, type InvariantReading } from './model';
import type { PauseIntent } from './mitigation/types';
import { err, ok, type Result } from './result';
import type { ChainContractStatus, WirePayload } from './wire';

/**
 * Recomputes each reading's status from its expected and observed values instead of trusting
 * the server's `status` field. Unknown invariant kinds keep the reported status.
 */
export function reevaluate(readings: readonly InvariantReading[]): InvariantReading[] {
  return readings.map((r) => {
    let breached: boolean;
    if (r.id === 'balance-conservation') breached = r.observed !== r.expected;
    else if (r.id === 'non-negative-balances') breached = r.observed < 0n;
    else breached = r.status === 'breached';
    if (breached) return { ...r, status: 'breached' };
    const { breachId: _b, detectedAtMs: _d, ...rest } = r;
    return { ...rest, status: 'holding' };
  });
}

export type FastPathDecision =
  | { readonly kind: 'none'; readonly reason: 'holding' | 'paused' | 'in_flight' | 'already_submitted' | 'no_breach_id' }
  | { readonly kind: 'reread'; readonly breachId: string }
  | { readonly kind: 'mitigate'; readonly breachId: string; readonly invariantId: string };

export interface FastPathInput {
  readonly status: ChainContractStatus;
  readonly readAtMs: number;
  readonly nowMs: number;
  readonly maxStateAgeMs: number;
  /** Breach IDs this runtime has already submitted (2.12). */
  readonly submitted: ReadonlySet<string>;
}

export function planFastPath(i: FastPathInput): FastPathDecision {
  if (i.status.paused) return { kind: 'none', reason: 'paused' };
  if (IN_FLIGHT_STATES.has(i.status.mitigation.state) || i.status.mitigation.state === 'confirmed') return { kind: 'none', reason: 'in_flight' };
  const breached = reevaluate(i.status.invariants).filter((r) => r.status === 'breached');
  if (breached.length === 0) return { kind: 'none', reason: 'holding' };
  const actionable = breached.find((r) => r.breachId !== undefined && !i.submitted.has(r.breachId));
  if (!actionable) return { kind: 'none', reason: breached.some((r) => r.breachId === undefined) ? 'no_breach_id' : 'already_submitted' };
  const breachId = actionable.breachId!;
  if (i.nowMs - i.readAtMs > i.maxStateAgeMs) return { kind: 'reread', breachId };
  return { kind: 'mitigate', breachId, invariantId: actionable.id };
}

const CAIP2_EVM = /^eip155:([1-9][0-9]{0,19})$/;

/** Rebuilds the intent from a server-built payload so the runtime can re-encode and gate it. */
export function intentFromPayload(contractId: string, p: WirePayload): Result<PauseIntent, string> {
  const m = CAIP2_EVM.exec(p.chain);
  if (!m) return err(`payload.chain ${p.chain} is not an EVM CAIP-2 ID`);
  if (!hexToBytes(p.to).ok || !hexToBytes(p.data).ok) return err('payload.to / payload.data must be even-length hex');
  return ok({
    contractId,
    chainId: BigInt(m[1]!),
    nonce: BigInt(p.nonce),
    maxFeePerGas: BigInt(p.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas),
    gasLimit: BigInt(p.gasLimit),
    to: p.to,
    value: BigInt(p.value),
    data: p.data,
  });
}
