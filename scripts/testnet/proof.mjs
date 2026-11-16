#!/usr/bin/env node
// Testnet proof for the Aegis Guard (tasks 5.5, 11.x). Run by .github/workflows/testnet-proof.yml.
//
// One run, on NEAR testnet, with fresh accounts:
//   1. guard-<tag>.<you>     created, funded, deployed, and initialized in ONE transaction that
//                            adds no access key, so the guard account never has a key.
//   2. sentinel-<tag>.<you>  created with a single function-call key that may call only
//                            guard.request_pause (it cannot attach deposits).
//   3. <you> (owner + fee oracle) allowlists the target and posts a fee quote.
//   4. The Sentinel key calls request_pause(contract_id, breach_id). The guard runs its 13 checks,
//      builds pause() itself, pays the MPC deposit, and calls v1.signer-prod.testnet.sign.
//   5. The script waits for on_signature, then checks the signed EIP-1559 transaction offline:
//      canonical encoding, fields, and that the signer recovers to the MPC-derived address.
//   6. Negative checks: a non-Sentinel caller, a replayed breach, and the Sentinel key calling an
//      owner method are all refused.
//   7. Optional (AEGIS_BROADCAST=1 + SEPOLIA_RPC_URL + a target with code): broadcast to Sepolia.
//
// Env: NEAR_TESTNET_ACCOUNT_ID, NEAR_TESTNET_PRIVATE_KEY (never logged), AEGIS_GUARD_WASM,
//      optional NEAR_RPC_URL, SEPOLIA_RPC_URL, AEGIS_TARGET_ADDRESS, AEGIS_BROADCAST, AEGIS_PROOF_OUT.
// `node proof.mjs --check` makes read-only calls only and needs no secrets.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, actions, baseDecode, baseEncode, JsonRpcProvider, KeyPair, nearToYocto, teraToGas, yoctoToNear } from 'near-api-js';
import { createPublicClient, http, keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const CHECK_ONLY = process.argv.includes('--check');
const NEAR_RPC = process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com';
const NEARBLOCKS = 'https://testnet.nearblocks.io';
const SIGN_TIMEOUT_MS = 240_000;

const config = JSON.parse(readFileSync(resolve(REPO, 'aegis-sentinel/config/guarded.json'), 'utf8'));
const entry = config.contracts[0];
const MPC = config.guard.mpc_contract;
const chainId = BigInt(/^eip155:(\d+)$/.exec(entry.chain)[1]);

const provider = new JsonRpcProvider({ url: NEAR_RPC });
const log = (msg) => process.stdout.write(`[testnet-proof] ${msg}\n`);
const txUrl = (hash) => `${NEARBLOCKS}/txns/${hash}`;
const accountUrl = (id) => `${NEARBLOCKS}/address/${id}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  process.stderr.write(`[testnet-proof] FAILED: ${msg}\n`);
  process.exit(1);
}

function expect(cond, msg) {
  if (!cond) fail(msg);
}

/** EVM address the MPC network controls for (predecessor, path) in the secp256k1 domain. */
async function derivedAddress(predecessor, path) {
  const pk = await provider.callFunction({ contractId: MPC, method: 'derived_public_key', args: { path, predecessor, domain_id: 0 } });
  expect(typeof pk === 'string' && pk.startsWith('secp256k1:'), `unexpected derived_public_key result: ${JSON.stringify(pk)}`);
  const raw = baseDecode(pk.slice('secp256k1:'.length));
  const uncompressed = raw.length === 64 ? Uint8Array.of(4, ...raw) : raw;
  expect(uncompressed.length === 65 && uncompressed[0] === 4, `derived key has ${raw.length} bytes, expected 64`);
  return { publicKey: pk, address: publicKeyToAddress(`0x${Buffer.from(uncompressed).toString('hex')}`) };
}

/** Signs and submits; returns the tx hash once included (does not wait for MPC yield/resume). */
async function submit(account, receiverId, txActions, waitUntil = 'EXECUTED_OPTIMISTIC') {
  const signer = account.getSigner();
  if (!signer) throw new Error(`no signer for ${account.accountId}`);
  const publicKey = await signer.getPublicKey();
  const tx = await account.createTransaction({ receiverId, actions: txActions, publicKey });
  const { txHash, signedTransaction } = await signer.signTransaction(tx);
  const hash = baseEncode(txHash);
  const res = await provider.sendTransactionUntil(signedTransaction, waitUntil);
  return { hash, res };
}

/** Runs fn and returns the refusal text; fails the proof if fn succeeds. */
async function refusal(label, fn) {
  try {
    const out = await fn();
    const failure = JSON.stringify(out?.res?.status ?? '').includes('Failure') || JSON.stringify(out?.res?.receipts_outcome ?? '').includes('rejected:');
    if (!failure) fail(`${label}: expected a refusal, but it succeeded`);
    const text = JSON.stringify(out.res.receipts_outcome ?? out.res.status);
    return { refused: true, reason: /rejected: [a-z_]+|only the [a-z ]+/.exec(text)?.[0] ?? 'Failure', ...(out.hash ? { tx: txUrl(out.hash) } : {}) };
  } catch (e) {
    const reason = e?.panicMessage ?? e?.type ?? e?.message ?? String(e);
    return { refused: true, reason: String(reason).slice(0, 200) };
  }
}

async function check() {
  const status = await provider.viewBlock({ finality: 'final' });
  log(`NEAR testnet reachable at block ${status.header.height}`);
  const d = await derivedAddress(config.guard.account, entry.derivation_path);
  log(`MPC ${MPC}: ${config.guard.account} + "${entry.derivation_path}" -> ${d.address}`);
  const wasm = process.env.AEGIS_GUARD_WASM;
  if (wasm) log(`wasm ${wasm}: ${existsSync(wasm) ? `${readFileSync(wasm).length} bytes` : 'missing'}`);
  log('check passed (read-only; no accounts created)');
}

async function proof() {
  // Secrets pasted into GitHub often carry a stray space, newline, or quotes; strip them.
  const clean = (v) => (v ?? '').trim().replace(/^["']+|["']+$/g, '').trim();
  const me = clean(process.env.NEAR_TESTNET_ACCOUNT_ID);
  const key = clean(process.env.NEAR_TESTNET_PRIVATE_KEY);
  const wasmPath = process.env.AEGIS_GUARD_WASM;
  expect(me && key, 'set NEAR_TESTNET_ACCOUNT_ID and NEAR_TESTNET_PRIVATE_KEY (repository secrets)');
  // Never print the key itself; describe what is wrong with it.
  expect(/^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.testnet$/.test(me), `NEAR_TESTNET_ACCOUNT_ID must be a testnet account like name.testnet (got ${me.length} chars ending "${me.slice(-12)}")`);
  expect(/^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(key), `NEAR_TESTNET_PRIVATE_KEY must look like ed25519:<base58> with no spaces (got ${key.length} chars, starts "${key.slice(0, 8)}")`);
  expect(wasmPath && existsSync(wasmPath), `AEGIS_GUARD_WASM must point to the built contract (got ${wasmPath})`);
  const wasm = readFileSync(wasmPath);
  const owner = new Account(me, provider, key);
  const tag = (process.env.GITHUB_RUN_ID ? `r${process.env.GITHUB_RUN_ID}` : Date.now().toString(36)).slice(-12);
  const guardId = `guard-${tag}.${me}`;
  const sentinelId = `sentinel-${tag}.${me}`;
  expect(guardId.length <= 64 && sentinelId.length <= 64, `account IDs too long for ${me}`);
  const startedAt = new Date().toISOString();
  const out = { startedAt, network: 'testnet', nearRpc: NEAR_RPC, mpcContract: MPC, owner: me, guard: guardId, sentinel: sentinelId, links: {}, checks: {}, negative: {} };

  const balance = await owner.getBalance();
  log(`owner ${me}: ${yoctoToNear(balance, 3)} NEAR`);
  // Storage costs 1e19 yoctoNEAR per byte; fund the wasm plus 0.5 NEAR for state and deposits.
  const guardFunding = BigInt(wasm.length) * 10n ** 19n + nearToYocto('0.5');
  // The Sentinel pays for its own calls. NEAR reserves prepaid gas at a pessimistic price
  // (run 43938901007: 300 TGas cost 0.3009 NEAR up front), so fund well above the gas used.
  const sentinelFunding = nearToYocto('1.2');
  const sentinelAllowance = nearToYocto('1');
  const needed = guardFunding + sentinelFunding + nearToYocto('0.3');
  expect(balance > needed, `owner needs at least ${yoctoToNear(needed, 2)} NEAR; has ${yoctoToNear(balance, 2)} (top up at https://near-faucet.io)`);

  // 1. Guard: create + fund + deploy + init in one transaction, with no access key.
  log(`creating ${guardId} (${wasm.length} bytes of wasm, no access key)`);
  const g = await submit(owner, guardId, [
    actions.createAccount(),
    actions.transfer(guardFunding),
    actions.deployContract(new Uint8Array(wasm)),
    actions.functionCall('new', { owner: me, sentinel: sentinelId, fee_oracle: me, mpc_contract: MPC }, teraToGas('100')),
  ]);
  out.links.guardDeploy = txUrl(g.hash);
  out.links.guardAccount = accountUrl(guardId);
  const guardKeys = await provider.viewAccessKeyList({ accountId: guardId });
  out.checks.guardAccessKeys = guardKeys.keys.length;
  expect(guardKeys.keys.length === 0, `guard account has ${guardKeys.keys.length} access keys; expected 0`);
  log(`guard deployed: ${txUrl(g.hash)} (0 access keys)`);

  // 2. Sentinel: one function-call key, request_pause only.
  const sentinelKey = KeyPair.fromRandom('ed25519');
  const s = await submit(owner, sentinelId, [
    actions.createAccount(),
    actions.transfer(sentinelFunding),
    actions.addFunctionCallAccessKey(sentinelKey.getPublicKey(), guardId, ['request_pause'], sentinelAllowance),
  ]);
  out.links.sentinelCreate = txUrl(s.hash);
  const sKeys = await provider.viewAccessKeyList({ accountId: sentinelId });
  out.checks.sentinelKeys = sKeys.keys.map((k) => k.access_key.permission);
  expect(
    sKeys.keys.length === 1 && JSON.stringify(sKeys.keys[0].access_key.permission).includes('request_pause') && sKeys.keys[0].access_key.permission !== 'FullAccess',
    `sentinel keys are not a single request_pause function-call key: ${JSON.stringify(out.checks.sentinelKeys)}`,
  );
  const sentinel = new Account(sentinelId, provider, sentinelKey.toString());
  log(`sentinel created with one function-call key (request_pause on ${guardId}): ${txUrl(s.hash)}`);

  // 3. Allowlist and fee quote. The derived address is the MPC key for (guard, path).
  const derived = await derivedAddress(guardId, entry.derivation_path);
  out.derivedAddress = derived.address;
  out.derivedPublicKey = derived.publicKey;
  const target = (process.env.AEGIS_TARGET_ADDRESS || entry.address).toLowerCase();
  let nonce = 0n;
  let maxFee = 2_000_000_000n;
  let maxPriority = 1_000_000_000n;
  const evm = process.env.SEPOLIA_RPC_URL && chainId === 11155111n ? createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) }) : undefined;
  if (evm) {
    nonce = BigInt(await evm.getTransactionCount({ address: derived.address }));
    const fees = await evm.estimateFeesPerGas();
    maxFee = fees.maxFeePerGas < BigInt(entry.max_fee_per_gas_cap) ? fees.maxFeePerGas : BigInt(entry.max_fee_per_gas_cap);
    maxPriority = fees.maxPriorityFeePerGas < BigInt(entry.max_priority_fee_per_gas_cap) ? fees.maxPriorityFeePerGas : BigInt(entry.max_priority_fee_per_gas_cap);
    if (maxPriority > maxFee) maxPriority = maxFee;
  }
  const c = await submit(owner, guardId, [
    actions.functionCall(
      'set_guarded',
      {
        entry: {
          contract_id: entry.contract_id,
          chain_id: chainId.toString(),
          address: target,
          derivation_path: entry.derivation_path,
          gas_limit: entry.gas_limit,
          max_fee_per_gas_cap: entry.max_fee_per_gas_cap,
          max_priority_fee_per_gas_cap: entry.max_priority_fee_per_gas_cap,
          min_interval_blocks: entry.min_interval_blocks,
        },
      },
      teraToGas('30'),
    ),
    actions.functionCall('update_fee_quote', { contract_id: entry.contract_id, nonce: nonce.toString(), max_fee_per_gas: maxFee.toString(), max_priority_fee_per_gas: maxPriority.toString() }, teraToGas('30')),
  ]);
  out.links.allowlistAndQuote = txUrl(c.hash);
  out.target = { chain: entry.chain, address: target, nonce: nonce.toString(), maxFeePerGas: maxFee.toString(), maxPriorityFeePerGas: maxPriority.toString(), feesFrom: evm ? 'sepolia rpc' : 'defaults (no SEPOLIA_RPC_URL)' };
  log(`allowlisted ${entry.contract_id} -> ${target} on ${entry.chain}, fee quote nonce ${nonce}: ${txUrl(c.hash)}`);

  // 4. Preview, then the real request from the Sentinel's restricted key.
  const breachId = `brk_testnet_${tag}`;
  const mitigationId = `${entry.contract_id}_${breachId}`;
  const preview = await provider.callFunction({ contractId: guardId, method: 'preview_pause', args: { contract_id: entry.contract_id, breach_id: breachId } });
  expect(preview?.ok === true, `preview_pause refused: ${preview?.reason}`);
  out.checks.guardChecks = preview.checks;
  log(`preview_pause: ${preview.checks.length} checks pass; payload ${preview.payload_hash}`);

  const t0 = Date.now();
  const r = await submit(sentinel, guardId, [actions.functionCall('request_pause', { contract_id: entry.contract_id, breach_id: breachId }, teraToGas('150'), 0n)], 'INCLUDED');
  out.links.requestPause = txUrl(r.hash);
  log(`request_pause sent by the Sentinel's function-call key (0 deposit): ${txUrl(r.hash)}`);

  // 5. Wait for the MPC callback.
  let m;
  let checkedTx = false;
  while (Date.now() - t0 < SIGN_TIMEOUT_MS) {
    m = await provider.callFunction({ contractId: guardId, method: 'get_mitigation', args: { mitigation_id: mitigationId } }).catch(() => undefined);
    if (m && m.status !== 'pending') break;
    if (!m && !checkedTx && Date.now() - t0 > 15_000) {
      // No mitigation after 15 s: if request_pause itself was rejected, say why instead of waiting.
      checkedTx = true;
      const st = await provider.viewTransactionStatus({ txHash: r.hash, accountId: sentinelId, waitUntil: 'NONE' }).catch(() => undefined);
      const reason = /rejected: [a-z_]+/.exec(JSON.stringify(st ?? ''))?.[0];
      if (reason) fail(`request_pause ${reason}: ${txUrl(r.hash)}`);
    }
    await sleep(2_000);
  }
  expect(m, 'mitigation never appeared; see the request_pause transaction');
  expect(m.status === 'signed', `mitigation ${m.status}${m.error ? `: ${m.error}` : ''} (timeout ${SIGN_TIMEOUT_MS / 1000} s)`);
  out.mitigation = m;
  out.timings = { requestToSignedMs: Date.now() - t0 };
  log(`MPC signed in ${((Date.now() - t0) / 1000).toFixed(1)} s; signed tx hash ${m.signed_tx_hash}`);

  const parsed = parseTransaction(m.signed_tx);
  const recovered = await recoverTransactionAddress({ serializedTransaction: m.signed_tx });
  out.checks.signedTx = {
    type: parsed.type,
    chainId: parsed.chainId,
    to: parsed.to,
    data: parsed.data,
    value: (parsed.value ?? 0n).toString(),
    unsignedMatchesPayloadHash: keccak256(m.unsigned_tx) === m.payload_hash,
    signedHashMatches: keccak256(m.signed_tx) === m.signed_tx_hash,
    recoveredSigner: recovered,
    recoveredEqualsDerived: recovered.toLowerCase() === derived.address.toLowerCase(),
  };
  const st = out.checks.signedTx;
  expect(parsed.type === 'eip1559' && BigInt(parsed.chainId) === chainId, 'signed tx is not EIP-1559 on the guarded chain');
  expect(parsed.to?.toLowerCase() === target && parsed.data === '0x8456cb59' && (parsed.value ?? 0n) === 0n, 'signed tx is not pause() to the allowlisted target with value 0');
  expect(st.unsignedMatchesPayloadHash && st.signedHashMatches, 'hash mismatch between guard fields and bytes');
  expect(st.recoveredEqualsDerived, `signer ${recovered} != MPC-derived ${derived.address}`);
  log(`signed tx verified: pause() to ${target}, chain ${parsed.chainId}, signer ${recovered} == MPC-derived address`);

  // 6. Refusals.
  out.negative.notSentinel = await refusal('owner calls request_pause', () =>
    submit(owner, guardId, [actions.functionCall('request_pause', { contract_id: entry.contract_id, breach_id: `${breachId}_x` }, teraToGas('100'))]),
  );
  out.negative.replayedBreach = await refusal('sentinel replays the breach', () =>
    submit(sentinel, guardId, [actions.functionCall('request_pause', { contract_id: entry.contract_id, breach_id: breachId }, teraToGas('100'))]),
  );
  out.negative.sentinelCallsOwnerMethod = await refusal('sentinel key calls set_sentinel', () =>
    submit(sentinel, guardId, [actions.functionCall('set_sentinel', { sentinel: sentinelId }, teraToGas('30'))]),
  );
  for (const [k, v] of Object.entries(out.negative)) log(`refused as expected (${k}): ${v.reason}`);

  // 7. Optional broadcast.
  out.broadcast = { done: false };
  if (process.env.AEGIS_BROADCAST === '1') {
    if (!evm) out.broadcast.reason = 'SEPOLIA_RPC_URL not set';
    else if (!process.env.AEGIS_TARGET_ADDRESS) out.broadcast.reason = 'AEGIS_TARGET_ADDRESS not set (the default address has no contract)';
    else if (!(await evm.getCode({ address: target }))) out.broadcast.reason = `no contract code at ${target}`;
    else {
      const bal = await evm.getBalance({ address: derived.address });
      const need = BigInt(entry.gas_limit) * maxFee;
      if (bal < need) out.broadcast.reason = `derived address ${derived.address} has ${bal} wei; needs ${need} for gas`;
      else {
        const hash = await evm.sendRawTransaction({ serializedTransaction: m.signed_tx });
        const receipt = await evm.waitForTransactionReceipt({ hash, timeout: 180_000 });
        out.broadcast = { done: true, hash, status: receipt.status, block: receipt.blockNumber.toString(), link: `https://sepolia.etherscan.io/tx/${hash}` };
        expect(receipt.status === 'success', `pause() reverted on Sepolia: ${out.broadcast.link}`);
        log(`pause() confirmed on Sepolia: ${out.broadcast.link}`);
      }
    }
    if (!out.broadcast.done) log(`not broadcast: ${out.broadcast.reason}`);
  } else out.broadcast.reason = 'AEGIS_BROADCAST not set';

  out.finishedAt = new Date().toISOString();
  const file = process.env.AEGIS_PROOF_OUT || resolve(REPO, '.kiro/artifacts/testnet-proof.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  log(`wrote ${file}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = Object.entries(out.links).map(([k, v]) => `| ${k} | ${v} |`).join('\n');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Aegis Guard testnet proof\n\n| Step | NEAR explorer |\n|---|---|\n${rows}\n\n- Guard access keys: **${out.checks.guardAccessKeys}**\n- Sentinel key: function-call, \`request_pause\` only\n- Checks enforced: **${out.checks.guardChecks.length}**\n- MPC signature in **${(out.timings.requestToSignedMs / 1000).toFixed(1)} s**; signer \`${recovered}\` = derived address\n- Refusals: ${Object.values(out.negative).map((v) => `\`${v.reason}\``).join(', ')}\n- Sepolia broadcast: ${out.broadcast.done ? out.broadcast.link : out.broadcast.reason}\n`,
    );
  }
}

(CHECK_ONLY ? check() : proof()).catch((e) => fail(e?.panicMessage ?? e?.message ?? String(e)));
