// Generates syntactically valid Solidity sources from a model, with optional risk patterns
// injected per function. The model is the oracle for P13 and P15.
import fc from 'fast-check';

export type Snippet = 'neutral' | 'txorigin' | 'unchecked' | 'checked' | 'callThenWrite' | 'writeThenCall';

export interface FnModel {
  name: string;
  visibility: 'external' | 'public' | 'internal' | 'private';
  mutability: '' | 'view' | 'pure' | 'payable';
  params: { type: string; name: string }[];
  returns: { type: string; name: string }[];
  modifiers: string[];
  body: Snippet[];
}

export interface ContractModel {
  name: string;
  abstract: boolean;
  inherits: string[];
  stateVars: { type: string; name: string; visibility: '' | 'public' | 'internal' | 'private' }[];
  token: boolean;
  events: { name: string; params: { type: string; name: string; indexed: boolean }[] }[];
  modifiers: { name: string; params: { type: string; name: string }[] }[];
  functions: FnModel[];
  receive: boolean;
}

export interface SourceModel {
  pragma: string | undefined;
  contracts: ContractModel[];
}

const ELEMENTARY = ['uint256', 'address', 'bool', 'bytes32', 'uint8', 'int256'] as const;
const suffix = fc.stringMatching(/^[a-z0-9]{0,6}$/);
// The underscore keeps generated names clear of Solidity keywords (`for`, `enum`, `pure`, ...).
const ident = (prefix: string) => suffix.map((s) => `${prefix}_${s}`);
const elementary = fc.constantFrom(...ELEMENTARY);

const version = fc
  .tuple(fc.integer({ min: 4, max: 9 }), fc.integer({ min: 0, max: 30 }), fc.boolean())
  .map(([minor, patch, full]) => (full ? `0.${minor}.${patch}` : `0.${minor}`));
const comparator = fc.tuple(fc.constantFrom('^', '~', '>=', '>', '<', '<=', '=', ''), version).map(([op, v]) => `${op}${v}`);

/** Pragma ranges: single comparators, AND pairs, and OR alternatives. */
export const pragmaRange = fc.oneof(
  { weight: 3, arbitrary: comparator },
  { weight: 2, arbitrary: fc.tuple(comparator, comparator).map(([a, b]) => `${a} ${b}`) },
  { weight: 1, arbitrary: fc.tuple(comparator, comparator).map(([a, b]) => `${a} || ${b}`) },
);

const params = (prefix: string) =>
  fc.uniqueArray(fc.record({ type: elementary, name: ident(prefix) }), { maxLength: 3, selector: (p) => p.name });

const snippet: fc.Arbitrary<Snippet> = fc.constantFrom('neutral', 'txorigin', 'unchecked', 'checked', 'callThenWrite', 'writeThenCall');

function contractModel(name: string, others: string[]): fc.Arbitrary<ContractModel> {
  return fc
    .record({
      abstract: fc.boolean(),
      inherits: fc.subarray(others, { maxLength: Math.min(2, others.length) }),
      token: fc.boolean(),
      stateVars: fc.uniqueArray(
        fc.record({ type: fc.oneof(elementary, fc.constant('mapping(address => uint256)')), name: ident('s'), visibility: fc.constantFrom('' as const, 'public' as const, 'internal' as const, 'private' as const) }),
        { minLength: 1, maxLength: 4, selector: (v) => v.name },
      ),
      events: fc.uniqueArray(fc.record({ name: ident('E'), params: fc.uniqueArray(fc.record({ type: elementary, name: ident('e'), indexed: fc.boolean() }), { maxLength: 3, selector: (p) => p.name }) }), { maxLength: 2, selector: (e) => e.name }),
      modifiers: fc.uniqueArray(fc.record({ name: ident('m'), params: params('q') }), { maxLength: 2, selector: (m) => m.name }),
      receive: fc.boolean(),
    })
    .chain((c) =>
      fc
        .uniqueArray(
          fc.record({
            name: ident('f'),
            visibility: fc.constantFrom('external' as const, 'public' as const, 'internal' as const, 'private' as const),
            mutability: fc.constantFrom('' as const, 'view' as const, 'pure' as const, 'payable' as const),
            params: params('p'),
            returns: params('r'),
            modifiers: fc.subarray(c.modifiers.map((m) => m.name)),
            body: fc.array(snippet, { maxLength: 4 }),
          }),
          { maxLength: 4, selector: (f) => f.name },
        )
        .map((functions) => {
          const stateVars = c.token
            ? [
                { type: 'mapping(address => uint256)', name: 'balanceOf', visibility: 'public' as const },
                { type: 'uint256', name: 'totalSupply', visibility: 'public' as const },
                ...c.stateVars,
              ]
            : c.stateVars;
          return { ...c, name, stateVars, functions };
        }),
    );
}

