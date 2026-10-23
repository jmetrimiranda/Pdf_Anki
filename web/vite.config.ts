import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import pdfcraft from './vite-plugin-pdfcraft';

// Tauri expects a fixed dev port and exposes TAURI_* env vars to the frontend.
export default defineConfig({
  // pdfcraft(): PdfCraft web at /pdfcraft/ on the same origin (spec 6.1).
  plugins: [react(), tailwindcss(), pdfcraft()],
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
  server: {
    port: 5173,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
    watch: { ignored: ['**/src-tauri/**'] },
    // Performance runs (LEITOR_PERF=1): a hot update would remount the Leitor mid-measurement.
    hmr: process.env.LEITOR_PERF !== '1',
  },
  build: {
    target: 'es2022',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Served from disk by Tauri, so one ~500 kB entry chunk is fine.
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'vite-plugin-pdfcraft.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
  },
});
