# Requirements Document: AEGIS Protocol

## Introduction

AEGIS CREW modernizes legacy Solidity contracts and guards them in production.

- **Aegis Forge** (`aegis-forge/`) is a CLI. It parses a legacy Solidity file, emits a JSON AST map, and writes a Kiro modernization spec.
- **Aegis Sentinel** (`aegis-sentinel/`) is a dashboard. It evaluates contract invariants against live chain state. When an invariant breaks, it signs a `pause` mitigation through NEAR Chain Signatures.

All requirements use EARS (Easy Approach to Requirements Syntax). Each one follows exactly one pattern:

| Pattern | Template |
|---|---|
| Ubiquitous | The `<system>` SHALL `<response>`. |
| Event-driven | WHEN `<trigger>`, the `<system>` SHALL `<response>`. |
| State-driven | WHILE `<state>`, the `<system>` SHALL `<response>`. |
| Unwanted behavior | IF `<condition>`, THEN the `<system>` SHALL `<response>`. |
| Optional feature | WHERE `<feature>`, the `<system>` SHALL `<response>`. |

## Glossary

- **Balance invariant**: For a token contract, `Σ balanceOf(a)` over all accounts `a` equals `totalSupply`, and every `balanceOf(a) ≥ 0`. The set of invariants is pre-defined per contract in an invariant registry.
- **State transition**: A function applied to contract state, for example `transfer`, `mint`, `burn`, or `approve`.
- **PBT suite**: Property-based tests in `<app>/tests/pbt/` written with `vitest` and `fast-check`.
- **Critical PBT failure**: An invariant property evaluated against live chain state returns `false`. Detection time `t0` is the moment the Sentinel core returns that result.
- **Mitigation payload**: An unsigned target-chain transaction that calls the guarded contract's `pause()` function.
- **Chain Signatures**: NEAR's MPC signing service. A NEAR account calls the MPC contract's `sign` method with a payload hash and a derivation path. The MPC network returns a signature for the derived address on the target chain.
- **Sentinel signer account**: The NEAR account the Sentinel uses to request signatures.
- **Aegis Guard contract**: A NEAR contract that holds the allowlist, builds the `pause()` transaction, pays the MPC deposit, and calls the MPC `sign` method. The Sentinel signer account may call only its `request_pause` method.

---

## Requirements

### Requirement 1: Balance invariant enforcement (Invariant 1)

**User Story:** As a protocol owner, I want every state transition checked against the balance invariant, so that no transition can create or destroy value.

**Invariant statement:** The system SHALL reject any state transition that violates the pre-defined balance invariant, as verified by the PBT suite.

#### Acceptance Criteria

1. **1.1 (Ubiquitous)** The invariant engine SHALL evaluate every registered invariant against the post-state of each proposed state transition before the transition is accepted.
2. **1.2 (Unwanted)** IF a proposed state transition produces a post-state that violates the balance invariant, THEN the invariant engine SHALL reject the transition and return the pre-state unchanged.
3. **1.3 (Unwanted)** IF a transition is rejected, THEN the invariant engine SHALL return an error value naming the violated invariant, the transition, and the pre-state and post-state totals.
4. **1.4 (Unwanted)** IF a transition would make any account balance negative, THEN the invariant engine SHALL reject the transition.
5. **1.5 (Ubiquitous)** The invariant engine SHALL be deterministic and free of I/O, as defined in `.kiro/steering/architecture.md`.
6. **1.6 (Ubiquitous)** The PBT suite SHALL include a property asserting that, for any generated initial state and any generated sequence of transitions, every accepted post-state satisfies the balance invariant.
7. **1.7 (Ubiquitous)** The PBT suite SHALL include a property asserting that every generated transition that violates the balance invariant is rejected.
8. **1.8 (Ubiquitous)** The PBT suite SHALL run at least 1,000 generated cases per invariant property.
9. **1.9 (Ubiquitous)** The invariant engine SHALL represent all balances and supplies as `bigint`.

---

### Requirement 2: Autonomous mitigation via NEAR Chain Signatures (Invariant 2)

**User Story:** As a protocol owner, I want the Sentinel to pause my contract on its own when an invariant breaks, so that an exploit is stopped faster than a human can respond, without anyone holding the target-chain private key.

**Invariant statement:** The Sentinel SHALL autonomously format and sign a 'pause' mitigation payload via NEAR Chain Signatures within 500ms of detecting a critical PBT failure, without requiring human key management.

#### Acceptance Criteria

**Detection and latency**

1. **2.1 (Event-driven)** WHEN the Sentinel detects a critical PBT failure, the Sentinel SHALL format a mitigation payload and submit a Chain Signatures `sign` request within 500ms of `t0`.
2. **2.2 (Event-driven)** WHEN the MPC network returns a signature, the Sentinel SHALL assemble the signed transaction and broadcast it to the target chain.
3. **2.3 (Unwanted)** IF no signature is returned within `SIGNATURE_TIMEOUT_MS`, THEN the Sentinel SHALL raise a critical alert in the dashboard and resubmit the `sign` request once.
4. **2.4 (Ubiquitous)** The Sentinel SHALL record `t0`, the sign-request submission time, the signature receipt time, and the broadcast time for each mitigation.

**Autonomy without human key management**

5. **2.5 (Ubiquitous)** The Sentinel SHALL obtain the target-chain signature from Chain Signatures and SHALL NOT store, load, or derive a target-chain private key.
6. **2.6 (Ubiquitous)** The Sentinel SHALL complete a mitigation without a human approval step.

**Scope of signing authority**

