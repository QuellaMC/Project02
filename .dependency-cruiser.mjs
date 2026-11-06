export default {
  forbidden: [
    {
      name: 'no-runtime-cycles',
      comment:
        'Rule 1a — no dependency cycles containing at least one value ' +
        '(non type-only) edge. These are real initialization-order hazards.',
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
        'and block module extraction).',
      severity: 'error',
      from: {},
      to: {circular: true},
    },
    {
      name: 'clients-see-only-the-wire',
      comment:
        'packages/wire/src/client and the page under packages/page are ' +
        'clients of the wire: they may import only wire/src/contract (the ' +
        'contract the Rust types generate, which value-imports nothing), ' +
        'wire/src/client and one another — type-only imports included — ' +
        'so whatever a client does, it does over the wire.',
      severity: 'error',
      from: {path: ['^packages/page/', '^packages/wire/src/client/']},
      to: {
        pathNot: [
          '^packages/page/',
          '^packages/wire/src/contract/',
          '^packages/wire/src/client/',
          'node_modules/',
        ],
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'nothing-imports-the-page',
      comment:
        'packages/page is a client of the wire, the web page; nothing ' +
        'imports it, so no surface is privileged over another.',
      severity: 'error',
      from: {pathNot: '^packages/page/'},
      to: {path: '^packages/page/'},
    },
    {
      name: 'cross-package-imports-name-the-package',
      comment:
        'Rule 5 — an import that crosses a package boundary names the ' +
        "package, so it lands on what the package's exports offer: " +
        '@project02/wire/contract, never a relative path into ' +
        'packages/wire. Imports within a package stay free.',
      severity: 'error',
      from: {path: '^(packages/[^/]+|tests)/'},
      to: {
        path: '^(packages/[^/]+|tests)/',
        pathNot: '^$1/',
        dependencyTypes: ['local'],
      },
    },
    {
      name: 'conformance-is-black-box',
      comment:
        "tests/conformance is the daemon's acceptance gate, so it reaches " +
        'the daemon only from outside: its process, its address, its files. ' +
        'It may import Node built-ins, vitest, ajv, its own files and the ' +
        'contract schema the Rust types generate, which it holds every ' +
        'answer and frame to — nothing else of the repository, type-only ' +
        'imports included.',
      severity: 'error',
      from: {path: '^tests/conformance/'},
      to: {
        // Unanchored: pnpm nests the packages under node_modules/.pnpm/.
        pathNot: [
          '^tests/conformance/',
          '^packages/wire/src/contract/generated/schema\\.json$',
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
        'and its own files — nothing else of the repository, nor ' +
        'vitest, type-only imports included.',
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
    // Rules that filter type-only edges need this to see them.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx'],
      // A workspace package is reached through its exports, at the real
      // path the rules name; dependency-cruiser reads no exports unasked.
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'default'],
    },
  },
};
