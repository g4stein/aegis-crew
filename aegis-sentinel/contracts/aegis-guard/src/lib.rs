//! Aegis Guard: the only path from the Sentinel to NEAR Chain Signatures.
//!
//! The Sentinel holds a function-call access key restricted to this contract. It may call
//! `request_pause(contract_id, breach_id)` and nothing that chooses a transaction: this
//! contract builds the EVM `pause()` transaction itself from its allowlist and the latest fee
//! quote, enforces every check on-chain, pays the MPC deposit from its own balance, and calls
//! the MPC `sign` method. Requirements: .kiro/specs/aegis-protocol/requirements.md (2.x).
//!
//! Function-call keys cannot attach deposits, and MPC `sign` requires one (1 yoctoNEAR today),
//! which is why this contract exists (design.md, Aegis Guard).

use aegis_pause_tx::{keccak256, pause_tx, signed_bytes, unsigned_bytes, EVMTransaction, EcdsaSignature, PauseParams, PAUSE_SELECTOR};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

/// `SIGN_DEPOSIT_YOCTONEAR` in near/mpc `near-mpc-contract-interface/src/deposits.rs`.
pub const DEFAULT_SIGN_DEPOSIT_YOCTO: u128 = 1;
/// The MPC contract requires at least 15 TGas attached to `sign` (`sign_call_gas_attachment_requirement_tera_gas`).
pub const MIN_SIGN_GAS_TGAS: u64 = 15;
pub const DEFAULT_SIGN_GAS_TGAS: u64 = 50;
pub const CALLBACK_GAS_TGAS: u64 = 20;
/// `domain_id` 0 is the secp256k1 (ECDSA) domain.
pub const ECDSA_DOMAIN_ID: u64 = 0;
pub const DEFAULT_MAX_QUOTE_AGE_BLOCKS: u64 = 120;
pub const EVENT_STANDARD: &str = "aegis-guard";
pub const EVENT_VERSION: &str = "1.0.0";

// ---- Types ------------------------------------------------------------------------------

/// One allowlist entry. Only the owner can add, change, or remove entries.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct GuardedContract {
    /// `[a-z0-9-]{1,64}`; same ID as aegis-sentinel/config/guarded.json.
    pub contract_id: String,
    pub chain_id: U64,
    /// `0x` + 40 hex characters; stored lowercase.
    pub address: String,
    /// MPC derivation path. One per contract and chain, so signatures cannot be replayed elsewhere.
    pub derivation_path: String,
    pub gas_limit: U64,
    pub max_fee_per_gas_cap: U128,
    pub max_priority_fee_per_gas_cap: U128,
    /// Minimum NEAR blocks between two pause requests for this contract.
    pub min_interval_blocks: U64,
}

