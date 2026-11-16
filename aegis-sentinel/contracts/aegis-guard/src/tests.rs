//! Unit tests (near-sdk mocked blockchain). Each test names the requirement it covers.
//! The MPC contract is mocked: we inspect the receipt `request_pause` creates and call
//! `on_signature` directly with the response the MPC network would return.

use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, VMContext};
use std::panic::{catch_unwind, AssertUnwindSafe};

const OWNER: &str = "owner.testnet";
const SENTINEL: &str = "sentinel.testnet";
const ORACLE: &str = "oracle.testnet";
const MPC: &str = "v1.signer-prod.testnet";
const GUARD: &str = "aegis-guard.testnet";
const MALLORY: &str = "mallory.testnet";
const VAULT: &str = "legacy-vault";
const VAULT_ADDR: &str = "0x000000000000000000000000000000000000ae61";
const GWEI: u128 = 1_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx_with(pred: &str, block: u64, balance: NearToken) -> VMContext {
    VMContextBuilder::new()
        .current_account_id(acc(GUARD))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .block_height(block)
        .block_timestamp(block * 1_000_000_000)
        .account_balance(balance)
        .build()
}

fn at(pred: &str, block: u64) {
    testing_env!(ctx_with(pred, block, NearToken::from_near(5)));
}

fn vault_entry() -> GuardedContract {
    GuardedContract {
        contract_id: VAULT.into(),
        chain_id: U64(11_155_111),
        address: VAULT_ADDR.into(),
        derivation_path: "aegis/legacy-vault/eip155:11155111".into(),
        gas_limit: U64(60_000),
        max_fee_per_gas_cap: U128(200 * GWEI),
        max_priority_fee_per_gas_cap: U128(5 * GWEI),
        min_interval_blocks: U64(10),
    }
}

/// Owner deploys, allowlists the vault; the oracle posts a quote at block 100.
fn setup() -> AegisGuard {
    at(OWNER, 100);
    let mut g = AegisGuard::new(acc(OWNER), acc(SENTINEL), Some(acc(ORACLE)), acc(MPC));
    g.set_guarded(vault_entry());
    at(ORACLE, 100);
    g.update_fee_quote(VAULT.into(), U64(7), U128(30 * GWEI), U128(3 * GWEI / 2));
    g
}

fn expected_params(nonce: u64) -> PauseParams {
    PauseParams {
        chain_id: 11_155_111,
        nonce,
        to: parse_address(VAULT_ADDR).unwrap(),
        gas_limit: 60_000,
        max_fee_per_gas: 30 * GWEI,
        max_priority_fee_per_gas: 3 * GWEI / 2,
    }
}

struct Call {
    receiver: AccountId,
    method: String,
    args: Vec<u8>,
    deposit: NearToken,
    gas: Gas,
}

fn calls() -> Vec<Call> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight { method_name, args, attached_deposit, prepaid_gas, .. } => Some(Call {
                    receiver: receiver.clone(),
                    method: String::from_utf8(method_name).unwrap(),
                    args,
                    deposit: attached_deposit,
                    gas: prepaid_gas,
                }),
                _ => None,
            })
        })
        .collect()
}

/// A secp256k1 response whose `r` starts with two zero bytes (exercises canonical encoding).
fn leading_zero_signature() -> SignatureResponse {
    let mut point = [0x5au8; 33];
    point[0] = 0x03;
    point[1] = 0x00;
    point[2] = 0x00;
    SignatureResponse::Secp256k1 { big_r: AffinePointHex { affine_point: hex::encode(point) }, s: ScalarHex { scalar: hex::encode([0x2bu8; 32]) }, recovery_id: 1 }
}

fn request(g: &mut AegisGuard, pred: &str, block: u64, breach: &str) -> Result<(), String> {
    at(pred, block);
    catch_unwind(AssertUnwindSafe(|| {
        let _ = g.request_pause(VAULT.into(), breach.into());
    }))
    .map_err(panic_message)
}

fn panic_message(e: Box<dyn std::any::Any + Send>) -> String {
    e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
}

