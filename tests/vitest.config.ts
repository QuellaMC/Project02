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
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'conformance',
          include: ['conformance/**/*.test.ts'],
          setupFiles: ['conformance/setup.ts'],
          // Its files run in parallel. The harness bounds every wait at
          // ten seconds, and a test may hold a dozen in sequence: these
          // are a backstop behind those ceilings.
          testTimeout: 120000,
          hookTimeout: 120000,
        },
      },
    ],
  },
});