/// Latest target-chain values, pushed by the fee oracle. Capped at request time.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct FeeQuote {
    pub nonce: U64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub quoted_at_block: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MitigationStatus {
    /// Sign request sent to the MPC contract; awaiting the callback.
    Pending,
    /// Signature received; `signed_tx` is ready to broadcast.
    Signed,
    /// The MPC call failed or returned an unusable signature.
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Mitigation {
    pub mitigation_id: String,
    pub contract_id: String,
    pub breach_id: String,
    pub status: MitigationStatus,
    pub requested_at_block: U64,
    pub requested_at_ms: U64,
    pub chain_id: U64,
    pub to: String,
    pub nonce: U64,
    pub gas_limit: U64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub derivation_path: String,
    pub unsigned_tx: String,
    pub payload_hash: String,
    pub deposit_yocto: U128,
    pub signed_tx: Option<String>,
    pub signed_tx_hash: Option<String>,
    pub error: Option<String>,
    pub resolved_at_block: Option<U64>,
}

/// What `request_pause` would do right now, without doing it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PausePreview {
    pub ok: bool,
    pub reason: Option<String>,
    pub mitigation_id: Option<String>,
    pub unsigned_tx: Option<String>,
    pub payload_hash: Option<String>,
    pub deposit_yocto: U128,
    pub checks: Vec<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct GuardConfig {
    pub owner: AccountId,
    pub sentinel: AccountId,
    pub fee_oracle: AccountId,
    pub mpc_contract: AccountId,
    pub sign_deposit_yocto: U128,
    pub sign_gas_tgas: u64,
    pub max_quote_age_blocks: u64,
}

/// MPC `sign` return value (near/mpc `near-mpc-crypto-types` `SignatureResponse`).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(tag = "scheme")]
pub enum SignatureResponse {
    Secp256k1 { big_r: AffinePointHex, s: ScalarHex, recovery_id: u8 },
    Ed25519 { signature: Value },
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AffinePointHex {
    /// 33-byte compressed point, hex.
    pub affine_point: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ScalarHex {
    /// 32-byte scalar, hex.
    pub scalar: String,
}

/// Why a request was refused. The string form is what callers see (`rejected: <code>`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rejection {
    NotSentinel,
    InvalidId,
    NotAllowlisted,
    MitigationInFlight,
    DuplicateBreach,
    RateLimited,
    NoFeeQuote,
    FeeQuoteStale,
    TargetMismatch,
    ChainMismatch,
    SelectorMismatch,
    NonzeroValue,
    AccessListNotEmpty,
    FeeQuoteInvalid,
    FeeAboveCap,
    InsufficientBalance,
}

impl Rejection {
    pub fn as_str(self) -> &'static str {
        match self {
            Rejection::NotSentinel => "not_sentinel",
            Rejection::InvalidId => "invalid_id",
            Rejection::NotAllowlisted => "not_allowlisted",
            Rejection::MitigationInFlight => "mitigation_in_flight",
            Rejection::DuplicateBreach => "duplicate_breach",
            Rejection::RateLimited => "rate_limited",
            Rejection::NoFeeQuote => "no_fee_quote",
            Rejection::FeeQuoteStale => "fee_quote_stale",
            Rejection::TargetMismatch => "target_mismatch",
            Rejection::ChainMismatch => "chain_mismatch",
            Rejection::SelectorMismatch => "selector_mismatch",
            Rejection::NonzeroValue => "nonzero_value",
            Rejection::AccessListNotEmpty => "access_list_not_empty",
            Rejection::FeeQuoteInvalid => "fee_quote_invalid",
            Rejection::FeeAboveCap => "fee_above_cap",
            Rejection::InsufficientBalance => "insufficient_balance",
        }
    }
}

fn reject(r: Rejection) -> ! {
    env::panic_str(&format!("rejected: {}", r.as_str()))
}

/// Checks, in the order they run. Reported on success so callers can see what was enforced.
pub const CHECKS: [&str; 13] = [
    "ids_valid",
    "allowlisted",
    "not_in_flight",
    "not_duplicate",
    "rate_limit",
    "fee_quote_present",
    "fee_quote_fresh",
    "target_is_allowlisted_address",
    "chain_matches",
    "calldata_is_pause_selector",
    "value_is_zero",
    "fee_within_cap",
    "guard_balance_covers_deposit",
];

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Guarded,
    Quotes,
    Mitigations,
    Active,
    LastRequest,
}

// ---- Pure helpers (no env access) -------------------------------------------------------

pub fn valid_contract_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `[A-Za-z0-9_-]{1,63}`, so `<contract_id>_<breach_id>` fits the 128-char mitigation ID limit
/// and is unambiguous (contract IDs contain no `_`).
pub fn valid_breach_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 63 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn mitigation_id(contract_id: &str, breach_id: &str) -> String {
    format!("{contract_id}_{breach_id}")
}

pub fn parse_address(s: &str) -> Option<[u8; 20]> {
    let h = s.strip_prefix("0x")?;
    if h.len() != 40 {
        return None;
    }
    let mut out = [0u8; 20];
    hex::decode_to_slice(h, &mut out).ok()?;
    Some(out)
}

pub fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

pub fn params_for(entry: &GuardedContract, quote: &FeeQuote) -> Option<PauseParams> {
    Some(PauseParams {
        chain_id: entry.chain_id.0,
        nonce: quote.nonce.0,
        to: parse_address(&entry.address)?,
        gas_limit: entry.gas_limit.0,
        max_fee_per_gas: quote.max_fee_per_gas.0,
        max_priority_fee_per_gas: quote.max_priority_fee_per_gas.0,
    })
}

