import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // The page's session and its components run only in a browser; the
      // browser suite is their cover. Everything else the page owns —
      // its store, every rule a tab follows — is covered here.
      exclude: [
        'src/session.ts',
        'src/settings-session.ts',
        'src/main.tsx',
        'src/app.tsx',
        'src/thread.tsx',
        'src/settings.tsx',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 97.5,
        branches: 93.2,
        functions: 98.9,
        lines: 97.4,
      },
    },
  },
});
