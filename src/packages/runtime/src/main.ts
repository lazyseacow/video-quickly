import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, type SecretStore } from './index.js';
import { createLogger, logError } from './logging.js';
import { createRuntimeMediaServices } from './node.js';
import { readStoryboardWebResearch } from './storyboard-research.js';

const args = process.argv.slice(2);
const argument = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const dataDirectory = argument('--data-dir') ?? process.env.VIDEO_QUICKLY_DATA ?? join(process.env.LOCALAPPDATA ?? homedir(), 'VideoQuickly');
const logger = createLogger({ dataDirectory, component: 'runtime' });
logger.info('runtime.starting', { platform: process.platform, arch: process.arch, nodeVersion: process.version });
process.on('uncaughtExceptionMonitor', error => logger.error('runtime.uncaught_exception', { error: logError(error) }));
const hostPending = new Map<string, { resolve(value: unknown): void; reject(reason: Error): void; timeout: ReturnType<typeof setTimeout> }>();
let hostSequence = 0;
const send = (message: unknown) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

function hostCall(method: string, params: unknown): Promise<unknown> {
  const id = `host-${++hostSequence}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { hostPending.delete(id); logger.error('host.request_timeout', { method, requestId: id }); reject(new Error('桌面系统能力请求超时。')); }, 30_000);
    hostPending.set(id, { resolve, reject, timeout });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

const secretStore: SecretStore = {
  persistent: true,
  async get(key) { const value = await hostCall('host.secret.get', { key }); return typeof value === 'string' ? value : undefined; },
  async set(key, value) { await hostCall('host.secret.set', { key, value }); },
  async delete(key) { await hostCall('host.secret.delete', { key }); },
};
let runtime: ReturnType<typeof createRuntime>;
const ffmpegPath = argument('--ffmpeg') ?? process.env.VIDEO_QUICKLY_FFMPEG;
const runtimeMedia = createRuntimeMediaServices({ dataDirectory, ffmpegPath });
try {
  runtime = createRuntime({ dataDirectory, mode: 'desktop', requireChargeConfirmation: true, seedBuiltInTemplates: true, logger, secretStore, hostCall,
    webResearch: readStoryboardWebResearch, ...runtimeMedia.options });
} catch (error) {
  logger.error('runtime.start_failed', { error: logError(error) });
  const failure = { jsonrpc: '2.0', method: 'runtime.failed', params: { message: error instanceof Error ? error.message : '本地工作区无法打开。' } };
  await new Promise<void>(resolve => process.stdout.write(`${JSON.stringify(failure)}\n`, () => resolve()));
  process.exit(1);
}
runtime.subscribe(event => send({ jsonrpc: '2.0', method: 'runtime.event', params: event }));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', line => {
  let message: unknown;
  try { message = JSON.parse(line); }
  catch { logger.warn('rpc.invalid_json'); send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '请求不是有效 JSON。' } }); return; }
  if (!message || typeof message !== 'object') return;
  const request = message as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown } };
  if (typeof request.id === 'string' && hostPending.has(request.id) && typeof request.method !== 'string') {
    const pending = hostPending.get(request.id)!; clearTimeout(pending.timeout); hostPending.delete(request.id);
    if (request.error) { logger.warn('host.request_failed', { requestId: request.id }); pending.reject(new Error('系统凭据操作失败。')); }
    else pending.resolve(request.result);
    return;
  }
  if ((typeof request.id !== 'string' && typeof request.id !== 'number') || typeof request.method !== 'string') return;
  const id = request.id;
  void runtime.dispatch(request.method, request.params, { requestId: id }).then(result => send({ jsonrpc: '2.0', id, result })).catch(error => {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof Error ? error.message : '操作失败。' } });
  });
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  logger.info('runtime.shutdown_requested');
  for (const pending of hostPending.values()) { clearTimeout(pending.timeout); pending.reject(new Error('运行环境已关闭。')); }
  hostPending.clear();
  await runtimeMedia.close();
  await runtime.close();
  process.exitCode = 0;
}
const stop = () => { void shutdown().catch(error => { logger.error('runtime.shutdown_failed', { error: logError(error) }); process.exitCode = 1; }); };
input.on('close', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
logger.info('runtime.ready');
send({ jsonrpc: '2.0', method: 'runtime.ready', params: { dataDirectory } });
