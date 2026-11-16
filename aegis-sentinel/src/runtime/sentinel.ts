// Sentinel runtime (Node). Owns the 500 ms fast path (Requirement 2.1):
//   read_state -> evaluate -> encode -> gate -> submit_sign
// Every decision is a pure core function; this file only sequences I/O. No LLM is involved.
//
// Serves the dashboard on 127.0.0.1 (AEGIS_RUNTIME_PORT, default 8787):
//   GET  /api/snapshot   current snapshot (wire JSON)
//   GET  /api/stream     Server-Sent Events, one `snapshot` event per change
//   POST /api/restart    restart the mock chain (mock mode only; header x-aegis-request: 1)
//   GET  /*              the built dashboard from aegis-sentinel/dist, if present
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { bytesToHex } from '../core/bytes';
import type { GuardedEntry } from '../core/config';
import { intentFromPayload, planFastPath, reevaluate } from '../core/fastpath';
import { approveSignRequest } from '../core/mitigation/gate';
import { encodeEip1559Unsigned } from '../core/mitigation/payload';
import type { Allowlist } from '../core/mitigation/types';
import type { ContractSnapshot, LogEvent, LogLevel, SentinelSnapshot } from '../core/model';
import { encodeSnapshot, type ChainContractStatus, type MitigationStatus } from '../core/wire';
import { McpChainClient } from '../adapters/chain/mcp-chain-client';
import { loadGuardedConfig, REPO_ROOT } from '../adapters/config/load-guarded';
import { keccakHex } from '../adapters/crypto/keccak';

const intEnv = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

const PORT = intEnv('AEGIS_RUNTIME_PORT', 8787);
const POLL_MS = intEnv('AEGIS_POLL_MS', 100);
const BUDGET_MS = 500;
const MAX_STATE_AGE_MS = 2_000;
const MAX_EVENTS = 60;
const MODE = process.env.AEGIS_CHAIN_MODE ?? 'mock';
const DIST = resolve(REPO_ROOT, 'aegis-sentinel/dist');

interface Tracked {
  readonly mitigationId: string;
  readonly breachId: string;
  readonly t0: number;
  readonly signRequestSubmitted: number;
  readonly nearTxHash?: string;
  status?: MitigationStatus;
}

class Runtime {
  private client?: McpChainClient;
  private readonly allowlist: Allowlist;
  private latest = new Map<string, { status: ChainContractStatus; readAtMs: number }>();
  private tracked = new Map<string, Tracked>();
  private submitted = new Set<string>();
  private noted = new Set<string>();
  private events: LogEvent[] = [];
  private seq = 0;
  private failures = 0;
  private snapshotJson = '';
  private readonly listeners = new Set<(json: string) => void>();
  private stopped = false;

  constructor(private readonly entries: readonly GuardedEntry[]) {
    this.allowlist = new Map(entries.map((e) => [e.guarded.contractId, e.guarded] as const));
  }

  log(level: LogLevel, message: string): void {
    this.seq += 1;
    this.events = [{ seq: this.seq, atMs: Date.now(), level, message }, ...this.events].slice(0, MAX_EVENTS);
    process.stderr.write(`[runtime] ${level.toUpperCase().padEnd(8)} ${message}\n`);
  }

  private noteOnce(key: string, level: LogLevel, message: string): void {
    if (this.noted.has(key)) return;
    this.noted.add(key);
    this.log(level, message);
  }

  async connect(): Promise<void> {
    this.client = new McpChainClient({
      env: { AEGIS_CHAIN_MODE: MODE },
      onLog: (line) => this.log(line.includes('BUG') || line.includes('fatal') ? 'critical' : 'info', line.replace(/^\[chain-state\] /, 'mcp: ')),
    });
    await this.client.connect();
    this.log('info', `connected to chain-state MCP server (stdio, mode ${MODE})`);
  }

  async restart(): Promise<void> {
    await this.client?.close();
    this.latest = new Map();
    this.tracked = new Map();
    this.submitted = new Set();
    this.noted = new Set();
    this.failures = 0;
    this.log('info', 'restarting mock chain');
    await this.connect();
  }