/// On-chain enforcement of the built transaction (Requirements 2.8, 2.9). Runs on every
/// request, even though `pause_tx` always builds pause(): a code or dependency change that
/// altered the transaction would be caught here rather than signed.
pub fn enforce(entry: &GuardedContract, tx: &EVMTransaction) -> Result<(), Rejection> {
    let expected_to = parse_address(&entry.address).ok_or(Rejection::TargetMismatch)?;
    if tx.to != Some(expected_to) {
        return Err(Rejection::TargetMismatch);
    }
    if tx.chain_id != entry.chain_id.0 {
        return Err(Rejection::ChainMismatch);
    }
    if tx.input.as_slice() != PAUSE_SELECTOR {
        return Err(Rejection::SelectorMismatch);
    }
    if tx.value != 0 {
        return Err(Rejection::NonzeroValue);
    }
    if !tx.access_list.is_empty() {
        return Err(Rejection::AccessListNotEmpty);
    }
    if tx.max_priority_fee_per_gas > tx.max_fee_per_gas {
        return Err(Rejection::FeeQuoteInvalid);
    }
    if tx.max_fee_per_gas > entry.max_fee_per_gas_cap.0 || tx.max_priority_fee_per_gas > entry.max_priority_fee_per_gas_cap.0 {
        return Err(Rejection::FeeAboveCap);
    }
    Ok(())
}

/// Converts an MPC secp256k1 response into `(y_parity, r, s)`. `r` is the x-coordinate of the
/// compressed point `big_r`; `y_parity` is `recovery_id`.
///
/// The point's prefix is NOT the parity. The MPC network normalizes `s` to the low half of the
/// curve order; when it negates `s`, the effective parity flips, and only `recovery_id` reflects
/// that. Testnet run 43940044484 returned `big_r` = 03… with `recovery_id` 0, and only
/// y_parity 0 recovers the MPC-derived address (regression test
/// `uses_recovery_id_not_the_point_prefix_for_parity`).
pub fn to_ecdsa(big_r_hex: &str, s_hex: &str, recovery_id: u8) -> Result<EcdsaSignature, &'static str> {
    let mut point = [0u8; 33];
    hex::decode_to_slice(big_r_hex.trim_start_matches("0x"), &mut point).map_err(|_| "bad_big_r")?;
    let mut s = [0u8; 32];
    hex::decode_to_slice(s_hex.trim_start_matches("0x"), &mut s).map_err(|_| "bad_s")?;
    if point[0] != 0x02 && point[0] != 0x03 {
        return Err("bad_big_r_prefix");
    }
    if recovery_id > 1 {
        return Err("bad_recovery_id");
    }
    let mut r = [0u8; 32];
    r.copy_from_slice(&point[1..]);
    Ok(EcdsaSignature { y_parity: recovery_id, r, s })
}

struct Plan {
    mitigation_id: String,
    entry: GuardedContract,
    quote: FeeQuote,
    unsigned: Vec<u8>,
    hash: [u8; 32],
}

fn emit(event: &str, data: Value) {
    let line = json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{line}"));
}

// ---- Contract ---------------------------------------------------------------------------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct AegisGuard {
    owner: AccountId,
    sentinel: AccountId,
    fee_oracle: AccountId,
    mpc_contract: AccountId,
    sign_deposit: NearToken,
    sign_gas_tgas: u64,
    max_quote_age_blocks: u64,
    guarded: IterableMap<String, GuardedContract>,
    quotes: LookupMap<String, FeeQuote>,
    mitigations: LookupMap<String, Mitigation>,
    /// contract_id -> mitigation_id while the MPC call is pending.
    active: LookupMap<String, String>,
    last_request_block: LookupMap<String, u64>,
}

#[near]
impl AegisGuard {
    #[init]
    pub fn new(owner: AccountId, sentinel: AccountId, fee_oracle: Option<AccountId>, mpc_contract: AccountId) -> Self {
        Self {
            fee_oracle: fee_oracle.unwrap_or_else(|| sentinel.clone()),
            owner,
            sentinel,
            mpc_contract,
            sign_deposit: NearToken::from_yoctonear(DEFAULT_SIGN_DEPOSIT_YOCTO),
            sign_gas_tgas: DEFAULT_SIGN_GAS_TGAS,
            max_quote_age_blocks: DEFAULT_MAX_QUOTE_AGE_BLOCKS,
            guarded: IterableMap::new(StorageKey::Guarded),
            quotes: LookupMap::new(StorageKey::Quotes),
            mitigations: LookupMap::new(StorageKey::Mitigations),
            active: LookupMap::new(StorageKey::Active),
            last_request_block: LookupMap::new(StorageKey::LastRequest),
        }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }

