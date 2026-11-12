import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import type { ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { createRuntime } from '@video-quickly/runtime';
import { createLogger, createRuntimeMediaServices, generateText, logError, readStoryboardWebResearch } from '@video-quickly/runtime/node';
import { fileContentType, resolveByteRange } from '../electron/file-response.mjs';
import { readRpcRequest } from './read-rpc-request.ts';
import { createRpcDiagnostics } from './rpc-diagnostics.ts';

const desktopDirectory = resolve(import.meta.dirname, '..');
const repositoryDirectory = resolve(desktopDirectory, '..');

// Development preview exercises the same runtime as the desktop sidecar.
// This bridge is never included in the production application.
export function runtimePreviewBridge(browserTest: boolean, developmentPort: number): Plugin {
  let dispose: (() => Promise<void>) | undefined;
  async function attach(server: ViteDevServer | PreviewServer) {
    // Local preview clients own their connection lifetime. Avoid both forced
    // connection churn and racing an idle server close with a pooled RPC.
    if (server.httpServer && 'keepAliveTimeout' in server.httpServer) server.httpServer.keepAliveTimeout = 0;
    if (browserTest) {
      const manifest: unknown = JSON.parse(readFileSync(resolve(desktopDirectory, '.generated/browser-preview/.vite/manifest.json'), 'utf8'));
      const entry = manifest && typeof manifest === 'object' && 'dev/thumbnail-test.ts' in manifest ? manifest['dev/thumbnail-test.ts'] : undefined;
      const file = entry && typeof entry === 'object' && 'file' in entry ? entry.file : undefined;
      if (typeof file !== 'string' || !file.startsWith('assets/') || file.includes('..')) throw new Error('浏览器缩略图夹具未完成构建。');
      server.middlewares.use('/__desktop_test/thumbnail', (_request, response) => { response.writeHead(302, { Location: '/' + file }); response.end(); });
    }
    const dataDirectory = resolve(process.env.VIDEO_QUICKLY_DATA_DIR ?? resolve(repositoryDirectory, '.data', browserTest ? 'browser-preview' : 'development'));
    const logger = createLogger({ dataDirectory, component: 'runtime' });
    const temporarySecrets = new Map<string, string>();
    const toolsDirectory = resolve(repositoryDirectory, '.tools');
    const mediaLock = JSON.parse(readFileSync(resolve(repositoryDirectory, 'scripts/media-manifest.json'), 'utf8')) as { directory: string };
    const bundledMedia = existsSync(toolsDirectory) ? readdirSync(toolsDirectory)
      .toSorted((a, b) => Number(b === mediaLock.directory) - Number(a === mediaLock.directory))
      .map(name => resolve(toolsDirectory, name, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
      .find(path => existsSync(path)) : undefined;
    const ffmpegPath = process.env.VIDEO_QUICKLY_FFMPEG ?? bundledMedia;
    const runtimeMedia = createRuntimeMediaServices({ dataDirectory, ffmpegPath });
    const diagnostics = browserTest && process.env.VIDEO_QUICKLY_RPC_DIAGNOSTICS ? createRpcDiagnostics(process.env.VIDEO_QUICKLY_RPC_DIAGNOSTICS) : undefined;
    let runtime: ReturnType<typeof createRuntime>;
    try {
      runtime = await createRuntime({ dataDirectory, seed: browserTest, seedBuiltInTemplates: true, mode: 'development', requireChargeConfirmation: !browserTest, logger,
        ...runtimeMedia.options,
        provider: diagnostics?.textProvider(generateText),
        webResearch: browserTest ? undefined : readStoryboardWebResearch,
        secretStore: {
          persistent: false,
          async get(key) { return temporarySecrets.get(key); },
          async set(key, value) { temporarySecrets.set(key, value); },
          async delete(key) { temporarySecrets.delete(key); },
        },
      });
    } catch (error) {
      try { await diagnostics?.close(); } finally { await runtimeMedia.close(); }
      throw error;
    }
    const peers = new Set<ServerResponse>();
    const unsubscribe = runtime.subscribe(event => {
      if ('ws' in server) server.ws.send({ type: 'custom', event: 'workspace-event', data: event });
      const message = 'data: ' + JSON.stringify(event) + '\n\n';
      for (const peer of peers) if (!peer.write(message)) { peers.delete(peer); peer.destroy(); }
    });
    const origin = () => { const address = server.httpServer?.address(); return `http://127.0.0.1:${address && typeof address === 'object' ? address.port : developmentPort}`; };
    let disposing: Promise<void> | undefined;
    const close = () => disposing ??= (async () => {
      unsubscribe(); for (const peer of peers) peer.destroy(); peers.clear();
      try { await diagnostics?.close(); } finally { try { await runtimeMedia.close(); } finally { await runtime.close(); } }
    })();
    dispose = close;
    if (browserTest) server.middlewares.use('/__desktop_events', (request, response) => {
      if (request.method !== 'GET') { response.statusCode = 405; response.end(); return; }
      if (request.headers.origin && request.headers.origin !== origin()) { response.statusCode = 403; response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      response.write(': connected\n\n'); peers.add(response);
      response.on('close', () => peers.delete(response));
    });
    server.httpServer?.on('close', () => { void close().catch(error => logger.error('preview.shutdown_failed', { error: logError(error) })); });
    server.middlewares.use('/__desktop_rpc', async (request, response) => {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (request.method !== 'POST') { response.statusCode = 405; response.end(JSON.stringify({ error: '只支持 POST' })); return; }
      if (request.headers.origin && request.headers.origin !== origin()) { response.statusCode = 403; response.end(JSON.stringify({ error: '不允许此来源' })); return; }
      const diagnostic = diagnostics?.request(request, response);
      try {
        const parsed = await readRpcRequest(request);
        diagnostic?.bodyDecoded(parsed && typeof parsed === 'object' && 'method' in parsed ? parsed.method : undefined);
        if (!parsed || typeof parsed !== 'object' || !('method' in parsed) || typeof parsed.method !== 'string') throw new Error('请求格式无效');
        diagnostic?.dispatchStarted();
        const result = ['runtime.status', 'runtime.reconnect'].includes(parsed.method) ? { state: 'ready', generation: 0 } : await runtime.dispatch(parsed.method, 'params' in parsed ? parsed.params : {});
        diagnostic?.dispatchCompleted();
        response.end(JSON.stringify({ result }));
      } catch (error) {
        logger.warn('preview.rpc_rejected', { error: logError(error) });
        diagnostic?.failed();
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
      response.setHeader('Content-Type', fileContentType(path));
      response.setHeader('Accept-Ranges', 'bytes');
      const range = resolveByteRange(metadata.size, request.headers.range);
      if (!range) { response.statusCode = 416; response.setHeader('Content-Range', `bytes */${metadata.size}`); response.end(); return; }
      const { start, end, length, contentRange } = range;
      if (contentRange) {
        response.statusCode = 206;
        response.setHeader('Content-Range', contentRange);
      }
      response.setHeader('Content-Length', length);
      if (request.method === 'HEAD' || !metadata.size) { response.end(); return; }
      const stream = createReadStream(path, { start, end });
      response.on('close', () => stream.destroy());
      stream.on('error', () => { if (!response.headersSent) response.statusCode = 500; response.end(); }).pipe(response);
    });
  }
  return { name: 'video-quickly-development-bridge', apply: 'serve', configureServer: attach, configurePreviewServer: browserTest ? attach : undefined, closeServer: async () => { await dispose?.(); }, closePreviewServer: async () => { await dispose?.(); } };
}
