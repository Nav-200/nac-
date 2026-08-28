import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

/**
 * Build config for the self-contained artifact page: one JS chunk, one CSS
 * asset, no module-preload shim — everything gets inlined into a single HTML
 * fragment by scripts/build-artifact.mjs afterwards.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  build: {
    outDir: 'dist-artifact',
    modulePreload: {polyfill: false},
    rollupOptions: {
      input: path.resolve(__dirname, 'artifact.html'),
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
