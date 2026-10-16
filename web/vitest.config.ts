import { defineConfig } from 'vitest/config';

// Playwright specs live in e2e/ and run with `npm run test:e2e`.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], exclude: ['node_modules', 'e2e'] } });
