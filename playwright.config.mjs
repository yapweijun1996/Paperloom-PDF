import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { readE2EConfig, verifyStaticExport } from './scripts/e2e-static-preflight.mjs';

const { port, basePath } = readE2EConfig();
verifyStaticExport(resolve('out'), basePath);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}${basePath}/`,
    browserName: 'chromium',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/serve-static-e2e.mjs',
    url: `http://127.0.0.1:${port}${basePath}/`,
    timeout: 30_000,
    reuseExistingServer: false,
  },
});
