# aegis-sentinel

Vite/React/TypeScript dashboard plus a Node runtime. Evaluates contract invariants against chain state read through the chain-state MCP server, and requests a `pause()` through NEAR Chain Signatures on a critical breach.

## Run

```sh
npm install                              # repo root
npm run -w aegis-sentinel build          # build the dashboard
npm run -w aegis-sentinel runtime        # runtime + MCP server; open http://127.0.0.1:8787/?source=live-mock
```

The dashboard has two data sources:
- **Scripted**: a timeline played in the browser. No runtime needed (`npm run -w aegis-sentinel dev`).
- **Live-mock**: the runtime's SSE stream. The runtime spawns `mcp/chain-state-server.mjs` over stdio, reads `config/guarded.json`, and loads invariants from the Forge output it names (`aegis-forge/output/legacy-vault.invariants.json`). The mock chain mis-credits shares 15 s after start; **Restart mock chain** replays it.

## Layout

| Path | Layer | Rule |
|---|---|---|
| `src/core/` | Pure core | Invariants, gate, payload, state machine, fast-path decisions, wire codecs, config validation. No I/O. Covered by `tests/pbt/`. |
| `src/adapters/chain/` | Adapter (Node) | MCP stdio client for the chain-state server. |
| `src/adapters/config/`, `src/adapters/crypto/` | Adapter (Node) | Config file loading, keccak256. |
| `src/adapters/feed/`, `src/adapters/mock/` | Adapter (browser) | SSE feed, scripted feed. |
| `src/adapters/audio/` | Adapter | WebAudio alarm output. |
| `src/runtime/` | Entry (Node) | Fast path loop and local HTTP/SSE API. |
| `src/ui/` | Presentation | React components. Must follow `.kiro/steering/ui-manifesto.md`. |
| `mcp/` | Entry (Node) | chain-state MCP server; tools from `.kiro/mcp/chain-state-mcp.json`. |
| `contracts/pause-tx/` | Rust | `pause()` transaction builder; emits `tests/vectors/`. |
| `tests/pbt/` | Tests | Property-based tests (vitest + fast-check), run by the pre-commit guard. |
| `tests/e2e/` | Tests | Runtime + MCP server end to end (`npm run -w aegis-sentinel test:e2e`). |

See `.kiro/steering/architecture.md`.
