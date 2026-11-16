# Implementation Plan: AEGIS Protocol

Each task lists the requirements it covers. Tasks marked `*` are optional for the hackathon demo. Pure-core tasks come before their adapters, so property tests exist before any I/O code does.

- [ ] 1. Workspace tooling
  - [x] 1.1 Add TypeScript, `vitest`, and `fast-check` to both apps; add `tests/pbt/setup.ts` with `fc.configureGlobal({ numRuns: 1000 })`
    - Add `test:pbt` scripts that run `vitest run tests/pbt` in each app
    - _Requirements: 1.8_
  - [ ] 1.2 Run `npm install` at the root so `prepare` sets `core.hooksPath` to `.githooks`; confirm the pbt-guard blocks a commit with a failing property
    - _Requirements: 1.6, 1.7_

- [x] 2. Sentinel UI foundation
  - [x] 2.1 Vite + React + TypeScript app shell with self-hosted JetBrains Mono and Playfair Display
  - [x] 2.2 Design tokens and base CSS from `ui-manifesto.md` (five colors, 1px collapsed grid borders, `gap: 0`, `border-radius: 0`, instant motion)
  - [x] 2.3 Primitives: `Grid`/`Cell`, `Heading`, `Label`, `Glyph`, `Button`, `LedgerTable`, `Meter`
  - [x] 2.4 Regions: Masthead, Bulletin, Contracts, Invariant ledger, Mitigation timeline, Event log, Colophon
  - [x] 2.5 Snapshot types, pure `severity` and `format` modules in `src/core/`, mock feed adapter with demo scenarios
    - _Requirements: 2.17_

- [x] 3. Sentinel invariant engine (pure core)
  - [x] 3.1 Implement `TokenState`, `Transition`, `applyTransition`, `evaluate` in `src/core/invariants/`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.9_
  - [x] 3.2 Write P1 `conservation` and P2 `violations-rejected`
    - _Requirements: 1.6, 1.7_
  - [x] 3.3 Write P3 `rejection-preserves-state`, P4 `no-negative-balances`, P5 `engine-determinism`
    - _Requirements: 1.2, 1.3, 1.4, 1.5_

- [x] 4. Sentinel mitigation core
  - [x] 4.1 Implement `approveSignRequest` and `PAUSE_SELECTOR`; write P6 `gate-soundness`
    - _Requirements: 2.8, 2.9, 2.16_
  - [x] 4.2 Implement `formatPauseIntent` and EIP-1559 RLP encoders (unsigned and signed); write P7 `payload-shape`
    - _Requirements: 2.1, 2.15_
  - [x] 4.3 Implement the mitigation state machine `step`; write P8 `single-in-flight`, P9 `stops-when-paused`, P10 `stale-state-reread`, P11 `timeline-monotonic`
    - _Requirements: 2.3, 2.4, 2.12, 2.13, 2.14_
  - [x] 4.4 Write P12 `acid-iff-critical` against `src/core/severity.ts`
    - _Requirements: 2.17_

- [ ] 5. Aegis Guard contract (NEAR, Rust)
  - [x] 5.1 Scaffold `contracts/aegis-guard` with `near-sdk`; owner-only `set_guarded` / `remove_guarded`
    - _Requirements: 2.8, 2.10_
  - [x] 5.2 Implement `request_pause(contract_id, breach_id)`: predecessor check, allowlist, in-flight/duplicate, rate limit, fee-quote freshness, on-chain `enforce` of the built tx (target, chain, selector, value, fee caps), balance check, EIP-1559 `pause()` build via `pause-tx`, keccak hash, MPC `sign` with 1 yN deposit, `on_signature` callback; events and views
    - `SignRequestArgs` / `SignatureResponse` shapes verified against near/mpc (`near-mpc-crypto-types`, wire-format snapshot)
  - [x] 5.2a Unit tests (near-sdk mocked blockchain, mocked MPC): 18 tests incl. allowlist, selector, fee cap, rate limit, duplicate/in-flight, caller, deposit, callback; 10 mutations caught
    - _Requirements: 2.3, 2.7, 2.8, 2.9, 2.12, 2.15_
  - [x] 5.2b Conformance vectors `tests/vectors/aegis-guard.json` from the contract; TS mirror `core/guard.ts` replays them (P20) and is checked against an independent oracle (P19); mock chain-state server runs the mirror
    - _Requirements: 2.5, 2.8, 2.9, 2.12_
    - _Requirements: 2.5, 2.7, 2.8, 2.9, 2.10_
  - [ ] 5.3 `near-workspaces` sandbox tests for the guard (needs the `wasm32-unknown-unknown` target; not installable in this sandbox)
    - _Requirements: 2.8, 2.9, 2.16_
  - [x] 5.4 `contracts/pause-tx` (Rust, omni-transaction) emits 310 vectors; Sentinel test matches unsigned bytes, signing hash, and signed bytes for every vector
    - _Requirements: 2.15_
  - [ ] 5.5 Deploy to testnet; add a function-call key for the Sentinel account restricted to `request_pause` and one for the fee oracle restricted to `update_fee_quote`; fund the guard for sign deposits; record the derived EVM address
    - _Requirements: 2.5, 2.7_

