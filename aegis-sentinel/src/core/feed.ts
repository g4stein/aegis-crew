// Ports for snapshot delivery. Implemented by adapters (mock, SSE).
import type { SentinelSnapshot } from './model';

export interface SnapshotFeed {
  /** Latest snapshot. Must return the same object until the snapshot changes. */
  current(): SentinelSnapshot;
  /** Registers a listener. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Demo-only controls, offered by the mock feed. */
export interface DemoControls {
  simulateBreach(): void;
  reset(): void;
}
