import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

import {App} from './app.tsx';
import {createPhoneSession} from './phone-session.ts';
import {PhoneWindow} from './phone-window.tsx';
import {createSession} from './session.ts';

const root = document.getElementById('root');

if (root === null) {
  throw new Error('The page has no root element.');
}

// The address carries the token in its fragment, as serve printed it. One
// that names a character's phone draws her phone and nothing else; any
// other is the chat.
const phone = new URL(location.href).searchParams.get('phone');

createRoot(root).render(
  <StrictMode>
    {phone === null ? (
      <App session={createSession(location.href)} />
    ) : (
      <PhoneWindow session={createPhoneSession(location.href, phone)} />
    )}
  </StrictMode>,
);
