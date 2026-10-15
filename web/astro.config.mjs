import { defineConfig } from 'astro/config';

const wasmCodecs = ['@jsquash/jpeg', '@jsquash/webp', '@jsquash/avif', '@jsquash/png', '@jsquash/oxipng', '@jsquash/resize'];

export default defineConfig({
  // Strict CSP (no inline styles/scripts), so never inline.
  build: { inlineStylesheets: 'never' },
  vite: {
    optimizeDeps: { exclude: wasmCodecs },
    worker: { format: 'es' },
    build: { assetsInlineLimit: 0, target: 'es2022' },
  },
});
