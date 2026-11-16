// chain-state MCP server (stdio). Tool definitions are served verbatim from
// .kiro/mcp/chain-state-mcp.json; every input and output is validated against that file.
//
// stdout is the MCP channel. Never write to it directly: all logging goes to stderr.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { encodeBroadcastResult, encodeChainReadout, encodeMitigationStatus } from '../../src/core/wire';
import { loadGuardedConfig, loadGuardSettings, REPO_ROOT } from '../../src/adapters/config/load-guarded';
import { prepareEnv } from './env';
import { MockChain, type ChainFixture } from './mock-chain';

const log = (msg: string) => process.stderr.write(`[chain-state] ${msg}\n`);

interface ToolSchemaFile {
  readonly server: { readonly name: string; readonly version: string };
  readonly tools: readonly (Tool & { inputSchema: object; outputSchema?: object })[];
}

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const fromRoot = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));
const intEnv = (name: string, fallback: number) => {
  const v = process.env[name];
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
};

const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

export async function startChainStateServer(): Promise<void> {
  // .env supplies signer settings for live mode. Real environment values win; unexpanded
  // "${VAR}" placeholders from the MCP host count as unset, so .env is used instead.
  const prepared = prepareEnv(process.env, resolve(REPO_ROOT, '.env'));
  if (prepared.unset.length > 0) log(`ignored unexpanded placeholders for ${prepared.unset.join(', ')}; using .env or unset`);
  const mode = process.env.AEGIS_CHAIN_MODE ?? 'mock';

  const schemaPath = fromRoot(process.env.AEGIS_TOOL_SCHEMA ?? '.kiro/mcp/chain-state-mcp.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as ToolSchemaFile;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validators = new Map<string, { input: ValidateFunction; output?: ValidateFunction }>();
  for (const t of schema.tools) {
    validators.set(t.name, { input: ajv.compile(t.inputSchema), ...(t.outputSchema ? { output: ajv.compile(t.outputSchema) } : {}) });
  }

  let chain: MockChain | undefined;
  if (mode === 'mock') {
    const configPath = process.env.AEGIS_GUARDED_CONFIG ? fromRoot(process.env.AEGIS_GUARDED_CONFIG) : undefined;
    const entries = loadGuardedConfig(configPath);
    if (!entries.ok) throw new Error(entries.error);
    const settings = loadGuardSettings(configPath);
    if (!settings.ok) throw new Error(settings.error);
    const fixture = JSON.parse(readFileSync(fromRoot(process.env.AEGIS_MOCK_FIXTURE ?? 'aegis-sentinel/mcp/fixtures/mock-chain.json'), 'utf8')) as ChainFixture;
    const breachAt = process.env.AEGIS_MOCK_BREACH_AT_MS;
    chain = new MockChain(
      entries.value,
      settings.value,
      fixture,
      {
        ...(breachAt !== undefined && breachAt !== '' ? { breachAtMs: intEnv('AEGIS_MOCK_BREACH_AT_MS', 15_000) } : {}),
        signatureMs: intEnv('AEGIS_MOCK_SIGNATURE_MS', 6_400),
        broadcastMs: intEnv('AEGIS_MOCK_BROADCAST_MS', 250),
        confirmMs: intEnv('AEGIS_MOCK_CONFIRM_MS', 12_000),
      },
      log,
    );
    chain.start();
    for (const e of entries.value) log(`guarding ${e.guarded.contractId} (${e.chain} ${e.guarded.address}); invariants from ${e.provenance.invariantsFile} sha256 ${e.provenance.invariantsSha256.slice(0, 12)}`);
  } else {
    log(`AEGIS_CHAIN_MODE=${mode}: live mode is not implemented in this build; tools will return errors`);
  }

  const handlers: Record<string, (args: Record<string, unknown>) => Record<string, unknown> | string> = {
    get_contract_invariants: (args) => {
      const readout = chain!.readout();
      const id = args.contract_id as string | undefined;
      return encodeChainReadout(id ? { ...readout, contracts: readout.contracts.filter((c) => c.contractId === id) } : readout);
    },
    broadcast_mitigation_payload: (args) =>
      encodeBroadcastResult(chain!.broadcast(args.contract_id as string, args.breach_id as string, args.dry_run === true)),
    get_mitigation_status: (args) => {
      const s = chain!.status(args.mitigation_id as string);
      return s ? encodeMitigationStatus(s) : `unknown mitigation_id ${String(args.mitigation_id)}`;
    },
  };

  const server = new Server({ name: schema.server.name, version: schema.server.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: schema.tools as Tool[] }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<ToolResult> => {
    const name = req.params.name;
    const v = validators.get(name);
    const handler = handlers[name];
    if (!v || !handler) return fail(`unknown tool ${name}`);
    const args = req.params.arguments ?? {};
    if (!v.input(args)) return fail(`invalid arguments for ${name}: ${ajv.errorsText(v.input.errors)}`);
    if (!chain) return fail(`AEGIS_CHAIN_MODE=${mode}: live mode is not implemented in this build`);
    const out = handler(args as Record<string, unknown>);
    if (typeof out === 'string') return fail(out);
    if (v.output && !v.output(out)) {
      log(`BUG: ${name} produced output that violates its outputSchema: ${ajv.errorsText(v.output.errors)}`);
      return fail(`internal error: ${name} output failed schema validation`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
  });

  const shutdown = () => {
    chain?.stop();
    void server.close().finally(() => process.exit(0));
  };
  process.stdin.on('end', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await server.connect(new StdioServerTransport());
  log(`ready (mode ${mode}, ${schema.tools.length} tools from ${schemaPath.replace(REPO_ROOT + '/', '')})`);
}
