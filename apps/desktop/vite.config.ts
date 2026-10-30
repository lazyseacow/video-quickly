import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { createRuntime } from '../../packages/runtime/src/index.ts';
import { createActivityExecutor, createWaveformReader, validateMediaActivity } from '../../packages/integrations/src/index.ts';
import { readRpcRequest } from './dev/read-rpc-request.ts';
import { audioMixProjectionKey, prepareAudioMix, readAudioLevelWindow, detectAudioSilence } from '../../packages/video/src/audio-mix.ts';

const developmentPort = Number(process.env.VIDEO_QUICKLY_PORT ?? 1420);

// Development preview exercises the same runtime as the desktop sidecar.
// This bridge is never included in the production application.
function developmentBridge(): Plugin {
  return {
    name: 'video-quickly-development-bridge',
    apply: 'serve',
    async configureServer(server) {
      // Local preview clients own their connection lifetime. Avoid both forced
      // connection churn and racing an idle server close with a pooled RPC.
      if (server.httpServer) server.httpServer.keepAliveTimeout = 0;
      const dataDirectory = resolve(process.env.VIDEO_QUICKLY_DATA_DIR ?? '../../.data/development');
      const temporarySecrets = new Map<string, string>();
      const toolsDirectory = resolve('../../.tools');
      const mediaLock = JSON.parse(readFileSync(resolve('../../scripts/media-manifest.json'), 'utf8')) as { directory: string };
      const bundledMedia = existsSync(toolsDirectory) ? readdirSync(toolsDirectory)
        .toSorted((a, b) => Number(b === mediaLock.directory) - Number(a === mediaLock.directory))
        .map(name => resolve(toolsDirectory, name, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
        .find(path => existsSync(path)) : undefined;
      const ffmpegPath = process.env.VIDEO_QUICKLY_FFMPEG ?? bundledMedia;
      const waveforms = createWaveformReader({ dataDirectory, ffmpegPath });
      const runtime = await createRuntime({ dataDirectory, mode: 'development', ffmpegPath, readAudioWaveform: asset => waveforms.read(asset),
        audioMix: { projectionKey: audioMixProjectionKey, prepare: options => prepareAudioMix({ ...options, ffmpegPath }), levels: readAudioLevelWindow, silence: options => detectAudioSilence({ ...options, ffmpegPath }) },
        preflightActivity: validateMediaActivity, executeActivity: createActivityExecutor({ ffmpegPath }), secretStore: {
        persistent: false,
        async get(key) { return temporarySecrets.get(key); },
        async set(key, value) { temporarySecrets.set(key, value); },
        async delete(key) { temporarySecrets.delete(key); },
      }});
      const unsubscribe = runtime.subscribe(event => server.ws.send({ type: 'custom', event: 'workspace-event', data: event }));
      server.httpServer?.on('close', () => { unsubscribe(); void waveforms.close().then(() => runtime.close()); });
      server.middlewares.use('/__desktop_rpc', async (request, response) => {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (request.method !== 'POST') { response.statusCode = 405; response.end(JSON.stringify({ error: '只支持 POST' })); return; }
        if (request.headers.origin && request.headers.origin !== `http://127.0.0.1:${developmentPort}`) { response.statusCode = 403; response.end(JSON.stringify({ error: '不允许此来源' })); return; }
        try {
          const parsed = await readRpcRequest(request);
          if (!parsed || typeof parsed !== 'object' || !('method' in parsed) || typeof parsed.method !== 'string') throw new Error('请求格式无效');
          const result = ['runtime.status', 'runtime.reconnect'].includes(parsed.method) ? { state: 'ready', generation: 0 } : await runtime.dispatch(parsed.method, 'params' in parsed ? parsed.params : {});
          response.end(JSON.stringify({ result }));
        } catch (error) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : '操作失败' }));
        }
      });
      server.middlewares.use('/__desktop_asset', (request, response) => {
        const requested = new URL(request.url ?? '/', 'http://localhost').searchParams.get('path');
        if (!requested) { response.statusCode = 400; response.end(); return; }
        const path = resolve(requested);
        const fromRoot = relative(dataDirectory, path);
        if (fromRoot.startsWith('..') || isAbsolute(fromRoot) || !existsSync(path)) { response.statusCode = 404; response.end(); return; }
        const metadata = statSync(path);
        if (!metadata.isFile()) { response.statusCode = 404; response.end(); return; }
        const mediaTypes: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' };
        response.setHeader('Content-Type', mediaTypes[extname(path).toLowerCase()] ?? 'application/octet-stream');
        response.setHeader('Accept-Ranges', 'bytes');
        let start = 0; let end = metadata.size - 1;
        if (request.headers.range) {
          const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
          if (range && (range[1] || range[2])) {
            start = range[1] ? Number(range[1]) : Math.max(0, metadata.size - Number(range[2]));
            end = range[1] && range[2] ? Math.min(end, Number(range[2])) : end;
          }
          if (!range || !range[1] && !range[2] || start > end || start < 0 || start >= metadata.size) { response.statusCode = 416; response.setHeader('Content-Range', `bytes */${metadata.size}`); response.end(); return; }
          response.statusCode = 206; response.setHeader('Content-Range', `bytes ${start}-${end}/${metadata.size}`);
        }
        response.setHeader('Content-Length', Math.max(0, end - start + 1));
        if (request.method === 'HEAD' || !metadata.size) { response.end(); return; }
        const stream = createReadStream(path, { start, end });
        response.on('close', () => stream.destroy());
        stream.on('error', () => { if (!response.headersSent) response.statusCode = 500; response.end(); }).pipe(response);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), developmentBridge()],
  server: { port: developmentPort, strictPort: true, host: '127.0.0.1', watch: { ignored: ['**/src-tauri/target/**', '**/.generated/**', '**/.tools/**'] } },
  clearScreen: false,
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
});