    // ---- Owner ----------------------------------------------------------------------------

    /// Adds or replaces an allowlist entry (Requirements 2.8, 2.10).
    pub fn set_guarded(&mut self, entry: GuardedContract) {
        self.assert_owner();
        require!(valid_contract_id(&entry.contract_id), "contract_id must match [a-z0-9-]{1,64}");
        require!(parse_address(&entry.address).is_some(), "address must be 0x + 40 hex characters");
        require!(entry.chain_id.0 > 0, "chain_id must be positive");
        require!(!entry.derivation_path.is_empty() && entry.derivation_path.len() <= 128, "derivation_path is required (max 128)");
        require!(entry.gas_limit.0 > 0, "gas_limit must be positive");
        require!(entry.max_fee_per_gas_cap.0 > 0 && entry.max_priority_fee_per_gas_cap.0 > 0, "fee caps must be positive");
        let entry = GuardedContract { address: entry.address.to_ascii_lowercase(), ..entry };
        emit("guarded_set", json!({ "contract_id": entry.contract_id, "chain_id": entry.chain_id, "address": entry.address, "derivation_path": entry.derivation_path }));
        self.guarded.insert(entry.contract_id.clone(), entry);
    }

    pub fn remove_guarded(&mut self, contract_id: String) {
        self.assert_owner();
        require!(!self.active.contains_key(&contract_id), "a mitigation is in flight for this contract");
        if self.guarded.remove(&contract_id).is_some() {
            self.quotes.remove(&contract_id);
            emit("guarded_removed", json!({ "contract_id": contract_id }));
        }
    }

    pub fn set_sentinel(&mut self, sentinel: AccountId) {
        self.assert_owner();
        self.sentinel = sentinel;
    }

    pub fn set_fee_oracle(&mut self, fee_oracle: AccountId) {
        self.assert_owner();
        self.fee_oracle = fee_oracle;
    }

    pub fn set_sign_config(&mut self, sign_deposit_yocto: U128, sign_gas_tgas: u64, max_quote_age_blocks: u64) {
        self.assert_owner();
        require!(sign_deposit_yocto.0 >= DEFAULT_SIGN_DEPOSIT_YOCTO, "deposit below the MPC minimum");
        require!(sign_gas_tgas >= MIN_SIGN_GAS_TGAS, "sign gas below the MPC minimum (15 TGas)");
        require!(max_quote_age_blocks > 0, "max_quote_age_blocks must be positive");
        self.sign_deposit = NearToken::from_yoctonear(sign_deposit_yocto.0);
        self.sign_gas_tgas = sign_gas_tgas;
        self.max_quote_age_blocks = max_quote_age_blocks;
    }

    // ---- Fee oracle -----------------------------------------------------------------------

    /// Records the latest nonce and EIP-1559 fees for a guarded contract's derived address.
    /// Not trusted: caps are enforced at request time.
    pub fn update_fee_quote(&mut self, contract_id: String, nonce: U64, max_fee_per_gas: U128, max_priority_fee_per_gas: U128) {
        require!(env::predecessor_account_id() == self.fee_oracle, "only the fee oracle");
        if !self.guarded.contains_key(&contract_id) {
            reject(Rejection::NotAllowlisted);
        }
        self.quotes.insert(contract_id, FeeQuote { nonce, max_fee_per_gas, max_priority_fee_per_gas, quoted_at_block: U64(env::block_height()) });
    }

    // ---- Sentinel -------------------------------------------------------------------------

