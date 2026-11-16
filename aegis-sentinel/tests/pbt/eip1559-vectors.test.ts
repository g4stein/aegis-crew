// Cross-language check: the TypeScript encoder must match the Rust encoder (contracts/pause-tx,
// built on NEAR's omni-transaction crate) byte for byte. Regenerate with `npm run vectors`.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../../src/core/bytes';
import { decodeEip1559, encodeEip1559Signed, encodeEip1559Unsigned } from '../../src/core/mitigation/payload';
import type { PauseIntent } from '../../src/core/mitigation/types';

interface Vector {
  chainId: string;
  nonce: string;
  to: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  value: string;
  data: string;
  unsigned: string;
  signingHash: string;
  signature: { yParity: 0 | 1; r: string; s: string };
  signed: string;
}

const file = JSON.parse(readFileSync(new URL('../vectors/eip1559-pause.json', import.meta.url), 'utf8')) as {
  generator: string;
  count: number;
  vectors: Vector[];
};

const intentOf = (v: Vector): PauseIntent => ({
  contractId: 'vector',
  chainId: BigInt(v.chainId),
  nonce: BigInt(v.nonce),
  maxFeePerGas: BigInt(v.maxFeePerGas),
  maxPriorityFeePerGas: BigInt(v.maxPriorityFeePerGas),
  gasLimit: BigInt(v.gasLimit),
  to: v.to,
  value: BigInt(v.value),
  data: v.data,
});

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe(`EIP-1559 pause vectors (${file.generator})`, () => {
  it('covers boundary and random cases', () => {
    expect(file.vectors).toHaveLength(file.count);
    expect(file.count).toBeGreaterThanOrEqual(300);
    // At least some vectors exercise leading-zero r or s (canonical integer encoding).
    expect(file.vectors.some((v) => v.signature.r.startsWith('0x00') || v.signature.s.startsWith('0x00'))).toBe(true);
  });

  it.each(file.vectors.map((v, i) => [i, v] as const))('vector %i: unsigned, signing hash, and signed bytes match Rust', (_i, v) => {
    const intent = intentOf(v);
    const unsigned = unwrap(encodeEip1559Unsigned(intent));
    expect(bytesToHex(unsigned)).toBe(v.unsigned);
    expect(bytesToHex(keccak_256(unsigned))).toBe(v.signingHash);

    const sig = { yParity: v.signature.yParity, r: BigInt(v.signature.r), s: BigInt(v.signature.s) };
    const signed = unwrap(encodeEip1559Signed(intent, sig));
    expect(bytesToHex(signed)).toBe(v.signed);

    const decoded = unwrap(decodeEip1559(unwrap(hexToBytes(v.signed))));
    expect(decoded.signature).toEqual(sig);
    expect(decoded.to).toBe(v.to);
  });
});
