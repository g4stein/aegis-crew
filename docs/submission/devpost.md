# Devpost submission: AEGIS CREW

Paste each section into the matching Devpost field. Every number here is checked against the repo (see "Fact sheet" at the end) and must be rechecked if the code changes.

- **Category:** Frankenstein
- **Bonus prizes to tick:** Best Kiro Crew App, Bonus Blog, Social Blitz (Best Demo needs no extra step)
- **Repo:** https://github.com/g4stein/aegis-crew (public, MIT, `/.kiro` at root)
- **Working app:** https://aegis-crew.vercel.app/?source=live-mock
- **Video:** _YouTube URL, public, under 3:00_

---

## Tagline (one line)

Reads a dead 2019 smart contract, writes its spec, and guards it with no human key.

## Inspiration

Old smart contracts don't die; they keep holding funds. Contracts written for Solidity 0.4 often have patterns we now know are dangerous (`tx.origin` auth, unchecked calls, state written after external calls), and many have no one left who will touch them. When an exploit starts, the usual defense is a human with a pause key, or a multisig that takes minutes to gather. A hot key held by a bot is no better: whoever steals it can do anything the key can do.

We wanted the opposite: a defender that is fast, and that can do exactly one harmless thing.

## What it does

AEGIS CREW is one pipeline built from four parts that were never designed to meet.

1. **Forge (CLI)** reads a legacy Solidity file as data, never compiling or running it. For our 2019-era vault it flags 9 risks (3 legacy-pragma, 1 `tx.origin` auth, 1 unchecked call, 4 call-before-write), proposes a balance-conservation invariant, and writes a full Kiro modernization spec (requirements in EARS syntax, design, tasks).
2. **Sentinel (dashboard + runtime)** loads that exact invariants file (the dashboard shows its sha256), evaluates it every block, and on a breach builds the case for a pause in a pure, deterministic fast path: 3 to 8 ms from detection to sign request, against a 500 ms budget. No LLM is in that path.
3. **Aegis Guard (NEAR contract, Rust)** is the only way the Sentinel can reach a signer. The Sentinel's key may call `request_pause(contract_id, breach_id)` and nothing else. The guard builds the `pause()` transaction itself, runs 13 ordered checks (allowlist, target, chain, selector, zero value, fee caps, quote freshness, rate limit, no duplicate or in-flight request, balance), pays the signing deposit, and asks NEAR Chain Signatures to sign.
4. **NEAR Chain Signatures** signs the Ethereum transaction through MPC. No private key for the target chain exists anywhere: not in the bot, the browser, or an agent's context.

A stolen Sentinel key can, at worst, pause an allowlisted contract, slowly.

The live demo runs the whole pipeline in the browser: the same runtime loop, mock chain, and conformance-tested guard mirror as the Node runtime, with no server and no keys.

## How we built it (and how we used Kiro)

Spec first, then code, with every commit gated by property tests.

- **Specs.** `.kiro/specs/aegis-protocol/` holds EARS requirements, a design with 20 named correctness properties, and a task plan we checked off as we went. The Forge *generates* a second spec (`legacy-vault-modernization/`), and a golden test fails if anyone edits it by hand.
- **Steering.** `architecture.md` forces a pure core (no I/O, no clock, no randomness, `bigint` for amounts, errors as values) behind thin adapters, so all logic is property-testable headless. `ui-manifesto.md` defines the Editorial Brutalist dashboard and bans gradients, blur, rounded corners, and decorative color.
- **Hooks.** `pbt-guard` runs the property suite before any `git commit` that touches core code and blocks on failure (a git pre-commit hook does the same outside Kiro). `spec-audit` checks every UI write against the manifesto. `archivist-intake` fires when a new `.sol` file lands in the Forge input folder.
- **Custom agents.** `aegis-archivist` may only run the ingest CLI and write spec/output paths. `aegis-verifier` is read-only and runs the tests. `aegis-sentinel` has MCP tools only: no shell, no writes.
- **MCP.** A chain-state MCP server whose tool schema (`.kiro/mcp/chain-state-mcp.json`) is the single source of truth: the server serves it verbatim and validates every input and output against it. Callers pass only `contract_id` and `breach_id`; they can't choose a payload.
- **Kiro Crew.** `.kiro/crew.yaml` describes the three-agent swarm and `scripts/crew/install.sh` registers its schedules (an intake check every 2 minutes, a Sentinel heartbeat every minute).
- **Property-based testing.** 20 properties, each tied to a requirement ID, 1,000 generated cases each: 338 Sentinel tests, 7 Forge tests, 15 end-to-end tests, 18 Rust guard tests.
- **Vibe sessions on top of specs.** Exploratory work (repo audits, Vercel build failures, the in-browser runtime) happened in Kiro Web vibe sessions, and the Playwright power captured the screenshots used as evidence. The PBT gate applied to every change.

The hook-to-agent chain caught a real bug on its first run: creating the vault file fired `archivist-intake`, and the Archivist reported that the Forge had **missed a reentrancy** in `deposit()`. We fixed detector R4, regenerated the spec, and the Verifier re-ran both suites.

## Challenges we ran into

