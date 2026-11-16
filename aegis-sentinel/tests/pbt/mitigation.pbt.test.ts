// P6–P11: sign-request gate, pause payload, mitigation state machine (Requirement 2).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { IN_FLIGHT_STATES } from '../../src/core/model';
import {
  DEFAULT_MITIGATION_CONFIG,
  initialMachine,
  step,
  type Command,
  type MitigationEvent,
  type MitigationMachine,
} from '../../src/core/mitigation/fsm';
import { approveSignRequest } from '../../src/core/mitigation/gate';
import { decodeEip1559, encodeEip1559Signed, encodeEip1559Unsigned, formatPauseIntent } from '../../src/core/mitigation/payload';
import { PAUSE_SELECTOR, type PauseIntent } from '../../src/core/mitigation/types';
import { address, allowlist, contractId, guardedContract, hexBytes, prefetch, recase, signature, U256_MAX, U64_MAX } from './arbitraries';

const cfg = DEFAULT_MITIGATION_CONFIG;

// ---- P6 ------------------------------------------------------------------------------

/** An intent that may or may not match an allowlist entry in each field independently. */
const gateCase = allowlist.chain((list) => {
  const entries = [...list.values()];
  const entry = fc.constantFrom(...entries);
  return fc
    .record({
      base: entry,
      useKnownId: fc.boolean(),
      otherId: contractId,
      useEntryTo: fc.boolean(),
      otherTo: fc.oneof(address, hexBytes(0, 24), fc.string()),
      useEntryChain: fc.boolean(),
      otherChain: fc.bigInt({ min: 0n, max: U64_MAX }),
      usePause: fc.boolean(),
      otherData: fc.oneof(hexBytes(0, 68), fc.constantFrom('0x', '0x8456cb', '0x8456cb5900', '0xa9059cbb')),
      zeroValue: fc.boolean(),
      otherValue: fc.bigInt({ min: 1n, max: U256_MAX }),
      p: prefetch,
    })
    .chain((c) =>
      fc.tuple(fc.constant(c), recase(c.base.address), recase(PAUSE_SELECTOR)).map(([c2, toCase, selCase]) => {
        const intent: PauseIntent = {
          contractId: c2.useKnownId ? c2.base.contractId : c2.otherId,
          chainId: c2.useEntryChain ? c2.base.chainId : c2.otherChain,
          nonce: c2.p.nonce,
          maxFeePerGas: c2.p.maxFeePerGas,
          maxPriorityFeePerGas: c2.p.maxPriorityFeePerGas,
          gasLimit: c2.base.gasLimit,
          to: c2.useEntryTo ? toCase : c2.otherTo,
          data: c2.usePause ? selCase : c2.otherData,
          value: c2.zeroValue ? 0n : c2.otherValue,
        };
        return { list, intent };
      }),
    );
});

// ---- FSM event sequences ---------------------------------------------------------

type EventTemplate =
  | { kind: 'breach_detected'; age: number }
  | { kind: 'gate_refused' }
  | { kind: 'sign_submitted' }
  | { kind: 'signature_received' }
  | { kind: 'broadcast' }
  | { kind: 'confirmed' }
  | { kind: 'timeout' }
  | { kind: 'paused_observed' };

const template: fc.Arbitrary<EventTemplate> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('breach_detected' as const), age: fc.integer({ min: 0, max: 2 * cfg.maxStateAgeMs }) }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'gate_refused' as const }) },
  { weight: 3, arbitrary: fc.constant({ kind: 'sign_submitted' as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: 'signature_received' as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: 'broadcast' as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: 'confirmed' as const }) },
  { weight: 4, arbitrary: fc.constant({ kind: 'timeout' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'paused_observed' as const }) },
);

