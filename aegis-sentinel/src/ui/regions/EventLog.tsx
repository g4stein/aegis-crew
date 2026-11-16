import { formatUtcTime } from '../../core/format';
import type { LogEvent } from '../../core/model';
import { Glyph } from '../primitives/Glyph';
import { Cell } from '../primitives/Sheet';
import { SectionHead } from '../primitives/Type';

export function EventLog({ events }: { events: readonly LogEvent[] }) {
  return (
    <Cell span={12} pad="none" labelledBy="log-title">
      <SectionHead id="log-title" title="Event log" meta={`${events.length} event${events.length === 1 ? '' : 's'}, newest first`} />
      <ol className="log" role="log" aria-labelledby="log-title">
        {events.map((e) => (
          <li key={e.seq} data-level={e.level}>
            <time dateTime={new Date(e.atMs).toISOString()}>{formatUtcTime(e.atMs, true)}</time>
            <span className="log-level">
              <Glyph kind={e.level} markOnly />
            </span>
            <span className="mono-wrap">{e.message}</span>
          </li>
        ))}
      </ol>
    </Cell>
  );
}
