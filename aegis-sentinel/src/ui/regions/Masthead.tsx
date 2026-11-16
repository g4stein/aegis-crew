import { formatUtcDate, formatUtcTime } from '../../core/format';
import type { SentinelSnapshot } from '../../core/model';
import { useNow } from '../hooks';
import { Cell, Subgrid } from '../primitives/Sheet';
import { Heading, Label } from '../primitives/Type';

export function Masthead({ snapshot }: { snapshot: SentinelSnapshot }) {
  const now = useNow();
  const block = snapshot.contracts[0]?.blockNumber;
  const rows: [string, string][] = [
    ['Network', snapshot.network],
    ['Feed', snapshot.source?.kind === 'live-mock' ? 'LIVE-MOCK · MCP' : 'SCRIPTED'],
    ['Block', block === undefined ? '\u2014' : block.toString()],
    ['Date', formatUtcDate(now)],
    ['UTC', formatUtcTime(now)],
  ];

  return (
    <>
      <Cell span={9} as="header" pad="none">
        <div className="masthead-title">
          <Label>Vol. I · Aegis Crew · Live invariant bulletin</Label>
          <Heading level={1} size="masthead">
            Aegis <em>Sentinel</em>
          </Heading>
        </div>
      </Cell>
      <Cell span={3} as="aside" pad="none">
        <Subgrid cols={1}>
          {rows.map(([k, v]) => (
            <div key={k}>
              <Label tone="ash">{k}</Label>
              <div className="data-lg mono-wrap">{v}</div>
            </div>
          ))}
        </Subgrid>
      </Cell>
    </>
  );
}
