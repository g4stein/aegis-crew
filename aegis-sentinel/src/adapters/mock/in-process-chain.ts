// Adapter (browser or Node): ChainStateClient over a MockChain in the same process.
// Every response goes through the same wire encode -> JSON -> decode path that the chain-state
// MCP server and McpChainClient use, so the runtime loop sees identical, validated data.
// What it skips is the stdio hop and the JSON Schema check against .kiro/mcp/chain-state-mcp.json.
import type { ChainStateClient } from '../../core/chain';
import { err, type Result } from '../../core/result';
import {
  decodeBroadcastResult,
  decodeChainReadout,
  decodeMitigationStatus,
  encodeBroadcastResult,
  encodeChainReadout,
  encodeMitigationStatus,
  type BroadcastResult,
  type ChainReadout,
  type MitigationStatus,
} from '../../core/wire';
import type { MockChain } from './mock-chain';

const overTheWire = (o: Record<string, unknown>): unknown => JSON.parse(JSON.stringify(o));

export class InProcessChainClient implements ChainStateClient {
  constructor(private readonly chain: MockChain) {}

  async readState(): Promise<Result<ChainReadout, string>> {
    return decodeChainReadout(overTheWire(encodeChainReadout(this.chain.readout())));
  }

  async requestPause(contractId: string, breachId: string, dryRun: boolean): Promise<Result<BroadcastResult, string>> {
    return decodeBroadcastResult(overTheWire(encodeBroadcastResult(this.chain.broadcast(contractId, breachId, dryRun))));
  }

  async mitigationStatus(mitigationId: string): Promise<Result<MitigationStatus, string>> {
    const s = this.chain.status(mitigationId);
    return s ? decodeMitigationStatus(overTheWire(encodeMitigationStatus(s))) : err(`get_mitigation_status: unknown mitigation_id ${mitigationId}`);
  }

  async close(): Promise<void> {
    this.chain.stop();
  }
}
