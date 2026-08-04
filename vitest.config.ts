import {defineConfig} from 'vitest/config';

/**
 * Suites that spawn real chat processes. They run in their own project,
 * one file at a time, so they never compete with each other for cores.
 */
const processSpawningTests = [
  'tests/integration/layered-control-locking.test.ts',
  'tests/integration/runtime-config-concurrency.test.ts',
  'tests/integration/runtime-session-writer.test.ts',
  'tests/integration/session-store-concurrency.test.ts',
  'tests/e2e/two-character-concurrency.test.ts',
];

export default defineConfig({
  test: {
    environment: 'node',
    maxWorkers: 4,
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // One project per test bucket; each inherits this root config. Coverage
    // stays global (root-level) — vitest 4 does not support per-project coverage.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'contract',
          include: ['tests/contract/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          exclude: processSpawningTests,
          // Headroom only: several suites spawn 2-7 child node processes and
          // contend for the lock/WAL files they exercise.
          testTimeout: 30000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          exclude: processSpawningTests,
        },
      },
      {
        extends: true,
        test: {
          name: 'processes',
          include: processSpawningTests,
          // These files launch real chat processes — up to seven at once —
          // and each one cold-starts Node. Run four such files in parallel
          // on a two-core CI runner and the children are starved of CPU
          // rather than blocked on anything: a turn that takes 69ms locally
          // stalls past any deadline, which is how this suite's idle
          // timeout went 6s, 8s, 15s, 20s without ever being long enough.
          // One file at a time keeps the process count bounded by what a
          // single test needs.
          fileParallelism: false,
          testTimeout: 60000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 85.3,
        branches: 79.1,
        functions: 94.4,
        lines: 85.3,
        'src/runtime/turn/input.ts': {
          statements: 31,
          branches: 31,
          functions: 57,
          lines: 31,
        },
        'src/runtime/storage/atomic-file.ts': {
          statements: 88,
          branches: 68,
          functions: 88,
          lines: 88,
        },
        'src/runtime/storage/mutation-lock.ts': {
          statements: 80,
          branches: 70,
          functions: 92,
          lines: 80,
        },
        'src/runtime/storage/codec-primitives.ts': {
          statements: 70,
          branches: 55,
          functions: 95,
          lines: 70,
        },
        'src/runtime/storage/raw-event-codec.ts': {
          statements: 75,
          branches: 70,
          functions: 95,
          lines: 75,
        },
        'src/runtime/storage/raw-event-tool-semantics.ts': {
          statements: 80,
          branches: 82,
          functions: 95,
          lines: 80,
        },
        'src/runtime/storage/trace-codec.ts': {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        'src/runtime/evidence/validation.ts': {
          statements: 83,
          branches: 76,
          functions: 90,
          lines: 83,
        },
        'src/runtime/evidence/recovery.ts': {
          statements: 84,
          branches: 65,
          functions: 92,
          lines: 84,
        },
        'src/runtime/storage/file-runtime-log-store.ts': {
          statements: 88,
          branches: 95,
          functions: 95,
          lines: 88,
        },
        'src/runtime/storage/file-runtime-log-store-state.ts': {
          statements: 90,
          branches: 88,
          functions: 90,
          lines: 90,
        },
        'src/runtime/storage/session-store.ts': {
          statements: 78,
          branches: 65,
          functions: 95,
          lines: 78,
        },
        'src/runtime/evidence/cache.ts': {
          statements: 78,
          branches: 65,
          functions: 95,
          lines: 78,
        },
        'src/runtime/storage/plugin-file-store/wal-codec.ts': {
          statements: 83,
          branches: 85,
          functions: 100,
          lines: 83,
        },
        'src/runtime/storage/plugin-file-store/wal.ts': {
          statements: 94,
          branches: 88,
          functions: 100,
          lines: 94,
        },
      },
    },
  },
});
