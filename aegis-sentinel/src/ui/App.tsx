import type { DemoControls, SnapshotFeed } from '../core/feed';
import { useSnapshot } from './hooks';
import { Bulletin } from './regions/Bulletin';
import { Colophon } from './regions/Colophon';
import { Contracts } from './regions/Contracts';
import { EventLog } from './regions/EventLog';
import { InvariantLedger } from './regions/InvariantLedger';
import { Masthead } from './regions/Masthead';
import { Mitigation } from './regions/Mitigation';
import { Sheet } from './primitives/Sheet';

/** Sentinel dashboard. Receives its feed from the composition root (main.tsx); imports no adapters. */
export function App({ feed, controls }: { feed: SnapshotFeed; controls?: DemoControls }) {
  const snapshot = useSnapshot(feed);
  return (
    <Sheet>
      <Masthead snapshot={snapshot} />
      <Bulletin snapshot={snapshot} {...(controls ? { controls } : {})} />
      <Contracts contracts={snapshot.contracts} />
      <InvariantLedger contracts={snapshot.contracts} />
      <Mitigation contract={snapshot.contracts[0]} budgetMs={snapshot.budgetMs} />
      <EventLog events={snapshot.events} />
      <Colophon />
    </Sheet>
  );
}
