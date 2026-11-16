// P12: Acid Green appears only for a critical state (Requirement 2.17).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { IN_FLIGHT_STATES, type ContractSnapshot, type MitigationState } from '../../src/core/model';
import { contractSeverity, overallSeverity } from '../../src/core/severity';
import { address } from './arbitraries';

const STATES: MitigationState[] = ['none', 'pending_signature', 'signed', 'broadcast', 'confirmed', 'failed', 'refused'];

const snapshot: fc.Arbitrary<ContractSnapshot> = fc.record({
  contractId: fc.stringMatching(/^[a-z0-9-]{1,12}$/),
  chain: fc.constant('eip155:11155111'),
  address,
  blockNumber: fc.bigInt({ min: 0n, max: 1n << 40n }),
  readAtMs: fc.nat(),
  paused: fc.boolean(),
  invariants: fc.array(
    fc.record({
      id: fc.constantFrom('balance-conservation', 'non-negative-balances'),
      requirement: fc.constantFrom('1.2', '1.4'),
      label: fc.constant('inv'),
      status: fc.constantFrom('holding' as const, 'breached' as const),
      expected: fc.bigInt({ min: 0n, max: 1n << 64n }),
      observed: fc.bigInt({ min: -(1n << 64n), max: 1n << 64n }),
    }),
    { maxLength: 4 },
  ),
  mitigation: fc.record({ state: fc.constantFrom(...STATES), attempts: fc.nat({ max: 3 }), timeline: fc.constant({}) }),
});

describe('severity', () => {
  it('P12 acid-iff-critical [Req 2.17]: critical iff (breached or mitigation in flight) and not contained', () => {
    fc.assert(
      fc.property(snapshot, (c) => {
        const breached = c.invariants.some((i) => i.status === 'breached');
        const inFlight = IN_FLIGHT_STATES.has(c.mitigation.state);
        const sev = contractSeverity(c);
        expect(sev === 'critical').toBe(!c.paused && (breached || inFlight));
        expect(sev === 'contained').toBe(c.paused);
      }),
    );
  });

  it('P12 acid-iff-critical [Req 2.17]: the page is critical iff at least one contract is', () => {
    fc.assert(
      fc.property(fc.array(snapshot, { maxLength: 5 }), (contracts) => {
        const page = overallSeverity({ network: 'n', mode: 'mock', budgetMs: 500, contracts, events: [] });
        expect(page === 'critical').toBe(contracts.some((c) => contractSeverity(c) === 'critical'));
      }),
    );
  });
});
