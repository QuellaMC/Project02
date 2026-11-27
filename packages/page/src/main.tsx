import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

import {App} from './app.tsx';
import {createPhoneSession} from './phone-session.ts';
import {PhoneWindow} from './phone-window.tsx';
import {createSession} from './session.ts';
import {createWorldSession} from './world-session.ts';
import {WorldWindow} from './world-window.tsx';

const root = document.getElementById('root');

if (root === null) {
  throw new Error('The page has no root element.');
}

// The address carries the token in its fragment, as serve printed it. One
// that names a character's phone draws her phone and nothing else, one that
// names her world, her world; any other is the chat.
const named = new URL(location.href).searchParams;
const phone = named.get('phone');
const world = named.get('world');

createRoot(root).render(
  <StrictMode>
    {phone !== null ? (
      <PhoneWindow session={createPhoneSession(location.href, phone)} />
    ) : world !== null ? (
      <WorldWindow session={createWorldSession(location.href, world)} />
    ) : (
      <App session={createSession(location.href)} />
    )}
  </StrictMode>,
);
