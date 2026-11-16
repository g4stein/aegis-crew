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
import { MockFeed } from './adapters/mock/mock-feed';
import { App } from './ui/App';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// Task 6.5 adds the SSE feed for VITE_SENTINEL_FEED_URL. Until then the mock feed is the only feed.
const feed = new MockFeed();

createRoot(root).render(
  <StrictMode>
    <App feed={feed} controls={feed} />
  </StrictMode>,
);
