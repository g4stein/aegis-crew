//! Writes `tests/vectors/eip1559-pause.json` for the Sentinel's TypeScript encoder.
//! Deterministic: a fixed-seed SplitMix64 generator, so reruns produce identical output.
//!
//! Usage (from aegis-sentinel/): npm run vectors

use aegis_pause_tx::{signed_bytes, signing_hash, unsigned_bytes, EcdsaSignature, PauseParams};
use std::fmt::Write;

const SEED: u64 = 0xAE61_5E17_1E1A_2026;
const RANDOM_VECTORS: usize = 256;

struct SplitMix64(u64);

impl SplitMix64 {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Value of a random byte width, so every RLP length class is exercised.
    fn u64_any_width(&mut self) -> u64 {
        let bits = self.next() % 65;
        if bits == 0 { 0 } else { self.next() >> (64 - bits) }
    }

    fn u128_any_width(&mut self) -> u128 {
        let bits = self.next() % 129;
        let v = (u128::from(self.next()) << 64) | u128::from(self.next());
        if bits == 0 { 0 } else { v >> (128 - bits) }
    }

    fn bytes32(&mut self, leading_zeros: usize) -> [u8; 32] {
        let mut out = [0u8; 32];
        for chunk in out.chunks_mut(8) {
            chunk.copy_from_slice(&self.next().to_be_bytes());
        }
        for b in out.iter_mut().take(leading_zeros) {
            *b = 0;
        }
        out
    }

    fn address(&mut self) -> [u8; 20] {
        let b = self.bytes32(0);
        let mut out = [0u8; 20];
        out.copy_from_slice(&b[..20]);
        out
    }
}

fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// Boundary values where RLP switches length class or integer width.
fn edge_cases() -> Vec<(PauseParams, EcdsaSignature)> {
    let u64s = [0u64, 1, 0x7f, 0x80, 0xff, 0x100, 0xffff, 1 << 55, u64::MAX];
    let u128s = [0u128, 1, 0x7f, 0x80, 1 << 64, u128::MAX];
    let mut out = Vec::new();
    for (i, &a) in u64s.iter().enumerate() {
        for (j, &b) in u128s.iter().enumerate() {
            let mut r = [0x5a; 32];
            let mut s = [0xa5; 32];
            // Leading-zero r/s in some cases to lock in canonical integer encoding.
            for k in 0..(i % 3) { r[k] = 0; }
            for k in 0..(j % 3) { s[k] = 0; }
            out.push((
                PauseParams {
                    chain_id: if a == 0 { 1 } else { a },
                    nonce: a,
                    to: [((i * 16 + j) & 0xff) as u8; 20],
                    gas_limit: a,
                    max_fee_per_gas: b,
                    max_priority_fee_per_gas: b / 2,
                },
                EcdsaSignature { y_parity: ((i + j) % 2) as u8, r, s },
            ));
        }
    }
    out
}

fn main() {
    let mut rng = SplitMix64(SEED);
    let mut cases = edge_cases();
    for _ in 0..RANDOM_VECTORS {
        let p = PauseParams {
            chain_id: rng.u64_any_width().max(1),
            nonce: rng.u64_any_width(),
            to: rng.address(),
            gas_limit: rng.u64_any_width(),
            max_fee_per_gas: rng.u128_any_width(),
            max_priority_fee_per_gas: rng.u128_any_width(),
        };
        let lz_r = if rng.next() % 8 == 0 { (rng.next() % 4) as usize } else { 0 };
        let lz_s = if rng.next() % 8 == 0 { (rng.next() % 4) as usize } else { 0 };
        let sig = EcdsaSignature { y_parity: (rng.next() % 2) as u8, r: rng.bytes32(lz_r), s: rng.bytes32(lz_s) };
        cases.push((p, sig));
    }

    let mut json = String::new();
    writeln!(json, "{{").unwrap();
    writeln!(json, "  \"generator\": \"aegis-pause-tx (omni-transaction 0.5.0, sha3 Keccak256)\",").unwrap();
    writeln!(json, "  \"seed\": \"0x{SEED:016x}\",").unwrap();
    writeln!(json, "  \"count\": {},", cases.len()).unwrap();
    writeln!(json, "  \"vectors\": [").unwrap();
    for (i, (p, sig)) in cases.iter().enumerate() {
        let comma = if i + 1 == cases.len() { "" } else { "," };
        writeln!(
            json,
            "    {{\"chainId\":\"{}\",\"nonce\":\"{}\",\"to\":\"{}\",\"gasLimit\":\"{}\",\"maxFeePerGas\":\"{}\",\"maxPriorityFeePerGas\":\"{}\",\"value\":\"0\",\"data\":\"0x8456cb59\",\"unsigned\":\"{}\",\"signingHash\":\"{}\",\"signature\":{{\"yParity\":{},\"r\":\"{}\",\"s\":\"{}\"}},\"signed\":\"{}\"}}{}",
            p.chain_id,
            p.nonce,
            hex0x(&p.to),
            p.gas_limit,
            p.max_fee_per_gas,
            p.max_priority_fee_per_gas,
            hex0x(&unsigned_bytes(p)),
            hex0x(&signing_hash(p)),
            sig.y_parity,
            hex0x(&sig.r),
            hex0x(&sig.s),
            hex0x(&signed_bytes(p, sig)),
            comma
        )
        .unwrap();
    }
    writeln!(json, "  ]").unwrap();
    writeln!(json, "}}").unwrap();
    print!("{json}");
}
