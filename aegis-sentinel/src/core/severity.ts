// Severity classification (Requirement 2.17). Pure.
// The UI shows Acid Green only when a severity is `critical` (ui-manifesto.md).
import { IN_FLIGHT_STATES, type ContractSnapshot, type SentinelSnapshot } from './model';

export type Severity = 'nominal' | 'critical' | 'contained';

export function contractSeverity(c: ContractSnapshot): Severity {
  if (c.paused) return 'contained';
  const breached = c.invariants.some((i) => i.status === 'breached');
  if (breached || IN_FLIGHT_STATES.has(c.mitigation.state)) return 'critical';
  return 'nominal';
}

export function overallSeverity(s: SentinelSnapshot): Severity {
  const levels = s.contracts.map(contractSeverity);
  if (levels.includes('critical')) return 'critical';
  if (levels.includes('contained')) return 'contained';
  return 'nominal';
}
