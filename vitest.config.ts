import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests-ts/**/*.test.ts'],
    environment: 'node',
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true
  }
});
