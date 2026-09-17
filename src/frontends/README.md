# frontends

Every platform a person talks to a character on — the web page here, the
messaging connectors to come — is a client of the daemon's wire and
nothing more. A frontend value-imports only the contract (`gateway/api`),
the reference client (`gateway/client`), `core`, and `shared` (arch rule
`clients-see-only-the-wire`), and nothing in the daemon imports a
frontend (`nothing-imports-frontends`): whatever a frontend cannot do
through the API, nobody can. Each platform is one directory here with its
own entry, toolchain, and tests; a connector joins as a sibling.

## web

The page a person opens at the address `serve` prints. Vite builds `web/`
into `dist/web`, which the daemon serves at its root — one origin, so no
CORS; the token rides the fragment of the address. `pnpm build:web`
builds it once, `pnpm serve` builds before it runs, and
`pnpm exec vite build --watch` is the developer's loop, with a reload in
the browser. The page's own `tsconfig.json` gives it the DOM and the JSX
transform; the root program excludes the directory.

The page follows the wire page's rules for a surface, stated once in
`store.ts`: everything a tab shows is one value, and every change to it is
a pure function of the previous value and one input — the daemon's
snapshot, an event, a history page, a send, a line's end. It is DOM-free
and unit-tested in Node. `session.ts` holds the tab's one client and one
stream and the verbs a page calls, and runs only in a browser; `app.tsx`
and `thread.tsx` render the store — the roster, every confirmation
waiting, the thread with its draft bubbles, the one-line composer. The
browser suite under `tests/browser` drives the built page in Chromium
against a real daemon.