- **The signing deposit.** NEAR's MPC `sign` call needs an attached deposit, and NEAR function-call keys can't attach deposits. A restricted bot key could never sign directly. That one constraint is why the Aegis Guard exists: the guard pays the deposit, and the bot's key can only ask.
- **A 1-in-128 encoding bug.** `omni-transaction` 0.5.0 (NEAR's transaction builder) appends signature `r` and `s` as raw 32-byte strings. When either starts with a zero byte (about 1 in 128 MPC signatures), the transaction isn't canonical RLP, and go-ethereum rejects it (`rlp: non-canonical integer`). We strip leading zeros, pin 310 Rust-to-TypeScript vectors byte for byte, and force a leading-zero `r` in every mock run so the fix is always exercised. We wrote up the upstream issue (`docs/upstream/`).
- **Making property tests honest.** We injected 36 bugs on purpose (14 in the TypeScript cores, 10 in the Rust guard, 12 in its TypeScript mirror). The first round let 3 through, so we strengthened the generators until every one was caught.
- **Keeping the browser keyless.** The demo runs the runtime in the tab, so a test walks the bundle's import graph and fails if it ever reaches the Node host, the chain adapters, the MCP server, or Node-only packages.

## Accomplishments that we're proud of

- A defender whose worst case is "pauses a contract that should have stayed live": no key, no arbitrary calldata, no funds movement.
- A Rust contract and its TypeScript mirror proven equivalent by vectors generated from the contract itself.
- A dashboard that reads like a printed security bulletin, where Acid Green appears only during a real breach, and the bulletin also carries a text label and an ARIA live region.

## What we learned

Spec-driven development pays off most where mistakes are expensive. Writing the invariant as an EARS requirement first, then a property, then code, meant the property test found a state-machine bug (re-signing after the contract was already paused) before any chain did.

## What's next for AEGIS CREW

- Run the testnet proof workflow (scripted in `.github/workflows/testnet-proof.yml`) and publish the explorer links.
- Live EVM adapters (task 6), then a Sepolia end-to-end with a real pausable token (task 11).
- File the `omni-transaction` issue and PR.

## Honest limitations

- The demo chain is a mock. The guard is enforced by its TypeScript mirror, which is proven equivalent to the Rust contract by conformance vectors.
- The Rust contract is unit-tested in near-sdk's mocked blockchain and builds to wasm. Its testnet deployment is scripted but has not run yet.

---

## Best Kiro Crew App (bonus field)

**Repo:** https://github.com/g4stein/aegis-crew (Crew manifest: `.kiro/crew.yaml`; installer: `scripts/crew/install.sh`)

**Features and functionality:** AEGIS CREW runs a least-privilege, three-agent Crew:

- **Archivist** (every 2 minutes, plus a file-create hook): finds new `.sol` files in `aegis-forge/input/`, runs the Forge CLI, and checks that the generated spec is valid EARS. It may run only the ingest command and write only to the spec and output paths.
- **Verifier** (on hand-off and before every commit): runs the property suites and reports which invariants hold. It is read-only.
- **Sentinel** (persistent heartbeat every 60 s): reads live invariant state through the chain-state MCP server, catches a breach the fast path missed, flags a stalled signature, and confirms containment. It has MCP tools only: no shell, no writes.

The Crew is deliberately *not* in the 500 ms path. An LLM heartbeat can't meet that budget, so the deterministic runtime does the pausing, and the Crew supervises it.

> **Before submitting:** run `scripts/crew/install.sh` with Kiro Crew, let one heartbeat report `HOLDING`, and add a screenshot or log to `.kiro/artifacts/`. Task 7.3 tracks this; until it's done, describe the Crew as configured, not as observed running.

---

## Fact sheet (source of every number)

| Claim | Value | Source |
|---|---|---|
| Forge risks on the sample | 9 (3 legacy-pragma, 1 tx-origin-auth, 1 unchecked-call, 4 call-before-write) | `aegis-forge/output/legacy-vault.ast.json` |
| Guard checks | 13 | `CHECKS` in `contracts/aegis-guard/src/lib.rs`; `GUARD_CHECKS` in `src/core/guard.ts` |
| Detect-to-submit | 3 ms (in-tab), 7–8 ms (Node + MCP stdio), budget 500 ms | `tests/e2e/*`, screenshot 08, `.kiro/artifacts/live-mock/runtime.log` |
| Properties | 20 (P1–P20), 1,000 runs each | `.kiro/specs/aegis-protocol/design.md`, `tests/pbt/setup.ts` |
| Tests | 338 Sentinel PBT, 7 Forge, 15 e2e, 18 guard (Rust), 3 pause-tx (Rust) | `npm run -w aegis-sentinel test:pbt` etc. |
| Mutations caught | 36 of 36 (14 + 10 + 12) | README, Mutation testing |
| Encoding vectors | 310 | `tests/vectors/eip1559-pause.json` |
| Leading-zero rate | 1 − (255/256)² ≈ 0.78% ≈ 1 in 128 | arithmetic |
| Guard wasm | 264,188 bytes (cargo-near 0.23, Rust 1.86, wasm-opt) | CI artifact `aegis-guard-wasm` |

Do not use: "billions in legacy contracts" or "$100B+" (no source), "runnable by a judge in minutes" for the Forge (it needs a clone and `npm install`; the Vercel view is instant), or "deployed on testnet" until the proof workflow has run green.