/** Event sequences with non-decreasing wall-clock times, as a real runtime produces. */
const eventSequence: fc.Arbitrary<MitigationEvent[]> = fc
  .array(fc.tuple(fc.integer({ min: 0, max: Math.ceil(cfg.signatureTimeoutMs * 1.5) }), template, signature), { maxLength: 40 })
  .map((items) => {
    let now = 1_800_000_000_000;
    let n = 0;
    return items.map(([dt, t, sig]): MitigationEvent => {
      now += dt;
      n += 1;
      switch (t.kind) {
        case 'breach_detected':
          return { kind: 'breach_detected', breachId: `brk_${n}`, readAtMs: now - t.age, nowMs: now };
        case 'gate_refused':
          return { kind: 'gate_refused', reason: 'calldata_not_pause', nowMs: now };
        case 'sign_submitted':
          return { kind: 'sign_submitted', nearTxHash: `near_${n}`, nowMs: now };
        case 'signature_received':
          return { kind: 'signature_received', signature: sig, nowMs: now };
        case 'broadcast':
          return { kind: 'broadcast', targetTxHash: `0x${n.toString(16).padStart(64, '0')}`, nowMs: now };
        case 'confirmed':
          return { kind: 'confirmed', nowMs: now };
        case 'timeout':
          return { kind: 'timeout', nowMs: now };
        case 'paused_observed':
          return { kind: 'paused_observed', nowMs: now };
      }
    });
  });

interface Trace {
  pre: MitigationMachine;
  event: MitigationEvent;
  next: MitigationMachine;
  commands: readonly Command[];
}

function run(events: readonly MitigationEvent[]): Trace[] {
  let m = initialMachine('legacy-token');
  return events.map((event) => {
    const { next, commands } = step(m, event, cfg);
    const t = { pre: m, event, next, commands };
    m = next;
    return t;
  });
}

const submits = (cs: readonly Command[]) => cs.filter((c) => c.kind === 'submit_sign');

// ---- Properties -------------------------------------------------------------------

describe('sign-request gate', () => {
  it('P6 gate-soundness [Req 2.8, 2.9, 2.16]: approves iff allowlisted target+chain, calldata == pause(), value == 0', () => {
    fc.assert(
      fc.property(gateCase, ({ list, intent }) => {
        const entry = list.get(intent.contractId);
        const expected =
          entry !== undefined &&
          intent.to.toLowerCase() === entry.address.toLowerCase() &&
          intent.chainId === entry.chainId &&
          intent.data.toLowerCase() === PAUSE_SELECTOR &&
          intent.value === 0n;
        const r = approveSignRequest(intent, list);
        expect(r.ok).toBe(expected);
        if (r.ok) expect(r.value.derivationPath).toBe(entry?.derivationPath);
      }),
    );
  });
});

describe('pause payload', () => {
  it('P7 payload-shape [Req 2.1, 2.15]: every formatted intent passes the gate and its encoding decodes to the same fields', () => {
    fc.assert(
      fc.property(guardedContract, prefetch, signature, (entry, pf, sig) => {
        const intent = formatPauseIntent(entry, pf);
        expect(approveSignRequest(intent, new Map([[entry.contractId, entry]])).ok).toBe(true);

        const unsigned = encodeEip1559Unsigned(intent);
        expect(unsigned.ok).toBe(true);
        if (!unsigned.ok) return;
        const d = decodeEip1559(unsigned.value);
        expect(d.ok).toBe(true);
        if (!d.ok) return;
        expect(d.value).toEqual({
          chainId: entry.chainId,
          nonce: pf.nonce,
          maxPriorityFeePerGas: pf.maxPriorityFeePerGas,
          maxFeePerGas: pf.maxFeePerGas,
          gasLimit: entry.gasLimit,
          to: entry.address.toLowerCase(),
          value: 0n,
          data: PAUSE_SELECTOR,
          accessListLength: 0,
        });

        const signed = encodeEip1559Signed(intent, sig);
        expect(signed.ok).toBe(true);
        if (!signed.ok) return;
        const ds = decodeEip1559(signed.value);
        expect(ds.ok && ds.value.signature).toEqual(sig);
      }),
    );
  });

  it('P7 payload-shape [Req 2.15]: out-of-range fields are rejected as values, never encoded', () => {
    fc.assert(
      fc.property(guardedContract, prefetch, fc.bigInt({ min: U64_MAX + 1n, max: U64_MAX * 4n }), (entry, pf, big) => {
        const intent = { ...formatPauseIntent(entry, pf), nonce: big };
        const r = encodeEip1559Unsigned(intent);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.field).toBe('nonce');
      }),
    );
  });
});

