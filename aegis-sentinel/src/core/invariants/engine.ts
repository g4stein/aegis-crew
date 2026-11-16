// Invariant engine (Requirement 1). Pure: deterministic, no I/O, inputs never mutated.
import type { InvariantReading } from '../model';
import { err, ok, type Result } from '../result';

export interface TokenState {
  readonly balances: ReadonlyMap<string, bigint>;
  readonly totalSupply: bigint;
}

/**
 * A proposed change to token state. `transfer`, `mint`, and `burn` are the ERC-20 semantics.
 * `rawSetBalance` and `rawSetSupply` model storage writes observed from legacy code that may
 * not keep the books consistent (for example a mint that forgets to update totalSupply).
 */
export type Transition =
  | { readonly kind: 'transfer'; readonly from: string; readonly to: string; readonly amount: bigint }
  | { readonly kind: 'mint'; readonly to: string; readonly amount: bigint }
  | { readonly kind: 'burn'; readonly from: string; readonly amount: bigint }
  | { readonly kind: 'rawSetBalance'; readonly account: string; readonly balance: bigint }
  | { readonly kind: 'rawSetSupply'; readonly totalSupply: bigint };

export type InvariantKind = 'balance-conservation' | 'non-negative-balances';

export interface InvariantDefinition {
  readonly id: string;
  readonly kind: InvariantKind;
  readonly requirement: string;
  readonly label: string;
}

export type InvariantRegistry = readonly InvariantDefinition[];

export const BALANCE_CONSERVATION: InvariantDefinition = {
  id: 'balance-conservation',
  kind: 'balance-conservation',
  requirement: '1.2',
  label: '\u03a3 balanceOf = totalSupply',
};

export const NON_NEGATIVE_BALANCES: InvariantDefinition = {
  id: 'non-negative-balances',
  kind: 'non-negative-balances',
  requirement: '1.4',
  label: 'balanceOf(a) >= 0',
};

/** Requirement 1.4 applies to every contract, whether or not it is registered. */
const MANDATORY: InvariantRegistry = [NON_NEGATIVE_BALANCES];

export const DEFAULT_REGISTRY: InvariantRegistry = [BALANCE_CONSERVATION, NON_NEGATIVE_BALANCES];

export interface Totals {
  readonly sumBalances: bigint;
  readonly totalSupply: bigint;
}

/** Requirement 1.3: names the invariant, the transition, and the pre/post totals. */
export interface InvariantViolation {
  readonly invariantId: string;
  readonly requirement: string;
  readonly transition: Transition;
  readonly pre: Totals;
  readonly post: Totals;
  readonly detail: string;
}

export function sumBalances(balances: ReadonlyMap<string, bigint>): bigint {
  let s = 0n;
  for (const v of balances.values()) s += v;
  return s;
}

function minBalance(balances: ReadonlyMap<string, bigint>): bigint {
  let m = 0n;
  for (const v of balances.values()) if (v < m) m = v;
  return m;
}

function totals(s: TokenState): Totals {
  return { sumBalances: sumBalances(s.balances), totalSupply: s.totalSupply };
}

function holds(def: InvariantDefinition, s: TokenState): boolean {
  switch (def.kind) {
    case 'balance-conservation':
      return sumBalances(s.balances) === s.totalSupply;
    case 'non-negative-balances':
      return minBalance(s.balances) >= 0n && s.totalSupply >= 0n;
  }
}

function readingFor(def: InvariantDefinition, s: TokenState): InvariantReading {
  const base = { id: def.id, requirement: def.requirement, label: def.label };
  const status = holds(def, s) ? 'holding' : 'breached';
  switch (def.kind) {
    case 'balance-conservation':
      return { ...base, status, expected: s.totalSupply, observed: sumBalances(s.balances) };
    case 'non-negative-balances':
      return { ...base, status, expected: 0n, observed: minBalance(s.balances) };
  }
}

function withMandatory(registry: InvariantRegistry): InvariantRegistry {
  const ids = new Set(registry.map((d) => d.id));
  return [...registry, ...MANDATORY.filter((d) => !ids.has(d.id))];
}

/** Evaluates every registered invariant (plus mandatory ones) against a state. */
export function evaluate(state: TokenState, registry: InvariantRegistry): InvariantReading[] {
  return withMandatory(registry).map((d) => readingFor(d, state));
}

function amountOf(t: Transition): bigint | undefined {
  return t.kind === 'transfer' || t.kind === 'mint' || t.kind === 'burn' ? t.amount : undefined;
}

/** Computes the post-state. Does not check invariants. Never mutates `state`. */
export function computePostState(state: TokenState, t: Transition): TokenState {
  const balances = new Map(state.balances);
  const bal = (a: string) => balances.get(a) ?? 0n;
  let totalSupply = state.totalSupply;
  switch (t.kind) {
    case 'transfer':
      balances.set(t.from, bal(t.from) - t.amount);
      balances.set(t.to, bal(t.to) + t.amount);
      break;
    case 'mint':
      balances.set(t.to, bal(t.to) + t.amount);
      totalSupply += t.amount;
      break;
    case 'burn':
      balances.set(t.from, bal(t.from) - t.amount);
      totalSupply -= t.amount;
      break;
    case 'rawSetBalance':
      balances.set(t.account, t.balance);
      break;
    case 'rawSetSupply':
      totalSupply = t.totalSupply;
      break;
  }
  return { balances, totalSupply };
}

/**
 * Applies a transition only if the post-state satisfies every registered invariant (1.1)
 * and no balance goes negative (1.4). On rejection the caller keeps the pre-state (1.2)
 * and receives a violation value (1.3).
 */
export function applyTransition(
  state: TokenState,
  t: Transition,
  registry: InvariantRegistry,
): Result<TokenState, InvariantViolation> {
  const pre = totals(state);
  const amount = amountOf(t);
  if (amount !== undefined && amount < 0n) {
    return err({
      invariantId: NON_NEGATIVE_BALANCES.id,
      requirement: NON_NEGATIVE_BALANCES.requirement,
      transition: t,
      pre,
      post: pre,
      detail: `negative ${t.kind} amount ${amount.toString()}`,
    });
  }

  const next = computePostState(state, t);
  for (const def of withMandatory(registry)) {
    if (!holds(def, next)) {
      const post = totals(next);
      return err({
        invariantId: def.id,
        requirement: def.requirement,
        transition: t,
        pre,
        post,
        detail:
          def.kind === 'balance-conservation'
            ? `sum of balances ${post.sumBalances.toString()} != totalSupply ${post.totalSupply.toString()}`
            : `a balance or totalSupply would be negative (min balance ${minBalance(next.balances).toString()})`,
      });
    }
  }
  return ok(next);
}
