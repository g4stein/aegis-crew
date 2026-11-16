// P17–P18: runtime fast-path decisions and wire codecs (Requirements 2.1, 2.12–2.14, 2.17).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { planFastPath, reevaluate } from '../../src/core/fastpath';
import { IN_FLIGHT_STATES, type ContractSnapshot, type InvariantReading, type MitigationState, type SentinelSnapshot } from '../../src/core/model';
import { decodeBroadcastResult, decodeChainReadout, decodeSnapshot, encodeBroadcastResult, encodeChainReadout, encodeSnapshot, type BroadcastResult, type ChainContractStatus } from '../../src/core/wire';
import { address } from './arbitraries';

const STATES: MitigationState[] = ['none', 'pending_signature', 'signed', 'broadcast', 'confirmed', 'failed', 'refused'];
const amount = fc.oneof(fc.bigInt({ min: 0n, max: 10n }), fc.bigInt({ min: -(1n << 70n), max: 1n << 70n }));

const reading: fc.Arbitrary<InvariantReading> = fc
  .record({
    id: fc.constantFrom('balance-conservation', 'non-negative-balances'),
    requirement: fc.constantFrom('1.2', '1.4'),
    label: fc.constantFrom('Σ balanceOf = totalSupply', 'balanceOf(a) >= 0'),
    status: fc.constantFrom('holding' as const, 'breached' as const),
    expected: amount,
    observed: amount,
    breachId: fc.option(fc.stringMatching(/^brk_[a-z0-9]{1,8}$/), { nil: undefined }),
    detectedAtMs: fc.option(fc.nat(), { nil: undefined }),
  })
  .map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as unknown as InvariantReading);

const status: fc.Arbitrary<ChainContractStatus> = fc.record({
  contractId: fc.stringMatching(/^[a-z0-9-]{1,12}$/),
  chain: fc.constant('eip155:11155111'),
  address,
  blockNumber: fc.bigInt({ min: 0n, max: 1n << 40n }),
  paused: fc.boolean(),
  invariants: fc.array(reading, { maxLength: 3 }),
  mitigation: fc.record({ state: fc.constantFrom(...STATES) }),
});

const truthBreached = (r: InvariantReading) => (r.id === 'balance-conservation' ? r.observed !== r.expected : r.observed < 0n);

describe('runtime fast path', () => {
  it('P17 fast-path-decision [Req 2.1, 2.12, 2.13, 2.14]: mitigate iff fresh, unpaused, idle, and a recomputed breach is unsubmitted', () => {
    fc.assert(
      fc.property(status, fc.nat({ max: 10_000 }), fc.nat({ max: 10_000 }), fc.array(fc.stringMatching(/^brk_[a-z0-9]{1,8}$/), { maxLength: 3 }), (s, readAt, age, submittedList) => {
        const submitted = new Set(submittedList);
        const maxStateAgeMs = 2_000;
        const d = planFastPath({ status: s, readAtMs: readAt, nowMs: readAt + age, maxStateAgeMs, submitted });

        // The server's status field is never trusted.
        const re = reevaluate(s.invariants);
        re.forEach((r, i) => expect(r.status === 'breached').toBe(truthBreached(s.invariants[i]!)));

        const idle = !s.paused && !IN_FLIGHT_STATES.has(s.mitigation.state) && s.mitigation.state !== 'confirmed';
        const candidate = s.invariants.find((r) => truthBreached(r) && r.breachId !== undefined && !submitted.has(r.breachId));
        const act = idle && candidate !== undefined;
        expect(d.kind === 'mitigate').toBe(act && age <= maxStateAgeMs);
        expect(d.kind === 'reread').toBe(act && age > maxStateAgeMs);
        if (d.kind !== 'none') expect(d.breachId).toBe(candidate!.breachId);
      }),
    );
  });
});

const snapshot: fc.Arbitrary<SentinelSnapshot> = fc.record({
  network: fc.string({ maxLength: 20 }),
  mode: fc.constantFrom('mock' as const, 'live' as const),
  budgetMs: fc.constant(500),
  contracts: fc.array(
    fc.record({
      contractId: fc.stringMatching(/^[a-z0-9-]{1,12}$/),
      chain: fc.constant('eip155:11155111'),
      address,
      blockNumber: fc.bigInt({ min: 0n, max: 1n << 40n }),
      readAtMs: fc.nat(),
      paused: fc.boolean(),
      invariants: fc.array(reading, { maxLength: 3 }),
      mitigation: fc.record({
        state: fc.constantFrom(...STATES),
        attempts: fc.nat({ max: 3 }),
        timeline: fc.record({ t0: fc.nat(), signRequestSubmitted: fc.nat() }, { requiredKeys: [] }),
      }),
    }) as fc.Arbitrary<ContractSnapshot>,
    { maxLength: 3 },
  ),
  events: fc.array(fc.record({ seq: fc.nat(), atMs: fc.nat(), level: fc.constantFrom('info' as const, 'warn' as const, 'critical' as const), message: fc.string({ maxLength: 40 }) }), { maxLength: 5 }),
  source: fc.record({ kind: fc.constantFrom('scripted' as const, 'live-mock' as const), link: fc.constantFrom('connecting' as const, 'open' as const, 'lost' as const) }),
});

const throughJson = (o: unknown) => JSON.parse(JSON.stringify(o)) as unknown;

describe('wire codecs', () => {
  it('P18 wire-roundtrip [Req 2.17]: snapshots, chain readouts, and broadcast results survive JSON losslessly', () => {
    fc.assert(
      fc.property(snapshot, status, fc.nat(), (s, c, readAt) => {
        const ds = decodeSnapshot(throughJson(encodeSnapshot(s)));
        expect(ds.ok && ds.value).toEqual(s);

        const readout = { readAtMs: readAt, contracts: [c] };
        const dr = decodeChainReadout(throughJson(encodeChainReadout(readout)));
        expect(dr.ok).toBe(true);
        if (dr.ok) expect(dr.value.contracts[0]!.invariants.map((r) => [r.id, r.expected, r.observed, r.breachId])).toEqual(c.invariants.map((r) => [r.id, r.expected, r.observed, r.breachId]));

        const b: BroadcastResult = { status: 'refused', contractId: c.contractId, refusalReason: 'not_allowlisted' };
        const db = decodeBroadcastResult(throughJson(encodeBroadcastResult(b)));
        expect(db.ok && db.value).toEqual(b);
      }),
    );
  });

  it('P18 wire-roundtrip [Req 2.17]: malformed amounts and states are rejected, never coerced', () => {
    fc.assert(
      fc.property(status, fc.constantFrom('1.5', '0x10', '', ' 7', '1e3', 'NaN'), (c, bad) => {
        const wire = throughJson(encodeChainReadout({ readAtMs: 1, contracts: [{ ...c, invariants: [{ id: 'balance-conservation', requirement: '1.2', label: 'x', status: 'holding', expected: 1n, observed: 1n }] }] })) as {
          contracts: { invariants: { observed: string }[]; mitigation: { state: string } }[];
        };
        wire.contracts[0]!.invariants[0]!.observed = bad;
        expect(decodeChainReadout(wire).ok).toBe(false);
        const wire2 = throughJson(encodeChainReadout({ readAtMs: 1, contracts: [c] })) as typeof wire;
        wire2.contracts[0]!.mitigation.state = 'exploded';
        expect(decodeChainReadout(wire2).ok).toBe(false);
      }),
    );
  });
});