    /// The Sentinel's only signing entry point (Requirements 2.1, 2.5–2.10, 2.12). Takes no
    /// target, calldata, value, or fee: the contract decides all of them. Non-payable, so it
    /// works with a function-call key (which cannot attach deposits).
    pub fn request_pause(&mut self, contract_id: String, breach_id: String) -> Promise {
        if env::predecessor_account_id() != self.sentinel {
            reject(Rejection::NotSentinel);
        }
        let block = env::block_height();
        let plan = self.plan(&contract_id, &breach_id, block).unwrap_or_else(|r| reject(r));

        // All checks passed. Only now is state written.
        let p = params_for(&plan.entry, &plan.quote).expect("checked by plan");
        let m = Mitigation {
            mitigation_id: plan.mitigation_id.clone(),
            contract_id: contract_id.clone(),
            breach_id: breach_id.clone(),
            status: MitigationStatus::Pending,
            requested_at_block: U64(block),
            requested_at_ms: U64(env::block_timestamp_ms()),
            chain_id: U64(p.chain_id),
            to: plan.entry.address.clone(),
            nonce: U64(p.nonce),
            gas_limit: U64(p.gas_limit),
            max_fee_per_gas: U128(p.max_fee_per_gas),
            max_priority_fee_per_gas: U128(p.max_priority_fee_per_gas),
            derivation_path: plan.entry.derivation_path.clone(),
            unsigned_tx: hex0x(&plan.unsigned),
            payload_hash: hex0x(&plan.hash),
            deposit_yocto: U128(self.sign_deposit.as_yoctonear()),
            signed_tx: None,
            signed_tx_hash: None,
            error: None,
            resolved_at_block: None,
        };
        self.mitigations.insert(plan.mitigation_id.clone(), m);
        self.active.insert(contract_id.clone(), plan.mitigation_id.clone());
        self.last_request_block.insert(contract_id.clone(), block);

        emit(
            "pause_requested",
            json!({
                "mitigation_id": plan.mitigation_id,
                "contract_id": contract_id,
                "breach_id": breach_id,
                "chain_id": U64(p.chain_id),
                "to": plan.entry.address,
                "nonce": U64(p.nonce),
                "payload_hash": hex0x(&plan.hash),
                "deposit_yocto": U128(self.sign_deposit.as_yoctonear()),
                "checks": CHECKS,
            }),
        );

        let args = json!({
            "request": {
                "path": plan.entry.derivation_path,
                "payload_v2": { "Ecdsa": hex::encode(plan.hash) },
                "domain_id": ECDSA_DOMAIN_ID,
            }
        });
        Promise::new(self.mpc_contract.clone())
            .function_call("sign", serde_json::to_vec(&args).expect("json"), self.sign_deposit, Gas::from_tgas(self.sign_gas_tgas))
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(CALLBACK_GAS_TGAS)).on_signature(plan.mitigation_id))
    }

    /// MPC callback. Builds the signed transaction with the leading-zero-safe encoder.
    #[private]
    pub fn on_signature(&mut self, mitigation_id: String, #[callback_result] result: Result<SignatureResponse, PromiseError>) -> Option<String> {
        let mut m = self.mitigations.get(&mitigation_id).cloned().unwrap_or_else(|| env::panic_str("unknown mitigation"));
        require!(m.status == MitigationStatus::Pending, "mitigation is not pending");
        let outcome: Result<EcdsaSignature, &'static str> = match result {
            Ok(SignatureResponse::Secp256k1 { big_r, s, recovery_id }) => to_ecdsa(&big_r.affine_point, &s.scalar, recovery_id),
            Ok(SignatureResponse::Ed25519 { .. }) => Err("unexpected_ed25519_signature"),
            Err(_) => Err("mpc_sign_failed"),
        };
        m.resolved_at_block = Some(U64(env::block_height()));
        self.active.remove(&m.contract_id);
        let signed = match outcome {
            Ok(sig) => {
                let p = PauseParams {
                    chain_id: m.chain_id.0,
                    nonce: m.nonce.0,
                    to: parse_address(&m.to).expect("stored address is valid"),
                    gas_limit: m.gas_limit.0,
                    max_fee_per_gas: m.max_fee_per_gas.0,
                    max_priority_fee_per_gas: m.max_priority_fee_per_gas.0,
                };
                let bytes = signed_bytes(&p, &sig);
                m.status = MitigationStatus::Signed;
                m.signed_tx = Some(hex0x(&bytes));
                m.signed_tx_hash = Some(hex0x(&keccak256(&bytes)));
                emit("pause_signed", json!({ "mitigation_id": m.mitigation_id, "signed_tx_hash": m.signed_tx_hash }));
                m.signed_tx.clone()
            }
            Err(reason) => {
                m.status = MitigationStatus::Failed;
                m.error = Some(reason.to_string());
                emit("pause_failed", json!({ "mitigation_id": m.mitigation_id, "reason": reason }));
                None
            }
        };
        self.mitigations.insert(mitigation_id, m);
        signed
    }

    // ---- Views ----------------------------------------------------------------------------

    /// Runs every check `request_pause` would run (except the caller check) and returns the
    /// transaction it would sign. Changes nothing.
    pub fn preview_pause(&self, contract_id: String, breach_id: String) -> PausePreview {
        let deposit_yocto = U128(self.sign_deposit.as_yoctonear());
        match self.plan(&contract_id, &breach_id, env::block_height()) {
            Ok(p) => PausePreview {
                ok: true,
                reason: None,
                mitigation_id: Some(p.mitigation_id),
                unsigned_tx: Some(hex0x(&p.unsigned)),
                payload_hash: Some(hex0x(&p.hash)),
                deposit_yocto,
                checks: CHECKS.iter().map(|c| c.to_string()).collect(),
            },
            Err(r) => PausePreview { ok: false, reason: Some(r.as_str().to_string()), mitigation_id: None, unsigned_tx: None, payload_hash: None, deposit_yocto, checks: vec![] },
        }
    }

    pub fn get_config(&self) -> GuardConfig {
        GuardConfig {
            owner: self.owner.clone(),
            sentinel: self.sentinel.clone(),
            fee_oracle: self.fee_oracle.clone(),
            mpc_contract: self.mpc_contract.clone(),
            sign_deposit_yocto: U128(self.sign_deposit.as_yoctonear()),
            sign_gas_tgas: self.sign_gas_tgas,
            max_quote_age_blocks: self.max_quote_age_blocks,
        }
    }

    pub fn get_guarded(&self, contract_id: String) -> Option<GuardedContract> {
        self.guarded.get(&contract_id).cloned()
    }

    pub fn list_guarded(&self) -> Vec<GuardedContract> {
        self.guarded.values().cloned().collect()
    }

    pub fn get_fee_quote(&self, contract_id: String) -> Option<FeeQuote> {
        self.quotes.get(&contract_id).cloned()
    }

    pub fn get_mitigation(&self, mitigation_id: String) -> Option<Mitigation> {
        self.mitigations.get(&mitigation_id).cloned()
    }

    pub fn get_active_mitigation(&self, contract_id: String) -> Option<Mitigation> {
        let id = self.active.get(&contract_id)?;
        self.mitigations.get(id).cloned()
    }
}