- [ ] 6. Sentinel chain adapters and runtime
  - [ ] 6.1 `evm-reader` (Multicall3 reads at a pinned block, holder set from `Transfer` logs) and `evm-prefetch`
    - _Requirements: 2.1, 2.14_
  - [ ] 6.2 `near-guard-client` with cached access-key nonce and block hash, `broadcast_tx_async`, status polling
    - _Requirements: 2.1, 2.2, 2.11_
  - [ ] 6.3 `evm-broadcaster`
    - _Requirements: 2.2_
  - [ ] 6.4 `runtime/sentinel.ts` loop (done against the MCP server in mock mode: fast path, SSE, restart; live adapters pending); `/api/snapshot`, `/api/stream` (SSE), `/api/mitigate` on `127.0.0.1`; secret redaction in logs
    - _Requirements: 2.1, 2.2, 2.4, 2.6, 2.11, 2.12_
  - [x] 6.5 `adapters/feed/sse-feed.ts`; switch `main.tsx` to SSE when `VITE_SENTINEL_FEED_URL` is set
    - _Requirements: 2.17_

- [ ] 7. Chain-state MCP server
  - [x] 7.1 `mcp/chain-state-server.mjs` (stdio) serving the tools in `.kiro/mcp/chain-state-mcp.json`; `mock` mode from fixtures (live mode: tasks 5–6)
    - _Requirements: 2.6, 2.12_
  - [ ] 7.2 Register the server in `.kiro/settings/mcp.json` (env: `AEGIS_CHAIN_MODE`, `AEGIS_TOOL_SCHEMA`; signer settings come from `.env`); add the file manually if the sandbox blocks writes
  - [ ] 7.3 Run `scripts/crew/install.sh`; confirm a heartbeat reports `HOLDING`, then `BREACH→MITIGATING` after an injected breach

- [x] 8. Forge parsing and AST map
  - [x] 8.1 `adapters/solidity-parser.ts` around `@solidity-parser/parser` with locations and structured errors
    - _Requirements: 3.1, 3.9, 3.11_
  - [x] 8.2 `logic/ast-map.ts`, `logic/canonical-json.ts`, `schema/ast-map.schema.json`
    - _Requirements: 3.2, 3.3, 3.12, 3.13_
  - [x] 8.3 Write P13 `ast-map-roundtrip` and P14 `forge-determinism`
    - _Requirements: 3.13, 3.14_

- [x] 9. Forge risks, invariants, and plan
  - [x] 9.1 `logic/risks.ts` detectors R1–R4; write P15 `risk-detection`
    - _Requirements: 3.7_
  - [x] 9.2 `logic/invariants.ts` token-like detection and `balance-conservation` proposal; output `<name>.invariants.json` in the Sentinel config format
    - _Requirements: 3.8_
  - [x] 9.3 `logic/plan.ts` renders EARS `requirements.md`, `design.md`, `tasks.md`; write P16 `ears-only`
    - _Requirements: 3.5, 3.6_

- [x] 10. Forge CLI
  - [x] 10.1 `cli/main.ts` `ingest [file] [--out] [--specs-dir] [--force]`; no-arg mode scans `input/`
    - _Requirements: 3.1, 3.4_
  - [x] 10.2 `adapters/fs-writer.ts` with temp directory and atomic rename; overwrite refusal
    - _Requirements: 3.9, 3.10_
  - [x] 10.3 Golden test: `input/legacy-vault.sol` (pragma ^0.4.24, `tx.origin`, unchecked `call`, reentrancy) → committed CLI outputs, byte for byte (`tests/pbt/legacy-vault.golden.test.ts`)
    - _Requirements: 3.1–3.13_

- [ ] 11. End-to-end demo
  - [ ] 11.1 Deploy a pausable legacy-style token to Sepolia; grant the pause role to the derived address
    - _Requirements: 2.5_
  - [ ] 11.2 Ingest it with the Forge; register the proposed invariant in `config/guarded.json`
    - _Requirements: 3.8_
  - [ ] 11.3 Inject a breach (test-only mint that skips `totalSupply`); record `t0 → signRequestSubmitted` for 50 runs and report p50/p99 against 500ms
    - _Requirements: 2.1, 2.4_
  - [ ]* 11.4 WebAudio alarm adapter, enabled by a user toggle
    - _Requirements: 2.17_
  - [ ]* 11.5 Record the demo video against the live dashboard
