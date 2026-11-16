// Adapter: keccak256. Kept out of the pure core so the core imports no libraries.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, type Hex } from '../../core/bytes';

export function keccakHex(bytes: Uint8Array): Hex {
  return bytesToHex(keccak_256(bytes));
}
