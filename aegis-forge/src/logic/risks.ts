// Legacy risk detectors R1–R4 (Requirement 3.7). Pure; reads the parsed AST only.
import type {
  ASTNode,
  BaseASTNode,
  ContractDefinition,
  Expression,
  FunctionCall,
  FunctionDefinition,
  ModifierDefinition,
  SourceUnit,
} from '@solidity-parser/parser/dist/src/ast-types';
import { admitsBelow080 } from './pragma';
import type { Loc, Risk } from './types';

const LOW_LEVEL = new Set(['call', 'delegatecall', 'staticcall', 'callcode', 'send']);
const EXTERNAL_VALUE_CALLS = new Set([...LOW_LEVEL, 'transfer']);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '<<=', '>>=']);
const AUTH_CALLS = new Set(['require', 'assert']);

type AnyNode = BaseASTNode & Record<string, unknown>;

const isNode = (v: unknown): v is AnyNode => typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';

function locOf(n: BaseASTNode): Loc {
  return { line: n.loc?.start.line ?? 0, column: n.loc?.start.column ?? 0 };
}

const startOf = (n: BaseASTNode) => n.range?.[0] ?? 0;

/** Visits every node under `root` with its ancestor chain. Skips location metadata. */
function walk(root: unknown, visit: (n: AnyNode, ancestors: readonly AnyNode[]) => void, ancestors: AnyNode[] = []): void {
  if (Array.isArray(root)) {
    for (const item of root) walk(item, visit, ancestors);
    return;
  }
  if (!isNode(root)) return;
  visit(root, ancestors);
  ancestors.push(root);
  for (const [k, v] of Object.entries(root)) {
    if (k === 'loc' || k === 'range' || k === 'comments') continue;
    if (typeof v === 'object' && v !== null) walk(v, visit, ancestors);
  }
  ancestors.pop();
}

/** Strips `{value: x}` options and legacy `.value(x)` / `.gas(x)` wrappers to find the member called. */
function calledMember(call: FunctionCall): string | undefined {
  let e: Expression = call.expression;
  for (;;) {
    if (e.type === 'NameValueExpression') e = e.expression;
    else if (e.type === 'FunctionCall' && e.expression.type === 'MemberAccess' && (e.expression.memberName === 'value' || e.expression.memberName === 'gas')) e = e.expression.expression;
    else break;
  }
  return e.type === 'MemberAccess' ? e.memberName : undefined;
}

function isLowLevelCall(n: AnyNode): n is AnyNode & FunctionCall {
  if (n.type !== 'FunctionCall') return false;
  const fc = n as unknown as FunctionCall;
  // `x.value(1)` inside `x.call.value(1)("")` is a wrapper, not a call of its own.
  const m = calledMember(fc);
  return m !== undefined && LOW_LEVEL.has(m);
}

/** The receiver expression of a member call, after stripping `{value: x}` and `.value(x)` wrappers. */
function callReceiver(call: FunctionCall): AnyNode | undefined {
  let e: Expression = call.expression;
  for (;;) {
    if (e.type === 'NameValueExpression') e = e.expression;
    else if (e.type === 'FunctionCall' && e.expression.type === 'MemberAccess' && (e.expression.memberName === 'value' || e.expression.memberName === 'gas')) e = e.expression.expression;
    else break;
  }
  return e.type === 'MemberAccess' ? (e.expression as unknown as AnyNode) : undefined;
}

/**
 * An external call: a low-level call or `.transfer`, or any member call on a state variable whose
 * type is a contract or interface (for example `token.transferFrom(...)`).
 */
function isExternalCall(n: AnyNode, contractVars: ReadonlySet<string>): boolean {
  if (n.type !== 'FunctionCall') return false;
  const fc = n as unknown as FunctionCall;
  const m = calledMember(fc);
  if (m === undefined) return false;
  if (EXTERNAL_VALUE_CALLS.has(m)) return true;
  const recv = callReceiver(fc);
  return recv?.type === 'Identifier' && contractVars.has(recv.name as string);
}

function isTxOrigin(n: AnyNode): boolean {
  if (n.type !== 'MemberAccess') return false;
  const e = n.expression as AnyNode | undefined;
  return n.memberName === 'origin' && e?.type === 'Identifier' && e.name === 'tx';
}

function isAuthContext(ancestors: readonly AnyNode[]): boolean {
  for (const a of ancestors) {
    if (a.type === 'BinaryOperation' && (a.operator === '==' || a.operator === '!=')) return true;
    if (a.type === 'IfStatement' || a.type === 'WhileStatement' || a.type === 'Conditional') return true;
    if (a.type === 'FunctionCall') {
      const callee = a.expression as AnyNode | undefined;
      if (callee?.type === 'Identifier' && AUTH_CALLS.has(callee.name as string)) return true;
    }
  }
  return false;
}

/** Root variable name written by an lvalue such as `balances[a].x`. */
function rootName(e: AnyNode | undefined): string | undefined {
  let cur = e;
  while (cur && (cur.type === 'IndexAccess' || cur.type === 'MemberAccess')) cur = (cur.type === 'IndexAccess' ? cur.base : cur.expression) as AnyNode;
  return cur?.type === 'Identifier' ? (cur.name as string) : undefined;
}

