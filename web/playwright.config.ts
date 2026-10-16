import { defineConfig } from '@playwright/test';

// Tests run against the production build served by `astro preview`, because that is what ships:
// bundled workers, the real CSP headers file is not applied by preview, so the privacy test
// enforces the same rules itself (same-origin only, no request bodies).
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: { baseURL: 'http://127.0.0.1:4321', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4321',
    url: 'http://127.0.0.1:4321',
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
