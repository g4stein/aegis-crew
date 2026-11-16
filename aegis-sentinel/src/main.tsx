// Browser composition root: picks the feed adapter and mounts the UI.
// Never import src/adapters/chain or src/runtime here; the signer key must not reach the bundle.
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
import { SseFeed } from './adapters/feed/sse-feed';
import { MockFeed } from './adapters/mock/mock-feed';
import { App } from './ui/App';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// SCRIPTED: a timeline played in the browser. LIVE-MOCK: the Sentinel runtime's SSE stream,
// which reads the chain-state MCP server (src/runtime/sentinel.ts). Base URL is same-origin
// /api (served by the runtime, or proxied by Vite in dev); override with VITE_SENTINEL_API.
const scripted = new MockFeed();
const live = new SseFeed(import.meta.env.VITE_SENTINEL_API ?? '/api');

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
