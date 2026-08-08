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
      name: 'core-is-pure',
      comment:
        'Rule 2 — src/core is pure domain: it may import core and shared ' +
        'only, never runtime, cli, role-model providers, or concrete ' +
        'plugins. Green (zero baseline entries).',
      severity: 'error',
      from: {path: '^src/core/'},
      to: {path: '^src/', pathNot: ['^src/core/', '^src/shared/']},
    },
    {
      name: 'shared-is-leaf',
      comment:
        'Rule 2b — src/shared is a leaf: generic utilities only, no imports ' +
        'from any other src module. Green (zero baseline entries).',
      severity: 'error',
      from: {path: '^src/shared/'},
      to: {path: '^src/', pathNot: ['^src/shared/']},
    },
    {
      name: 'fs-only-in-file-system-seam',
      comment:
        'Rule 2c — node:fs is importable from src/shared/file-system.ts and ' +
        'nowhere else, so "which files touch the disk" has a one-word ' +
        'answer. Add the operation to the seam instead of reaching past it. ' +
        'Green with no exemptions: a violation here means a second ' +
        'filesystem boundary is growing.',
      severity: 'error',
      from: {path: '^src/', pathNot: ['^src/shared/file-system\\.ts$']},
      to: {path: '^fs(/promises)?$', dependencyTypes: ['core']},
    },
    {
      name: 'sqlite-driver-only-in-sqlite-seam',
      comment:
        'Rule 2d — the better-sqlite3 driver is VALUE-importable from ' +
        'src/runtime/storage/sqlite.ts and nowhere else, so "which files ' +
        'open a database" has a one-word answer. Type-only imports are ' +
        'erased and stay free: capability contracts name the handle type. ' +
        'Green with no exemptions.',
      severity: 'error',
      from: {path: '^src/', pathNot: ['^src/runtime/storage/sqlite\\.ts$']},
      to: {
        // pnpm nests the resolved path under node_modules/.pnpm/, so the
        // node_modules segment must stay unanchored; the bare name covers
        // unresolved imports.
        path: ['^better-sqlite3$', 'node_modules/better-sqlite3/'],
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'contracts-no-impl-value-deps',
      comment:
        'Rule 3 — contract files (contract.ts, contracts.ts, *-contract.ts) ' +
        'must not VALUE-import implementation files. `import type` from an ' +
        'implementation is tolerated (erased, no runtime coupling); value ' +
        'imports mean the contract drags the implementation in. Contract ' +
        'surface a contract file MAY value-import: other contract/types ' +
        'files, chat-wire (provider wire types + their freeze invariants), ' +
        'core, and shared. Baselined.',
      severity: 'error',
      from: {path: '(^|/)(contracts?|[^/]*-contract)\\.ts$'},
      to: {
        path: '^src/',
        pathNot: [
          '(^|/)(contracts?|[^/]*-contract|types|plugin-types|chat-wire)\\.ts$',
          '^src/shared/',
          '^src/core/',
        ],
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'characters-is-data-only',
      comment:
        'src/characters owns the data-only character package contract: it ' +
        'may import characters, core, and shared only — never runtime, ' +
        'plugins, role-model, app, or cli. Keeps character definitions ' +
        'provider- and runtime-independent. Green (zero baseline entries).',
      severity: 'error',
      from: {path: '^src/characters/'},
      to: {
        path: '^src/',
        pathNot: ['^src/characters/', '^src/core/', '^src/shared/'],
      },
    },
    {
      name: 'nothing-imports-app',
      comment:
        'src/app is the composition root: it wires runtime, plugins, and ' +
        'role-model together. Only the public barrel and cli may import it. ' +
        'Green (zero baseline entries).',
      severity: 'error',
      from: {
        path: '^src/',
        pathNot: ['^src/app/', '^src/cli/', '^src/index\\.ts$'],
      },
      to: {path: '^src/app/'},
    },
    {
      name: 'nothing-imports-cli',
      comment:
        'Rule 4 — src/cli is a pure composition shell; no production code ' +
        'may import it. Green (zero baseline entries).',
      severity: 'error',
      from: {path: '^src/', pathNot: ['^src/cli/']},
      to: {path: '^src/cli/'},
    },
    {
      name: 'runtime-plugins-value-via-api',
      comment:
        'runtime may VALUE-import plugins only through the plugin contract ' +
        'barrel (plugins/api/index.ts): data shapes, contract constants, ' +
        'validating constructors, pure predicates. Host, policy, and ' +
        'package behavior are out of bounds for runtime. Green (zero ' +
        'baseline entries).',
      severity: 'error',
      from: {path: '^src/runtime/'},
      to: {
        path: '^src/plugins/',
        pathNot: ['^src/plugins/api/index\\.ts$'],
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'runtime-plugins-via-barrels',
      comment:
        'every runtime import of plugins — type or value — lands on ' +
        'plugins/api/index.ts or plugins/index.ts (the host interface ' +
        'types live behind the main barrel until the 3e host split). ' +
        'Green (zero baseline entries).',
      severity: 'error',
      from: {path: '^src/runtime/'},
      to: {
        path: '^src/plugins/',
        pathNot: ['^src/plugins/api/index\\.ts$', '^src/plugins/index\\.ts$'],
      },
    },
    {
      name: 'no-deep-cross-module-imports',
      comment:
        'Rule 5 — an import that crosses a top-level module boundary must ' +
        "land on that module's public index.ts (first- or second-level), " +
        'the root barrel, or a src/shared file. Intra-module deep imports ' +
        'stay free. Baselined until every module grows its barrel (Slice 3 ' +
        'of the migration plan), then ratcheted to zero.',
      severity: 'error',
      from: {path: '^src/([^/]+)/'},
      to: {
        path: '^src/',
        pathNot: [
          '^src/$1/',
          '^src/[^/]+/index\\.ts$',
          '^src/[^/]+/[^/]+/index\\.ts$',
          '^src/index\\.ts$',
          '^src/shared/[^/]+\\.ts$',
        ],
      },
    },
  ],
  options: {
    doNotFollow: {path: 'node_modules'},
    tsConfig: {fileName: 'tsconfig.json'},
    // Rules that filter type-only edges need this to see them.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {extensions: ['.ts']},
  },
};
