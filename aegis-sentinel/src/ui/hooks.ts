import { useEffect, useState, useSyncExternalStore } from 'react';
import type { SnapshotFeed } from '../core/feed';
import type { SentinelSnapshot } from '../core/model';

export function useSnapshot(feed: SnapshotFeed): SentinelSnapshot {
  return useSyncExternalStore(
    (listener) => feed.subscribe(listener),
    () => feed.current(),
  );
}

/** Wall clock for display. UI layer only; the core never reads the clock. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
