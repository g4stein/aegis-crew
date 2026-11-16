// Recursive Length Prefix encoding (Ethereum Yellow Paper, Appendix B). Pure.
// The decoder is strict: it rejects non-canonical lengths and trailing bytes.
import { concatBytes, uintToBytes } from './bytes';
import { err, ok, type Result } from './result';

export type RlpItem = Uint8Array | readonly RlpItem[];

function encodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) return Uint8Array.of(offset + len);
  const lenBytes = uintToBytes(BigInt(len));
  return concatBytes(Uint8Array.of(offset + 55 + lenBytes.length), lenBytes);
}

export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0]! < 0x80) return item;
    return concatBytes(encodeLength(item.length, 0x80), item);
  }
  const payload = concatBytes(...item.map(rlpEncode));
  return concatBytes(encodeLength(payload.length, 0xc0), payload);
}

interface Decoded {
  item: RlpItem;
  end: number;
}

function readLength(buf: Uint8Array, pos: number, lenOfLen: number): Result<number, string> {
  if (pos + lenOfLen > buf.length) return err('length prefix past end');
  if (buf[pos] === 0) return err('non-canonical length (leading zero)');
  let len = 0;
  for (let i = 0; i < lenOfLen; i++) len = len * 256 + buf[pos + i]!;
  if (len < 56) return err('non-canonical length (long form under 56)');
  return ok(len);
}

function decodeAt(buf: Uint8Array, pos: number): Result<Decoded, string> {
  if (pos >= buf.length) return err('unexpected end of input');
  const b = buf[pos]!;
  if (b < 0x80) return ok({ item: buf.subarray(pos, pos + 1), end: pos + 1 });

  if (b < 0xc0) {
    let start: number;
    let len: number;
    if (b <= 0xb7) {
      len = b - 0x80;
      start = pos + 1;
      if (len === 1 && start < buf.length && buf[start]! < 0x80) return err('non-canonical single byte');
    } else {
      const lol = b - 0xb7;
      const r = readLength(buf, pos + 1, lol);
      if (!r.ok) return r;
      len = r.value;
      start = pos + 1 + lol;
    }
    if (start + len > buf.length) return err('string past end');
    return ok({ item: buf.subarray(start, start + len), end: start + len });
  }

  let start: number;
  let len: number;
  if (b <= 0xf7) {
    len = b - 0xc0;
    start = pos + 1;
  } else {
    const lol = b - 0xf7;
    const r = readLength(buf, pos + 1, lol);
    if (!r.ok) return r;
    len = r.value;
    start = pos + 1 + lol;
  }
  const end = start + len;
  if (end > buf.length) return err('list past end');
  const items: RlpItem[] = [];
  let p = start;
  while (p < end) {
    const r = decodeAt(buf, p);
    if (!r.ok) return r;
    if (r.value.end > end) return err('list item past list end');
    items.push(r.value.item);
    p = r.value.end;
  }
  return ok({ item: items, end });
}

export function rlpDecode(buf: Uint8Array): Result<RlpItem, string> {
  const r = decodeAt(buf, 0);
  if (!r.ok) return r;
  if (r.value.end !== buf.length) return err('trailing bytes after RLP item');
  return ok(r.value.item);
}
