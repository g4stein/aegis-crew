// P19–P20: Aegis Guard mirror (core/guard.ts) against an independent oracle and against the
// Rust contract's own conformance vectors (Requirements 2.5, 2.7–2.10, 2.12, 2.15).
import { keccak_256 } from '@noble/hashes/sha3.js';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../../src/core/bytes';
import {
  enforceIntent,
  GUARD_CHECKS,
  initialGuardState,
  onSignature,
  planPause,
  requestPause,
  updateFeeQuote,
  type GuardConfig,
  type GuardEntry,
  type GuardState,
  type MpcSignResult,
} from '../../src/core/guard';
import { approveSignRequest } from '../../src/core/mitigation/gate';
import { decodeEip1559 } from '../../src/core/mitigation/payload';

const keccak = (b: Uint8Array) => keccak_256(b);

// ---- P19: soundness against an independent statement of the rules ----------------------

const CONFIG: GuardConfig = {
  owner: 'owner.testnet',
  sentinel: 'sentinel.testnet',
  feeOracle: 'oracle.testnet',
  mpcContract: 'v1.signer-prod.testnet',
  guardAccount: 'aegis-guard.testnet',
  signDepositYocto: 1n,
  signGasTgas: 50,
  maxQuoteAgeBlocks: 120n,
};

const ENTRY: GuardEntry = {
  contractId: 'legacy-vault',
  chainId: 11_155_111n,
  address: '0x000000000000000000000000000000000000ae61',
  derivationPath: 'aegis/legacy-vault/eip155:11155111',
  gasLimit: 60_000n,
  maxFeePerGasCap: 200_000_000_000n,
  maxPriorityFeePerGasCap: 5_000_000_000n,
  minIntervalBlocks: 10n,
};

const gwei = (n: number) => BigInt(Math.round(n * 1e9));

const scenario = fc.record({
  predecessor: fc.constantFrom('sentinel.testnet', 'sentinel.testnet', 'sentinel.testnet', 'mallory.testnet', 'oracle.testnet'),
  contractId: fc.constantFrom('legacy-vault', 'legacy-vault', 'legacy-vault', 'other-token', 'Bad_Id'),
  breachId: fc.oneof(fc.stringMatching(/^brk_[a-z0-9]{1,8}$/), fc.constantFrom('', 'brk/1', 'x'.repeat(64))),
  hasQuote: fc.boolean(),
  quoteBlock: fc.bigInt({ min: 0n, max: 400n }),
  // Bias half the cases to the quote-age boundary (119/120/121 blocks), where off-by-one bugs live.
  requestOffset: fc.oneof(fc.bigInt({ min: -50n, max: 400n }), fc.constantFrom(119n, 120n, 121n)),
  maxFee: fc.oneof(fc.bigInt({ min: 1n, max: gwei(250) }), fc.constant(ENTRY.maxFeePerGasCap)),
  priority: fc.oneof(fc.bigInt({ min: 0n, max: gwei(8) }), fc.constant(ENTRY.maxPriorityFeePerGasCap)),
  available: fc.constantFrom(0n, 1n, 10n ** 24n),
  prior: fc.constantFrom('none', 'in_flight', 'resolved_same_breach', 'resolved_recently', 'resolved_long_ago'),
});

