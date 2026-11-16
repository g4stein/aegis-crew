// Guarded-contract configuration (Requirements 2.8, 2.10). Pure: validates already-parsed JSON.
// Deployment facts (chain, address, derivation path) come from aegis-sentinel/config/guarded.json.
// Invariants come only from the Forge output file each entry names, so App 1 drives App 2.
import type { InvariantDefinition, InvariantRegistry } from './invariants/engine';
import type { Address } from './model';
import type { GuardedContract } from './mitigation/types';
import { err, ok, type Result } from './result';

export interface GuardedEntry {
  readonly guarded: GuardedContract;
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
    const f = files[file];
    if (!f) return err(`${at}: invariants file ${file} was not loaded`);
    const reg = registryFrom(file, forgeContract, f.json);
    if (!reg.ok) return reg;
    out.push({
      guarded: { contractId, chainId: BigInt(chainMatch[1]!), address: address as Address, derivationPath: path, gasLimit: BigInt(gas) },
      chain,
      forgeContract,
      registry: reg.value.registry,
      provenance: { invariantsFile: file, invariantsSha256: f.sha256, sourceName: reg.value.sourceName, sourceSha256: reg.value.sourceSha256 },
    });
  }
  return ok(out);
}
