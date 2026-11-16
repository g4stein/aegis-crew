import type { DemoControls, LiveControls, SnapshotFeed } from '../core/feed';
import type { SourceKind } from '../core/model';

/** A selectable data source for the dashboard. Built in main.tsx (the composition root). */
export type DataSource =
  | { readonly id: 'scripted'; readonly label: string; readonly feed: SnapshotFeed; readonly controls: DemoControls }
  | { readonly id: 'live-mock'; readonly label: string; readonly feed: SnapshotFeed; readonly controls: LiveControls };

export type Sources = { readonly [K in SourceKind]: Extract<DataSource, { id: K }> };
