# AEGIS CREW: Kiroween 2026 playbook (corrected)

Deadline: **Friday, December 4, 2026, 2:00 PM PT.** Judging runs Dec 16, 2026 to Jan 29, 2027.

## Entry

- **Category: Frankenstein** ("stitch together a chimera of technologies into one app"). AEGIS CREW is one pipeline built from legacy EVM Solidity, Kiro's spec-driven agents, NEAR MPC Chain Signatures, and a Rust guard contract.
  - Why not Skeleton Crew: Forge and Sentinel are two stages of one pipeline, not two distinct apps from a reusable template.
  - Why not Resurrection: the Forge writes a modernization *spec*; it doesn't bring the old contract back to life.
- **Prizes in play:** Overall 1st–3rd or Best Frankenstein (one of them), plus bonuses: Best Kiro Crew App, Best Demo (automatic: highest Presentation score in the top 10%), Bonus Blog, Social Blitz.
- **Not in play:** Best Student (needs a student email for every member), Best Startup (needs a real company), Ghost of Kiroween Past (needs a 2025 registration).

## The pitch in one sentence

AEGIS CREW reads a dead 2019 smart contract, writes its spec, and guards it with an emergency `pause()` that no human key can sign.

## Criteria, and what carries each one

| Criterion (20% each) | Evidence |
|---|---|
| Potential Impact | Old contracts still hold funds, and today's pause options are a slow human or a bot whose stolen key can do anything. AEGIS's worst case is pausing a contract. Judges can try it instantly at the Vercel link. |
| Technological Implementation | Specs, steering, 3 hooks, 3 least-privilege agents, Crew manifest, MCP with schema validation, 20 properties × 1,000 runs, 36/36 mutations caught, 310 Rust↔TS vectors, a Rust contract plus a mirror proven by contract-generated vectors, green CI including the wasm build. |
| Design | Editorial Brutalist dashboard enforced by a hook. Acid Green only on breach, text labels and ARIA live region on alerts, keyboard toggle. |
| Innovation | The deposit-paying guard (forced by NEAR's function-call-key limit), keyless MPC signing for EVM, and the 1-in-128 `omni-transaction` finding. |
| Presentation | The 2:50 video (`video-script.md`), a working URL, and a README that ties every claim to an artifact. |

## Corrected claims

| Don't say | Say instead | Source |
|---|---|---|
| "Billions sit in legacy contracts", "$100B+" | "Old contracts still hold funds, and many have no one left who will touch them" | No sourced figure yet; add one only with a citation |
| "guard: 7 checks" | 13 checks | `CHECKS` in `aegis-guard/src/lib.rs` |
| "a publishable bug in NEAR's library" | "`omni-transaction` 0.5.0 emits non-canonical RLP about 1 in 128 signatures; go-ethereum rejects it. Issue: <link once filed>" | `docs/upstream/omni-transaction-leading-zero.md` |
| "runnable by a judge in minutes" | "The Vercel demo runs in the browser instantly; the Forge needs a clone and `npm install`" | README |
| "deployed on testnet" | "testnet deployment is scripted (GitHub Actions) and is the next step", until the workflow runs green | `.github/workflows/testnet-proof.yml` |
| "Kiro Crew runs the swarm" | "the Crew is configured (`crew.yaml`, `install.sh`)", until you've run it and captured a heartbeat | task 7.3 |
| "7 ms" everywhere | "3 ms in the browser, 7–8 ms through MCP stdio, budget 500 ms" | e2e tests, screenshot 08 |

## Checklist

Done in the repo:

- [x] Public repo, MIT license detected by GitHub, `/.kiro` at the root and tracked
- [x] Working URL with no `[ERR]`: live-mock runs in the tab (commit `7cbea90`)
- [x] CI green: typecheck, PBT, e2e, UI audit, build, Forge reproducibility, Rust tests, wasm build
- [x] Testnet proof workflow and script (`--check` mode verified against testnet)
- [x] Upstream issue draft, Devpost text, video script, blog draft, social post

Needs you:

- [ ] **Redeploy Vercel** from `main` and open `/?source=live-mock`. Check that the masthead says `LIVE-MOCK · IN-TAB` and the bulletin reaches "legacy-vault is paused."
- [ ] **Testnet proof:** create a testnet account (faucet, about 5 NEAR), add the secrets `NEAR_TESTNET_ACCOUNT_ID` and `NEAR_TESTNET_PRIVATE_KEY`, and run *Actions → testnet-proof → Run workflow*. Send me the run link and I'll put the explorer links in the README and video script.
- [ ] **File the upstream issue** from `docs/upstream/omni-transaction-leading-zero.md` under your GitHub account, then replace "<link once filed>".
- [ ] **Kiro Crew:** run `scripts/crew/install.sh` with the `kirocrew` CLI and save one heartbeat log or screenshot to `.kiro/artifacts/`. This makes the Best Kiro Crew App entry evidence-backed.
- [ ] **Record the video** (`video-script.md`), upload it to YouTube as public, with no copyrighted music.
- [ ] **Publish the blog** (`blog-post.md`) and the **social post** (`social-thread.md`, must start with `#KiroweenHackathon26`).
- [ ] **GitHub About:** add the description ("Reads a dead smart contract, writes its spec, and guards it with no human key. Kiroween 2026.") and the website URL.
- [ ] **Devpost:** paste `devpost.md`, choose Frankenstein, tick the bonuses, add the video, blog, and social URLs, and submit before Dec 4, 2:00 PM PT.
