import {defineConfig, devices} from '@playwright/test';

// The built page in Chromium against a daemon of its own per test; the
// suite spawns the daemon itself, and pnpm check builds the page first.
export default defineConfig({
  testDir: './tests/browser',
  timeout: 60_000,
  expect: {timeout: 15_000},
  reporter: 'list',
  use: {trace: 'retain-on-failure'},
  projects: [{name: 'chromium', use: {...devices['Desktop Chrome']}}],
});
