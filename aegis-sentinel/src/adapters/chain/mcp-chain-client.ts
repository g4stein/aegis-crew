// Adapter (Node): MCP stdio client for the chain-state server. Spawns the server as a child
// process and translates tool calls into validated core types. No business decisions here.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { err, ok, type Result } from '../../core/result';
import { decodeBroadcastResult, decodeChainReadout, decodeMitigationStatus, type BroadcastResult, type ChainReadout, type MitigationStatus } from '../../core/wire';
import { REPO_ROOT } from '../config/load-guarded';

export const SERVER_ENTRY = resolve(REPO_ROOT, 'aegis-sentinel/mcp/chain-state-server.mjs');

export interface ChainClientOptions {
  /** Extra environment for the server process (merged over the runtime's own). */
  readonly env?: Readonly<Record<string, string>>;
  readonly onLog?: (line: string) => void;
}

export class McpChainClient {
  private client?: Client;
  private transport?: StdioClientTransport;

  constructor(private readonly opts: ChainClientOptions = {}) {}

  async connect(): Promise<void> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
    Object.assign(env, this.opts.env ?? {});
    this.transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], env, cwd: REPO_ROOT, stderr: 'pipe' });
    this.transport.stderr?.on('data', (d: Buffer) => {
      for (const line of d.toString('utf8').split('\n')) if (line.trim()) this.opts.onLog?.(line.trim());
    });
    this.client = new Client({ name: 'aegis-sentinel-runtime', version: '0.1.0' });
    await this.client.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    this.transport = undefined;
  }

  private async call(name: string, args: Record<string, unknown>): Promise<Result<unknown, string>> {
    if (!this.client) return err('chain-state client is not connected');
    try {
      const r = await this.client.callTool({ name, arguments: args });
      if (r.isError) {
        const text = Array.isArray(r.content) ? r.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ') : '';
        return err(`${name}: ${text || 'tool error'}`);
      }
      return ok(r.structuredContent);
    } catch (e) {
      return err(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async readState(): Promise<Result<ChainReadout, string>> {
    const r = await this.call('get_contract_invariants', {});
    return r.ok ? decodeChainReadout(r.value) : r;
  }

  async requestPause(contractId: string, breachId: string, dryRun: boolean): Promise<Result<BroadcastResult, string>> {
    const r = await this.call('broadcast_mitigation_payload', { contract_id: contractId, breach_id: breachId, ...(dryRun ? { dry_run: true } : {}) });
    return r.ok ? decodeBroadcastResult(r.value) : r;
  }

  async mitigationStatus(mitigationId: string): Promise<Result<MitigationStatus, string>> {
    const r = await this.call('get_mitigation_status', { mitigation_id: mitigationId });
    return r.ok ? decodeMitigationStatus(r.value) : r;
  }
}
