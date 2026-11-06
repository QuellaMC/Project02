import {defineConfig, devices} from '@playwright/test';

// The built page in Chromium against a daemon of its own per test; the
// suite spawns the daemon itself, and pnpm test:browser builds the page
// and the binary that serves it first.
export default defineConfig({
  testDir: './browser',
  timeout: 60_000,
  expect: {timeout: 15_000},
  reporter: 'list',
  use: {trace: 'retain-on-failure'},
  projects: [{name: 'chromium', use: {...devices['Desktop Chrome']}}],
});