const snap = (s: GuardState) => JSON.stringify({ q: [...s.quotes], m: [...s.mitigations.keys()], a: [...s.active], l: [...s.lastRequestBlock] }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

describe('aegis guard mirror', () => {
  it('P19 guard-soundness [Req 2.7, 2.8, 2.9, 2.12]: request_pause accepts iff every on-chain check passes', () => {
    fc.assert(
      fc.property(scenario, (raw) => {
        const sc = { ...raw, requestBlock: raw.quoteBlock + raw.requestOffset };
        let s = initialGuardState(CONFIG, [ENTRY]);
        if (sc.hasQuote) {
          const q = updateFeeQuote(s, { predecessor: CONFIG.feeOracle, contractId: ENTRY.contractId, nonce: 7n, maxFeePerGas: sc.maxFee, maxPriorityFeePerGas: sc.priority, blockHeight: sc.quoteBlock });
          expect(q.ok).toBe(true);
          if (q.ok) s = q.value;
        }
        // Prior history for the same contract.
        let priorBlock: bigint | undefined;
        if (sc.prior !== 'none') {
          // In-flight and long-ago priors sit outside the rate-limit window, so only the check under
          // test can reject them (otherwise the rate limit masks a missing in-flight check).
          priorBlock = sc.prior === 'resolved_recently' || sc.prior === 'resolved_same_breach' ? sc.requestBlock - 3n : sc.requestBlock - 50n;
          const priorBreach = sc.prior === 'resolved_same_breach' ? sc.breachId : 'brk_prior';
          const mitigations = new Map(s.mitigations);
          const id = `${ENTRY.contractId}_${priorBreach}`;
          mitigations.set(id, { mitigationId: id, contractId: ENTRY.contractId, breachId: priorBreach, status: sc.prior === 'in_flight' ? 'pending' : 'signed', requestedAtBlock: priorBlock } as never);
          const active = new Map(s.active);
          if (sc.prior === 'in_flight') active.set(ENTRY.contractId, id);
          s = { ...s, mitigations, active, lastRequestBlock: new Map([[ENTRY.contractId, priorBlock]]) };
        }

        const before = snap(s);
        const r = requestPause(s, { predecessor: sc.predecessor, contractId: sc.contractId, breachId: sc.breachId, blockHeight: sc.requestBlock, availableYocto: sc.available }, keccak);

        // Independent oracle (written from the requirements, not from guard.ts).
        const idsOk = /^[a-z0-9-]{1,64}$/.test(sc.contractId) && /^[A-Za-z0-9_-]{1,63}$/.test(sc.breachId);
        const expected =
          sc.predecessor === CONFIG.sentinel &&
          idsOk &&
          sc.contractId === ENTRY.contractId &&
          sc.prior !== 'in_flight' &&
          sc.prior !== 'resolved_same_breach' &&
          (priorBlock === undefined || sc.requestBlock - priorBlock >= ENTRY.minIntervalBlocks) &&
          sc.hasQuote &&
          sc.requestBlock - sc.quoteBlock <= CONFIG.maxQuoteAgeBlocks &&
          sc.priority <= sc.maxFee &&
          sc.maxFee <= ENTRY.maxFeePerGasCap &&
          sc.priority <= ENTRY.maxPriorityFeePerGasCap &&
          sc.available >= CONFIG.signDepositYocto;
        expect(r.ok).toBe(expected);

        if (!r.ok) {
          expect(snap(s)).toBe(before);
          return;
        }
        // Accepted: the only transaction the guard will sign is pause() to the allowlisted target.
        const { mitigation, signCall } = r.value;
        expect(approveSignRequest(mitigation.intent, new Map([[ENTRY.contractId, { ...ENTRY, address: ENTRY.address as `0x${string}` }]])).ok).toBe(true);
        const decoded = decodeEip1559(hexToBytes(mitigation.unsignedTx).ok ? (hexToBytes(mitigation.unsignedTx) as { value: Uint8Array }).value : new Uint8Array());
        expect(decoded.ok && decoded.value).toMatchObject({ to: ENTRY.address, data: '0x8456cb59', value: 0n, chainId: ENTRY.chainId });
        expect(signCall).toMatchObject({ receiver: CONFIG.mpcContract, method: 'sign', depositYocto: 1n });
        expect(`0x${signCall.args.request.payload_v2.Ecdsa}`).toBe(bytesToHex(keccak((hexToBytes(mitigation.unsignedTx) as { value: Uint8Array }).value)));
        expect(r.value.state.active.get(ENTRY.contractId)).toBe(mitigation.mitigationId);
      }),
    );
  });
});

describe('aegis guard transaction enforcement', () => {
  const base = { contractId: ENTRY.contractId, chainId: ENTRY.chainId, nonce: 7n, maxFeePerGas: gwei(30), maxPriorityFeePerGas: gwei(1), gasLimit: ENTRY.gasLimit, to: ENTRY.address, value: 0n, data: '0x8456cb59' };

  it('P19 guard-soundness [Req 2.8, 2.9]: enforce accepts a transaction iff it is exactly pause() to the allowlisted target', () => {
    // The guard always builds pause(), so this check is defense in depth; test it directly with
    // crafted transactions (mirrors rejects_any_calldata_other_than_the_pause_selector in Rust).
    fc.assert(
      fc.property(
        fc.record({
          data: fc.oneof(fc.constantFrom('0x8456cb59', '0x8456CB59', '0x8456cb', '0x8456cb5900', '0xa9059cbb', '0x'), fc.uint8Array({ maxLength: 8 }).map(bytesToHex)),
          value: fc.oneof(fc.constant(0n), fc.bigInt({ min: 1n, max: 1n << 64n })),
          to: fc.oneof(fc.constant(ENTRY.address), fc.constant(ENTRY.address.toUpperCase().replace('0X', '0x')), fc.uint8Array({ minLength: 20, maxLength: 20 }).map(bytesToHex)),
          chainId: fc.oneof(fc.constant(ENTRY.chainId), fc.bigInt({ min: 1n, max: 1n << 32n })),
        }),
        (t) => {
          const r = enforceIntent(ENTRY, { ...base, ...t });
          const expected = t.data.toLowerCase() === '0x8456cb59' && t.value === 0n && t.to.toLowerCase() === ENTRY.address && t.chainId === ENTRY.chainId;
          expect(r.ok).toBe(expected);
          if (!r.ok && t.to.toLowerCase() === ENTRY.address && t.chainId === ENTRY.chainId && t.value === 0n) expect(r.error).toBe('selector_mismatch');
        },
      ),
    );
  });
});

// ---- P20: conformance with the Rust contract -------------------------------------------

interface Vectors {
  generator: string;
  config: { owner: string; sentinel: string; fee_oracle: string; mpc_contract: string; guard_account: string; sign_deposit_yocto: string; sign_gas_tgas: number; max_quote_age_blocks: number };
  entries: { contract_id: string; chain_id: string; address: string; derivation_path: string; gas_limit: string; max_fee_per_gas_cap: string; max_priority_fee_per_gas_cap: string; min_interval_blocks: string }[];
  scenarios: { name: string; steps: Record<string, unknown>[] }[];
}

const vectors = JSON.parse(readFileSync(new URL('../vectors/aegis-guard.json', import.meta.url), 'utf8')) as Vectors;

describe(`aegis guard conformance (${vectors.generator})`, () => {
  const config: GuardConfig = {
    owner: vectors.config.owner,
    sentinel: vectors.config.sentinel,
    feeOracle: vectors.config.fee_oracle,
    mpcContract: vectors.config.mpc_contract,
    guardAccount: vectors.config.guard_account,
    signDepositYocto: BigInt(vectors.config.sign_deposit_yocto),
    signGasTgas: vectors.config.sign_gas_tgas,
    maxQuoteAgeBlocks: BigInt(vectors.config.max_quote_age_blocks),
  };
  const entries: GuardEntry[] = vectors.entries.map((e) => ({
    contractId: e.contract_id,
    chainId: BigInt(e.chain_id),
    address: e.address,
    derivationPath: e.derivation_path,
    gasLimit: BigInt(e.gas_limit),
    maxFeePerGasCap: BigInt(e.max_fee_per_gas_cap),
    maxPriorityFeePerGasCap: BigInt(e.max_priority_fee_per_gas_cap),
    minIntervalBlocks: BigInt(e.min_interval_blocks),
  }));

  it.each(vectors.scenarios.map((s) => [s.name, s] as const))('P20 guard-conformance [Req 2.8, 2.9, 2.12, 2.15]: %s', (_name, sc) => {
    let s = initialGuardState(config, entries);
    for (const [i, step] of sc.steps.entries()) {
      const at = `${sc.name} step ${i} (${String(step.op)})`;
      const args = step.args as Record<string, string>;
      const expectv = step.expect as Record<string, unknown>;
      const block = BigInt(step.block as number);
      if (step.op === 'update_fee_quote') {
        const r = updateFeeQuote(s, { predecessor: step.predecessor as string, contractId: args.contract_id!, nonce: BigInt(args.nonce!), maxFeePerGas: BigInt(args.max_fee_per_gas!), maxPriorityFeePerGas: BigInt(args.max_priority_fee_per_gas!), blockHeight: block });
        expect(r.ok ? { ok: true } : { ok: false, reason: r.error }, at).toEqual(expectv);
        if (r.ok) s = r.value;
      } else if (step.op === 'preview_pause') {
        const p = planPause(s, { contractId: args.contract_id!, breachId: args.breach_id!, blockHeight: block, availableYocto: BigInt(step.available_yocto as string) }, keccak);
        const got = p.ok
          ? { ok: true, reason: null, mitigation_id: p.value.mitigationId, unsigned_tx: p.value.unsignedTx, payload_hash: p.value.payloadHash, deposit_yocto: config.signDepositYocto.toString(), checks: [...GUARD_CHECKS] }
          : { ok: false, reason: p.error, mitigation_id: null, unsigned_tx: null, payload_hash: null, deposit_yocto: config.signDepositYocto.toString(), checks: [] };
        expect(got, at).toEqual(expectv);
      } else if (step.op === 'request_pause') {
        const r = requestPause(s, { predecessor: step.predecessor as string, contractId: args.contract_id!, breachId: args.breach_id!, blockHeight: block, availableYocto: BigInt(step.available_yocto as string) }, keccak);
        const got = r.ok
          ? {
              ok: true,
              mitigation_id: r.value.mitigation.mitigationId,
              unsigned_tx: r.value.mitigation.unsignedTx,
              payload_hash: r.value.mitigation.payloadHash,
              sign_call: { receiver: r.value.signCall.receiver, method: r.value.signCall.method, deposit_yocto: r.value.signCall.depositYocto.toString(), gas_tgas: r.value.signCall.gasTgas, args: r.value.signCall.args },
            }
          : { ok: false, reason: r.error };
        expect(got, at).toEqual(expectv);
        if (r.ok) s = r.value.state;
      } else if (step.op === 'on_signature') {
        const r = onSignature(s, step.mitigation_id as string, step.result as MpcSignResult, keccak);
        expect(r.ok, at).toBe(true);
        if (!r.ok) return;
        const m = r.value.mitigation;
        expect({ status: m.status, signed_tx: r.value.signedTx ?? null, signed_tx_hash: m.signedTxHash ?? null, error: m.error ?? null }, at).toEqual(expectv);
        s = r.value.state;
      } else {
        throw new Error(`unknown op ${String(step.op)}`);
      }
    }
  });

  it('covers every rejection the contract can produce from these inputs', () => {
    const reasons = new Set(vectors.scenarios.flatMap((s) => s.steps.map((st) => (st.expect as { reason?: string }).reason).filter(Boolean)));
    for (const r of ['not_sentinel', 'invalid_id', 'not_allowlisted', 'mitigation_in_flight', 'duplicate_breach', 'rate_limited', 'no_fee_quote', 'fee_quote_stale', 'fee_quote_invalid', 'fee_above_cap', 'insufficient_balance']) {
      expect(reasons, r).toContain(r);
    }
  });
});