/// The contract-level reason inside a mocked-VM panic: `rejected: <code>` -> `<code>`,
/// `require!` messages as written.
fn reason(raw: &str) -> String {
    if let Some(i) = raw.find("rejected: ") {
        return raw[i + 10..].chars().take_while(|c| c.is_ascii_lowercase() || *c == '_').collect();
    }
    if let Some(i) = raw.find("panic_msg: \"") {
        return raw[i + 12..].chars().take_while(|c| *c != '"').collect();
    }
    raw.to_string()
}

// ---- Happy path -------------------------------------------------------------------------

#[test]
fn happy_path_builds_pause_tx_pays_deposit_and_calls_mpc_sign() {
    // Req 2.1, 2.5, 2.7, 2.10, 2.15
    let mut g = setup();
    at(SENTINEL, 101);
    let _ = g.request_pause(VAULT.into(), "brk_1".into());

    let unsigned = unsigned_bytes(&expected_params(7));
    let hash = keccak256(&unsigned);
    let cs = calls();
    let sign = cs.iter().find(|c| c.receiver == acc(MPC)).expect("a call to the MPC contract");
    assert_eq!(sign.method, "sign");
    assert_eq!(sign.deposit, NearToken::from_yoctonear(DEFAULT_SIGN_DEPOSIT_YOCTO), "deposit is paid by the guard");
    assert!(sign.gas.as_tgas() >= MIN_SIGN_GAS_TGAS, "MPC requires at least 15 TGas");
    let args: Value = serde_json::from_slice(&sign.args).unwrap();
    assert_eq!(
        args,
        json!({ "request": { "path": "aegis/legacy-vault/eip155:11155111", "payload_v2": { "Ecdsa": hex::encode(hash) }, "domain_id": 0 } })
    );
    let cb = cs.iter().find(|c| c.receiver == acc(GUARD)).expect("a callback to the guard");
    assert_eq!(cb.method, "on_signature");

    // The transaction is pause() to the allowlisted address with value 0, nothing else.
    let tx = pause_tx(&expected_params(7));
    assert_eq!(tx.input, PAUSE_SELECTOR.to_vec());
    assert_eq!(tx.value, 0);
    assert_eq!(tx.to, Some(parse_address(VAULT_ADDR).unwrap()));

    let m = g.get_active_mitigation(VAULT.into()).expect("pending mitigation");
    assert_eq!(m.status, MitigationStatus::Pending);
    assert_eq!(m.unsigned_tx, hex0x(&unsigned));
    assert_eq!(m.payload_hash, hex0x(&hash));
    assert_eq!(m.deposit_yocto, U128(1));
    assert!(get_logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"pause_requested\"")));
}

#[test]
fn callback_signs_with_leading_zero_safe_encoder() {
    // Req 2.2, 2.15
    let mut g = setup();
    at(SENTINEL, 101);
    let _ = g.request_pause(VAULT.into(), "brk_1".into());
    at(GUARD, 102);
    let signed = g.on_signature(mitigation_id(VAULT, "brk_1"), Ok(leading_zero_signature())).expect("signed tx");

    let mut r = [0x5au8; 32];
    r[0] = 0;
    r[1] = 0;
    let expected = signed_bytes(&expected_params(7), &EcdsaSignature { y_parity: 1, r, s: [0x2b; 32] });
    assert_eq!(signed, hex0x(&expected));
    // Canonical: r is encoded as a 30-byte integer (0x9e prefix), not a 32-byte string.
    assert!(signed.contains(&format!("9e{}", "5a".repeat(30))));
    let m = g.get_mitigation(mitigation_id(VAULT, "brk_1")).unwrap();
    assert_eq!(m.status, MitigationStatus::Signed);
    assert!(g.get_active_mitigation(VAULT.into()).is_none());
}

