//! The `pause()` transaction the Aegis Guard contract builds and has NEAR Chain Signatures sign.
//!
//! The guard builds the transaction itself, so the caller cannot choose the target, value,
//! or calldata (Requirements 2.8, 2.9). Encoding uses NEAR's `omni-transaction` crate.
//! `bin/vectors.rs` writes cross-language test vectors that the Sentinel's TypeScript
//! encoder must match byte for byte (design.md, Correctness Properties).

use omni_transaction::evm::types::Signature;
use omni_transaction::evm::EVMTransaction;
use sha3::{Digest, Keccak256};

/// `bytes4(keccak256("pause()"))`.
pub const PAUSE_SELECTOR: [u8; 4] = [0x84, 0x56, 0xcb, 0x59];

/// Inputs the guard contract takes from its allowlist entry (chain, target, gas limit)
/// and from the Sentinel's request (nonce, fees, already capped by the guard).
#[derive(Clone, Copy, Debug)]
pub struct PauseParams {
    pub chain_id: u64,
    pub nonce: u64,
    pub to: [u8; 20],
    pub gas_limit: u64,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
}

/// A secp256k1 signature as returned by the MPC network: 32-byte big-endian `r` and `s`.
#[derive(Clone, Copy, Debug)]
pub struct EcdsaSignature {
    pub y_parity: u8,
    pub r: [u8; 32],
    pub s: [u8; 32],
}

pub fn pause_tx(p: &PauseParams) -> EVMTransaction {
    EVMTransaction {
        chain_id: p.chain_id,
        nonce: p.nonce,
        to: Some(p.to),
        value: 0,
        input: PAUSE_SELECTOR.to_vec(),
        gas_limit: u128::from(p.gas_limit),
        max_fee_per_gas: p.max_fee_per_gas,
        max_priority_fee_per_gas: p.max_priority_fee_per_gas,
        access_list: vec![],
    }
}

/// `0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList])`
pub fn unsigned_bytes(p: &PauseParams) -> Vec<u8> {
    pause_tx(p).build_for_signing()
}

/// The 32-byte hash passed to the MPC `sign` method.
pub fn signing_hash(p: &PauseParams) -> [u8; 32] {
    Keccak256::digest(unsigned_bytes(p)).into()
}

/// RLP integers must not have leading zero bytes. `omni-transaction` appends `r` and `s`
/// as raw byte strings, so a signature whose `r` or `s` starts with 0x00 (about 1 in 128)
/// would produce a non-canonical transaction that Ethereum nodes reject. Strip them here.
fn canonical_int(bytes: &[u8]) -> Vec<u8> {
    let first = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    bytes[first..].to_vec()
}

/// `0x02 || rlp([...unsigned fields, yParity, r, s])` with canonical `r` and `s`.
pub fn signed_bytes(p: &PauseParams, sig: &EcdsaSignature) -> Vec<u8> {
    let signature = Signature {
        v: u64::from(sig.y_parity),
        r: canonical_int(&sig.r),
        s: canonical_int(&sig.s),
    };
    pause_tx(p).build_with_signature(&signature)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> PauseParams {
        PauseParams {
            chain_id: 11_155_111,
            nonce: 7,
            to: [0xae; 20],
            gas_limit: 60_000,
            max_fee_per_gas: 30_000_000_000,
            max_priority_fee_per_gas: 1_500_000_000,
        }
    }

    #[test]
    fn selector_is_keccak_of_pause_signature() {
        let h = Keccak256::digest(b"pause()");
        assert_eq!(&h[..4], &PAUSE_SELECTOR);
    }

    #[test]
    fn unsigned_starts_with_type_byte_and_carries_only_pause_calldata() {
        let bytes = unsigned_bytes(&params());
        assert_eq!(bytes[0], 0x02);
        let tx = pause_tx(&params());
        assert_eq!(tx.value, 0);
        assert_eq!(tx.input, PAUSE_SELECTOR.to_vec());
        assert!(tx.access_list.is_empty());
    }

    #[test]
    fn leading_zero_signature_components_are_stripped() {
        let mut r = [0x11; 32];
        r[0] = 0;
        r[1] = 0;
        let sig = EcdsaSignature { y_parity: 1, r, s: [0x22; 32] };
        let ours = signed_bytes(&params(), &sig);

        // Raw omni-transaction output keeps the zero bytes, so it is 2 bytes longer
        // and non-canonical. This test documents why `canonical_int` exists.
        let raw = pause_tx(&params()).build_with_signature(&Signature {
            v: 1,
            r: r.to_vec(),
            s: [0x22; 32].to_vec(),
        });
        assert_eq!(raw.len(), ours.len() + 2);
    }
}
