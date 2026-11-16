// Byte, hex, and unsigned-integer helpers. Pure; no Buffer, no TextEncoder.
import { err, ok, type Result } from './result';

export type Hex = `0x${string}`;

const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

export function isHex(s: string): s is Hex {
  return HEX_RE.test(s);
}

export function hexToBytes(hex: string): Result<Uint8Array, string> {
  if (!isHex(hex)) return err(`not an even-length 0x hex string: ${hex.slice(0, 20)}`);
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return ok(out);
}

export function bytesToHex(bytes: Uint8Array): Hex {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s as Hex;
}

/** Minimal big-endian bytes; 0n -> empty (RLP canonical integer form). */
export function uintToBytes(v: bigint): Uint8Array {
  if (v < 0n) throw new RangeError('uintToBytes: negative');
  if (v === 0n) return new Uint8Array(0);
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToUint(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
