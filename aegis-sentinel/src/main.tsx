// Browser composition root: picks the feed adapter and mounts the UI.
// Never import src/runtime/sentinel.ts, src/adapters/{chain,config,crypto} or mcp/ here: they are
// Node-only and near the signer key. tests/e2e/bundle-boundary.test.ts enforces this.
// src/runtime/loop.ts is environment-neutral and is bundled on purpose (in-browser runtime).
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/playfair-display/400-italic.css';
import '@fontsource/playfair-display/900.css';
import './ui/styles/tokens.css';
import './ui/styles/base.css';
import './ui/styles/sheet.css';
import './ui/styles/components.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRuntimeFeed } from './adapters/feed/browser-runtime';
import { LiveMockFeed, probeNodeRuntime } from './adapters/feed/live-feed';
import { SseFeed } from './adapters/feed/sse-feed';
import { MockFeed } from './adapters/mock/mock-feed';
import { App } from './ui/App';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// SCRIPTED: a timeline played in the browser.
// LIVE-MOCK: the Sentinel runtime loop. If a Node runtime answers on same-origin /api (served by
// `npm run runtime`, or proxied by Vite in dev; override with VITE_SENTINEL_API), the dashboard
// streams from it over SSE. Otherwise (static hosting) the same loop runs in this tab.
// `?runtime=node` or `?runtime=browser` skips the probe.
// On a public static host (no VITE_SENTINEL_API, not localhost) there is no Node runtime to find,
// so the probe is skipped instead of logging a 404.
const api = import.meta.env.VITE_SENTINEL_API ?? '/api';
const runtimeParam = new URLSearchParams(window.location.search).get('runtime');
const local = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
const forced =
  runtimeParam === 'node' || runtimeParam === 'browser' ? runtimeParam : local || import.meta.env.VITE_SENTINEL_API ? undefined : ('browser' as const);
const scripted = new MockFeed();
const live = new LiveMockFeed({ node: new SseFeed(api), browser: new BrowserRuntimeFeed() }, () => probeNodeRuntime(api), forced);

createRoot(root).render(
  <StrictMode>
    <App
      sources={{
        scripted: { id: 'scripted', label: 'Scripted', feed: scripted, controls: scripted },
        'live-mock': { id: 'live-mock', label: 'Live-mock', feed: live, controls: live },
      }}
    />
  </StrictMode>,
);
