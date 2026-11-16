# aegis-forge

Node.js/TypeScript CLI. Ingests a legacy Solidity contract, emits a JSON AST map, and writes a Kiro modernization spec.

## Run

```sh
npx aegis-forge ingest aegis-forge/input/legacy-vault.sol            # from the repo root
npm run -w aegis-forge ingest -- aegis-forge/input/legacy-vault.sol  # same, via npm
npx aegis-forge ingest                                               # every input/*.sol without a spec yet
```

Options: `--out <dir>` (default `aegis-forge/output`), `--specs-dir <dir>` (default `.kiro/specs`), `--force` (replace an existing spec; the old one is restored if the write fails). A parse error exits 1, prints `file:line:column`, and writes nothing. Input is parsed only, never compiled or executed.

## Layout

| Path | Layer | Rule |
|---|---|---|
| `src/logic/` | Pure core | Deterministic, no I/O; imports only types from the parser. Covered by `tests/pbt/`. |
| `src/adapters/` | Adapters | Solidity parser (the only runtime parser import), file reading and atomic writing. |
| `src/cli/` | Entry point | Argument parsing and wiring only. |
| `bin/aegis-forge.mjs` | Entry point | Runs the CLI through `tsx`; no build step. |
| `schema/ast-map.schema.json` | Data | JSON Schema for `<name>.ast.json`. |
| `input/` | Drop zone | Legacy `.sol` files to ingest. Never modified by the CLI. |
| `output/` | Generated | `<name>.ast.json` and `<name>.invariants.json`, written by the CLI only. |
| `tests/pbt/` | Tests | P13–P16 (vitest + fast-check) and the legacy-vault golden test. |

See `.kiro/steering/architecture.md`.
