import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false,
  // Each browser uses the same serial FFmpeg preparation queue in the local runtime.
  workers: 2,
  reporter: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ? [['line'], ['json']] : 'list',
  outputDir: process.env.PLAYWRIGHT_ARTIFACT_DIR ?? join(tmpdir(), 'video-quickly-playwright-results'),
  use: { baseURL: 'http://127.0.0.1:1421', viewport: { width: 1536, height: 960 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'pnpm dev:e2e', url: 'http://127.0.0.1:1421', reuseExistingServer: false, timeout: 60000,
    env: { VIDEO_QUICKLY_PORT: '1421', VIDEO_QUICKLY_DATA_DIR: join(tmpdir(), `video-quickly-e2e-${process.pid}-${Date.now()}`) } },
});
