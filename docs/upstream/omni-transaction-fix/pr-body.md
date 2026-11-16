## Problem

`EVMTransaction::build_with_signature` appends `signature.r` and `signature.s` to the RLP stream as byte strings, unchanged. In an EIP-1559 transaction, `r` and `s` are RLP integers, which must be minimal (no leading zero bytes).

Callers naturally pass fixed 32-byte scalars: that's how NEAR Chain Signatures returns them (`big_r` x-coordinate and `s`), and how alloy's `to_be_bytes::<32>()` produces them (as in this crate's own tests). When either value starts with `0x00`, which happens for about `1 - (255/256)^2 ≈ 0.78%` of signatures (roughly 1 in 128), the output is non-canonical:

- go-ethereum rejects it at decode: `rlp: non-canonical integer (leading zero bytes)` (`rlp/decode.go`, `ErrCanonInt`), so `eth_sendRawTransaction` fails.
- Lenient decoders accept it but compute a different transaction hash than the canonical encoding.

Because it only happens about once in 128 signatures, it shows up as an intermittent broadcast failure that's hard to trace.

## Fix

Strip leading zero bytes from `r` and `s` before appending them (`trim_leading_zeros`). Callers that already pass minimal bytes are unaffected, and the public `Signature` type is unchanged.

## Test

`test_build_with_signature_strips_leading_zeros_in_r_and_s_against_alloy` compares the output against alloy's `eip2718_encode` for a leading zero in `r`, two leading zeros in `s`, and both together.

- With this change: all 11 EVM lib tests and the 4 EVM doc tests pass, along with `clippy --all-targets -- -D clippy::all -D clippy::nursery` (EVM features) and `cargo check --target wasm32-unknown-unknown --no-default-features --features evm`.
- Without it, only the new test fails, which shows it reproduces the bug.

(I couldn't run the bitcoin tests locally, because `omni-testing-utilities` isn't publicly accessible; this change doesn't touch bitcoin code.)

## Context

Found while building [AEGIS CREW](https://github.com/g4stein/aegis-crew) for Kiroween 2026: a NEAR contract that builds an EVM `pause()` transaction with this crate and has it signed through `v1.signer-prod.testnet`. We worked around it on our side (`canonical_int` in [`contracts/pause-tx/src/lib.rs`](https://github.com/g4stein/aegis-crew/blob/main/aegis-sentinel/contracts/pause-tx/src/lib.rs)) and pin 310 Rust-to-TypeScript encoding vectors that include leading-zero cases, in [`tests/vectors/eip1559-pause.json`](https://github.com/g4stein/aegis-crew/blob/main/aegis-sentinel/tests/vectors/eip1559-pause.json).
