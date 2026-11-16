// Adapter (browser): live-mock feed. Subscribes to the Sentinel runtime's Server-Sent Events
// stream and decodes each snapshot through the core wire codec (trust boundary).
import type { LiveControls, SnapshotFeed } from '../../core/feed';
import type { LinkState, SentinelSnapshot } from '../../core/model';
import { decodeSnapshot } from '../../core/wire';

const PLACEHOLDER: SentinelSnapshot = {
  network: 'MOCK CHAIN',
  mode: 'mock',
  budgetMs: 500,
  contracts: [],
  events: [],
  source: { kind: 'live-mock', link: 'connecting' },
};

export class SseFeed implements SnapshotFeed, LiveControls {
  private snapshot: SentinelSnapshot = PLACEHOLDER;
  private es?: EventSource;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly base = '/api') {}

  current(): SentinelSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.es) return;
    this.setLink('connecting');
    const es = new EventSource(`${this.base}/stream`);
    es.addEventListener('open', () => this.setLink('open'));
    // EventSource reconnects on its own; `open` fires again when it succeeds.
    es.addEventListener('error', () => this.setLink('lost'));
    es.addEventListener('snapshot', (ev) => {
      let raw: unknown;
      try {
        raw = JSON.parse((ev as MessageEvent<string>).data);
      } catch {
        return;
      }
      const d = decodeSnapshot(raw);
      if (!d.ok) return;
      this.snapshot = { ...d.value, source: { ...(d.value.source ?? { kind: 'live-mock' }), link: 'open' } };
      this.emit();
    });
    this.es = es;
  }

  stop(): void {
    this.es?.close();
    this.es = undefined;
  }

  async restartMockChain(): Promise<void> {
    await fetch(`${this.base}/restart`, { method: 'POST', headers: { 'x-aegis-request': '1' } });
  }

  private setLink(link: LinkState): void {
    const src = this.snapshot.source ?? { kind: 'live-mock' as const, link };
    if (src.link === link) return;
    this.snapshot = { ...this.snapshot, source: { ...src, link } };
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }
}
