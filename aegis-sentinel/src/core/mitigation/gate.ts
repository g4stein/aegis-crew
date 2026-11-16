// Sign-request gate (Requirements 2.8, 2.9, 2.16). Pure.
// Defense in depth: the Aegis Guard contract enforces the same rules on-chain.
import { err, ok, type Result } from '../result';
import { PAUSE_SELECTOR, type Allowlist, type ApprovedIntent, type GateRefusal, type PauseIntent } from './types';

/**
 * Approves a sign request if and only if:
 * - the contract is allowlisted, and the intent's target address and chain match that entry,
 * - the calldata is exactly the `pause()` selector,
 * - the value is zero.
 */
export function approveSignRequest(intent: PauseIntent, allowlist: Allowlist): Result<ApprovedIntent, GateRefusal> {
  const entry = allowlist.get(intent.contractId);
  if (!entry) return err({ reason: 'not_allowlisted', contractId: intent.contractId });
  if (intent.to.toLowerCase() !== entry.address.toLowerCase()) {
    return err({ reason: 'target_mismatch', expected: entry.address, actual: intent.to });
  }
  if (intent.chainId !== entry.chainId) {
    return err({ reason: 'chain_mismatch', expected: entry.chainId, actual: intent.chainId });
  }
  if (intent.data.toLowerCase() !== PAUSE_SELECTOR) return err({ reason: 'calldata_not_pause', actual: intent.data });
  if (intent.value !== 0n) return err({ reason: 'nonzero_value', actual: intent.value });
  return ok({ ...intent, approved: true, derivationPath: entry.derivationPath });
}
