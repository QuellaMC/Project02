import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

import {App} from './app.tsx';
import {createSession} from './session.ts';

const root = document.getElementById('root');

if (root === null) {
  throw new Error('The page has no root element.');
}

// A page restored from the back-forward cache holds a stale stream; the
// daemon's state is the truth, so the page loads afresh.
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    location.reload();
  }
});

// The address carries the token in its fragment, as serve printed it.
createRoot(root).render(
  <StrictMode>
    <App session={createSession(location.href)} />
  </StrictMode>,
);
