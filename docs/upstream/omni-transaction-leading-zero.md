# Upstream fix: `near/omni-transaction-rs` (pull request)

`near/omni-transaction-rs` has GitHub Issues turned off, so this goes upstream as a pull request with the fix and a test.

**PR:** [near/omni-transaction-rs#5](https://github.com/near/omni-transaction-rs/pull/5) (opened 2026-11-17; awaiting maintainer review and CI approval)

## Files

| File | Use |
|---|---|
| [`omni-transaction-fix/evm_transaction.rs`](omni-transaction-fix/evm_transaction.rs) | The complete fixed `src/evm/evm_transaction.rs` (upstream `main` at `70930eb` plus the fix and test). Paste it over the file in your fork. |
| [`omni-transaction-fix/pr-body.md`](omni-transaction-fix/pr-body.md) | The PR description. |
| [`omni-transaction-fix/0001-fix-evm-strip-leading-zeros.patch`](omni-transaction-fix/0001-fix-evm-strip-leading-zeros.patch) | The same change as a git patch (`git am`). |

**PR title:** `fix(evm): strip leading zeros from r and s in build_with_signature`

## What was verified (2026-11-16, rustc 1.100.0)

- All 11 EVM lib tests pass with the fix, including the new `test_build_with_signature_strips_leading_zeros_in_r_and_s_against_alloy`.
- With the fix reverted, only the new test fails.
- The 4 EVM doc tests pass, along with `cargo fmt --check`, `cargo clippy --all-targets -- -D clippy::all -D clippy::nursery` (EVM features), and the wasm32 `cargo check` for `--features evm`.
- Not run: the bitcoin tests. They depend on `omni-testing-utilities`, which isn't publicly accessible, and this change doesn't touch bitcoin code.

## The bug, briefly

`build_with_signature` appended `r` and `s` as raw byte strings. RLP integers must be minimal, so whenever a 32-byte `r` or `s` starts with `0x00` (about 1 in 128 signatures), go-ethereum rejects the transaction with `rlp: non-canonical integer (leading zero bytes)`. AEGIS CREW works around it in `aegis-sentinel/contracts/pause-tx/src/lib.rs` (`canonical_int`) and pins 310 vectors in `aegis-sentinel/tests/vectors/eip1559-pause.json`.
