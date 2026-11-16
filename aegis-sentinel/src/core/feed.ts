// Ports for snapshot delivery. Implemented by adapters (scripted mock, SSE from the runtime).
import type { SentinelSnapshot } from './model';

export interface SnapshotFeed {
  /** Latest snapshot. Must return the same object until the snapshot changes. */
  current(): SentinelSnapshot;
  /** Registers a listener. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Opens the underlying connection, if any. Called when the feed is selected. */
  start?(): void;
  /** Closes the underlying connection, if any. Called when another feed is selected. */
  stop?(): void;
}

/** Demo-only controls, offered by the scripted feed. */
export interface DemoControls {
  simulateBreach(): void;
  reset(): void;
}

/** Controls for the live-mock feed, served by the Sentinel runtime. */
export interface LiveControls {
  restartMockChain(): Promise<void>;
}
