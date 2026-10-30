import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1, timeout: 30000,
  expect: { timeout: 8000 }, outputDir: './tests/results',
  reporter: [['list'], ['html', { outputFolder: './tests/report', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4173/test/observe/', viewport: { width: 1440, height: 900 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  globalSetup: './tests/e2e/global-setup.mjs',
});