describe('mitigation state machine', () => {
  it('P8 single-in-flight [Req 2.3, 2.12]: no second sign request while in flight, except one retry after timeout', () => {
    fc.assert(
      fc.property(eventSequence, (events) => {
        let episodeSubmits = 0;
        for (const t of run(events)) {
          const s = submits(t.commands);
          const wasInFlight = IN_FLIGHT_STATES.has(t.pre.mitigation.state);
          if (t.event.kind === 'breach_detected' && wasInFlight) expect(s).toHaveLength(0);
          for (const c of s) {
            if (c.kind !== 'submit_sign') continue;
            if (c.attempt === 1) {
              expect(wasInFlight).toBe(false);
              episodeSubmits = 1;
            } else {
              expect(t.event.kind).toBe('timeout');
              episodeSubmits += 1;
            }
            expect(episodeSubmits).toBeLessThanOrEqual(cfg.maxSignAttempts);
          }
        }
      }),
    );
  });

  it('P9 stops-when-paused [Req 2.13]: after paused_observed, no event sequence produces submit_sign', () => {
    fc.assert(
      fc.property(eventSequence, (events) => {
        let pausedSeen = false;
        for (const t of run(events)) {
          if (pausedSeen) expect(submits(t.commands)).toHaveLength(0);
          if (t.event.kind === 'paused_observed') pausedSeen = true;
        }
      }),
      {
        // Regression: seed 209548967 shrank to this sequence; the timeout used to resubmit after pause.
        examples: [
          [
            [
              { kind: 'breach_detected', breachId: 'brk_1', readAtMs: 1_800_000_000_000, nowMs: 1_800_000_000_000 },
              { kind: 'paused_observed', nowMs: 1_800_000_000_000 },
              { kind: 'timeout', nowMs: 1_800_000_030_000 },
            ],
          ],
        ],
      },
    );
  });

  it('P10 stale-state-reread [Req 2.14]: a breach read longer ago than MAX_STATE_AGE_MS never yields submit_sign', () => {
    fc.assert(
      fc.property(eventSequence, fc.integer({ min: cfg.maxStateAgeMs + 1, max: 10 * cfg.maxStateAgeMs }), (prefix, age) => {
        const trace = run(prefix);
        const m = trace.at(-1)?.next ?? initialMachine('legacy-token');
        const now = (prefix.at(-1)?.nowMs ?? 1_800_000_000_000) + 1;
        const { next, commands } = step(m, { kind: 'breach_detected', breachId: 'stale', readAtMs: now - age, nowMs: now }, cfg);
        expect(submits(commands)).toHaveLength(0);
        expect(next).toEqual(m);
        const eligible = !m.paused && !IN_FLIGHT_STATES.has(m.mitigation.state) && m.mitigation.state !== 'confirmed';
        if (eligible) expect(commands).toEqual([{ kind: 'reread_state' }]);
      }),
    );
  });

  it('P11 timeline-monotonic [Req 2.4]: recorded timestamps never decrease in pipeline order', () => {
    const order = ['t0', 'signRequestSubmitted', 'signatureReceived', 'broadcast', 'confirmed'] as const;
    fc.assert(
      fc.property(eventSequence, (events) => {
        for (const t of run(events)) {
          const tl = t.next.mitigation.timeline;
          const recorded = order.map((k) => tl[k]).filter((v): v is number => v !== undefined);
          for (let i = 1; i < recorded.length; i++) expect(recorded[i]).toBeGreaterThanOrEqual(recorded[i - 1]!);
          if (recorded.length > 0) expect(tl.t0).toBeDefined();
        }
      }),
    );
  });
});

