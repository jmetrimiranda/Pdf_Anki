import { defineConfig, devices } from '@playwright/test';

const PORT = 5199;
const PERF = process.env.LEITOR_PERF === '1';
const LOAD = process.env.LEITOR_LOAD === '1';
const viewport = { width: 1280, height: 820 };

// WebGL without a GPU: PdfCraft web draws with WebGL (glow). Headless Chromium gets it from SwiftShader through ANGLE.
const CHROMIUM_GL = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

// Spec 20. `chromium`/`webkit`: the UI against the mocked core. `bridge-*`: the same mocked core with the REAL
// PdfCraft web build (scripts/build-pdfcraft-web.sh) served at /pdfcraft/ by vite-plugin-pdfcraft.
// `perf-chromium`/`perf-webkit` (LEITOR_PERF=1): 500-page PDF, the app vs PdfCraft alone (docs/progresso.md). WebKit
// is the engine family of the shipped Linux app (WebKitGTK), where WebAssembly speed is the risk (spec 22).
// `load-chromium`/`load-webkit` (LEITOR_LOAD=1): click on the Leitor tab → PdfCraft ready, first and later openings.
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/artifacts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', testIgnore: ['bridge/**'], use: { ...devices['Desktop Chrome'], viewport } },
    { name: 'webkit', testIgnore: ['bridge/**'], use: { ...devices['Desktop Safari'], viewport } },
    {
      name: 'bridge-chromium',
      testDir: './e2e/bridge',
      outputDir: './test-results/artifacts-bridge',
      testIgnore: ['perf.spec.ts', 'load.spec.ts'],
      timeout: 120_000,
      // Each test runs a 40 MB WebAssembly app on a software GPU: one file at a time per worker.
      fullyParallel: false,
      use: { ...devices['Desktop Chrome'], viewport, launchOptions: { args: CHROMIUM_GL } },
    },
    {
      name: 'bridge-webkit',
      testDir: './e2e/bridge',
      outputDir: './test-results/artifacts-bridge',
      testIgnore: ['perf.spec.ts', 'load.spec.ts'],
      timeout: 180_000,
      fullyParallel: false,
      use: { ...devices['Desktop Safari'], viewport },
    },
    ...(PERF
      ? [
          {
            name: 'perf-chromium',
            testDir: './e2e/bridge',
            outputDir: './test-results/artifacts-perf',
            testMatch: ['perf.spec.ts'],
            timeout: 600_000,
            fullyParallel: false,
            use: { ...devices['Desktop Chrome'], viewport, launchOptions: { args: CHROMIUM_GL } },
          },
          {
            name: 'perf-webkit',
            testDir: './e2e/bridge',
            outputDir: './test-results/artifacts-perf',
            testMatch: ['perf.spec.ts'],
            timeout: 900_000,
            fullyParallel: false,
            use: { ...devices['Desktop Safari'], viewport },
          },
        ]
      : []),
    ...(LOAD
      ? (['chromium', 'webkit'] as const).map((engine) => ({
          name: `load-${engine}`,
          testDir: './e2e/bridge',
          outputDir: './test-results/artifacts-load',
          testMatch: ['load.spec.ts'],
          timeout: 1_200_000,
          fullyParallel: false,
          use:
            engine === 'chromium'
              ? { ...devices['Desktop Chrome'], viewport, launchOptions: { args: CHROMIUM_GL } }
              : { ...devices['Desktop Safari'], viewport },
        }))
      : []),
  ],
  webServer: {
    command: `pnpm exec vite --mode mock --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
