import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { androidApp } from './platform';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Opening without a network in a browser needs a service worker, which browsers allow only over
// HTTPS (and on localhost). The Android app keeps its own copy (ShellCache) and does not need it.
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext && !androidApp()) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
