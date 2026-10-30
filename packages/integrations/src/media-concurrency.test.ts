import { createServer, type Server, type RequestListener } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { projectSchema, modelSchema, workflowNodeSchema, DEFAULT_VIDEO_PROFILE } from '@video-quickly/contracts';
import { createActivityExecutor, type MediaActivityContext } from './index';
import { mapMediaShots, MediaRequestQueue } from './media-concurrency';

const directories: string[] = [], servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function service(handler: RequestListener) { const server = createServer(handler); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address'); return `http://127.0.0.1:${address.port}`; }
async function context(baseUrl: string, id: string, count = 3): Promise<MediaActivityContext> {
  const directory = await mkdtemp(join(tmpdir(), 'vq-media-concurrency-')); directories.push(directory);
  const model = modelSchema.parse({ id: 'shared-model', createdAt: '', updatedAt: '', name: 'fixture', provider: 'custom-http', baseUrl, model: 'fixture', capabilities: ['image'], enabled: true, parameters: { requestPath: 'generate', requestTemplate: { name: '{{narration}}' }, resultBase64Path: 'data' } });
  const project = projectSchema.parse({ id, title: id, brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: { id: 'workflow', version: 1, name: 'parallel', nodes: [workflowNodeSchema.parse({ id: 'assets', kind: 'assets', label: 'assets', modelId: model.id })], edges: [], execution: { maxConcurrentShots: 3, modelLimits: { [model.id]: 2 } } }, shots: Array.from({ length: count }, (_, index) => ({ id: `shot-${index}`, title: `shot ${index}`, narration: `shot-${index}`, visualPrompt: '', durationUs: 1_000_000 })), claims: [], createdAt: '', updatedAt: '' });
  return { project, node: project.workflow.nodes[0], model, runId: id, operationId: `${id}:assets`, signal: new AbortController().signal, assets: [], dataDirectory: directory, persistRemoteTask() {} };
}
it('bounds actual overlapping HTTP generation across projects sharing a model and preserves shot order', async () => {
  let active = 0, peak = 0, posts = 0;
  const base = await service((request, response) => { if (request.method !== 'POST') { response.writeHead(404).end(); return; } posts++; active++; peak = Math.max(peak, active); request.resume(); setTimeout(() => { active--; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: png })); }, 35); });
  const execute = createActivityExecutor(), first = await context(base, 'first'), second = await context(base, 'second');
  const results = await Promise.all([execute(first), execute(second)]);
  expect(peak).toBe(2); expect(posts).toBe(6);
  for (const result of results) { if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.assets)) throw new Error('Missing assets'); expect(result.assets.map(asset => asset && typeof asset === 'object' && !Array.isArray(asset) ? asset.shotId : null)).toEqual(['shot-0', 'shot-1', 'shot-2']); }
});
it('drains in-flight successes and resumes only failed downloads without repeating any POST', async () => {
  let posts = 0, failDownload = true, downloads = 0;
  const base = await service(async (request, response) => {
    if (request.method === 'POST') { posts++; let body = ''; for await (const chunk of request) body += chunk; const input = JSON.parse(body); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ url: `${base}/download/${input.name}` })); return; }
    downloads++;
    if (request.url?.endsWith('shot-1') && failDownload) { response.writeHead(503).end('retry download'); return; }
    response.setHeader('Content-Type', 'image/png'); response.end(Buffer.from(png, 'base64'));
  });
  const execute = createActivityExecutor(), input = await context(base, 'partial', 2); if (!input.model) throw new Error('Missing model'); delete input.model.parameters.resultBase64Path; input.model.parameters.resultUrlPath = 'url';
  await expect(execute(input)).rejects.toThrow('下载失败'); expect(posts).toBe(2);
  failDownload = false; const result = await execute(input);
  expect(result).toMatchObject({ source: 'model' }); expect(posts).toBe(2); expect(downloads).toBe(3);
});
it('cancels queued requests before they submit and releases model slots for later work', async () => {
  const queue = new MediaRequestQueue(), first = new AbortController(), waiting = new AbortController();
  let release!: () => void; const held = queue.run('model', 1, first.signal, () => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve(); let submitted = false;
  const pending = queue.run('model', 1, waiting.signal, async () => { submitted = true; }); const rejected = expect(pending).rejects.toBeDefined(); waiting.abort(); await rejected; expect(submitted).toBe(false);
  release(); await held; expect(await queue.run('model', 1, first.signal, async () => 'ready')).toBe('ready');
});
it('stops assigning new shots after failure while allowing already running work to settle', async () => {
  const started: number[] = [], completed: number[] = []; let finish!: () => void;
  const work = mapMediaShots([0, 1, 2, 3], 2, new AbortController().signal, async value => { started.push(value); if (value === 0) { await new Promise<void>(resolve => { finish = resolve; }); completed.push(value); return value; } throw new Error('known failure'); });
  const rejected = expect(work).rejects.toThrow('known failure'); await Promise.resolve(); finish(); await rejected;
  expect(started).toEqual([0, 1]); expect(completed).toEqual([0]);
});

it('does not submit the next waiting shot when a limited model request fails', async () => {
  let posts = 0;
  const base = await service((request, response) => { posts++; request.resume(); response.writeHead(503).end(); });
  const execute = createActivityExecutor(), input = await context(base, 'stop-queued', 3); input.project.workflow.execution!.modelLimits['shared-model'] = 1;
  await expect(execute(input)).rejects.toThrow('HTTP 503'); expect(posts).toBe(1);
});
