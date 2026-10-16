import { defineConfig } from '@playwright/test';

// Drives the real Tauri window over WebView2's DevTools port (Windows). The debug executable must
// exist: `cargo build` in desktop/src-tauri after `npm run build:desktop` in web/.
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 90_000 },
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
});
