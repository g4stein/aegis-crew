// Forge output model. Mirrors schema/ast-map.schema.json (Requirement 3.2, 3.3).

export interface Loc {
  readonly line: number;
  readonly column: number;
}

export interface Param {
  readonly name: string;
  readonly type: string;
}

export interface StateVariableMap {
  readonly name: string;
  readonly type: string;
  readonly visibility: string;
  readonly constant: boolean;
  readonly immutable: boolean;
}

export interface FunctionMap {
  readonly name: string;
  readonly kind: 'function' | 'constructor' | 'fallback' | 'receive';
  readonly visibility: string;
  readonly mutability: string;
  readonly modifiers: readonly string[];
  readonly parameters: readonly Param[];
  readonly returns: readonly Param[];
  readonly loc: Loc;
}

export interface EventMap {
  readonly name: string;
  readonly parameters: readonly (Param & { readonly indexed: boolean })[];
}

export interface ModifierMap {
  readonly name: string;
  readonly parameters: readonly Param[];
}

export interface ContractMap {
  readonly name: string;
  readonly kind: 'contract' | 'abstract' | 'interface' | 'library';
  readonly pragma: readonly string[];
  readonly inherits: readonly string[];
  readonly stateVariables: readonly StateVariableMap[];
  readonly functions: readonly FunctionMap[];
  readonly events: readonly EventMap[];
  readonly modifiers: readonly ModifierMap[];
}

export type RiskId = 'legacy-pragma' | 'tx-origin-auth' | 'unchecked-call' | 'call-before-write';

export interface Risk {
  readonly id: RiskId;
  readonly severity: 'high' | 'medium';
  readonly confidence: 'certain' | 'heuristic';
  readonly contract: string;
  readonly function?: string;
  readonly loc: Loc;
  readonly message: string;
}

export interface AstMap {
  readonly schemaVersion: 1;
  readonly source: { readonly name: string; readonly sha256: string };
  readonly contracts: readonly ContractMap[];
  readonly risks: readonly Risk[];
}

/** Same shape as an entry in aegis-sentinel/config/guarded.json `invariants`. */
export interface ProposedInvariant {
  readonly id: 'balance-conservation';
  readonly kind: 'balance-conservation';
  readonly contract: string;
  readonly balances: string;
  readonly supply: string;
}
