// Solidity version-pragma ranges (npm-style semantics, as solc uses). Pure.
// Answers one question for risk R1: can this pragma select a compiler below 0.8.0?

type V = readonly [number, number, number];

interface Bound {
  readonly v: V;
  readonly inclusive: boolean;
}

/** Interval of versions; `undefined` hi means unbounded. */
interface Interval {
  readonly lo: Bound;
  readonly hi?: Bound;
}

const ZERO: Bound = { v: [0, 0, 0], inclusive: true };
const FULL: Interval = { lo: ZERO };

function cmp(a: V, b: V): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

interface Partial {
  readonly parts: readonly number[]; // 0 to 3 numeric components; wildcards end the list
}

function parsePartial(s: string): Partial | undefined {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(s);
  if (!m) return undefined;
  const parts: number[] = [];
  for (const p of [m[1], m[2], m[3]]) {
    if (p === undefined || /^[xX*]$/.test(p)) break;
    parts.push(Number(p));
  }
  return { parts };
}

function floor(p: Partial): V {
  return [p.parts[0] ?? 0, p.parts[1] ?? 0, p.parts[2] ?? 0];
}

/** First version above every version the partial matches (exclusive upper bound). */
function ceilingExclusive(p: Partial): V | undefined {
  const [a, b, c] = p.parts;
  if (a === undefined) return undefined;
  if (b === undefined) return [a + 1, 0, 0];
  if (c === undefined) return [a, b + 1, 0];
  return [a, b, c + 1];
}

function comparator(op: string, p: Partial): Interval | 'empty' {
  const lo = floor(p);
  const ceil = ceilingExclusive(p);
  const [a, b, c] = p.parts;
  switch (op) {
    case '':
    case '=':
      return ceil ? { lo: { v: lo, inclusive: true }, hi: { v: ceil, inclusive: false } } : FULL;
    case '>=':
      return { lo: { v: lo, inclusive: true } };
    case '>':
      return ceil ? { lo: { v: ceil, inclusive: true } } : 'empty';
    case '<':
      return p.parts.length === 0 ? 'empty' : { lo: ZERO, hi: { v: lo, inclusive: false } };
    case '<=':
      return ceil ? { lo: ZERO, hi: { v: ceil, inclusive: false } } : FULL;
    case '~': {
      if (a === undefined) return FULL;
      const hi: V = b === undefined ? [a + 1, 0, 0] : [a, b + 1, 0];
      return { lo: { v: lo, inclusive: true }, hi: { v: hi, inclusive: false } };
    }
    case '^': {
      if (a === undefined) return FULL;
      let hi: V;
      if (a > 0 || b === undefined) hi = [a + 1, 0, 0];
      else if (b > 0 || c === undefined) hi = [0, b + 1, 0];
      else hi = [0, 0, c + 1];
      return { lo: { v: lo, inclusive: true }, hi: { v: hi, inclusive: false } };
    }
  }
  return 'empty';
}

function intersect(x: Interval, y: Interval): Interval | 'empty' {
  const lo = cmp(x.lo.v, y.lo.v) > 0 ? x.lo : cmp(x.lo.v, y.lo.v) < 0 ? y.lo : { v: x.lo.v, inclusive: x.lo.inclusive && y.lo.inclusive };
  let hi: Bound | undefined;
  if (!x.hi) hi = y.hi;
  else if (!y.hi) hi = x.hi;
  else hi = cmp(x.hi.v, y.hi.v) < 0 ? x.hi : cmp(x.hi.v, y.hi.v) > 0 ? y.hi : { v: x.hi.v, inclusive: x.hi.inclusive && y.hi.inclusive };
  if (hi) {
    const c = cmp(lo.v, hi.v);
    if (c > 0 || (c === 0 && !(lo.inclusive && hi.inclusive))) return 'empty';
  }
  return hi ? { lo, hi } : { lo };
}

/** Parses a pragma value into a union of intervals. `undefined` if unparseable. */
export function parseVersionRange(range: string): Interval[] | undefined {
  const out: Interval[] = [];
  for (const alt of range.split('||')) {
    const tokens = alt.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    let acc = FULL as Interval | 'empty';
    for (const tok of tokens) {
      const m = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(tok);
      const p = m ? parsePartial(m[2]!) : undefined;
      if (!m || !p) return undefined;
      const c = comparator(m[1] ?? '', p);
      acc = c === 'empty' || acc === 'empty' ? 'empty' : intersect(acc, c);
    }
    if (acc !== 'empty') out.push(acc);
  }
  return out;
}

const BELOW_080: Interval = { lo: ZERO, hi: { v: [0, 8, 0], inclusive: false } };

/**
 * True if the conjunction of all pragma ranges admits any compiler below 0.8.0.
 * No pragma, or an unparseable one, admits any compiler, so it returns true (fail safe).
 */
export function admitsBelow080(pragmaValues: readonly string[]): boolean {
  let alternatives: Interval[] = [FULL];
  for (const value of pragmaValues) {
    const parsed = parseVersionRange(value);
    if (!parsed) return true;
    const next: Interval[] = [];
    for (const a of alternatives) for (const b of parsed) {
      const i = intersect(a, b);
      if (i !== 'empty') next.push(i);
    }
    alternatives = next;
  }
  return alternatives.some((a) => intersect(a, BELOW_080) !== 'empty');
}
