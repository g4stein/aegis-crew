// Domain types shared by the Sentinel core, adapters, and UI.
// Pure module: types and constants only. See .kiro/specs/aegis-protocol/design.md (Data Models).

export type Address = `0x${string}`;

export type InvariantStatus = 'holding' | 'breached';

export interface InvariantReading {
  readonly id: string;
  /** Requirement ID in .kiro/specs/aegis-protocol/requirements.md, e.g. "1.2". */
  readonly requirement: string;
  readonly label: string;
  readonly status: InvariantStatus;
  /** For balance conservation: totalSupply. */
  readonly expected: bigint;
  /** For balance conservation: sum of balanceOf over all holders. */
  readonly observed: bigint;
  readonly breachId?: string;
  /** t0 for Requirement 2.1. */
  readonly detectedAtMs?: number;
}

export type MitigationState =
  | 'none'
  | 'pending_signature'
  | 'signed'
  | 'broadcast'
  | 'confirmed'
  | 'failed'
  | 'refused';

/** Requirement 2.4 timestamps, Unix ms. */
export interface MitigationTimeline {
  readonly t0?: number;
  readonly signRequestSubmitted?: number;
  readonly signatureReceived?: number;
  readonly broadcast?: number;
  readonly confirmed?: number;
}

export interface Mitigation {
  readonly state: MitigationState;
  readonly id?: string;
  readonly attempts: number;
  readonly nearTxHash?: string;
  readonly targetTxHash?: string;
  readonly timeline: MitigationTimeline;
}

export interface ContractSnapshot {
  readonly contractId: string;
  /** CAIP-2 chain ID, e.g. "eip155:11155111". */
  readonly chain: string;
  readonly address: Address;
  readonly blockNumber: bigint;
  readonly readAtMs: number;
  readonly paused: boolean;
  readonly invariants: readonly InvariantReading[];
  readonly mitigation: Mitigation;
}

export type LogLevel = 'info' | 'warn' | 'critical';

export interface LogEvent {
  readonly seq: number;
  readonly atMs: number;
  readonly level: LogLevel;
  readonly message: string;
}

export type SourceKind = 'scripted' | 'live-mock';
export type LinkState = 'connecting' | 'open' | 'lost';

/** Where a snapshot came from, and where its invariants were defined. */
export interface FeedSource {
  readonly kind: SourceKind;
  readonly link: LinkState;
  /** Live-mock only: where the runtime loop runs (a Node process, or this browser tab). */
  readonly host?: 'node' | 'browser';
  /** Repo-relative path of the Forge invariants file that defined the registry. */
  readonly invariantsFile?: string;
  readonly invariantsSha256?: string;
  /** sha256 of the Solidity source the Forge ingested. */
  readonly sourceSha256?: string;
}

export interface SentinelSnapshot {
  readonly network: string;
  readonly mode: 'mock' | 'live';
  /** Requirement 2.1 budget in ms. */
  readonly budgetMs: number;
  readonly contracts: readonly ContractSnapshot[];
  readonly events: readonly LogEvent[];
  readonly source?: FeedSource;
}

export const IN_FLIGHT_STATES: ReadonlySet<MitigationState> = new Set<MitigationState>([
  'pending_signature',
  'signed',
  'broadcast',
]);