function stateVarNames(c: ContractDefinition): Set<string> {
  const names = new Set<string>();
  for (const n of c.subNodes as ASTNode[]) {
    if (n.type === 'StateVariableDeclaration') for (const v of n.variables) if (v.name) names.add(v.name);
  }
  return names;
}

/** Names of user-defined types that are not contracts or interfaces: structs, enums, libraries. */
function nonContractTypeNames(unit: SourceUnit): Set<string> {
  const names = new Set<string>();
  walk(unit.children, (n) => {
    if (n.type === 'StructDefinition' || n.type === 'EnumDefinition') names.add(n.name as string);
    if (n.type === 'ContractDefinition' && n.kind === 'library') names.add(n.name as string);
  });
  return names;
}

/** State variables typed as a contract or interface, e.g. `ERC20 public token;`. */
function contractTypedVars(c: ContractDefinition, nonContract: ReadonlySet<string>): Set<string> {
  const names = new Set<string>();
  for (const n of c.subNodes as ASTNode[]) {
    if (n.type !== 'StateVariableDeclaration') continue;
    for (const v of n.variables) {
      if (v.name && v.typeName?.type === 'UserDefinedTypeName' && !nonContract.has(v.typeName.namePath)) names.add(v.name);
    }
  }
  return names;
}

function legacyPragmaRisks(unit: SourceUnit, contracts: readonly ContractDefinition[]): Risk[] {
  const pragmas = unit.children.filter((n) => n.type === 'PragmaDirective' && n.name === 'solidity');
  const values = pragmas.map((p) => (p as { value: string }).value);
  if (!admitsBelow080(values)) return [];
  const loc = pragmas[0] ? locOf(pragmas[0]) : { line: 1, column: 0 };
  const what = values.length > 0 ? `pragma ${values.map((v) => `"${v}"`).join(' and ')}` : 'missing pragma';
  return contracts.map((c) => ({
    id: 'legacy-pragma' as const,
    severity: 'high' as const,
    confidence: 'certain' as const,
    contract: c.name,
    loc,
    message: `${what} admits compilers below 0.8.0 (unchecked arithmetic)`,
  }));
}

function bodyRisks(
  c: ContractDefinition,
  fn: FunctionDefinition | ModifierDefinition,
  state: ReadonlySet<string>,
  contractVars: ReadonlySet<string>,
): Risk[] {
  const risks: Risk[] = [];
  const fname = fn.type === 'ModifierDefinition' ? fn.name : fn.isConstructor ? 'constructor' : fn.isFallback ? 'fallback' : fn.isReceiveEther ? 'receive' : (fn.name ?? '');
  const base = { contract: c.name, function: fname };
  const calls: number[] = [];
  const writes: { at: number; node: AnyNode; name: string }[] = [];

  walk(fn.body, (n, ancestors) => {
    if (isTxOrigin(n) && isAuthContext(ancestors)) {
      risks.push({ ...base, id: 'tx-origin-auth', severity: 'high', confidence: 'certain', loc: locOf(n), message: `tx.origin used for authorization in ${c.name}.${fname}` });
    }
    if (isLowLevelCall(n)) {
      const parent = ancestors.at(-1);
      if (parent?.type === 'ExpressionStatement') {
        risks.push({ ...base, id: 'unchecked-call', severity: 'high', confidence: 'heuristic', loc: locOf(n), message: `return value of low-level ${calledMember(n as unknown as FunctionCall)} is discarded in ${c.name}.${fname}` });
      }
    }
    if (isExternalCall(n, contractVars) && !(ancestors.at(-1)?.type === 'FunctionCall' && isExternalCall(ancestors.at(-1)!, contractVars))) calls.push(startOf(n));
    if (n.type === 'BinaryOperation' && ASSIGN_OPS.has(n.operator as string)) {
      const name = rootName(n.left as AnyNode);
      if (name && state.has(name)) writes.push({ at: startOf(n), node: n, name });
    }
    if (n.type === 'UnaryOperation' && ['++', '--', 'delete'].includes(n.operator as string)) {
      const name = rootName(n.subExpression as AnyNode);
      if (name && state.has(name)) writes.push({ at: startOf(n), node: n, name });
    }
  });

  const firstCall = calls.length > 0 ? Math.min(...calls) : undefined;
  if (firstCall !== undefined) {
    const late = writes.filter((w) => w.at > firstCall).sort((a, b) => a.at - b.at)[0];
    if (late) {
      risks.push({ ...base, id: 'call-before-write', severity: 'high', confidence: 'heuristic', loc: locOf(late.node), message: `state variable ${late.name} is written after an external call in ${c.name}.${fname} (reentrancy)` });
    }
  }
  return risks;
}

/** All risks, in source order. */
export function detectRisks(unit: SourceUnit): Risk[] {
  const contracts = unit.children.filter((n): n is ContractDefinition => n.type === 'ContractDefinition');
  const risks = legacyPragmaRisks(unit, contracts);
  const nonContract = nonContractTypeNames(unit);
  for (const c of contracts) {
    const state = stateVarNames(c);
    const contractVars = contractTypedVars(c, nonContract);
    for (const n of c.subNodes as ASTNode[]) {
      if ((n.type === 'FunctionDefinition' || n.type === 'ModifierDefinition') && n.body) risks.push(...bodyRisks(c, n, state, contractVars));
    }
  }
  return risks;
}
