/**
 * Architecture gate rules (`pnpm arch:check`).
 *
 * Ratchet contract (same as the max-lines overrides in eslint.config.mjs):
 * pre-existing violations live in `.dependency-cruiser-known-violations.json`
 * and that file may only shrink. Regenerate it with `pnpm arch:baseline` in
 * the same PR that removes violations; reviewers reject baseline diffs that
 * add entries. Rules marked "green" below have zero baseline entries and act
 * as hard regression guards from day one.
 *
 * Rule 6 (shared additions need approved consumers) is enforced by
 * `scripts/check-shared-consumers.mjs` against `src/shared/consumers.json`.
 * Rule 7 (one responsibility, one owner) is a human review rule — module
 * README ownership statements — and is deliberately not encoded here.
 *
 * See docs/plan/repo-structure-migration-2026-07-16.md, Slice 0.
 */

// Default export: required by dependency-cruiser's config loader.
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
        via: { dependencyTypesNot: ['type-only'] }
      }
    },
    {
      name: 'no-cycles-strict',
      comment:
        'Rule 1b — no dependency cycles at all, including type-only ones ' +
        '(erased at runtime, but they still force duplicate implementations ' +
        'and block module extraction). Baselined.',
      severity: 'error',
      from: {},
      to: { circular: true }
    },
    {
      name: 'core-is-pure',
      comment:
        'Rule 2 — src/core is pure domain: it may import core and shared ' +
        'only, never runtime, cli, role-model providers, or concrete ' +
        'plugins. Green (zero baseline entries).',
      severity: 'error',
      from: { path: '^src/core/' },
      to: { path: '^src/', pathNot: ['^src/core/', '^src/shared/'] }
    },
    {
      name: 'shared-is-leaf',
      comment:
        'Rule 2b — src/shared is a leaf: generic utilities only, no imports ' +
        'from any other src module. Green (zero baseline entries).',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/', pathNot: ['^src/shared/'] }
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
      from: { path: '(^|/)(contracts?|[^/]*-contract)\\.ts$' },
      to: {
        path: '^src/',
        pathNot: [
          '(^|/)(contracts?|[^/]*-contract|types|plugin-types|chat-wire)\\.ts$',
          '^src/shared/',
          '^src/core/'
        ],
        dependencyTypesNot: ['type-only']
      }
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
        pathNot: ['^src/app/', '^src/cli/', '^src/index\\.ts$']
      },
      to: { path: '^src/app/' }
    },
    {
      name: 'nothing-imports-cli',
      comment:
        'Rule 4 — src/cli is a pure composition shell; no production code ' +
        'may import it. Green (zero baseline entries).',
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/cli/'] },
      to: { path: '^src/cli/' }
    },
    {
      name: 'no-deep-cross-module-imports',
      comment:
        'Rule 5 — an import that crosses a top-level module boundary must ' +
        'land on that module\'s public index.ts (first- or second-level), ' +
        'the root barrel, or a src/shared file. Intra-module deep imports ' +
        'stay free. Baselined until every module grows its barrel (Slice 3 ' +
        'of the migration plan), then ratcheted to zero.',
      severity: 'error',
      from: { path: '^src/([^/]+)/' },
      to: {
        path: '^src/',
        pathNot: [
          '^src/$1/',
          '^src/[^/]+/index\\.ts$',
          '^src/[^/]+/[^/]+/index\\.ts$',
          '^src/index\\.ts$',
          '^src/shared/[^/]+\\.ts$'
        ]
      }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    // Make `import type` edges visible so rules can distinguish type-only
    // from value dependencies (verbatimModuleSyntax erases them at runtime).
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { extensions: ['.ts'] }
  }
};
