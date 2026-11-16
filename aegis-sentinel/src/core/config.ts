// Guarded-contract configuration (Requirements 2.8, 2.10). Pure: validates already-parsed JSON.
// Deployment facts (chain, address, derivation path) come from aegis-sentinel/config/guarded.json.
// Invariants come only from the Forge output file each entry names, so App 1 drives App 2.
import type { InvariantDefinition, InvariantRegistry } from './invariants/engine';
import type { Address } from './model';
import type { GuardedContract } from './mitigation/types';
import { err, ok, type Result } from './result';

export interface GuardedEntry {
  readonly guarded: GuardedContract;
  /** Aegis Guard limits for this contract (enforced on-chain). */
  readonly limits: {
    readonly maxFeePerGasCap: bigint;
    readonly maxPriorityFeePerGasCap: bigint;
    readonly minIntervalBlocks: bigint;
  };
  /** CAIP-2 chain ID, e.g. "eip155:11155111". */
  readonly chain: string;
  /** Contract name in the Forge output, e.g. "LegacyVault". */
  readonly forgeContract: string;
  readonly registry: InvariantRegistry;
  readonly provenance: {
    readonly invariantsFile: string;
    readonly invariantsSha256: string;
    readonly sourceName: string;
    readonly sourceSha256: string;
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: Obj, k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CONTRACT_ID = /^[a-z0-9-]{1,64}$/;
const CAIP2_EVM = /^eip155:([1-9][0-9]{0,19})$/;
const DECIMAL = /^[0-9]{1,20}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** The Forge invariants files a guarded config refers to, in order. */
export function invariantFilesOf(raw: unknown): Result<string[], string> {
  if (!isObj(raw) || !Array.isArray(raw.contracts)) return err('guarded config: expected { "contracts": [...] }');
  const files: string[] = [];
  for (const [i, c] of raw.contracts.entries()) {
    const f = isObj(c) ? str(c, 'invariants_file') : undefined;
    if (!f) return err(`guarded config: contracts[${i}].invariants_file is required`);
    files.push(f);
  }
  return ok(files);
}

function registryFrom(file: string, forgeContract: string, forge: unknown): Result<{ registry: InvariantRegistry; sourceName: string; sourceSha256: string }, string> {
  if (!isObj(forge) || !isObj(forge.source) || !Array.isArray(forge.invariants)) return err(`${file}: not a Forge invariants file`);
  const sourceName = str(forge.source, 'name');
  const sourceSha256 = str(forge.source, 'sha256');
  if (!sourceName || !sourceSha256 || !HEX64.test(sourceSha256)) return err(`${file}: source.name and source.sha256 are required`);
  const defs: InvariantDefinition[] = [];
  for (const inv of forge.invariants) {
    if (!isObj(inv) || str(inv, 'contract') !== forgeContract) continue;
    if (str(inv, 'kind') !== 'balance-conservation') return err(`${file}: unsupported invariant kind ${String(inv.kind)}`);
    const balances = str(inv, 'balances');
    const supply = str(inv, 'supply');
    if (!balances || !supply) return err(`${file}: balance-conservation needs "balances" and "supply"`);
    defs.push({ id: 'balance-conservation', kind: 'balance-conservation', requirement: '1.2', label: `\u03a3 ${balances} = ${supply}` });
  }
  if (defs.length === 0) return err(`${file}: no invariants for contract ${forgeContract}`);
  return ok({ registry: defs, sourceName, sourceSha256 });
}

/**
 * Validates the guarded config and joins each entry with its Forge invariants.
 * `files` maps each `invariants_file` to `{ json, sha256 }`, read by an adapter.
 */
export function parseGuardedConfig(
  raw: unknown,
  files: Readonly<Record<string, { readonly json: unknown; readonly sha256: string }>>,
): Result<GuardedEntry[], string> {
  if (!isObj(raw) || !Array.isArray(raw.contracts)) return err('guarded config: expected { "contracts": [...] }');
  const out: GuardedEntry[] = [];
  const seen = new Set<string>();
  for (const [i, c] of raw.contracts.entries()) {
    const at = `guarded config: contracts[${i}]`;
    if (!isObj(c)) return err(`${at} must be an object`);
    const contractId = str(c, 'contract_id');
    const file = str(c, 'invariants_file');
    const forgeContract = str(c, 'forge_contract');
    const chain = str(c, 'chain');
    const address = str(c, 'address');
    const path = str(c, 'derivation_path');
    const gas = str(c, 'gas_limit');
    if (!contractId || !CONTRACT_ID.test(contractId)) return err(`${at}.contract_id must match ${CONTRACT_ID}`);
    if (seen.has(contractId)) return err(`${at}.contract_id ${contractId} is duplicated`);
    seen.add(contractId);
    if (!file || !forgeContract) return err(`${at}: invariants_file and forge_contract are required`);
    const chainMatch = chain ? CAIP2_EVM.exec(chain) : null;
    if (!chain || !chainMatch) return err(`${at}.chain must be an EVM CAIP-2 ID like eip155:11155111`);
    if (!address || !ADDRESS.test(address)) return err(`${at}.address must be a 20-byte hex address`);
    if (!path || path.length > 128) return err(`${at}.derivation_path is required (max 128 chars)`);
    if (!gas || !DECIMAL.test(gas)) return err(`${at}.gas_limit must be a decimal string`);
    const caps = ['max_fee_per_gas_cap', 'max_priority_fee_per_gas_cap', 'min_interval_blocks'].map((k) => str(c, k));
    if (caps.some((v) => !v || !/^[0-9]{1,40}$/.test(v) || BigInt(v) === 0n)) {
      return err(`${at}: max_fee_per_gas_cap, max_priority_fee_per_gas_cap and min_interval_blocks must be positive decimal strings`);
    }
    const f = files[file];
    if (!f) return err(`${at}: invariants file ${file} was not loaded`);
    const reg = registryFrom(file, forgeContract, f.json);
    if (!reg.ok) return reg;
    out.push({
      guarded: { contractId, chainId: BigInt(chainMatch[1]!), address: address as Address, derivationPath: path, gasLimit: BigInt(gas) },
      limits: { maxFeePerGasCap: BigInt(caps[0]!), maxPriorityFeePerGasCap: BigInt(caps[1]!), minIntervalBlocks: BigInt(caps[2]!) },
      chain,
      forgeContract,
      registry: reg.value.registry,
      provenance: { invariantsFile: file, invariantsSha256: f.sha256, sourceName: reg.value.sourceName, sourceSha256: reg.value.sourceSha256 },
    });
  }
  return ok(out);
}

/** Aegis Guard deployment settings from the guarded config's `guard` object. */
export interface GuardSettings {
  readonly account: string;
  readonly owner: string;
  readonly sentinel: string;
  readonly feeOracle: string;
  readonly mpcContract: string;
  readonly signDepositYocto: bigint;
  readonly signGasTgas: number;
  readonly maxQuoteAgeBlocks: bigint;
}

const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function parseGuardSettings(raw: unknown): Result<GuardSettings, string> {
  const at = 'guarded config: guard';
  if (!isObj(raw) || !isObj(raw.guard)) return err(`${at} is required`);
  const g = raw.guard;
  const accounts = ['account', 'owner', 'sentinel', 'fee_oracle', 'mpc_contract'].map((k) => str(g, k));
  if (accounts.some((a) => !a || !NEAR_ACCOUNT.test(a))) return err(`${at}: account, owner, sentinel, fee_oracle and mpc_contract must be NEAR account IDs`);
  const deposit = str(g, 'sign_deposit_yocto');
  const age = str(g, 'max_quote_age_blocks');
  const gas = g.sign_gas_tgas;
  if (!deposit || !/^[0-9]{1,40}$/.test(deposit) || BigInt(deposit) < 1n) return err(`${at}.sign_deposit_yocto must be >= 1`);
  if (typeof gas !== 'number' || !Number.isInteger(gas) || gas < 15) return err(`${at}.sign_gas_tgas must be an integer >= 15 (MPC minimum)`);
  if (!age || !/^[0-9]{1,20}$/.test(age) || BigInt(age) === 0n) return err(`${at}.max_quote_age_blocks must be positive`);
  const [account, owner, sentinel, feeOracle, mpcContract] = accounts as [string, string, string, string, string];
  return ok({ account, owner, sentinel, feeOracle, mpcContract, signDepositYocto: BigInt(deposit), signGasTgas: gas, maxQuoteAgeBlocks: BigInt(age) });
}
