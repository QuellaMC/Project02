import {defineConfig} from 'vitest/config';

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
          name: 'conformance',
          include: ['tests/conformance/**/*.test.ts'],
          setupFiles: ['tests/conformance/setup.ts'],
          // Its files run in parallel. The harness bounds every wait at
          // ten seconds, and a test may hold a dozen in sequence: these
          // are a backstop behind those ceilings.
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
        statements: 44.6,
        branches: 45.3,
        functions: 46.4,
        lines: 44,
      },
    },
  },
});
