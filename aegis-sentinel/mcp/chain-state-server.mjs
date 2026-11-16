#!/usr/bin/env node
// chain-state MCP server (stdio), exposing the tools defined in .kiro/mcp/chain-state-mcp.json:
//   get_contract_invariants, broadcast_mitigation_payload, get_mitigation_status
//
// The server builds the pause() payload itself and enforces the allowlist; callers pass only
// contract_id + breach_id (+ dry_run). Mock mode reads config/guarded.json, the Forge invariants
// it names, and mcp/fixtures/mock-chain.json. .env is loaded at startup (dotenv, quiet).
//
// The implementation is TypeScript (mcp/src) so it can share the Sentinel's pure core;
// tsx compiles it on the fly. stdout carries MCP messages only; logs go to stderr.
import { register } from 'tsx/esm/api';

register();
const { startChainStateServer } = await import('./src/server.ts');
try {
  await startChainStateServer();
} catch (e) {
  process.stderr.write(`[chain-state] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
