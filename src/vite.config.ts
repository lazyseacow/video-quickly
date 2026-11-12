import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type PluginOption, type UserConfig } from 'vite';

const developmentPort = Number(process.env.VIDEO_QUICKLY_PORT ?? 1420);

export default defineConfig(async ({ command, isPreview, mode }): Promise<UserConfig> => {
  const browserTest = mode === 'browser-test';
  const enableBrowserBridge = command === 'serve' && process.env.VIDEO_QUICKLY_NATIVE_DESKTOP !== '1'
    && (isPreview !== true || browserTest);
  const plugins: PluginOption[] = [react()];
  if (enableBrowserBridge) {
    // Vite bundles literal config imports, including the preview bridge's server-only dependencies.
    const bridgeUrl = new URL('./dev/runtime-preview-bridge.ts', import.meta.url);
    const { runtimePreviewBridge }: typeof import('./dev/runtime-preview-bridge.ts') = await import(bridgeUrl.href);
    plugins.push(runtimePreviewBridge(browserTest, developmentPort));
  }

  return {
    plugins,
    preview: { port: developmentPort, strictPort: true, host: '127.0.0.1' },
    server: { port: developmentPort, strictPort: true, host: '127.0.0.1', watch: { ignored: ['**/.generated/**', '**/.tools/**'] } },
    clearScreen: false,
    build: { target: 'es2022', chunkSizeWarningLimit: 1000, ...(browserTest ? {
      outDir: '.generated/browser-preview', manifest: true,
      rolldownOptions: { input: { app: resolve('index.html'), thumbnail: resolve('dev/thumbnail-test.ts') }, preserveEntrySignatures: 'strict' },
    } : {}) },
  };
});