export const sourceModel: fc.Arbitrary<SourceModel> = fc
  .tuple(fc.option(pragmaRange, { nil: undefined }), fc.uniqueArray(ident('C'), { minLength: 1, maxLength: 3 }))
  .chain(([pragma, names]) =>
    fc.tuple(...names.map((n, i) => contractModel(n, names.slice(0, i)))).map((contracts) => ({ pragma, contracts })),
  );

function renderSnippet(s: Snippet, stateVar: string): string {
  switch (s) {
    case 'neutral':
      return 'uint256 t = 1; t = t + 1;';
    case 'txorigin':
      return 'require(tx.origin == msg.sender);';
    case 'unchecked':
      return 'msg.sender.call("");';
    case 'checked':
      return '(bool ok, ) = msg.sender.call(""); require(ok);';
    case 'callThenWrite':
      return `payable(msg.sender).transfer(1); ${stateVar} = ${stateVar};`;
    case 'writeThenCall':
      return `${stateVar} = ${stateVar}; payable(msg.sender).transfer(1);`;
  }
}

/**
 * An lvalue that writes a real state variable of this contract: `x` for scalars, `x[msg.sender]`
 * for mappings. (P15 seed 713695097 found that the old fallback wrote a name that was not a
 * state variable of the contract, so the injected pattern was not actually a state write.)
 */
export const stateLvalue = (c: ContractModel) => {
  const v = c.stateVars[0];
  if (!v) throw new Error('generator: contract has no state variables');
  return v.type.startsWith('mapping') ? `${v.name}[msg.sender]` : v.name;
};

export function renderSource(m: SourceModel): string {
  const out: string[] = ['// SPDX-License-Identifier: UNLICENSED'];
  if (m.pragma !== undefined) out.push(`pragma solidity ${m.pragma};`);
  for (const c of m.contracts) {
    const head = `${c.abstract ? 'abstract ' : ''}contract ${c.name}${c.inherits.length ? ` is ${c.inherits.join(', ')}` : ''} {`;
    out.push(head);
    for (const v of c.stateVars) out.push(`  ${v.type}${v.visibility ? ` ${v.visibility}` : ''} ${v.name};`);
    for (const e of c.events) out.push(`  event ${e.name}(${e.params.map((p) => `${p.type}${p.indexed ? ' indexed' : ''} ${p.name}`).join(', ')});`);
    for (const md of c.modifiers) out.push(`  modifier ${md.name}(${md.params.map((p) => `${p.type} ${p.name}`).join(', ')}) { _; }`);
    const sv = stateLvalue(c);
    for (const f of c.functions) {
      const sig = [
        `function ${f.name}(${f.params.map((p) => `${p.type} ${p.name}`).join(', ')})`,
        f.visibility,
        f.mutability,
        ...f.modifiers,
        f.returns.length ? `returns (${f.returns.map((r) => `${r.type} ${r.name}`).join(', ')})` : '',
      ].filter(Boolean);
      out.push(`  ${sig.join(' ')} {`);
      for (const s of f.body) out.push(`    ${renderSnippet(s, sv)}`);
      out.push('  }');
    }
    if (c.receive) out.push('  receive() external payable {}');
    out.push('}');
  }
  return `${out.join('\n')}\n`;
}

export const SHA = 'a'.repeat(64);
