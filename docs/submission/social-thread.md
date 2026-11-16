# Social Blitz post (X / LinkedIn / Bluesky)

Rule: the post must start with `#KiroweenHackathon26`. Attach screenshot 08 (breach) or a 10 s screen capture of breach → paused. Post 1 is the entry; the rest are an optional thread.

**1/**
#KiroweenHackathon26 I built AEGIS CREW with @kirodotdev: it reads a dead 2019 smart contract, writes its spec, and guards it with an emergency pause that no human key can sign.

Try it in your browser, no install: https://aegis-crew.vercel.app/?source=live-mock

**2/**
A breach fires 15 s after load. The Sentinel detects it and submits a pause request in 3 ms. No AI model is in that path, just pure, property-tested code.

**3/**
The pause goes through a NEAR contract that builds the tx itself and runs 13 checks, then NEAR Chain Signatures signs for Ethereum via MPC. A stolen bot key can, at worst, pause a contract.

**4/**
Built spec-first in Kiro: EARS requirements, 20 properties × 1,000 runs, and a hook that blocks any commit that breaks them. I injected 36 bugs on purpose; the tests caught all 36.

**5/**
Along the way I found that NEAR's tx builder emits a transaction Ethereum nodes reject about 1 in 128 times (leading zero in r or s). Fixed, with a PR upstream: https://github.com/near/omni-transaction-rs/pull/5
Repo: https://github.com/g4stein/aegis-crew
