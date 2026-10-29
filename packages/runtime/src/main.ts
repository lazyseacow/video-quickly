import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, type SecretStore } from './index.js';
import { createActivityExecutor } from '@video-quickly/integrations';

const args = process.argv.slice(2);
const argument = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const dataDirectory = argument('--data-dir') ?? process.env.VIDEO_QUICKLY_DATA ?? join(process.env.LOCALAPPDATA ?? homedir(), 'VideoQuickly');
const hostPending = new Map<string, { resolve(value: unknown): void; reject(reason: Error): void; timeout: ReturnType<typeof setTimeout> }>();
let hostSequence = 0;
const send = (message: unknown) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

function hostCall(method: string, params: unknown): Promise<unknown> {
  const id = `host-${++hostSequence}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { hostPending.delete(id); reject(new Error('桌面系统能力请求超时。')); }, 30_000);
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
const runtime = createRuntime({ dataDirectory, mode: 'desktop', secretStore, hostCall, executeActivity: createActivityExecutor({ ffmpegPath: argument('--ffmpeg') ?? process.env.VIDEO_QUICKLY_FFMPEG }) });
runtime.subscribe(event => send({ jsonrpc: '2.0', method: 'runtime.event', params: event }));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', line => {
  let message: unknown;
  try { message = JSON.parse(line); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '请求不是有效 JSON。' } }); return; }
  if (!message || typeof message !== 'object') return;
  const request = message as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown } };
  if (typeof request.id === 'string' && hostPending.has(request.id) && typeof request.method !== 'string') {
    const pending = hostPending.get(request.id)!; clearTimeout(pending.timeout); hostPending.delete(request.id);
    if (request.error) pending.reject(new Error('系统凭据操作失败。'));
    else pending.resolve(request.result);
    return;
  }
  if ((typeof request.id !== 'string' && typeof request.id !== 'number') || typeof request.method !== 'string') return;
  const id = request.id;
  void runtime.dispatch(request.method, request.params).then(result => send({ jsonrpc: '2.0', id, result })).catch(error => {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof Error ? error.message : '操作失败。' } });
  });
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const pending of hostPending.values()) { clearTimeout(pending.timeout); pending.reject(new Error('运行环境已关闭。')); }
  hostPending.clear();
  await runtime.close();
  process.exitCode = 0;
}
input.on('close', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
send({ jsonrpc: '2.0', method: 'runtime.ready', params: { dataDirectory } });
