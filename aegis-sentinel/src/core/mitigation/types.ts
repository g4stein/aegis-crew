import type { Hex } from '../bytes';
import type { Address } from '../model';

/** `bytes4(keccak256("pause()"))`. Verified in the Rust crate's tests. */
export const PAUSE_SELECTOR = '0x8456cb59' as const;

/** One allowlist entry. Mirrors the Aegis Guard contract's `GuardedContract`. */
export interface GuardedContract {
  readonly contractId: string;
  readonly chainId: bigint;
  readonly address: Address;
  readonly derivationPath: string;
  readonly gasLimit: bigint;
}

export type Allowlist = ReadonlyMap<string, GuardedContract>;

/** Target-chain values refreshed by an adapter every block, so formatting needs no I/O. */
export interface EvmPrefetch {
  readonly nonce: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/** The unsigned EIP-1559 transaction the Sentinel wants signed. */
export interface PauseIntent {
  readonly contractId: string;
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimit: bigint;
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
}

export interface EcdsaSignature {
  readonly yParity: 0 | 1;
  readonly r: bigint;
  readonly s: bigint;
}

export type ApprovedIntent = PauseIntent & { readonly approved: true; readonly derivationPath: string };

export type GateRefusal =
  | { readonly reason: 'not_allowlisted'; readonly contractId: string }
  | { readonly reason: 'target_mismatch'; readonly expected: Address; readonly actual: string }
  | { readonly reason: 'chain_mismatch'; readonly expected: bigint; readonly actual: bigint }
  | { readonly reason: 'calldata_not_pause'; readonly actual: string }
  | { readonly reason: 'nonzero_value'; readonly actual: bigint };

export type { Hex };
