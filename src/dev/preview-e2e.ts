import { isAbsolute, resolve } from 'node:path';
import { preview, type PreviewServer } from 'vite';

const directory = process.env.VIDEO_QUICKLY_DATA_DIR;
if (!directory || !isAbsolute(directory)) throw new Error('隔离预览必须显式指定绝对工作区目录。');
let server: PreviewServer | undefined, requested = false, closing: Promise<void> | undefined;
async function send(value: Record<string, string>) {
  if (process.connected && process.send) await new Promise<void>((done, reject) => process.send!(value, error => error ? reject(error) : done()));
}
function stop() {
  requested = true;
  if (!server) return Promise.resolve();
  return closing ??= (async () => { await server.close(); await send({ type: 'closed' }); process.exit(0); })();
}
const fail = async (error: unknown) => { console.error(error instanceof Error ? error.stack : String(error)); await send({ type: 'failed', message: error instanceof Error ? error.message : String(error) }); process.exit(1); };
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') void stop().catch(fail); });
process.once('disconnect', () => { void stop().catch(fail); });
process.once('SIGINT', () => { void stop().catch(fail); }); process.once('SIGTERM', () => { void stop().catch(fail); });
try {
  server = await preview({ mode: 'browser-test', logLevel: 'error' });
  if (requested) await stop();
  else {
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error('隔离预览未返回监听地址。');
    await send({ type: 'ready', url, directory: resolve(directory) });
    if (!process.send) console.log(url);
  }
} catch (error) { try { await server?.close(); } finally { await fail(error); } }
