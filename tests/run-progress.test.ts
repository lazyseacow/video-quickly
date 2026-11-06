import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { modelSchema, projectDetailSchema, projectSchema, runInspectionSchema, runSchema, runStepPayloadSchema } from '@video-quickly/contracts';
import { createActivityExecutor, validateMediaActivity } from '../packages/integrations/src';
import { createRuntime } from '../packages/runtime/src';
import { DocumentStore, openDatabase } from '../packages/runtime/src/database';
import { createRunProgress } from '../packages/runtime/src/run-progress';

const directories: string[] = [], servers: Server[] = [], runtimes: ReturnType<typeof createRuntime>[] = [], releases: (() => void)[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function gate() { let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); releases.push(release); return { pending, release }; }
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(directories.splice(0).map(directory => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('vq-step-progress-')) throw new Error('Unexpected progress fixture cleanup path');
    return rm(directory, { recursive: true, force: true });
  }));
});
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const server = createServer((request, response) => { void handler(request, response).catch(error => response.destroy(error)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return `http://127.0.0.1:${address.port}`;
}
function open(directory: string) {
  const runtime = createRuntime({ dataDirectory: directory, seed: false, executeActivity: createActivityExecutor(), preflightActivity: validateMediaActivity });
  runtimes.push(runtime); return runtime;
}
async function fixture(url: string, text = false, polling = false, count = 2, concurrency = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-step-progress-')); directories.push(directory);
  const runtime = open(directory), created = projectSchema.parse(await runtime.dispatch('project.create', { title: '真实步骤进度' }));
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: {
    name: '本地生成边界', provider: text ? 'openai-compatible' : 'custom-http', baseUrl: url, model: 'progress-fixture', connectionType: text ? 'text' : 'image', capabilities: [text ? 'text' : 'image'],
    parameters: text ? {} : { requestPath: 'generate', requestTemplate: { narration: '{{narration}}' }, resultUrlPath: 'url', ...(polling ? { taskIdPath: 'id', pollPath: 'jobs/{{taskId}}', statusPath: 'status' } : {}) },
  } }));
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: {
    shots: Array.from({ length: count }, (_, index) => ({ id: `shot-${index + 1}`, title: `镜头 ${index + 1}`, narration: `镜头 ${index + 1}`, visualPrompt: '', durationUs: 1_000_000 })),
    workflow: { id: 'progress-fixture', name: '进度验证', version: 1, production: created.workflow.production, nodes: [{ id: 'generate', kind: text ? 'style' : 'assets', label: text ? '风格生成' : '参考图生成', modelId: model.id }], edges: [], ...(concurrency > 1 ? { execution: { maxConcurrentShots: concurrency, modelLimits: { [model.id]: concurrency } } } : {}) },
  } }));
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id }));
  return { runtime, project, run, directory };
}
async function inspect(runtime: ReturnType<typeof createRuntime>, runId: string) { return runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId })); }
async function output(runtime: ReturnType<typeof createRuntime>, runId: string) { return runStepPayloadSchema.parse(await runtime.dispatch('run.step.payload', { runId, nodeId: 'generate', kind: 'output' })); }

it('reports a real pending text request without manufacturing a percentage or fresh feedback', async () => {
  const waiting = gate(), entered = gate(); let requests = 0;
  const base = await serve(async (request, response) => {
    for await (const _bytes of request) { /* Consume the actual request. */ }
    requests++; entered.release(); await waiting.pending;
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: '生成的视觉风格' } }] }));
  });
  const f = await fixture(base, true); await entered.pending;
  const step = (await inspect(f.runtime, f.run.id)).steps[0];
  expect(step.progress).toMatchObject({ phase: 'requesting' }); expect(step.progress?.fraction).toBeUndefined(); expect(step.progress?.lastConfirmedAt).toBeUndefined();
  expect((await output(f.runtime, f.run.id)).available).toBe(false);
  expect((await inspect(f.runtime, f.run.id)).steps[0].progress?.updatedAt).toBe(step.progress?.updatedAt);
  waiting.release(); await f.runtime.waitForIdle();
  expect((await inspect(f.runtime, f.run.id)).steps[0]).toMatchObject({ status: 'succeeded', progress: { phase: 'completed', endedAt: expect.any(String), lastConfirmedAt: expect.any(String) } });
  expect(requests).toBe(1);
});

it('exposes validated partial media before the step commits and keeps it when stopped', async () => {
  const waiting = gate(), entered = gate(); let requests = 0, base = '';
  base = await serve(async (request, response) => {
    if (request.method === 'GET') { response.end(png); return; }
    for await (const _bytes of request) { /* Consume the actual request. */ }
    if (++requests === 2) { entered.release(); await waiting.pending; }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ url: `${base}/image.png` }));
  });
  const f = await fixture(base); await entered.pending;
  const state = await inspect(f.runtime, f.run.id), partial = await output(f.runtime, f.run.id);
  expect(state.steps[0].progress).toMatchObject({ total: 2, completed: 1 });
  expect(state.steps[0].progress).not.toHaveProperty('shots'); expect(state.steps[0].progress).not.toHaveProperty('assets');
  expect(partial.available).toBe(false); expect(partial.progress?.shots.map(shot => shot.status)).toEqual(['completed', 'submitting']);
  expect(partial.progress?.assets).toHaveLength(1); expect(partial.progress?.assets[0].shotId).toBe('shot-1');
  await expect(f.runtime.dispatch('asset.delete', { assetId: partial.progress?.assets[0].id })).rejects.toThrow('正在使用或已保留的素材不能移除');
  expect(projectDetailSchema.parse(await f.runtime.dispatch('project.get', { projectId: f.project.id })).project).toEqual(f.project);
  await f.runtime.dispatch('run.cancel', { runId: f.run.id }); await f.runtime.waitForIdle();
  const stopped = await output(f.runtime, f.run.id);
  expect(stopped.progress?.shots.map(shot => shot.status)).toEqual(['completed', 'canceled']);
  expect(stopped.progress?.endedAt).toBeDefined(); expect(stopped.progress?.assets[0].id).toBe(partial.progress?.assets[0].id); expect(requests).toBe(2);
});

