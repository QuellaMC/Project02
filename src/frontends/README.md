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