7. **2.7 (Ubiquitous)** The Sentinel signer account SHALL use a NEAR function-call access key restricted to the Aegis Guard contract's `request_pause` method, and the Aegis Guard contract SHALL be the only caller of the MPC contract's `sign` method on the Sentinel's behalf. (The MPC `sign` method requires an attached deposit, which function-call keys cannot attach.)
8. **2.8 (Unwanted)** IF a payload's target address is not in the guarded-contract allowlist, THEN the Sentinel SHALL refuse to request a signature.
9. **2.9 (Unwanted)** IF a payload's calldata is anything other than the `pause()` function selector, THEN the Sentinel SHALL refuse to request a signature.
10. **2.10 (Ubiquitous)** The Sentinel SHALL use a fixed derivation path per guarded contract, defined in configuration.
11. **2.11 (Ubiquitous)** The Sentinel SHALL read the signer access key only from an environment variable and SHALL NOT write it to logs, the UI, or storage.

**Duplicate and false-positive protection**

12. **2.12 (State-driven)** WHILE a mitigation for a contract is in flight, the Sentinel SHALL NOT submit a second mitigation for the same contract.
13. **2.13 (Event-driven)** WHEN the target chain reports the contract as paused, the Sentinel SHALL stop issuing mitigations for that contract.
14. **2.14 (Unwanted)** IF the chain-state read that produced the failure is older than `MAX_STATE_AGE_MS`, THEN the Sentinel SHALL re-read state before mitigating.

**Testability**

15. **2.15 (Ubiquitous)** Payload formatting and the allowlist and selector checks SHALL be pure functions in `aegis-sentinel/src/core/`, covered by the PBT suite.
16. **2.16 (Ubiquitous)** The PBT suite SHALL include a property asserting that for any generated target address and calldata, the core approves a sign request only if the address is allowlisted and the calldata equals the `pause()` selector.

**Dashboard**

17. **2.17 (Event-driven)** WHEN a critical PBT failure is detected, the dashboard SHALL display the breach in Acid Green (`#CCFF00`) with a `[!] BREACH` text label and an ARIA live region, as defined in `.kiro/steering/ui-manifesto.md`.

---

### Requirement 3: Legacy contract ingestion (Invariant 3)

**User Story:** As a developer inheriting a legacy contract, I want the Forge to turn a Solidity file into a structured map and a modernization plan, so that I can upgrade the contract through Kiro's spec workflow.

**Invariant statement:** The Forge CLI SHALL parse a provided legacy Solidity file and output a structured JSON AST map and a corresponding `.kiro/specs/` modernization plan.

#### Acceptance Criteria

**Parsing**

1. **3.1 (Event-driven)** WHEN the user runs `aegis-forge ingest <file.sol>`, the Forge CLI SHALL parse the file and write `<name>.ast.json` to the output directory.
2. **3.2 (Ubiquitous)** The JSON AST map SHALL list, for each contract, its pragma version, inheritance chain, state variables (name, type, visibility), functions (name, visibility, mutability, modifiers, parameters), events, and modifiers.
3. **3.3 (Ubiquitous)** The JSON AST map SHALL validate against a published JSON Schema in `aegis-forge/schema/ast-map.schema.json`.
4. **3.4 (Event-driven)** WHEN a `.sol` file is added to `aegis-forge/input/`, the Forge SHALL be able to ingest it without additional arguments.

**Modernization plan**

5. **3.5 (Event-driven)** WHEN parsing succeeds, the Forge CLI SHALL write `.kiro/specs/<contract-name>-modernization/` containing `requirements.md`, `design.md`, and `tasks.md`.
6. **3.6 (Ubiquitous)** The generated `requirements.md` SHALL use EARS syntax.
7. **3.7 (Ubiquitous)** The generated plan SHALL list detected legacy risks, including pragma below `0.8.0` (unchecked arithmetic), `tx.origin` authentication, unchecked low-level `call` return values, and external calls before state updates (reentrancy).
8. **3.8 (Ubiquitous)** The generated plan SHALL propose at least one balance invariant per token-like contract for registration with the invariant engine (Requirement 1).

**Errors and safety**

9. **3.9 (Unwanted)** IF the Solidity file fails to parse, THEN the Forge CLI SHALL exit with a non-zero code, print the line and column of the error, and write no output files.
10. **3.10 (Unwanted)** IF the target spec directory already exists, THEN the Forge CLI SHALL refuse to overwrite it unless `--force` is passed.
11. **3.11 (Ubiquitous)** The Forge CLI SHALL treat input Solidity as data and SHALL NOT compile, execute, or deploy it.

**Determinism and testability**

12. **3.12 (Ubiquitous)** The AST-to-map transform and the plan generator SHALL be pure functions in `aegis-forge/src/logic/`.
13. **3.13 (Ubiquitous)** The Forge CLI SHALL produce byte-identical output for the same input file.
14. **3.14 (Ubiquitous)** The PBT suite SHALL include a property asserting that for any generated valid AST, the map round-trips (map → JSON → parse) without loss and validates against the schema.

---

## Open Questions

1. **Signature latency.** Chain Signatures returns the signature asynchronously through the MPC network over multiple NEAR blocks, so a full signature round-trip in 500ms is not expected. Criterion 2.1 therefore applies the 500ms budget to detection, formatting, and sign-request submission. `SIGNATURE_TIMEOUT_MS` should be set after measuring testnet latency.
2. **Target chain.** Which EVM chain hosts the guarded contract (for example Sepolia)? This fixes the transaction format and the broadcast adapter.
3. **`MAX_STATE_AGE_MS`.** What staleness is acceptable for the state read that triggers a mitigation?
4. **Pause authority.** The derived Chain Signatures address must hold the pause role on the guarded contract. Who grants it, and is it pause-only (no unpause)?
