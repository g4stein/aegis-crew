// P1–P5: invariant engine (Requirement 1).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyTransition,
  DEFAULT_REGISTRY,
  evaluate,
  type TokenState,
  type Transition,
} from '../../src/core/invariants/engine';

// ---- Generators ----------------------------------------------------------------

const ACCOUNTS = ['0xa1', '0xb2', '0xc3', '0xd4', '0xe5'] as const;
const account = fc.constantFrom(...ACCOUNTS);

const amount = fc.oneof(
  { weight: 5, arbitrary: fc.bigInt({ min: 0n, max: 1_000n }) },
  { weight: 2, arbitrary: fc.bigInt({ min: 0n, max: 1n << 128n }) },
  { weight: 1, arbitrary: fc.bigInt({ min: -1_000n, max: -1n }) },
);

/** A state that satisfies every invariant. */
const validState: fc.Arbitrary<TokenState> = fc
  .array(fc.tuple(account, fc.bigInt({ min: 0n, max: 1n << 96n })), { maxLength: ACCOUNTS.length })
  .map((entries) => {
    const balances = new Map<string, bigint>(entries);
    let total = 0n;
    for (const v of balances.values()) total += v;
    return { balances, totalSupply: total };
  });

/** Any state, including broken ones (for determinism). */
const anyState: fc.Arbitrary<TokenState> = fc
  .tuple(fc.array(fc.tuple(account, fc.bigInt({ min: -(1n << 64n), max: 1n << 64n })), { maxLength: 5 }), fc.bigInt({ min: -(1n << 64n), max: 1n << 64n }))
  .map(([entries, totalSupply]) => ({ balances: new Map<string, bigint>(entries), totalSupply }));

const transition: fc.Arbitrary<Transition> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('transfer' as const), from: account, to: account, amount }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('mint' as const), to: account, amount }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('burn' as const), from: account, amount }) },
  // Faulty legacy writes: almost always break conservation.
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('rawSetBalance' as const), account, balance: fc.bigInt({ min: -1_000n, max: 1n << 96n }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('rawSetSupply' as const), totalSupply: fc.bigInt({ min: -1_000n, max: 1n << 96n }) }) },
);

// ---- Independent oracle (plain records, written separately from the engine) ------

interface OracleState {
  bal: Record<string, bigint>;
  supply: bigint;
}

function toOracle(s: TokenState): OracleState {
  return { bal: Object.fromEntries(s.balances), supply: s.totalSupply };
}

function oracleApply(s: OracleState, t: Transition): { post: OracleState; badAmount: boolean } {
  const bal = { ...s.bal };
  const get = (a: string) => bal[a] ?? 0n;
  let supply = s.supply;
  let badAmount = false;
  if (t.kind === 'transfer') {
    badAmount = t.amount < 0n;
    bal[t.from] = get(t.from) - t.amount;
    bal[t.to] = get(t.to) + t.amount;
  } else if (t.kind === 'mint') {
    badAmount = t.amount < 0n;
    bal[t.to] = get(t.to) + t.amount;
    supply += t.amount;
  } else if (t.kind === 'burn') {
    badAmount = t.amount < 0n;
    bal[t.from] = get(t.from) - t.amount;
    supply -= t.amount;
  } else if (t.kind === 'rawSetBalance') {
    bal[t.account] = t.balance;
  } else {
    supply = t.totalSupply;
  }
  return { post: { bal, supply }, badAmount };
}

const oracleSum = (s: OracleState) => Object.values(s.bal).reduce((a, b) => a + b, 0n);
const oracleConserves = (s: OracleState) => oracleSum(s) === s.supply;
const oracleNonNegative = (s: OracleState) => s.supply >= 0n && Object.values(s.bal).every((v) => v >= 0n);
const oracleValid = (s: OracleState) => oracleConserves(s) && oracleNonNegative(s);

const snapshot = (s: TokenState) => ({ balances: [...s.balances.entries()], totalSupply: s.totalSupply });

// ---- Properties -------------------------------------------------------------------

describe('invariant engine', () => {
  it('P1 conservation [Req 1.6]: every accepted post-state satisfies Σ balances = totalSupply', () => {
    fc.assert(
      fc.property(validState, fc.array(transition, { maxLength: 30 }), (s0, ts) => {
        let s = s0;
        for (const t of ts) {
          const r = applyTransition(s, t, DEFAULT_REGISTRY);
          if (r.ok) {
            s = r.value;
            expect(oracleConserves(toOracle(s))).toBe(true);
          }
        }
        expect(oracleConserves(toOracle(s))).toBe(true);
      }),
    );
  });

  it('P2 violations-rejected [Req 1.2, 1.7]: a transition is rejected iff its post-state breaks an invariant', () => {
    fc.assert(
      fc.property(validState, transition, (s, t) => {
        const { post, badAmount } = oracleApply(toOracle(s), t);
        const shouldReject = badAmount || !oracleValid(post);
        const r = applyTransition(s, t, DEFAULT_REGISTRY);
        expect(r.ok).toBe(!shouldReject);
        if (r.ok) expect(toOracle(r.value)).toEqual(post);
      }),
    );
  });

  it('P3 rejection-preserves-state [Req 1.2, 1.3]: on rejection the input is unchanged and the error is complete', () => {
    fc.assert(
      fc.property(validState, transition, (s, t) => {
        const before = snapshot(s);
        const r = applyTransition(s, t, DEFAULT_REGISTRY);
        expect(snapshot(s)).toEqual(before);
        if (r.ok) return;
        const { post, badAmount } = oracleApply(toOracle(s), t);
        const e = r.error;
        expect(DEFAULT_REGISTRY.map((d) => d.id)).toContain(e.invariantId);
        expect(e.transition).toBe(t);
        expect(e.pre).toEqual({ sumBalances: oracleSum(toOracle(s)), totalSupply: s.totalSupply });
        expect(e.post).toEqual(badAmount ? e.pre : { sumBalances: oracleSum(post), totalSupply: post.supply });
        expect(e.detail.length).toBeGreaterThan(0);
      }),
    );
  });

  it('P4 no-negative-balances [Req 1.4]: no accepted state has a negative balance, and transitions that create one are rejected', () => {
    fc.assert(
      fc.property(validState, fc.array(transition, { maxLength: 30 }), (s0, ts) => {
        let s = s0;
        for (const t of ts) {
          const { post } = oracleApply(toOracle(s), t);
          const r = applyTransition(s, t, DEFAULT_REGISTRY);
          if (!oracleNonNegative(post)) expect(r.ok).toBe(false);
          if (r.ok) {
            s = r.value;
            expect(oracleNonNegative(toOracle(s))).toBe(true);
          }
        }
      }),
    );
  });

  it('P5 engine-determinism [Req 1.5]: equal inputs give deep-equal outputs', () => {
    fc.assert(
      fc.property(anyState, transition, (s, t) => {
        const copy: TokenState = { balances: new Map(s.balances), totalSupply: s.totalSupply };
        expect(evaluate(s, DEFAULT_REGISTRY)).toStrictEqual(evaluate(copy, DEFAULT_REGISTRY));
        const a = applyTransition(s, t, DEFAULT_REGISTRY);
        const b = applyTransition(copy, t, DEFAULT_REGISTRY);
        expect(a.ok).toBe(b.ok);
        if (a.ok && b.ok) expect(snapshot(a.value)).toStrictEqual(snapshot(b.value));
        if (!a.ok && !b.ok) expect(a.error).toStrictEqual(b.error);
      }),
    );
  });
});
