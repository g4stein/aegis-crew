import { useEffect, useState } from 'react';
import type { SourceKind } from '../core/model';
import { useSnapshot } from './hooks';
import { Bulletin } from './regions/Bulletin';
import { Colophon } from './regions/Colophon';
import { Contracts } from './regions/Contracts';
import { EventLog } from './regions/EventLog';
import { InvariantLedger } from './regions/InvariantLedger';
import { Masthead } from './regions/Masthead';
import { Mitigation } from './regions/Mitigation';
import { SourcePanel } from './regions/SourcePanel';
import { Sheet } from './primitives/Sheet';
import type { Sources } from './sources';

const isKind = (v: string | null): v is SourceKind => v === 'scripted' || v === 'live-mock';

/** Initial source from `?source=live-mock`, so a link can open the live view directly. */
function initialSource(): SourceKind {
  const q = new URLSearchParams(window.location.search).get('source');
  return isKind(q) ? q : 'scripted';
}

/** Sentinel dashboard. Feeds come from the composition root (main.tsx); this file imports no adapters. */
export function App({ sources }: { sources: Sources }) {
  const [selected, setSelected] = useState<SourceKind>(initialSource);
  const feed = sources[selected].feed;

  useEffect(() => {
    feed.start?.();
    const url = new URL(window.location.href);
    url.searchParams.set('source', selected);
    window.history.replaceState(null, '', url);
    return () => feed.stop?.();
  }, [feed, selected]);

  const snapshot = useSnapshot(feed);
  return (
    <Sheet>
      <Masthead snapshot={snapshot} />
      <Bulletin snapshot={snapshot} aside={<SourcePanel sources={sources} selected={selected} onSelect={setSelected} snapshot={snapshot} />} />
      <Contracts contracts={snapshot.contracts} />
      <InvariantLedger contracts={snapshot.contracts} {...(snapshot.source ? { source: snapshot.source } : {})} />
      <Mitigation contract={snapshot.contracts[0]} budgetMs={snapshot.budgetMs} />
      <EventLog events={snapshot.events} />
      <Colophon />
    </Sheet>
  );
}
