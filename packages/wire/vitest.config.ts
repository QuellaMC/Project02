import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 12.6,
        branches: 12.4,
        functions: 4.2,
        lines: 13,
      },
    },
  },
});
