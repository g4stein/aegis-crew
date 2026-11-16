# aegis-forge

Node.js/TypeScript CLI. Ingests a legacy Solidity contract, emits a JSON AST map, and writes a Kiro modernization spec.

| Path | Layer | Rule |
|---|---|---|
| `src/logic/` | Pure core | Deterministic, no I/O. Covered by `tests/pbt/`. |
| `src/adapters/` | Adapters | File system, Solidity parser, spec writer. |
| `src/cli/` | Entry point | Argument parsing and wiring only. |
| `input/` | Drop zone | Legacy `.sol` files to ingest. |
| `tests/pbt/` | Tests | Property-based tests (vitest + fast-check). |

See `.kiro/steering/architecture.md`.