  onSnapshot(fn: (json: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  currentJson(): string {
    return this.snapshotJson;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      const started = Date.now();
      await this.pollOnce().catch((e: unknown) => this.log('critical', `poll failed: ${e instanceof Error ? e.message : String(e)}`));
      this.publish();
      await new Promise((r) => setTimeout(r, Math.max(0, POLL_MS - (Date.now() - started))));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.client?.close();
  }

  private async pollOnce(): Promise<void> {
    const client = this.client;
    if (!client) return;

    // 1. read_state
    const read = await client.readState();
    if (!read.ok) {
      this.failures += 1;
      this.noteOnce(`read-fail-${this.failures > 5 ? 'many' : 'first'}`, 'critical', `read_state failed: ${read.error}`);
      if (this.failures === 5) await this.restart().catch(() => undefined);
      return;
    }
    this.failures = 0;
    const tRead = Date.now();

    for (const status of read.value.contracts) {
      this.latest.set(status.contractId, { status, readAtMs: read.value.readAtMs });

      // 2. evaluate (pure). t0 is the moment the core reports the breach.
      const decision = planFastPath({ status, readAtMs: read.value.readAtMs, nowMs: Date.now(), maxStateAgeMs: MAX_STATE_AGE_MS, submitted: this.submitted });
      const t0 = Date.now();
      if (decision.kind === 'none') {
        if (decision.reason === 'no_breach_id') this.noteOnce(`nobid-${status.contractId}`, 'warn', `${status.contractId}: breach without breach_id; cannot request a pause`);
        continue;
      }
      if (decision.kind === 'reread') {
        this.noteOnce(`stale-${decision.breachId}`, 'warn', `${status.contractId}: state older than ${MAX_STATE_AGE_MS} ms; re-reading before mitigating (2.14)`);
        continue;
      }
      this.log('critical', `INVARIANT BREACHED ${decision.invariantId} on ${status.contractId} (breach ${decision.breachId})`);
      await this.fastPath(client, status.contractId, decision.breachId, t0, tRead);
    }

    // Mirror mitigation progress from the server (signature, broadcast, confirmation).
    for (const t of this.tracked.values()) {
      if (t.status?.state === 'confirmed' || t.status?.state === 'failed') continue;
      const s = await client.mitigationStatus(t.mitigationId);
      if (!s.ok) continue;
      const before = t.status?.state;
      t.status = s.value;
      if (before !== s.value.state) {
        const level: LogLevel = s.value.state === 'confirmed' ? 'info' : s.value.state === 'failed' ? 'critical' : 'warn';
        this.log(level, `${t.mitigationId}: ${s.value.state.replace('_', ' ')}${s.value.targetTxHash ? ` (target tx ${s.value.targetTxHash.slice(0, 12)}…)` : ''}`);
      }
    }
  }

  /** encode -> gate -> submit_sign. Refuses to submit if the server's payload does not check out. */
  private async fastPath(client: McpChainClient, contractId: string, breachId: string, t0: number, tRead: number): Promise<void> {
    this.submitted.add(breachId);
    const dry = await client.requestPause(contractId, breachId, true);
    if (!dry.ok) {
      this.submitted.delete(breachId);
      this.log('critical', `dry run failed: ${dry.error}`);
      return;
    }
    if (dry.value.status === 'refused' || !dry.value.payload) {
      if (dry.value.refusalReason === 'breach_not_current') this.submitted.delete(breachId);
      this.log('warn', `server refused pause for ${contractId}: ${dry.value.refusalReason ?? 'no payload'}`);
      return;
    }
    const p = dry.value.payload;

    // 3. encode: rebuild the transaction from the server's fields and check its bytes and hash.
    const intent = intentFromPayload(contractId, p);
    if (!intent.ok) return this.log('critical', `refusing to submit: ${intent.error}`);
    const unsigned = encodeEip1559Unsigned(intent.value);
    if (!unsigned.ok) return this.log('critical', `refusing to submit: ${unsigned.error.message}`);
    if (bytesToHex(unsigned.value) !== p.unsignedTx.toLowerCase() || keccakHex(unsigned.value) !== p.payloadHash.toLowerCase()) {
      return this.log('critical', 'refusing to submit: server payload does not match its own fields');
    }
    const tEncode = Date.now();

    // 4. gate: the runtime's own allowlist, target, chain, selector, and value checks (2.8, 2.9).
    const gate = approveSignRequest(intent.value, this.allowlist);
    if (!gate.ok) return this.log('critical', `refusing to submit: gate ${gate.error.reason}`);
    const tGate = Date.now();

    // 5. submit_sign
    const sub = await client.requestPause(contractId, breachId, false);
    const ack = Date.now();
    if (!sub.ok) {
      this.submitted.delete(breachId);
      return this.log('critical', `submit failed: ${sub.error}`);
    }
    if (sub.value.status !== 'submitted' || !sub.value.mitigationId) return this.log('warn', `server refused submission: ${sub.value.refusalReason ?? sub.value.status}`);
    if (sub.value.payload?.payloadHash !== p.payloadHash) this.log('critical', 'server signed a different payload than the one verified');

    this.tracked.set(contractId, {
      mitigationId: sub.value.mitigationId,
      breachId,
      t0,
      signRequestSubmitted: ack,
      ...(sub.value.signRequest?.nearTxHash ? { nearTxHash: sub.value.signRequest.nearTxHash } : {}),
    });
    const total = ack - t0;
    const stages = `read ${Math.max(0, t0 - tRead)} · encode ${tEncode - t0} · gate ${tGate - tEncode} · submit ${ack - tGate} ms`;
    this.log(total <= BUDGET_MS ? 'warn' : 'critical', `fast path detect-to-submit ${total} ms of ${BUDGET_MS} ms (${stages}); server detect-to-submit ${sub.value.timings?.detectToSubmit ?? '?'} ms`);
  }

  private snapshot(): SentinelSnapshot {
    const contracts: ContractSnapshot[] = [];
    for (const { status, readAtMs } of this.latest.values()) {
      const t = this.tracked.get(status.contractId);
      const st = t?.status;
      contracts.push({
        contractId: status.contractId,
        chain: status.chain,
        address: status.address as `0x${string}`,
        blockNumber: status.blockNumber,
        readAtMs,
        paused: status.paused,
        invariants: reevaluate(status.invariants),
        mitigation: t
          ? {
              state: st?.state ?? 'pending_signature',
              id: t.mitigationId,
              attempts: 1,
              ...(t.nearTxHash ? { nearTxHash: t.nearTxHash } : {}),
              ...(st?.targetTxHash ? { targetTxHash: st.targetTxHash } : {}),
              timeline: {
                t0: t.t0,
                signRequestSubmitted: t.signRequestSubmitted,
                ...(st?.timings.signatureReceived ? { signatureReceived: st.timings.signatureReceived } : {}),
                ...(st?.timings.broadcast ? { broadcast: st.timings.broadcast } : {}),
                ...(st?.timings.confirmed ? { confirmed: st.timings.confirmed } : {}),
              },
            }
          : { state: status.mitigation.state, attempts: 0, timeline: {} },
      });
    }
    const p = this.entries[0]?.provenance;
    return {
      network: `MOCK CHAIN / ${this.entries[0]?.chain ?? '—'}`,
      mode: 'mock',
      budgetMs: BUDGET_MS,
      contracts,
      events: this.events,
      source: {
        kind: 'live-mock',
        link: 'open',
        ...(p ? { invariantsFile: p.invariantsFile, invariantsSha256: p.invariantsSha256, sourceSha256: p.sourceSha256 } : {}),
      },
    };
  }

  private publish(): void {
    const json = JSON.stringify(encodeSnapshot(this.snapshot()));
    if (json === this.snapshotJson) return;
    this.snapshotJson = json;
    for (const l of this.listeners) l(json);
  }
}

// ---- HTTP -------------------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function send(res: ServerResponse, code: number, type: string, body: string | Buffer): void {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end(body);
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  if (!existsSync(DIST)) return send(res, 404, 'text/plain; charset=utf-8', 'Dashboard not built. Run: npm run -w aegis-sentinel build');
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  let file = normalize(join(DIST, path));
  if (!file.startsWith(DIST + sep) && file !== DIST) return send(res, 403, 'text/plain', 'forbidden');
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  send(res, 200, TYPES[extname(file)] ?? 'application/octet-stream', readFileSync(file));
}

async function main(): Promise<void> {
  const entries = loadGuardedConfig();
  if (!entries.ok) throw new Error(entries.error);
  const rt = new Runtime(entries.value);
  for (const e of entries.value) {
    rt.log('info', `guarding ${e.guarded.contractId}: invariants from ${e.provenance.invariantsFile} (Forge, source sha256 ${e.provenance.sourceSha256.slice(0, 12)}…)`);
  }
  await rt.connect();

  const http = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/api/snapshot' && req.method === 'GET') return send(res, 200, 'application/json', rt.currentJson() || '{}');
    if (url === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
      const push = (json: string) => res.write(`event: snapshot\ndata: ${json}\n\n`);
      if (rt.currentJson()) push(rt.currentJson());
      const off = rt.onSnapshot(push);
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => {
        off();
        clearInterval(ping);
      });
      return;
    }
    if (url === '/api/restart') {
      // A custom header forces a CORS preflight, which this server never answers, so other origins cannot trigger it.
      if (req.method !== 'POST' || req.headers['x-aegis-request'] !== '1') return send(res, 403, 'text/plain', 'forbidden');
      if (MODE !== 'mock') return send(res, 409, 'text/plain', 'restart is only available in mock mode');
      void rt.restart().then(
        () => send(res, 204, 'text/plain', ''),
        (e: unknown) => send(res, 500, 'text/plain', e instanceof Error ? e.message : String(e)),
      );
      return;
    }
    if (url?.startsWith('/api/')) return send(res, 404, 'text/plain', 'not found');
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
    serveStatic(req, res);
  });
  http.listen(PORT, '127.0.0.1', () => rt.log('info', `dashboard and API on http://127.0.0.1:${PORT}`));

  const shutdown = () => {
    void rt.stop().finally(() => http.close(() => process.exit(0)));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await rt.run();
}

main().catch((e: unknown) => {
  process.stderr.write(`[runtime] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
