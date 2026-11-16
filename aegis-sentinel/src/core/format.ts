// Deterministic display formatting. Pure: no locale, no Date, no clock.

const MINUS = '\u2212';

/** 1500000n -> "1,500,000". Locale-independent. */
export function formatAmount(v: bigint): string {
  const negative = v < 0n;
  const digits = (negative ? -v : v).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `${MINUS}${grouped}` : grouped;
}

/** Signed difference with an explicit sign: "+500,000", "−3", "0". */
export function formatDelta(observed: bigint, expected: bigint): string {
  const d = observed - expected;
  if (d === 0n) return '0';
  return d > 0n ? `+${formatAmount(d)}` : formatAmount(d);
}

/** "0x1234…abcd". Returns the input unchanged if it is short. */
export function shortHex(hex: string, head = 6, tail = 4): string {
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}\u2026${hex.slice(-tail)}`;
}

function pad(n: number, width = 2): string {
  return n.toString().padStart(width, '0');
}

/** Days since 1970-01-01 -> civil date (proleptic Gregorian). */
function civilFromDays(days: number): { y: number; m: number; d: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

/** Unix ms -> "2026-11-16". */
export function formatUtcDate(ms: number): string {
  const { y, m, d } = civilFromDays(Math.floor(ms / 86_400_000));
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Unix ms -> "13:04:52Z", or "13:04:52.184Z" with millis. */
export function formatUtcTime(ms: number, withMillis = false): string {
  const dayMs = ((ms % 86_400_000) + 86_400_000) % 86_400_000;
  const h = Math.floor(dayMs / 3_600_000);
  const min = Math.floor((dayMs % 3_600_000) / 60_000);
  const s = Math.floor((dayMs % 60_000) / 1000);
  const base = `${pad(h)}:${pad(min)}:${pad(s)}`;
  return withMillis ? `${base}.${pad(dayMs % 1000, 3)}Z` : `${base}Z`;
}

/** 184 -> "184 ms", 6400 -> "6.400 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${Math.floor(ms / 1000)}.${pad(ms % 1000, 3)} s`;
}

/** Elapsed time from t0 as "+184 ms", or "—" if either side is missing. */
export function formatOffset(t0: number | undefined, t: number | undefined): string {
  if (t0 === undefined || t === undefined) return '\u2014';
  return `+${formatDuration(t - t0)}`;
}
