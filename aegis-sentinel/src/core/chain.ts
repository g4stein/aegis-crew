// Port for reading guarded-contract state and requesting a pause (ports and adapters).
// Implemented by adapters/chain/mcp-chain-client.ts (Node, MCP stdio to the chain-state server)
// and adapters/mock/in-process-chain.ts (browser, the same mock chain without the stdio hop).
// Type-only module.
import type { Result } from './result';
import type { BroadcastResult, ChainReadout, MitigationStatus } from './wire';

export interface ChainStateClient {
  /** get_contract_invariants */
  readState(): Promise<Result<ChainReadout, string>>;
  /** broadcast_mitigation_payload. The server builds the payload; callers pass only IDs. */
  requestPause(contractId: string, breachId: string, dryRun: boolean): Promise<Result<BroadcastResult, string>>;
  /** get_mitigation_status */
  mitigationStatus(mitigationId: string): Promise<Result<MitigationStatus, string>>;
  close(): Promise<void>;
}

/** Where the Sentinel runtime loop is running. */
export type RuntimeHost = 'node' | 'browser';

/**
 * Picks the runtime host for the live-mock view. An explicit choice wins; otherwise a reachable
 * Node runtime is preferred, and the in-browser runtime is the fallback (for static hosting).
 */
export function chooseRuntimeHost(forced: RuntimeHost | undefined, nodeReachable: boolean): RuntimeHost {
  return forced ?? (nodeReachable ? 'node' : 'browser');
}
