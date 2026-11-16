// Sentinel runtime, Node host. Runs the shared fast-path loop (runtime/loop.ts) against the
// chain-state MCP server over stdio, and serves the dashboard on 127.0.0.1
// (AEGIS_RUNTIME_PORT, default 8787):
//   GET  /api/snapshot   current snapshot (wire JSON)
//   GET  /api/stream     Server-Sent Events, one `snapshot` event per change
//   POST /api/restart    restart the mock chain (mock mode only; header x-aegis-request: 1)
//   GET  /*              the built dashboard from aegis-sentinel/dist, if present
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { LogLevel } from '../core/model';
import { McpChainClient } from '../adapters/chain/mcp-chain-client';
import { loadGuardedConfig, REPO_ROOT } from '../adapters/config/load-guarded';
import { keccakHex } from '../adapters/crypto/keccak';
import { SentinelLoop } from './loop';

const intEnv = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

const PORT = intEnv('AEGIS_RUNTIME_PORT', 8787);
const POLL_MS = intEnv('AEGIS_POLL_MS', 100);
const MODE = process.env.AEGIS_CHAIN_MODE ?? 'mock';
const DIST = resolve(REPO_ROOT, 'aegis-sentinel/dist');

const stderrSink = (level: LogLevel, message: string) => process.stderr.write(`[runtime] ${level.toUpperCase().padEnd(8)} ${message}\n`);

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
  let path: string;
  try {
    // A malformed escape (e.g. "/%E0%A4%A") throws URIError; it must not crash the runtime.
    path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  } catch {
    return send(res, 400, 'text/plain', 'bad request');
  }
  if (path.includes('\0')) return send(res, 400, 'text/plain', 'bad request');
  let file = normalize(join(DIST, path));
  if (!file.startsWith(DIST + sep) && file !== DIST) return send(res, 403, 'text/plain', 'forbidden');
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  send(res, 200, TYPES[extname(file)] ?? 'application/octet-stream', readFileSync(file));
}

async function main(): Promise<void> {
  const entries = loadGuardedConfig();
  if (!entries.ok) throw new Error(entries.error);
  const rt: SentinelLoop = new SentinelLoop({
    entries: entries.value,
    host: 'node',
    pollMs: POLL_MS,
    now: () => Date.now(),
    keccakHex,
    sink: stderrSink,
    connectedMessage: `connected to chain-state MCP server (stdio, mode ${MODE})`,
    connect: async () => {
      const client = new McpChainClient({
        env: { AEGIS_CHAIN_MODE: MODE },
        onLog: (line) => rt.log(line.includes('BUG') || line.includes('fatal') ? 'critical' : 'info', line.replace(/^\[chain-state\] /, 'mcp: ')),
      });
      await client.connect();
      return client;
    },
  });
  for (const e of entries.value) {
    rt.log('info', `guarding ${e.guarded.contractId}: invariants from ${e.provenance.invariantsFile} (Forge, source sha256 ${e.provenance.sourceSha256.slice(0, 12)}…)`);
  }
  await rt.connect();

  const http = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/api/snapshot' && req.method === 'GET') return send(res, 200, 'application/json', rt.currentJson() || '{}');
    if (url === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
      res.on('error', () => undefined); // a client that vanished mid-write must not crash the runtime
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
    try {
      serveStatic(req, res);
    } catch (e) {
      // Last line of defense: one bad request (unreadable file, race with a rebuild) never kills the fast path.
      rt.log('warn', `static file error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) send(res, 500, 'text/plain', 'internal error');
      else res.end();
    }
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
