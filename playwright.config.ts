import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const port = Number(process.env.VIDEO_QUICKLY_PORT ?? 1421);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false,
  // Each browser uses the same serial FFmpeg preparation queue in the local runtime.
  workers: 2,
  reporter: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ? [['line'], ['json']] : 'list',
  outputDir: process.env.PLAYWRIGHT_ARTIFACT_DIR ?? join(tmpdir(), 'video-quickly-playwright-results'),
  use: { baseURL, viewport: { width: 1536, height: 960 }, screenshot: 'only-on-failure', trace: 'retain-on-failure',
    // Existing editor scenarios use a returning profile; getting-started.spec covers first use.
    storageState: { cookies: [], origins: [{ origin: baseURL, localStorage: [{ name: 'vq-theme', value: 'dark' }, { name: 'vq-onboarding-v1', value: 'done' }] }] },
  },
  webServer: { command: 'pnpm dev:e2e', url: baseURL, reuseExistingServer: false, timeout: 60000,
    env: { VIDEO_QUICKLY_PORT: String(port), VIDEO_QUICKLY_DATA_DIR: join(tmpdir(), `video-quickly-e2e-${process.pid}-${Date.now()}`) } },
});
