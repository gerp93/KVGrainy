import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

const wasmCodecs = ['@jsquash/jpeg', '@jsquash/webp', '@jsquash/avif', '@jsquash/png', '@jsquash/oxipng', '@jsquash/resize'];

// One UI, two hosts. `KVG_TARGET=desktop` (see scripts/with-target.mjs) builds the same pages for the
// Tauri shell: stills run natively through Tauri commands instead of the Rust core in WebAssembly,
// and saving uses the native dialog. Everything else is shared.
const desktop = process.env.KVG_TARGET === 'desktop';
const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  outDir: desktop ? 'dist-desktop' : 'dist',
  server: { port: desktop ? 4322 : 4321 },
  // Strict CSP (no inline styles/scripts), so never inline.
  build: { inlineStylesheets: 'never' },
  vite: {
    resolve: {
      alias: {
        '@stills': here(desktop ? './src/engine/stills.desktop.ts' : './src/engine/stills.web.ts'),
        '@shell': here(desktop ? './src/engine/shell.desktop.ts' : './src/engine/shell.web.ts'),
        '@core-wasm': here(desktop ? './src/engine/wasm.stub.ts' : './src/wasm/kvgrainy_wasm.js'),
      },
    },
    optimizeDeps: { exclude: wasmCodecs },
    worker: { format: 'es' },
    build: { assetsInlineLimit: 0, target: 'es2022' },
  },
});
