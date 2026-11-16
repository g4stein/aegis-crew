import { formatOffset, formatUtcTime, shortHex } from '../../core/format';
import { IN_FLIGHT_STATES, type ContractSnapshot, type MitigationTimeline } from '../../core/model';
import { contractSeverity } from '../../core/severity';
import { Glyph, Mark } from '../primitives/Glyph';
import { Meter } from '../primitives/Meter';
import { Cell } from '../primitives/Sheet';
import { Label, SectionHead } from '../primitives/Type';

const STEPS: readonly { key: keyof MitigationTimeline; label: string }[] = [
  { key: 't0', label: 'Breach detected' },
  { key: 'signRequestSubmitted', label: 'Sign request submitted' },
  { key: 'signatureReceived', label: 'MPC signature received' },
  { key: 'broadcast', label: 'pause() broadcast' },
  { key: 'confirmed', label: 'Confirmed on target' },
];

export function Mitigation({ contract, budgetMs }: { contract: ContractSnapshot | undefined; budgetMs: number }) {
  const m = contract?.mitigation;
  const tl = m?.timeline ?? {};
  const inFlight = m !== undefined && IN_FLIGHT_STATES.has(m.state);
  const critical = contract !== undefined && contractSeverity(contract) === 'critical';
  const firstPending = STEPS.findIndex((s) => tl[s.key] === undefined);
  const submitMs = tl.t0 !== undefined && tl.signRequestSubmitted !== undefined ? tl.signRequestSubmitted - tl.t0 : undefined;

  return (
    <Cell span={5} pad="none" labelledBy="mitigation-title">
      <SectionHead id="mitigation-title" title="Mitigation" meta="Req 2.1 / 2.4" />
      <div className="budget">
        <Label tone="ash">
          Detect <Mark shape="arrow-right" /> sign request, budget {budgetMs} ms
        </Label>
        <div className="data-lg">{submitMs === undefined ? '\u2014' : `${submitMs} ms / ${budgetMs} ms`}</div>
        <Meter value={submitMs ?? 0} max={budgetMs} critical={critical} label="Detection to sign request latency" />
      </div>
      <ol className="timeline" aria-label="Mitigation timeline">
        {STEPS.map((s, i) => {
          const t = tl[s.key];
          const done = t !== undefined;
          const current = !done && inFlight && i === firstPending;
          return (
            <li key={s.key} data-pending={(!done && !current) || undefined} data-current={current || undefined}>
              <Glyph kind={done ? 'done' : current ? 'current' : 'pending'} markOnly />
              <span>{s.label}</span>
              <span>{s.key === 't0' ? (t === undefined ? '\u2014' : formatUtcTime(t, true)) : formatOffset(tl.t0, t)}</span>
            </li>
          );
        })}
      </ol>
      <div className="budget">
        <Label tone="ash">NEAR tx</Label>
        <div className="mono-wrap">{m?.nearTxHash ?? '\u2014'}</div>
        <Label tone="ash">Target tx</Label>
        <div className="mono-wrap" title={m?.targetTxHash}>
          {m?.targetTxHash ? shortHex(m.targetTxHash, 18, 8) : '\u2014'}
        </div>
      </div>
    </Cell>
  );
}