it('restores partial progress after reopening and reuses completed receipts on a step retry', async () => {
  let requests = 0, base = '';
  base = await serve(async (request, response) => {
    if (request.method === 'GET') { response.end(png); return; }
    for await (const _bytes of request) { /* Consume the actual request. */ }
    response.setHeader('content-type', 'application/json');
    if (++requests === 2) { response.writeHead(400); response.end('{}'); return; }
    response.end(JSON.stringify({ url: `${base}/image.png` }));
  });
  const f = await fixture(base); await f.runtime.waitForIdle();
  const partial = await output(f.runtime, f.run.id);
  expect(partial.progress?.shots.map(shot => shot.status)).toEqual(['completed', 'interrupted']);
  await f.runtime.close(); runtimes.splice(runtimes.indexOf(f.runtime), 1);
  const runtime = open(f.directory);
  expect((await output(runtime, f.run.id)).progress).toEqual(partial.progress);
  await runtime.dispatch('run.step.retry', { runId: f.run.id, nodeId: 'generate' }); await runtime.waitForIdle();
  const final = await output(runtime, f.run.id);
  expect(final.available).toBe(true); expect(final.progress).toMatchObject({ completed: 2, total: 2 });
  expect(final.progress?.shots[0].assetId).toBe(partial.progress?.shots[0].assetId); expect(requests).toBe(3);
});

it('retains each parallel shot status when results finish out of order', async () => {
  const waiting = gate(); let requests = 0, base = '';
  base = await serve(async (request, response) => {
    if (request.method === 'GET') { response.end(png); return; }
    let body = ''; for await (const bytes of request) body += bytes;
    requests++;
    if (!body.includes('镜头 2')) await waiting.pending;
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ url: `${base}/image.png` }));
  });
  const f = await fixture(base, false, false, 3, 2);
  await vi.waitFor(async () => expect((await inspect(f.runtime, f.run.id)).steps[0].progress?.completed).toBe(1));
  const partial = await output(f.runtime, f.run.id);
  expect(partial.progress?.shots[1]).toMatchObject({ id: 'shot-2', status: 'completed', assetId: expect.any(String) });
  expect(partial.progress?.shots[0].status).not.toBe('completed'); expect(partial.progress?.shots[2].status).not.toBe('completed');
  waiting.release(); await f.runtime.waitForIdle();
  const final = await output(f.runtime, f.run.id);
  expect(final.progress?.shots.map(shot => shot.id)).toEqual(['shot-1', 'shot-2', 'shot-3']);
  expect(final.progress).toMatchObject({ completed: 3, total: 3 }); expect(requests).toBe(3);
});

it('uses actual remote queue and generation states and does not confirm a failed poll', async () => {
  const failedPoll = gate(); let posts = 0, polls = 0, ready = false, base = '';
  base = await serve(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST') { for await (const _bytes of request) {} posts++; response.end(JSON.stringify({ id: 'original-job' })); return; }
    if (request.url === '/image.png') { response.end(png); return; }
    if (++polls === 3) { response.writeHead(503); response.end('{}'); failedPoll.release(); return; }
    response.end(JSON.stringify(ready ? { status: 'completed', url: `${base}/image.png` } : { status: polls === 1 ? 'queued' : 'running' }));
  });
  const f = await fixture(base, false, true, 1);
  await vi.waitFor(async () => expect((await output(f.runtime, f.run.id)).progress?.shots[0].status).toBe('queued'));
  await vi.waitFor(async () => expect((await output(f.runtime, f.run.id)).progress?.shots[0].status).toBe('generating'), { timeout: 5000 });
  const confirmed = (await inspect(f.runtime, f.run.id)).steps[0].progress?.lastConfirmedAt;
  await failedPoll.pending;
  expect((await inspect(f.runtime, f.run.id)).steps[0].progress?.lastConfirmedAt).toBe(confirmed);
  ready = true; await f.runtime.waitForIdle();
  expect((await output(f.runtime, f.run.id)).progress).toMatchObject({ completed: 1, total: 1 }); expect(posts).toBe(1);
});

it('bounds progress notifications for per-frame render callbacks while retaining the terminal value', async () => {
  const base = await serve(async (_request, response) => { response.end('{}'); });
  const f = await fixture(base); await f.runtime.waitForIdle();
  const database = openDatabase(f.directory);
  try {
    const changed = vi.fn(), progress = createRunProgress(new DocumentStore(database), changed);
    progress.begin('render-feedback', f.project, undefined, []);
    for (let frame = 0; frame <= 2000; frame++) progress.phase('render-feedback', 'rendering', false, frame / 2000);
    expect(progress.summary('render-feedback')).toMatchObject({ phase: 'rendering', fraction: 1 }); expect(changed.mock.calls.length).toBeLessThan(10);
    progress.phase('render-feedback', 'rendering', false, 0.1); expect(progress.summary('render-feedback')?.fraction).toBe(1);
  } finally { database.close(); }
});
