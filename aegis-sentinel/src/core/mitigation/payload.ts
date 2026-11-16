// Pause payload formatting and EIP-1559 (type 2) encoding (Requirements 2.1, 2.15). Pure.
// Must match the Rust encoder in contracts/pause-tx byte for byte (tests/vectors).
import { bytesToHex, bytesToUint, concatBytes, hexToBytes, uintToBytes, type Hex } from '../bytes';
import { err, ok, type Result } from '../result';
import { rlpDecode, rlpEncode, type RlpItem } from '../rlp';
import { PAUSE_SELECTOR, type EcdsaSignature, type EvmPrefetch, type GuardedContract, type PauseIntent } from './types';

const TX_TYPE = 0x02;
const U64_MAX = (1n << 64n) - 1n;
const U256_MAX = (1n << 256n) - 1n;

/** Builds the pause intent from the allowlist entry and prefetched chain values. No I/O. */
export function formatPauseIntent(entry: GuardedContract, prefetch: EvmPrefetch): PauseIntent {
  return {
    contractId: entry.contractId,
    chainId: entry.chainId,
    nonce: prefetch.nonce,
    maxPriorityFeePerGas: prefetch.maxPriorityFeePerGas,
    maxFeePerGas: prefetch.maxFeePerGas,
    gasLimit: entry.gasLimit,
    to: entry.address,
    value: 0n,
    data: PAUSE_SELECTOR,
  };
}

export type EncodeError = { readonly field: string; readonly message: string };

function uintField(name: string, v: bigint, max: bigint): Result<Uint8Array, EncodeError> {
  if (v < 0n || v > max) return err({ field: name, message: `${name} out of range: ${v.toString()}` });
  return ok(uintToBytes(v));
}

function fieldsOf(intent: PauseIntent): Result<RlpItem[], EncodeError> {
  const to = hexToBytes(intent.to);
  if (!to.ok || to.value.length !== 20) return err({ field: 'to', message: 'to must be a 20-byte address' });
  const data = hexToBytes(intent.data);
  if (!data.ok) return err({ field: 'data', message: data.error });
  const ints: [string, bigint, bigint][] = [
    ['chainId', intent.chainId, U64_MAX],
    ['nonce', intent.nonce, U64_MAX],
    ['maxPriorityFeePerGas', intent.maxPriorityFeePerGas, U256_MAX],
    ['maxFeePerGas', intent.maxFeePerGas, U256_MAX],
    ['gasLimit', intent.gasLimit, U64_MAX],
  ];
  const encoded: Uint8Array[] = [];
  for (const [name, v, max] of ints) {
    const r = uintField(name, v, max);
    if (!r.ok) return r;
    encoded.push(r.value);
  }
  const value = uintField('value', intent.value, U256_MAX);
  if (!value.ok) return value;
  // [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList]
  return ok([...encoded, to.value, value.value, data.value, []]);
}

/** `0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, []])` */
export function encodeEip1559Unsigned(intent: PauseIntent): Result<Uint8Array, EncodeError> {
  const f = fieldsOf(intent);
  if (!f.ok) return f;
  return ok(concatBytes(Uint8Array.of(TX_TYPE), rlpEncode(f.value)));
}

/** Signed form: appends `yParity, r, s` as canonical integers. */
export function encodeEip1559Signed(intent: PauseIntent, sig: EcdsaSignature): Result<Uint8Array, EncodeError> {
  const f = fieldsOf(intent);
  if (!f.ok) return f;
  const r = uintField('r', sig.r, U256_MAX);
  if (!r.ok) return r;
  const s = uintField('s', sig.s, U256_MAX);
  if (!s.ok) return s;
  return ok(concatBytes(Uint8Array.of(TX_TYPE), rlpEncode([...f.value, uintToBytes(BigInt(sig.yParity)), r.value, s.value])));
}

export interface DecodedEip1559 {
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimit: bigint;
  readonly to: Hex;
  readonly value: bigint;
  readonly data: Hex;
  readonly accessListLength: number;
  readonly signature?: EcdsaSignature;
}

function asBytes(item: RlpItem | undefined, name: string): Result<Uint8Array, string> {
  if (!(item instanceof Uint8Array)) return err(`${name}: expected byte string`);
  return ok(item);
}

function asUint(item: RlpItem | undefined, name: string): Result<bigint, string> {
  const b = asBytes(item, name);
  if (!b.ok) return b;
  if (b.value.length > 0 && b.value[0] === 0) return err(`${name}: non-canonical integer (leading zero)`);
  return ok(bytesToUint(b.value));
}

/** Strict decoder for unsigned or signed type-2 transactions. Used to prove round-trips (P7). */
export function decodeEip1559(bytes: Uint8Array): Result<DecodedEip1559, string> {
  if (bytes[0] !== TX_TYPE) return err('not a type-2 transaction');
  const d = rlpDecode(bytes.subarray(1));
  if (!d.ok) return d;
  const list = d.value;
  if (list instanceof Uint8Array || (list.length !== 9 && list.length !== 12)) return err('expected 9 or 12 fields');

  const ints: bigint[] = [];
  for (const [i, name] of ['chainId', 'nonce', 'maxPriorityFeePerGas', 'maxFeePerGas', 'gasLimit'].entries()) {
    const v = asUint(list[i], name);
    if (!v.ok) return v;
    ints.push(v.value);
  }
  const to = asBytes(list[5], 'to');
  if (!to.ok) return to;
  const value = asUint(list[6], 'value');
  if (!value.ok) return value;
  const data = asBytes(list[7], 'data');
  if (!data.ok) return data;
  const access = list[8];
  if (access === undefined || access instanceof Uint8Array) return err('accessList: expected list');

  let signature: EcdsaSignature | undefined;
  if (list.length === 12) {
    const y = asUint(list[9], 'yParity');
    if (!y.ok) return y;
    if (y.value > 1n) return err('yParity must be 0 or 1');
    const r = asUint(list[10], 'r');
    if (!r.ok) return r;
    const s = asUint(list[11], 's');
    if (!s.ok) return s;
    signature = { yParity: y.value === 1n ? 1 : 0, r: r.value, s: s.value };
  }

  const [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit] = ints as [bigint, bigint, bigint, bigint, bigint];
  return ok({
    chainId,
    nonce,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasLimit,
    to: bytesToHex(to.value),
    value: value.value,
    data: bytesToHex(data.value),
    accessListLength: access.length,
    ...(signature ? { signature } : {}),
  });
}
