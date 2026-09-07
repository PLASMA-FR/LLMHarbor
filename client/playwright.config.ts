import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://127.0.0.1:4179', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm exec -w server -- tsx src/__tests__/fixtures/browser.ts',
    cwd: path.resolve(import.meta.dirname, '..'),
    url: 'http://127.0.0.1:4179/api/ping',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