#[test]
fn parses_the_mpc_wire_format() {
    // Req 2.2: SignatureResponse JSON as returned by near/mpc (tag "scheme", hex fields).
    let json = format!(r#"{{"scheme":"Secp256k1","big_r":{{"affine_point":"02{}"}},"s":{{"scalar":"{}"}},"recovery_id":0}}"#, "11".repeat(32), "22".repeat(32));
    let r: SignatureResponse = serde_json::from_str(&json).unwrap();
    match r {
        SignatureResponse::Secp256k1 { big_r, s, recovery_id } => assert!(to_ecdsa(&big_r.affine_point, &s.scalar, recovery_id).is_ok()),
        _ => panic!("expected secp256k1"),
    }
}

// ---- Rejections -------------------------------------------------------------------------

#[test]
fn rejects_contracts_not_on_the_allowlist() {
    // Req 2.8
    let mut g = setup();
    at(SENTINEL, 101);
    let e = catch_unwind(AssertUnwindSafe(|| {
        let _ = g.request_pause("other-token".into(), "brk_1".into());
    }))
    .map_err(panic_message)
    .unwrap_err();
    assert!(e.contains("rejected: not_allowlisted"), "{e}");
    assert!(calls().is_empty(), "no sign request on rejection");
}

#[test]
fn rejects_callers_other_than_the_sentinel() {
    // Req 2.7
    let mut g = setup();
    for who in [MALLORY, ORACLE, OWNER] {
        let e = request(&mut g, who, 101, "brk_1").unwrap_err();
        assert!(e.contains("rejected: not_sentinel"), "{who}: {e}");
    }
}

#[test]
fn rejects_any_calldata_other_than_the_pause_selector() {
    // Req 2.9: on-chain check of the built transaction.
    let entry = vault_entry();
    let ok = pause_tx(&expected_params(7));
    assert_eq!(enforce(&entry, &ok), Ok(()));
    for input in [vec![0xa9, 0x05, 0x9c, 0xbb], vec![0x84, 0x56, 0xcb], vec![0x84, 0x56, 0xcb, 0x59, 0x00], vec![]] {
        let mut tx = ok.clone();
        tx.input = input;
        assert_eq!(enforce(&entry, &tx), Err(Rejection::SelectorMismatch));
    }
    let mut tx = ok.clone();
    tx.value = 1;
    assert_eq!(enforce(&entry, &tx), Err(Rejection::NonzeroValue));
    let mut tx = ok.clone();
    tx.to = Some([0xee; 20]);
    assert_eq!(enforce(&entry, &tx), Err(Rejection::TargetMismatch));
    let mut tx = ok.clone();
    tx.chain_id = 1;
    assert_eq!(enforce(&entry, &tx), Err(Rejection::ChainMismatch));
    let mut tx = ok;
    tx.access_list = vec![([0x11; 20], vec![])];
    assert_eq!(enforce(&entry, &tx), Err(Rejection::AccessListNotEmpty));
}

#[test]
fn rejects_fees_above_the_owner_cap() {
    // Design: fee cap. The oracle is not trusted; caps are checked at request time.
    let mut g = setup();
    at(ORACLE, 100);
    g.update_fee_quote(VAULT.into(), U64(7), U128(201 * GWEI), U128(GWEI));
    assert!(request(&mut g, SENTINEL, 101, "brk_1").unwrap_err().contains("rejected: fee_above_cap"));
    at(ORACLE, 100);
    g.update_fee_quote(VAULT.into(), U64(7), U128(30 * GWEI), U128(6 * GWEI));
    assert!(request(&mut g, SENTINEL, 101, "brk_1").unwrap_err().contains("rejected: fee_above_cap"));
    at(ORACLE, 100);
    g.update_fee_quote(VAULT.into(), U64(7), U128(GWEI), U128(2 * GWEI));
    assert!(request(&mut g, SENTINEL, 101, "brk_1").unwrap_err().contains("rejected: fee_quote_invalid"));
}

#[test]
fn rejects_stale_or_missing_fee_quotes() {
    // Req 2.14 (stale inputs are not acted on)
    let mut g = setup();
    let e = request(&mut g, SENTINEL, 100 + DEFAULT_MAX_QUOTE_AGE_BLOCKS + 1, "brk_1").unwrap_err();
    assert!(e.contains("rejected: fee_quote_stale"), "{e}");
    at(OWNER, 100);
    g.set_guarded(GuardedContract { contract_id: "fresh-token".into(), ..vault_entry() });
    at(SENTINEL, 101);
    let e = catch_unwind(AssertUnwindSafe(|| {
        let _ = g.request_pause("fresh-token".into(), "brk_1".into());
    }))
    .map_err(panic_message)
    .unwrap_err();
    assert!(e.contains("rejected: no_fee_quote"), "{e}");
}

#[test]
fn accepts_a_quote_exactly_max_age_old() {
    // Req 2.14 boundary: age == max_quote_age_blocks is fresh; one more block is stale.
    let mut g = setup();
    let e = request(&mut g, SENTINEL, 100 + DEFAULT_MAX_QUOTE_AGE_BLOCKS + 1, "brk_1").unwrap_err();
    assert!(e.contains("rejected: fee_quote_stale"), "{e}");
    request(&mut g, SENTINEL, 100 + DEFAULT_MAX_QUOTE_AGE_BLOCKS, "brk_1").expect("exactly max age is accepted");
}

#[test]
fn enforces_the_per_contract_rate_limit() {
    // Design: rate limit (min_interval_blocks = 10)
    let mut g = setup();
    request(&mut g, SENTINEL, 101, "brk_1").unwrap();
    at(GUARD, 102);
    g.on_signature(mitigation_id(VAULT, "brk_1"), Err(PromiseError::Failed));
    let e = request(&mut g, SENTINEL, 110, "brk_2").unwrap_err();
    assert!(e.contains("rejected: rate_limited"), "{e}");
    request(&mut g, SENTINEL, 111, "brk_2").expect("allowed once the interval has passed");
}

#[test]
fn rejects_duplicates_and_requests_while_in_flight() {
    // Req 2.12
    let mut g = setup();
    request(&mut g, SENTINEL, 101, "brk_1").unwrap();
    let e = request(&mut g, SENTINEL, 150, "brk_2").unwrap_err();
    assert!(e.contains("rejected: mitigation_in_flight"), "{e}");
    at(GUARD, 151);
    g.on_signature(mitigation_id(VAULT, "brk_1"), Ok(leading_zero_signature()));
    let e = request(&mut g, SENTINEL, 152, "brk_1").unwrap_err();
    assert!(e.contains("rejected: duplicate_breach"), "{e}");
}

#[test]
fn rejects_when_the_guard_cannot_pay_the_deposit() {
    let mut g = setup();
    testing_env!(ctx_with(SENTINEL, 101, NearToken::from_yoctonear(0)));
    let e = catch_unwind(AssertUnwindSafe(|| {
        let _ = g.request_pause(VAULT.into(), "brk_1".into());
    }))
    .map_err(panic_message)
    .unwrap_err();
    assert!(e.contains("rejected: insufficient_balance"), "{e}");
}

#[test]
fn rejects_malformed_ids() {
    let mut g = setup();
    for bad in ["", "brk/1", "brk 1", &"x".repeat(64)] {
        let e = request(&mut g, SENTINEL, 101, bad).unwrap_err();
        assert!(e.contains("rejected: invalid_id"), "{bad:?}: {e}");
    }
}

#[test]
fn failed_mpc_call_marks_failed_and_frees_the_contract() {
    // Req 2.3
    let mut g = setup();
    request(&mut g, SENTINEL, 101, "brk_1").unwrap();
    at(GUARD, 102);
    assert_eq!(g.on_signature(mitigation_id(VAULT, "brk_1"), Err(PromiseError::Failed)), None);
    let m = g.get_mitigation(mitigation_id(VAULT, "brk_1")).unwrap();
    assert_eq!(m.status, MitigationStatus::Failed);
    assert_eq!(m.error.as_deref(), Some("mpc_sign_failed"));
    assert!(g.get_active_mitigation(VAULT.into()).is_none());
    assert!(get_logs().iter().any(|l| l.contains("\"pause_failed\"")));
}

#[test]
fn rejects_signatures_whose_recovery_id_disagrees_with_the_point() {
    let mut g = setup();
    request(&mut g, SENTINEL, 101, "brk_1").unwrap();
    at(GUARD, 102);
    let mut bad = leading_zero_signature();
    if let SignatureResponse::Secp256k1 { recovery_id, .. } = &mut bad {
        *recovery_id = 0;
    }
    assert_eq!(g.on_signature(mitigation_id(VAULT, "brk_1"), Ok(bad)), None);
    assert_eq!(g.get_mitigation(mitigation_id(VAULT, "brk_1")).unwrap().error.as_deref(), Some("recovery_id_mismatch"));
}

#[test]
fn only_the_owner_configures_and_only_the_oracle_quotes() {
    // Req 2.8, 2.10: allowlist integrity
    let mut g = setup();
    at(MALLORY, 101);
    let e = catch_unwind(AssertUnwindSafe(|| g.set_guarded(GuardedContract { address: "0x00000000000000000000000000000000deadbeef".into(), ..vault_entry() })))
        .map_err(panic_message)
        .unwrap_err();
    assert!(e.contains("only the owner"), "{e}");
    let e = catch_unwind(AssertUnwindSafe(|| g.update_fee_quote(VAULT.into(), U64(0), U128(1), U128(1)))).map_err(panic_message).unwrap_err();
    assert!(e.contains("only the fee oracle"), "{e}");
    assert_eq!(g.get_guarded(VAULT.into()).unwrap().address, VAULT_ADDR);
}

#[test]
fn preview_matches_request_and_changes_nothing() {
    let mut g = setup();
    at(SENTINEL, 101);
    let p = g.preview_pause(VAULT.into(), "brk_1".into());
    assert!(p.ok);
    assert!(g.get_active_mitigation(VAULT.into()).is_none());
    let _ = g.request_pause(VAULT.into(), "brk_1".into());
    let m = g.get_active_mitigation(VAULT.into()).unwrap();
    assert_eq!(p.unsigned_tx.as_deref(), Some(m.unsigned_tx.as_str()));
    assert_eq!(p.payload_hash.as_deref(), Some(m.payload_hash.as_str()));
}

// ---- Conformance vectors for the TypeScript mirror (core/guard.ts) ----------------------

/// Runs scripted scenarios against the real contract and records every outcome. With
/// AEGIS_WRITE_GUARD_VECTORS=<path> it writes the file; otherwise it checks the committed file
/// still matches, so the TypeScript mock cannot drift from the contract.
#[test]
fn conformance_vectors() {
    let committed = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/vectors/aegis-guard.json");
    let out = build_vectors();
    let text = format!("{}\n", serde_json::to_string_pretty(&out).unwrap());
    match std::env::var("AEGIS_WRITE_GUARD_VECTORS") {
        Ok(path) if !path.is_empty() => std::fs::write(path, &text).unwrap(),
        _ => {
            let existing = std::fs::read_to_string(committed).expect("tests/vectors/aegis-guard.json missing; run with AEGIS_WRITE_GUARD_VECTORS");
            assert_eq!(existing, text, "guard behaviour changed; regenerate tests/vectors/aegis-guard.json");
        }
    }
}

enum Step {
    Quote { block: u64, pred: &'static str, contract: &'static str, nonce: u64, max_fee: u128, priority: u128 },
    Request { block: u64, pred: &'static str, contract: &'static str, breach: &'static str, balance: NearToken },
    Preview { block: u64, contract: &'static str, breach: &'static str },
    Sign { block: u64, contract: &'static str, breach: &'static str, result: Option<SignatureResponse> },
}

fn sig_json(s: &SignatureResponse) -> Value {
    serde_json::to_value(s).unwrap()
}

fn build_vectors() -> Value {
    use Step::*;
    let five = NearToken::from_near(5);
    let mut bad_rid = leading_zero_signature();
    if let SignatureResponse::Secp256k1 { recovery_id, .. } = &mut bad_rid {
        *recovery_id = 0;
    }
    let mut even = [0x77u8; 33];
    even[0] = 0x02;
    let even_sig = SignatureResponse::Secp256k1 { big_r: AffinePointHex { affine_point: hex::encode(even) }, s: ScalarHex { scalar: format!("00{}", "44".repeat(31)) }, recovery_id: 0 };

    let scenarios: Vec<(&str, Vec<Step>)> = vec![
        (
            "happy path, duplicate, rate limit",
            vec![
                Quote { block: 100, pred: ORACLE, contract: VAULT, nonce: 7, max_fee: 30 * GWEI, priority: 3 * GWEI / 2 },
                Preview { block: 101, contract: VAULT, breach: "brk_a" },
                Request { block: 101, pred: SENTINEL, contract: VAULT, breach: "brk_a", balance: five },
                Request { block: 102, pred: SENTINEL, contract: VAULT, breach: "brk_b", balance: five },
                Sign { block: 103, contract: VAULT, breach: "brk_a", result: Some(leading_zero_signature()) },
                Preview { block: 104, contract: VAULT, breach: "brk_a" },
                Request { block: 105, pred: SENTINEL, contract: VAULT, breach: "brk_b", balance: five },
                Quote { block: 110, pred: ORACLE, contract: VAULT, nonce: 8, max_fee: 31 * GWEI, priority: 2 * GWEI },
                Request { block: 111, pred: SENTINEL, contract: VAULT, breach: "brk_b", balance: five },
                Sign { block: 112, contract: VAULT, breach: "brk_b", result: Some(even_sig) },
            ],
        ),
        (
            "caller, allowlist, id, quote, fee and balance checks",
            vec![
                Request { block: 100, pred: SENTINEL, contract: VAULT, breach: "brk_a", balance: five },
                Quote { block: 100, pred: MALLORY, contract: VAULT, nonce: 0, max_fee: 1, priority: 1 },
                Quote { block: 100, pred: ORACLE, contract: "other-token", nonce: 0, max_fee: 1, priority: 1 },
                Quote { block: 100, pred: ORACLE, contract: VAULT, nonce: 3, max_fee: 30 * GWEI, priority: GWEI },
                Request { block: 101, pred: MALLORY, contract: VAULT, breach: "brk_a", balance: five },
                Request { block: 101, pred: SENTINEL, contract: "other-token", breach: "brk_a", balance: five },
                Request { block: 101, pred: SENTINEL, contract: VAULT, breach: "brk/a", balance: five },
                Request { block: 221, pred: SENTINEL, contract: VAULT, breach: "brk_a", balance: five },
                Request { block: 101, pred: SENTINEL, contract: VAULT, breach: "brk_a", balance: NearToken::from_yoctonear(0) },
                Quote { block: 101, pred: ORACLE, contract: VAULT, nonce: 3, max_fee: 201 * GWEI, priority: GWEI },
                Request { block: 102, pred: SENTINEL, contract: VAULT, breach: "brk_a", balance: five },
                Quote { block: 102, pred: ORACLE, contract: VAULT, nonce: 3, max_fee: 30 * GWEI, priority: 6 * GWEI },
                Request { block: 103, pred: SENTINEL, contract: VAULT, breach: "brk_a", balance: five },
                Quote { block: 103, pred: ORACLE, contract: VAULT, nonce: 3, max_fee: GWEI, priority: 2 * GWEI },
                Request { block: 104, pred: SENTINEL, contract: VAULT, breach: "brk_a", balance: five },
                Quote { block: 104, pred: ORACLE, contract: VAULT, nonce: 3, max_fee: 200 * GWEI, priority: 5 * GWEI },
                Request { block: 105, pred: SENTINEL, contract: VAULT, breach: "brk_a", balance: five },
            ],
        ),
        (
            "quote age boundary (120 blocks allowed, 121 stale)",
            vec![
                Quote { block: 100, pred: ORACLE, contract: VAULT, nonce: 1, max_fee: 30 * GWEI, priority: GWEI },
                Request { block: 221, pred: SENTINEL, contract: VAULT, breach: "brk_a", balance: five },
                Preview { block: 220, contract: VAULT, breach: "brk_a" },
                Request { block: 220, pred: SENTINEL, contract: VAULT, breach: "brk_a", balance: five },
            ],
        ),
        (
            "mpc failure and bad signatures",
            vec![
                Quote { block: 100, pred: ORACLE, contract: VAULT, nonce: 0, max_fee: 30 * GWEI, priority: GWEI },
                Request { block: 101, pred: SENTINEL, contract: VAULT, breach: "brk_a", balance: five },
                Sign { block: 102, contract: VAULT, breach: "brk_a", result: None },
                Request { block: 111, pred: SENTINEL, contract: VAULT, breach: "brk_b", balance: five },
                Sign { block: 112, contract: VAULT, breach: "brk_b", result: Some(bad_rid) },
                Request { block: 121, pred: SENTINEL, contract: VAULT, breach: "brk_c", balance: five },
                Sign { block: 122, contract: VAULT, breach: "brk_c", result: Some(leading_zero_signature()) },
            ],
        ),
    ];

    let mut out_scenarios = vec![];
    for (name, steps) in scenarios {
        // testing_env! carries storage across calls; each scenario starts from empty state.
        near_sdk::mock::with_mocked_blockchain(|b| {
            b.take_storage();
        });
        at(OWNER, 99);
        let mut g = AegisGuard::new(acc(OWNER), acc(SENTINEL), Some(acc(ORACLE)), acc(MPC));
        g.set_guarded(vault_entry());
        let mut out_steps = vec![];
        for s in steps {
            let v = match s {
                Quote { block, pred, contract, nonce, max_fee, priority } => {
                    at(pred, block);
                    let r = catch_unwind(AssertUnwindSafe(|| g.update_fee_quote(contract.into(), U64(nonce), U128(max_fee), U128(priority)))).map_err(panic_message);
                    json!({ "op": "update_fee_quote", "block": block, "predecessor": pred,
                        "args": { "contract_id": contract, "nonce": nonce.to_string(), "max_fee_per_gas": max_fee.to_string(), "max_priority_fee_per_gas": priority.to_string() },
                        "expect": match r { Ok(()) => json!({ "ok": true }), Err(e) => json!({ "ok": false, "reason": reason(&e) }) } })
                }
                Request { block, pred, contract, breach, balance } => {
                    testing_env!(ctx_with(pred, block, balance));
                    let available = env::account_balance().saturating_sub(env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage())));
                    let r = catch_unwind(AssertUnwindSafe(|| {
                        let _ = g.request_pause(contract.into(), breach.into());
                    }))
                    .map_err(panic_message);
                    let expect = match r {
                        Ok(()) => {
                            let cs = calls();
                            let sign = cs.iter().find(|c| c.receiver == acc(MPC)).unwrap();
                            let m = g.get_active_mitigation(contract.into()).unwrap();
                            json!({ "ok": true, "mitigation_id": m.mitigation_id, "unsigned_tx": m.unsigned_tx, "payload_hash": m.payload_hash,
                                "sign_call": { "receiver": sign.receiver, "method": sign.method, "deposit_yocto": sign.deposit.as_yoctonear().to_string(), "gas_tgas": sign.gas.as_tgas(),
                                    "args": serde_json::from_slice::<Value>(&sign.args).unwrap() } })
                        }
                        Err(e) => json!({ "ok": false, "reason": reason(&e) }),
                    };
                    json!({ "op": "request_pause", "block": block, "predecessor": pred, "available_yocto": available.as_yoctonear().to_string(),
                        "args": { "contract_id": contract, "breach_id": breach }, "expect": expect })
                }
                Preview { block, contract, breach } => {
                    at(SENTINEL, block);
                    let p = g.preview_pause(contract.into(), breach.into());
                    let available = env::account_balance().saturating_sub(env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage())));
                    json!({ "op": "preview_pause", "block": block, "available_yocto": available.as_yoctonear().to_string(), "args": { "contract_id": contract, "breach_id": breach }, "expect": p })
                }
                Sign { block, contract, breach, result } => {
                    at(GUARD, block);
                    let id = mitigation_id(contract, breach);
                    let input = result.as_ref().map(sig_json).unwrap_or(json!("failed"));
                    let r = match result {
                        Some(s) => Ok(s),
                        None => Err(PromiseError::Failed),
                    };
                    let signed = g.on_signature(id.clone(), r);
                    let m = g.get_mitigation(id.clone()).unwrap();
                    json!({ "op": "on_signature", "block": block, "mitigation_id": id, "result": input,
                        "expect": { "status": m.status, "signed_tx": signed, "signed_tx_hash": m.signed_tx_hash, "error": m.error } })
                }
            };
            out_steps.push(v);
        }
        out_scenarios.push(json!({ "name": name, "steps": out_steps }));
    }

    json!({
        "generator": "aegis-guard unit tests (near-sdk 5.27.0 mocked blockchain)",
        "config": { "owner": OWNER, "sentinel": SENTINEL, "fee_oracle": ORACLE, "mpc_contract": MPC, "guard_account": GUARD,
            "sign_deposit_yocto": DEFAULT_SIGN_DEPOSIT_YOCTO.to_string(), "sign_gas_tgas": DEFAULT_SIGN_GAS_TGAS, "max_quote_age_blocks": DEFAULT_MAX_QUOTE_AGE_BLOCKS },
        "entries": [vault_entry()],
        "scenarios": out_scenarios,
    })
}
