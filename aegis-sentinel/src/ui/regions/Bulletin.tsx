import type { ReactNode } from 'react';
import { formatDelta, formatDuration } from '../../core/format';
import type { ContractSnapshot, SentinelSnapshot } from '../../core/model';
import { contractSeverity, overallSeverity, type Severity } from '../../core/severity';
import { Mark } from '../primitives/Glyph';
import { Cell } from '../primitives/Sheet';
import { Heading, Label } from '../primitives/Type';

const RANK: Record<Severity, number> = { critical: 2, contained: 1, nominal: 0 };

function focusContract(s: SentinelSnapshot): ContractSnapshot | undefined {
  return [...s.contracts].sort((a, b) => RANK[contractSeverity(b)] - RANK[contractSeverity(a)])[0];
}

function stateText(c: ContractSnapshot): string {
  return c.mitigation.state.replace('_', ' ').toUpperCase();
}

function copy(severity: Severity, s: SentinelSnapshot, c: ContractSnapshot | undefined) {
  const invariantCount = s.contracts.reduce((n, x) => n + x.invariants.length, 0);
  if (!c || severity === 'nominal') {
    return {
      flag: <><Mark shape="square" /> All clear</>,
      headline: 'Every invariant holds.',
      deck: `${s.contracts.length} contract${s.contracts.length === 1 ? '' : 's'} \u00b7 ${invariantCount} invariant${invariantCount === 1 ? '' : 's'} \u00b7 evaluated every block`,
    };
  }
  const breached = c.invariants.find((i) => i.status === 'breached');
  if (severity === 'critical') {
    return {
      flag: <>[!] BREACH</>,
      headline: `Supply diverges on ${c.contractId}.`,
      deck: breached
        ? `${breached.label} off by ${formatDelta(breached.observed, breached.expected)} \u00b7 mitigation ${stateText(c)}`
        : `Mitigation ${stateText(c)}`,
    };
  }
  const { t0, confirmed } = c.mitigation.timeline;
  return {
    flag: <><Mark shape="square-filled" /> Contained</>,
    headline: `${c.contractId} is paused.`,
    deck:
      t0 !== undefined && confirmed !== undefined
        ? `pause() confirmed ${formatDuration(confirmed - t0)} after detection \u00b7 no human key used`
        : 'Contract reports paused() == true',
  };
}

/** A lost or pending feed is not a breach: it is reported in mono with no acid (design.md, Error Handling). */
function linkCopy(s: SentinelSnapshot) {
  const link = s.source?.link;
  if (link === 'lost') {
    return { flag: <>[ERR] Feed lost</>, headline: 'Runtime unreachable.', deck: 'Retrying. Start it with npm run -w aegis-sentinel runtime' };
  }
  if (link === 'connecting' && s.contracts.length === 0) {
    return { flag: <><Mark shape="square" /> Connecting</>, headline: 'Waiting for the runtime.', deck: 'Live-mock reads chain state through the chain-state MCP server' };
  }
  return undefined;
}

export function Bulletin({ snapshot, aside }: { snapshot: SentinelSnapshot; aside: ReactNode }) {
  const linkText = linkCopy(snapshot);
  const severity: Severity | 'link' = linkText ? 'link' : overallSeverity(snapshot);
  const text = linkText ?? copy(severity as Severity, snapshot, focusContract(snapshot));

  return (
    <>
      <Cell span={9} pad="none" labelledBy="bulletin-headline">
        {/* Requirement 2.17: text label plus live region; acid only when critical. */}
        <div className="bulletin" data-severity={severity} role="alert" aria-atomic="true">
          <div>
            <span className={severity === 'critical' ? 'flag blink' : 'flag'}>{text.flag}</span>
          </div>
          <Heading level={2} size="headline" id="bulletin-headline">
            {text.headline}
          </Heading>
          <Label>{text.deck}</Label>
        </div>
      </Cell>
      <Cell span={3} as="aside">
        {aside}
      </Cell>
    </>
  );
}
