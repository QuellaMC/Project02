// The known-violations baseline may only shrink (pnpm arch:baseline).
export default {
  forbidden: [
    {
      name: 'no-runtime-cycles',
      comment:
        'Rule 1a — no dependency cycles containing at least one value ' +
        '(non type-only) edge. These are real initialization-order hazards. ' +
        'Baselined: burn down before the type-only variant.',
      severity: 'error',
      from: {},
      to: {
        circular: true,
        via: {dependencyTypesNot: ['type-only']},
      },
    },
    {
      name: 'no-cycles-strict',
      comment:
        'Rule 1b — no dependency cycles at all, including type-only ones ' +
        '(erased at runtime, but they still force duplicate implementations ' +
        'and block module extraction). Baselined.',
      severity: 'error',
      from: {},
      to: {circular: true},
    },
    {
      name: 'shared-is-leaf',
      comment:
        'Rule 2 — src/shared is a leaf: generic utilities only, no imports ' +
        'from any other src module. Green (zero baseline entries).',
      severity: 'error',
      from: {path: '^src/shared/'},
      to: {path: '^src/', pathNot: ['^src/shared/']},
    },
    {
      name: 'clients-see-only-the-wire',
      comment:
        'src/gateway/client and every frontend under src/frontends are ' +
        'clients of the wire: they may import only gateway/api (the ' +
        'contract the Rust types generate, which value-imports nothing), ' +
        'gateway/client, shared and one another — type-only imports ' +
        'included — so whatever a client does, it does over the wire. ' +
        'Green (zero baseline entries).',
      severity: 'error',
      from: {path: ['^src/gateway/client/', '^src/frontends/']},
      to: {
        path: '^src/',
        pathNot: [
          '^src/gateway/client/',
          '^src/gateway/api/',
          '^src/shared/',
          '^src/frontends/',
        ],
      },
    },
    {
      name: 'nothing-imports-frontends',
      comment:
        'src/frontends holds the clients of the wire — the web page, the ' +
        'Telegram connector; nothing else imports one, so no frontend is ' +
        'privileged over another. Green (zero baseline entries).',
      severity: 'error',
      from: {path: '^src/', pathNot: ['^src/frontends/']},
      to: {path: '^src/frontends/'},
    },
    {
      name: 'no-deep-cross-module-imports',
      comment:
        'Rule 5 — an import that crosses a top-level module boundary must ' +
        "land on that module's public index.ts (first- or second-level), " +
        'or a src/shared file. Intra-module deep imports stay free. Green ' +
        '(zero baseline entries).',
      severity: 'error',
      from: {path: '^src/([^/]+)/'},
      to: {
        path: '^src/',
        pathNot: [
          '^src/$1/',
          '^src/[^/]+/index\\.ts$',
          '^src/[^/]+/[^/]+/index\\.ts$',
          '^src/shared/[^/]+\\.ts$',
        ],
      },
    },
    {
      name: 'conformance-is-black-box',
      comment:
        "tests/conformance is the daemon's acceptance gate, so it reaches " +
        'the daemon only from outside: its process, its address, its files. ' +
        'It may import Node built-ins, vitest, ajv, its own files and the ' +
        'contract schema the Rust types generate, which it holds every ' +
        'answer and frame to — never other src or tests/support, type-only ' +
        'imports included. Green (zero baseline entries).',
      severity: 'error',
      from: {path: '^tests/conformance/'},
      to: {
        // Unanchored: pnpm nests the packages under node_modules/.pnpm/.
        pathNot: [
          '^tests/conformance/',
          '^src/gateway/api/generated/schema\\.json$',
          '^vitest$',
          'node_modules/vitest/',
          'node_modules/ajv/',
        ],
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'browser-is-black-box',
      comment:
        'tests/browser drives the built page against a daemon it meets only ' +
        'through the conformance harness, so it runs against any build of ' +
        'the daemon. It may import Node built-ins, Playwright, the harness ' +
        'and its own files — never src, tests/support or vitest, type-only ' +
        'imports included. Green (zero baseline entries).',
      severity: 'error',
      from: {path: '^tests/browser/'},
      to: {
        // Unanchored: pnpm nests the package under node_modules/.pnpm/.
        pathNot: [
          '^tests/browser/',
          '^tests/conformance/harness/',
          '^@playwright/test$',
          'node_modules/@playwright/test/',
        ],
        dependencyTypesNot: ['core'],
      },
    },
  ],
  options: {
    doNotFollow: {path: 'node_modules'},
    tsConfig: {fileName: 'tsconfig.json'},
    // Rules that filter type-only edges need this to see them.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {extensions: ['.ts', '.tsx']},
  },
};
