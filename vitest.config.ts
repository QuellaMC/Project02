import {defineConfig} from 'vitest/config';

const processSpawningTests = [
  'tests/integration/conversation-store-concurrency.test.ts',
  'tests/integration/layered-control-locking.test.ts',
  'tests/integration/runtime-config-concurrency.test.ts',
  'tests/integration/session-store-concurrency.test.ts',
  'tests/e2e/two-character-concurrency.test.ts',
  'tests/e2e/serve-instances.test.ts',
  'tests/e2e/serve-test-durations.test.ts',
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
    // Coverage stays at root level: vitest 4 has no per-project coverage.
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
          // Headroom for suites that spawn child processes and contend on
          // the lock and WAL files they exercise.
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
          // Each file launches real daemon processes; running files in
          // parallel starves them of CPU on a two-core CI runner.
          fileParallelism: false,
          testTimeout: 60000,
        },
      },
      {
        extends: true,
        test: {
          name: 'conformance',
          include: ['tests/conformance/**/*.test.ts'],
          globalSetup: ['tests/conformance/harness/build-page.ts'],
          setupFiles: ['tests/conformance/setup.ts'],
          // Its files run in parallel, unlike the processes project's. The
          // harness bounds every wait at ten seconds, and a test may hold a
          // dozen in sequence: these are a backstop behind those ceilings.
          testTimeout: 120000,
          hookTimeout: 120000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // The page's session and its components run only in a browser; the
      // browser suite is their cover. Everything else the page owns —
      // its store, every rule a tab follows — is covered here. The
      // connector's entry runs in the processes the conformance suite
      // spawns, out of coverage's sight; that suite is its cover.
      exclude: [
        'src/frontends/web/session.ts',
        'src/frontends/web/settings-session.ts',
        'src/frontends/web/main.tsx',
        'src/frontends/web/app.tsx',
        'src/frontends/web/thread.tsx',
        'src/frontends/web/settings.tsx',
        'src/frontends/telegram/main.ts',
      ],
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
          statements: 87.5,
          branches: 68,
          functions: 88,
          lines: 87.5,
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
        'src/runtime/evidence/validation.ts': {
          statements: 83,
          branches: 76,
          functions: 90,
          lines: 83,
        },
        'src/runtime/storage/file-runtime-log-store.ts': {
          statements: 88,
          branches: 95,
          functions: 95,
          lines: 88,
        },
        'src/runtime/storage/file-runtime-log-store-state.ts': {
          statements: 90,
          branches: 86,
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
