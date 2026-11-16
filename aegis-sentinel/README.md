# aegis-sentinel

Vite/React/TypeScript live monitoring dashboard. Evaluates contract invariants against live chain state and signs a `pause` mitigation through NEAR Chain Signatures on a critical breach.

| Path | Layer | Rule |
|---|---|---|
| `src/core/` | Pure core | Invariant evaluation, payload formatting. No I/O. Covered by `tests/pbt/`. |
| `src/adapters/chain/` | Adapter | NEAR RPC, MPC signer, target-chain broadcast. |
| `src/adapters/audio/` | Adapter | WebAudio alarm output. |
| `src/ui/` | Presentation | React components. Must follow `.kiro/steering/ui-manifesto.md`. |
| `tests/pbt/` | Tests | Property-based tests (vitest + fast-check). |

See `.kiro/steering/architecture.md`.
