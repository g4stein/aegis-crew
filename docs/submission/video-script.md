# Demo video script (target 2:50, hard limit 3:00)

Rules: public on YouTube, under 3 minutes, no copyrighted music (use silence or a royalty-free track from the YouTube Audio Library). Record at 1440×1000 or 1920×1080. Judges may stop at 3:00, so the payoff (the confirmed pause) must land before 2:00.

**Prep:** open `https://aegis-crew.vercel.app/?source=live-mock` in one tab but don't load it yet; the breach fires 15 s after load. In a terminal, have the repo cloned and `npm install` done. Use a large font.

| Time | Screen | Voice-over (about 150 words per minute) |
|---|---|---|
| 0:00–0:15 | Black title card: "Old contracts don't die. They keep holding money." Then `aegis-forge/input/legacy-vault.sol`, scrolled to `tx.origin` and `call.value`. | "This vault was written in 2019. It still compiles in our heads as safe, but it isn't: `tx.origin` auth, unchecked calls, and a reentrancy. When it's exploited, someone has to pause it. Today that means a human with a key, or a bot whose stolen key can do anything." |
| 0:15–0:45 | Terminal: `npx aegis-forge ingest aegis-forge/input/legacy-vault.sol --force`. Highlight `9 risks` and `invariants LegacyVault:balance-conservation`. Cut to `.kiro/specs/legacy-vault-modernization/requirements.md` (EARS lines). | "AEGIS Forge reads it as data, never running it. It finds 9 risks, proposes the invariant that matters, total supply equals the sum of balances, and writes a full Kiro spec for the rewrite. That invariants file is exactly what the Sentinel will enforce." |
| 0:45–1:00 | Load the Vercel tab. Point at masthead `LIVE-MOCK · IN-TAB` and the ledger's `Defined by` row with the file path and sha256. | "This is the Sentinel, live, in your browser. Same runtime as the server, same Forge file; check the hash." |
| 1:00–1:20 | Breach fires: Acid Green bulletin, `[!] BREACH`, `+500,000`. Hold on the Mitigation cell: `3 ms / 500 ms`. | "A reentrant withdraw mis-credits half a million shares. The Sentinel detects it and submits a pause request in 3 milliseconds. No AI model is in this path; it's pure, property-tested code." |
| 1:20–1:45 | Scroll the event log to `aegis-guard: request_pause … 13 checks passed` and `paid 1 yoctoNEAR sign deposit`, then `on_signature -> signed … leading zero byte, encoded canonically`. | "The request goes to the Aegis Guard, a NEAR contract. The Sentinel's key can call one method and pass two IDs. The guard builds `pause()` itself, runs 13 checks, pays the deposit, and NEAR Chain Signatures signs for Ethereum through MPC. No private key exists." |
| 1:45–2:00 | Bulletin turns off-white: `legacy-vault is paused.` `NO HUMAN KEY USED`. | "Contained. Worst case, a stolen Sentinel key pauses a contract. It can't move a cent." |
| 2:00–2:30 | Fast cuts: `.kiro/` tree (specs, steering, hooks, agents, crew.yaml); `pbt-guard` blocking a commit, then `PBT suite passed. Commit allowed.`; the mutation-testing list in the README. | "Kiro built this spec-first. EARS requirements, 20 correctness properties at a thousand runs each, and a hook that blocks any commit that breaks them. We injected 36 bugs on purpose; the tests caught all 36. The first time the agent chain ran, the Archivist caught a reentrancy our own detector missed." |
| 2:30–2:45 | `docs/upstream/omni-transaction-leading-zero.md` and the `canonical_int` function in `pause-tx/src/lib.rs`. | "Along the way we found that NEAR's transaction builder produces a transaction Ethereum nodes reject, about 1 time in 128. We fixed it, pinned 310 vectors, and wrote it up upstream." |
| 2:45–2:55 | Repo URL and the Vercel URL on a black card. | "AEGIS CREW. Dead code in, verified spec out, keyless defense on top. Try it in your browser now." |

**If the testnet proof has run green before recording:** replace 2:30–2:45 with the NearBlocks page for the `request_pause` transaction and the GitHub Actions summary ("signer = derived address"), and say: "This isn't only a mock: here is the guard on NEAR testnet, a real MPC signature, and the signer matching the derived address."

**Don't say:** "deployed on mainnet", "billions", "production-ready", or anything about testnet before the workflow has passed.
