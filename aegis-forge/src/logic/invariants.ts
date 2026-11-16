// Invariant proposals for token-like contracts (Requirement 3.8). Pure.
import type { AstMap, ContractMap, ProposedInvariant } from './types';

const BALANCE_MAP = /^mapping\(address(?: payable)? => uint\d*\)$/;
const UINT = /^uint\d*$/;

function find(c: ContractMap, nameRe: RegExp, typeRe: RegExp): string | undefined {
  return c.stateVariables.find((v) => nameRe.test(v.name) && typeRe.test(v.type) && !v.constant)?.name;
}

/** A contract is token-like if it stores per-address uint balances and a uint supply. */
export function proposeInvariants(map: AstMap): ProposedInvariant[] {
  const out: ProposedInvariant[] = [];
  for (const c of map.contracts) {
    if (c.kind === 'interface' || c.kind === 'library') continue;
    const balances = find(c, /balance/i, BALANCE_MAP);
    const supply = find(c, /supply/i, UINT);
    if (balances && supply) out.push({ id: 'balance-conservation', kind: 'balance-conservation', contract: c.name, balances, supply });
  }
  return out;
}