impl AegisGuard {
    /// Every check, in order. The first failure is returned. Reads state only.
    fn plan(&self, contract_id: &str, breach_id: &str, block: u64) -> Result<Plan, Rejection> {
        if !valid_contract_id(contract_id) || !valid_breach_id(breach_id) {
            return Err(Rejection::InvalidId);
        }
        let entry = self.guarded.get(contract_id).cloned().ok_or(Rejection::NotAllowlisted)?;
        if self.active.contains_key(contract_id) {
            return Err(Rejection::MitigationInFlight);
        }
        let id = mitigation_id(contract_id, breach_id);
        if self.mitigations.contains_key(&id) {
            return Err(Rejection::DuplicateBreach);
        }
        if let Some(last) = self.last_request_block.get(contract_id) {
            if block.saturating_sub(*last) < entry.min_interval_blocks.0 {
                return Err(Rejection::RateLimited);
            }
        }
        let quote = self.quotes.get(contract_id).cloned().ok_or(Rejection::NoFeeQuote)?;
        if block.saturating_sub(quote.quoted_at_block.0) > self.max_quote_age_blocks {
            return Err(Rejection::FeeQuoteStale);
        }
        let params = params_for(&entry, &quote).ok_or(Rejection::TargetMismatch)?;
        enforce(&entry, &pause_tx(&params))?;
        let available = env::account_balance().saturating_sub(env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage())));
        if available < self.sign_deposit {
            return Err(Rejection::InsufficientBalance);
        }
        let unsigned = unsigned_bytes(&params);
        let hash = keccak256(&unsigned);
        Ok(Plan { mitigation_id: id, entry, quote, unsigned, hash })
    }
}

#[cfg(test)]
mod tests;
