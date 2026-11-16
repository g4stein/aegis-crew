// Adapter (browser): the live-mock data source. On first start it probes for a Node runtime
// (GET <base>/snapshot). If one answers with JSON it streams from it over SSE; otherwise it runs
// the runtime loop in this tab. The choice is made once and kept, so a Node runtime that stops
// later is reported as "Feed lost", not silently replaced. `?runtime=node|browser` forces it.
import { chooseRuntimeHost, type RuntimeHost } from '../../core/chain';
import type { LiveControls, SnapshotFeed } from '../../core/feed';
import type { SentinelSnapshot } from '../../core/model';
import type { BrowserRuntimeFeed } from './browser-runtime';
import type { SseFeed } from './sse-feed';

type Inner = SnapshotFeed & LiveControls;

const PROBING: SentinelSnapshot = {
  network: 'MOCK CHAIN',
  mode: 'mock',
  budgetMs: 500,
  contracts: [],
  events: [],
  source: { kind: 'live-mock', link: 'connecting' },
};

export async function probeNodeRuntime(base: string, timeoutMs = 1_500): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/snapshot`, { cache: 'no-store', signal: ctl.signal });
    return r.ok && (r.headers.get('content-type') ?? '').includes('application/json');
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export class LiveMockFeed implements SnapshotFeed, LiveControls {
  private active?: Inner;
  private wanted = false;
  private probing = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly hosts: { readonly node: SseFeed; readonly browser: BrowserRuntimeFeed },
    private readonly probe: () => Promise<boolean>,
    private readonly forced?: RuntimeHost,
  ) {}

  current(): SentinelSnapshot {
    return this.active?.current() ?? PROBING;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    this.wanted = true;
    if (this.active) return this.active.start?.();
    if (this.probing) return;
    this.probing = true;
    const decide = this.forced ? Promise.resolve(false) : this.probe();
    void decide.then((reachable) => {
      this.probing = false;
      const host = chooseRuntimeHost(this.forced, reachable);
      this.active = this.hosts[host];
      this.active.subscribe(() => this.emit());
      if (this.wanted) this.active.start?.();
      this.emit();
    });
  }

  stop(): void {
    this.wanted = false;
    this.active?.stop?.();
  }

  async restartMockChain(): Promise<void> {
    await this.active?.restartMockChain();
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }
}
