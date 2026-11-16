// Shared generators for the mitigation and severity properties.
import fc from 'fast-check';
import { bytesToHex } from '../../src/core/bytes';
import type { Address } from '../../src/core/model';
import type { EcdsaSignature, EvmPrefetch, GuardedContract } from '../../src/core/mitigation/types';

export const U64_MAX = (1n << 64n) - 1n;
export const U256_MAX = (1n << 256n) - 1n;

/** Unsigned integer biased toward RLP length boundaries. */
export const uint = (max: bigint) =>
  fc.oneof(
    fc.constantFrom(0n, 1n, 0x7fn, 0x80n, 0xffn, 0x100n, max),
    fc.bigInt({ min: 0n, max: 1_000_000n }),
    fc.bigInt({ min: 0n, max }),
  );

export const hexBytes = (min: number, max: number) =>
  fc.uint8Array({ minLength: min, maxLength: max }).map((b) => bytesToHex(b));

export const address: fc.Arbitrary<Address> = hexBytes(20, 20) as fc.Arbitrary<Address>;

export const contractId = fc.stringMatching(/^[a-z0-9-]{1,24}$/);

export const guardedContract: fc.Arbitrary<GuardedContract> = fc.record({
  contractId,
  chainId: fc.bigInt({ min: 1n, max: U64_MAX }),
  address,
  derivationPath: fc.stringMatching(/^aegis\/[a-z0-9-]{1,16}\/eip155:[0-9]{1,8}$/),
  gasLimit: uint(U64_MAX),
});

export const allowlist = fc
  .uniqueArray(guardedContract, { minLength: 1, maxLength: 6, selector: (g) => g.contractId })
  .map((entries) => new Map(entries.map((e) => [e.contractId, e] as const)));

export const prefetch: fc.Arbitrary<EvmPrefetch> = fc.record({
  nonce: uint(U64_MAX),
  maxFeePerGas: uint(U256_MAX),
  maxPriorityFeePerGas: uint(U256_MAX),
});

export const signature: fc.Arbitrary<EcdsaSignature> = fc.record({
  yParity: fc.constantFrom(0 as const, 1 as const),
  r: uint(U256_MAX),
  s: uint(U256_MAX),
});

/** Randomizes hex letter case without changing the bytes. */
export const recase = (hex: string) =>
  fc.array(fc.boolean(), { minLength: hex.length, maxLength: hex.length }).map((flags) =>
    [...hex].map((c, i) => (i > 1 && flags[i] ? c.toUpperCase() : c)).join(''),
  );
