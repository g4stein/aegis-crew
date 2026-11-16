---
title: "Building a keyless emergency brake for dead smart contracts with Kiro (Kiroween 2026)"
tags: kiro, web3, near, testing
---

<!-- Publish on dev.to, Hashnode, or Medium. Bonus Blog rule: public post that mentions Kiroween 2026. Add the cover image .kiro/artifacts/screenshots/sentinel-08-in-tab-breach.png. -->

For **Kiroween 2026** I built AEGIS CREW: a system that reads a 2019 Solidity contract, writes a modernization spec for it, and guards it with an emergency `pause()` that no human key can sign. It's entered in the Frankenstein category because it stitches together parts that were never meant to meet: legacy EVM code, Kiro's spec-driven agents, NEAR's MPC Chain Signatures, and a Rust guard contract.

Live demo (runs entirely in your browser): https://aegis-crew.vercel.app/?source=live-mock
Code: https://github.com/g4stein/aegis-crew

## The problem with pause keys

Most DeFi contracts that can be paused rely on a privileged key. If a human holds it, the response time is however long it takes to wake someone up. If a bot holds it, the bot's key becomes the most valuable secret in the system, because it can do anything the role allows.

I wanted a defender with the opposite profile: fast, and able to do exactly one harmless thing.

## The shape of the answer

1. **Forge** parses the legacy contract as data. On the sample vault it finds 9 risks and proposes the invariant that matters: `Σ balanceOf = totalSupply`.
2. **Sentinel** enforces that invariant every block. On a breach, a pure, deterministic fast path builds a pause request in 3 to 8 ms. There's no LLM in that path.
3. **Aegis Guard**, a NEAR contract, is the only door to a signer. The Sentinel's key may call `request_pause(contract_id, breach_id)` and nothing else. The guard builds `pause()` itself, runs 13 checks, and pays the MPC deposit.
4. **NEAR Chain Signatures** signs the Ethereum transaction via MPC. There is no private key to steal.

The guard exists because of one constraint I didn't expect. NEAR's MPC `sign` method requires an attached deposit, and NEAR function-call keys (the restricted kind you'd give a bot) can't attach deposits. A restricted bot key can't sign directly, so the contract pays, and the bot can only ask.

## Spec first, with Kiro

I started with `.kiro/specs/aegis-protocol/requirements.md` in EARS syntax, then a design with 20 named correctness properties, then a task list. Two steering files did most of the shaping:

- `architecture.md`: the logic lives in a pure core (no I/O, no clock, no randomness, `bigint` for amounts, errors as values). Adapters do the I/O. That's what makes every rule property-testable without a chain.
- `ui-manifesto.md`: the dashboard is "Editorial Brutalism," a printed security bulletin with a 1px grid, mono and serif type, and no gradients, blur, or rounded corners. Acid Green appears only during a real breach. A hook audits every UI write against it.

The hook I'd recommend to anyone is `pbt-guard`: before any `git commit` that touches core code, it runs the property suite and blocks the commit on failure. It never got in the way, and it caught real regressions.

## Bugs the process found

- **Property P9** shrank a failure to three events, `breach → paused_observed → timeout`: the state machine re-submitted a sign request after the contract was already paused.
- **The agent chain.** Dropping the vault into `aegis-forge/input/` fired a hook that started the Archivist agent, which ran the CLI and reported that my reentrancy detector had *missed* one in `deposit()`.
- **Mutation testing.** I injected 36 bugs on purpose. The first round let 3 through, so I strengthened the generators until all 36 were caught.

## A 1-in-128 bug in an Ethereum transaction encoder

My favorite finding. `omni-transaction` 0.5.0, NEAR's multi-chain transaction builder, appends signature `r` and `s` to the RLP stream as raw 32-byte strings. RLP integers must not have leading zeros. When `r` or `s` starts with `0x00` (probability `1 − (255/256)² ≈ 1/128`), the transaction is non-canonical, and go-ethereum rejects it with `rlp: non-canonical integer`.

That's the worst kind of bug: it passes every test you write by hand and fails in production about once a week. The fix is three lines. The guard strips leading zeros, 310 cross-language vectors pin the bytes, and the mock MPC *always* returns an `r` with a leading zero so the safe path runs on every demo. The issue write-up is in the repo under `docs/upstream/`.

## Making the demo honest

Judges click links, so the Vercel deploy had to work with no server. The runtime loop was already environment-neutral behind a `ChainStateClient` port, so the browser runs the *same* loop, mock chain, and guard mirror as the Node runtime. It even hashes the bundled Forge file, and the hash matches the server's. A test walks the bundle's import graph to prove it never reaches Node-only code or anything near a key.

What's still mock: the dashboard's chain. The guard's TypeScript mirror is proven equivalent to the Rust contract by vectors the contract generates.

## Then I ran it on a real network

A GitHub Actions workflow deploys the Rust guard to NEAR testnet on fresh accounts. The guard account has no access keys at all, and the Sentinel account's only key is a function-call key for `request_pause`. The first run with a real MPC signature failed: my guard rejected a valid signature. I had assumed the parity in the signature point's prefix equals `recovery_id`, but the MPC network normalizes `s`, which flips it. Every mocked test was built on the same wrong assumption, so they all passed. After the fix, [the next run](https://github.com/g4stein/aegis-crew/actions/runs/43944959335) went through: a signature for `pause()` came back 8.2 s after the request, its signer recovered to the MPC-derived address, and the guard refused a non-Sentinel caller, a replayed breach, and the Sentinel key calling an owner method. That bug is now a regression test that replays the real signature through `ecrecover`.

## Takeaways

- Write the invariant as a requirement before it's a test, and the test before it's code.
- Give agents the least privilege that works. The Sentinel agent has no shell and no write access, and it can't choose a payload.
- Keep LLMs out of anything with a latency budget. The Crew supervises; deterministic code acts.

Built for #Kiroween 2026 with Kiro.
