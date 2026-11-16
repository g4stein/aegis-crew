// AST map (Requirement 3.2). Pure: takes a parsed source unit and metadata, returns data.
import type {
  ASTNode,
  BaseASTNode,
  ContractDefinition,
  EventDefinition,
  FunctionDefinition,
  ModifierDefinition,
  PragmaDirective,
  SourceUnit,
  StateVariableDeclaration,
  TypeName,
  VariableDeclaration,
} from '@solidity-parser/parser/dist/src/ast-types';
import { detectRisks } from './risks';
import type { AstMap, ContractMap, EventMap, FunctionMap, Loc, ModifierMap, Param, StateVariableMap } from './types';

export interface SourceMeta {
  readonly sourceName: string;
  readonly sha256: string;
}

export function locOf(node: BaseASTNode): Loc {
  return { line: node.loc?.start.line ?? 0, column: node.loc?.start.column ?? 0 };
}

export function typeNameToString(t: TypeName | null | undefined): string {
  if (!t) return '';
  switch (t.type) {
    case 'ElementaryTypeName':
      return t.stateMutability === 'payable' ? `${t.name} payable` : t.name;
    case 'UserDefinedTypeName':
      return t.namePath;
    case 'Mapping':
      return `mapping(${typeNameToString(t.keyType)} => ${typeNameToString(t.valueType)})`;
    case 'ArrayTypeName': {
      const len = t.length && t.length.type === 'NumberLiteral' ? t.length.number : '';
      return `${typeNameToString(t.baseTypeName)}[${len}]`;
    }
    case 'FunctionTypeName':
      return 'function';
  }
}

function param(v: VariableDeclaration): Param {
  return { name: v.name ?? '', type: typeNameToString(v.typeName) };
}

function contractKind(kind: string): ContractMap['kind'] {
  return kind === 'abstract' || kind === 'interface' || kind === 'library' ? kind : 'contract';
}

function functionMap(f: FunctionDefinition): FunctionMap {
  const kind: FunctionMap['kind'] = f.isConstructor ? 'constructor' : f.isReceiveEther ? 'receive' : f.isFallback ? 'fallback' : 'function';
  return {
    name: kind === 'function' ? (f.name ?? '') : kind,
    kind,
    // Before 0.5.0 an unmarked function was public.
    visibility: f.visibility === 'default' ? 'public' : f.visibility,
    mutability: f.stateMutability ?? 'nonpayable',
    modifiers: f.modifiers.map((m) => m.name),
    parameters: f.parameters.map(param),
    returns: (f.returnParameters ?? []).map(param),
    loc: locOf(f),
  };
}

function stateVariables(d: StateVariableDeclaration): StateVariableMap[] {
  return d.variables.map((v) => ({
    name: v.name ?? '',
    type: typeNameToString(v.typeName),
    visibility: !v.visibility || v.visibility === 'default' ? 'internal' : v.visibility,
    constant: v.isDeclaredConst === true,
    immutable: v.isImmutable === true,
  }));
}

function eventMap(e: EventDefinition): EventMap {
  return { name: e.name, parameters: e.parameters.map((p) => ({ ...param(p), indexed: p.isIndexed })) };
}

function modifierMap(m: ModifierDefinition): ModifierMap {
  return { name: m.name, parameters: (m.parameters ?? []).map(param) };
}

export function solidityPragmas(unit: SourceUnit): PragmaDirective[] {
  return unit.children.filter((n): n is PragmaDirective => n.type === 'PragmaDirective' && n.name === 'solidity');
}

export function contractsOf(unit: SourceUnit): ContractDefinition[] {
  return unit.children.filter((n: ASTNode): n is ContractDefinition => n.type === 'ContractDefinition');
}

function contractMap(c: ContractDefinition, pragma: readonly string[]): ContractMap {
  const nodes = c.subNodes as ASTNode[];
  return {
    name: c.name,
    kind: contractKind(c.kind),
    pragma: [...pragma],
    inherits: c.baseContracts.map((b) => b.baseName.namePath),
    stateVariables: nodes.flatMap((n) => (n.type === 'StateVariableDeclaration' ? stateVariables(n) : [])),
    functions: nodes.flatMap((n) => (n.type === 'FunctionDefinition' ? [functionMap(n)] : [])),
    events: nodes.flatMap((n) => (n.type === 'EventDefinition' ? [eventMap(n)] : [])),
    modifiers: nodes.flatMap((n) => (n.type === 'ModifierDefinition' ? [modifierMap(n)] : [])),
  };
}

/** Builds the AST map. Arrays keep source order, so equal input gives equal output (3.13). */
export function toAstMap(unit: SourceUnit, meta: SourceMeta): AstMap {
  const pragma = solidityPragmas(unit).map((p) => p.value);
  return {
    schemaVersion: 1,
    source: { name: meta.sourceName, sha256: meta.sha256 },
    contracts: contractsOf(unit).map((c) => contractMap(c, pragma)),
    risks: detectRisks(unit),
  };
}
