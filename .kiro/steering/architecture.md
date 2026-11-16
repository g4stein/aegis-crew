---
inclusion: always
---

# Architecture: Pure Core, Thin Adapters

AEGIS CREW separates deterministic logic from every side effect, so the logic can be property-tested headlessly with no browser, chain, clock, or audio device.

## Layers

| Layer | Forge path | Sentinel path | May import |
|---|---|---|---|
| Pure core | `aegis-forge/src/logic/` | `aegis-sentinel/src/core/` | Other pure-core modules, type-only imports |
| Adapters | `aegis-forge/src/adapters/` | `aegis-sentinel/src/adapters/{chain,audio}/` | Pure core, Node/browser/vendor APIs |
| Entry / UI | `aegis-forge/src/cli/` | `aegis-sentinel/src/ui/` | Pure core, adapters |

Dependencies point inward only: Entry/UI → Adapters → Pure core. The pure core never imports from an adapter or the UI.

## Rules for the pure core

1. Functions are deterministic: the same input always yields the same output.
2. No I/O of any kind. Forbidden in `src/logic/` and `src/core/`:
   - `react`, `react-dom`, any `*.tsx` file
   - `node:fs`, `node:net`, `node:child_process`, `process.env`
   - `fetch`, `WebSocket`, `XMLHttpRequest`
   - `AudioContext` or any WebAudio API
   - `near-api-js`, `@near-js/*`, `viem`, `ethers`, or any chain SDK
   - `Date.now()`, `new Date()`, `performance.now()`, `Math.random()`, `crypto.getRandomValues()`
3. Time, randomness, and configuration are passed in as arguments (for example a `now: number` parameter or an injected `Clock` interface).
4. Data is immutable. Return new objects; do not mutate inputs.
5. Errors are values. Return a discriminated union (`{ ok: true, value } | { ok: false, error }`) rather than throwing across the core boundary.
6. Amounts are `bigint`. Never use `number` for token balances or supply.

Rust is permitted for pure logic (for example a NEAR contract or a WASM invariant engine) under the same rules, exposed to TypeScript only through a typed adapter.

## Rules for adapters

1. One adapter per external system: Solidity parser, file system, NEAR RPC, MPC signer, target-chain broadcaster, WebAudio.
2. Each adapter implements an interface declared in the pure core (ports and adapters). The core defines `interface ChainStateReader`; `adapters/chain/` implements it.
3. Adapters contain no business decisions. They translate, call, and return.
4. Secrets (NEAR access keys, RPC tokens) are read only by adapters, only from environment variables, and are never logged.

## Testing

- Property-based tests live in `<app>/tests/pbt/` and use `vitest` with `fast-check`.
- PBT targets the pure core only. A PBT that needs a mock network or DOM indicates misplaced logic; move the logic into the core.
- Run with `vitest run tests/pbt` from the app directory.
- Every invariant in `.kiro/specs/aegis-protocol/requirements.md` maps to at least one named property.
- Failing seeds are recorded in the test file as regression cases.

## Checklist for new code

- [ ] Is this logic deterministic? If yes, it goes in the pure core.
- [ ] Does it touch the network, disk, clock, DOM, or audio? If yes, it goes in an adapter.
- [ ] Does the pure core import anything from the forbidden list above? If yes, refactor.
