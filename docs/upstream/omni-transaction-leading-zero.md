# Upstream issue draft: `near/omni-transaction-rs`

File at: https://github.com/near/omni-transaction-rs/issues/new

Before filing, search the repo's issues for "canonical" and "leading zero" to make sure it's new. On 2026-11-16, none of the 50 most recent issues (open or closed) had either term in the title, and `build_with_signature` on `main` still appends `r`/`s` unchanged.

---

**Title:** EVM `build_with_signature` encodes 32-byte `r`/`s` with leading zeros, producing non-canonical RLP (~1 in 128 MPC signatures)

**Body:**

### Summary

`EVMTransaction::build_with_signature` appends `signature.r` and `signature.s` to the RLP stream as byte strings, without stripping leading zero bytes:

```rust
// src/evm/evm_transaction.rs (v0.5.0)
rlp_stream.append(&signature.v);
rlp_stream.append(&signature.r);
rlp_stream.append(&signature.s);
```

In an EIP-1559 transaction, `r` and `s` are RLP *integers*, which must be minimal (no leading zero bytes). NEAR Chain Signatures returns `r` (the x-coordinate of `big_r`) and `s` as fixed 32-byte values. When either starts with `0x00`, the output is not canonical:

- go-ethereum rejects it at decode with `rlp: non-canonical integer (leading zero bytes)` (`rlp/decode.go`, `ErrCanonInt`), so `eth_sendRawTransaction` fails.
- Clients that decode leniently compute a different transaction hash from the one the canonical encoding would have, so the hash a relayer tracks does not match the one the chain reports.

For uniformly random scalars, the chance that `r` or `s` starts with a zero byte is `1 - (255/256)^2 ≈ 0.78%`, or about 1 in 128 signatures. A relayer that always passes the MPC's 32-byte values will fail intermittently, which is hard to diagnose.

### Reproduction

```rust
use omni_transaction::evm::types::Signature;
// tx: any EVMTransaction built with TransactionBuilder::new::<EVM>()
let mut r = [0x11u8; 32];
r[0] = 0x00; // as returned by MPC about 1 time in 256
let s = [0x22u8; 32];

let raw = tx.build_with_signature(&Signature { v: 1, r: r.to_vec(), s: s.to_vec() });
let canonical = tx.build_with_signature(&Signature { v: 1, r: r[1..].to_vec(), s: s.to_vec() });
assert_eq!(raw.len(), canonical.len() + 1); // raw carries a non-canonical 33-byte r item
```

A runnable version is the `leading_zero_signature_components_are_stripped` test in [`aegis-crew/aegis-sentinel/contracts/pause-tx/src/lib.rs`](https://github.com/g4stein/aegis-crew/blob/main/aegis-sentinel/contracts/pause-tx/src/lib.rs). The same repo pins 310 cross-language vectors (Rust ↔ TypeScript, byte for byte), including leading-zero cases, in [`tests/vectors/eip1559-pause.json`](https://github.com/g4stein/aegis-crew/blob/main/aegis-sentinel/tests/vectors/eip1559-pause.json).

### Suggested fix

Normalize inside `build_with_signature` so callers can't get it wrong:

```rust
fn trim_leading_zeros(b: &[u8]) -> &[u8] {
    let i = b.iter().position(|x| *x != 0).unwrap_or(b.len());
    &b[i..]
}
rlp_stream.append(&trim_leading_zeros(&signature.r));
rlp_stream.append(&trim_leading_zeros(&signature.s));
```

Alternatively, change `Signature.r`/`s` to a fixed `[u8; 32]` (or `U256`) and encode them as integers, or document that callers must pass minimal big-endian bytes. A regression test with `r[0] == 0` would lock it in. I'm happy to open a PR with the fix and test.

### Environment

- `omni-transaction` 0.5.0, features `evm`
- Signatures from `v1.signer-prod.testnet` (`domain_id` 0, secp256k1)
