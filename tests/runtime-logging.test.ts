import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { modelSchema, projectSchema, runSchema, workflowNodeSchema } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src/index';
import { ActivityJournal, AmbiguousActivityError } from '../packages/runtime/src/activities';
import { openDatabase } from '../packages/runtime/src/database';
import { createLogger } from '../packages/runtime/src/logging';
import { createActivityExecutor, validateMediaActivity } from '../packages/integrations/src/index';
import { createNativeVideoWorkflow } from '@video-quickly/contracts';
import { fixtureNativeVideo } from './fixtures/native-video';

interface LogRecord { event: string; level: string; [field: string]: unknown }
const directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [], servers: Server[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function location() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-runtime-logging-')); directories.push(directory); return directory;
}
function open(directory: string, options: Partial<RuntimeOptions> = {}) {
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ...options }); runtimes.push(runtime); return runtime;
}
async function close(runtime: ReturnType<typeof createRuntime>) {
  await runtime.close(); runtimes.splice(runtimes.indexOf(runtime), 1);
}
async function service(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return `http://127.0.0.1:${address.port}`;
}
async function logs(directory: string) {
  const text = await readFile(join(directory, 'logs', 'runtime.log'), 'utf8');
  const records = text.trim().split('\n').map(line => {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || !('event' in value) || typeof value.event !== 'string' || !('level' in value) || typeof value.level !== 'string') throw new Error('Invalid structured diagnostic record');
    return value as LogRecord;
  });
  return { records, text };
}
async function workflow(runtime: ReturnType<typeof createRuntime>, modelId?: string, label = '本地步骤') {
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: 'private-project-title', brief: 'private-project-brief' }));
  await runtime.dispatch('project.update', { projectId: project.id, patch: { workflow: { id: 'logging-fixture', version: 1, name: 'private-workflow-name', production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label, modelId, prompt: 'private-node-prompt' })], edges: [] } } });
  return project;
}

it('records lifecycle and user changes by default, with protocol request correlation and no polling or content', async () => {
  const directory = await location(), runtime = open(directory);
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: 'private-project-title', brief: 'private-project-brief' }, { requestId: 42 }));
  await runtime.dispatch('workspace.summary');
  await close(runtime);
  const { records, text } = await logs(directory);
  expect(records.map(record => record.event)).toEqual(['runtime.initializing', 'runtime.initialized', 'rpc.started', 'rpc.completed', 'runtime.stopping', 'runtime.stopped']);
  expect(records.find(record => record.event === 'rpc.completed')).toMatchObject({ level: 'info', requestId: 42, method: 'project.create', projectId: project.id, durationMs: expect.any(Number) });
  expect(text).not.toContain('private-project-title'); expect(text).not.toContain('private-project-brief');
  expect(text).not.toContain('workspace.summary');
});

it('keeps provider failure diagnostics useful without persisting response text, credentials or project content', async () => {
  const directory = await location(), secrets = new Map<string, string>(), secret = 'fixture-private-provider-credential';
  const runtime = open(directory, {
    logger: createLogger({ dataDirectory: directory, component: 'runtime', level: 'debug' }),
    secretStore: { async get(key) { return secrets.get(key); }, async set(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); } },
    provider: async () => { throw Object.assign(new Error(`private-provider-response ${secret}`), { code: 'EACCES', status: 503 }); },
  });
  const modelInput = { name: 'private-model-name', provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'fixture', connectionType: 'text', capabilities: ['text'] };
  await expect(runtime.dispatch('model.save', { model: { ...modelInput, baseUrl: `${modelInput.baseUrl}?token=${secret}` }, secret })).rejects.toThrow('不含凭据');
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: modelInput, secret }));
  const project = await workflow(runtime, model.id, `private-node-label ${secret}`);
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id }));
  await runtime.waitForIdle();
  expect(runSchema.parse(await runtime.dispatch('run.get', { runId: run.id })).status).toBe('failed');
  await expect(runtime.dispatch('project.get', { projectId: 'not-present' }, { requestId: 43 })).rejects.toThrow('项目不存在');
  await close(runtime);
  const { records, text } = await logs(directory);
  expect(records.find(record => record.event === 'activity.failed')).toMatchObject({ level: 'error', runId: run.id, activityId: 'brief', safety: 'external', status: 'unknown', error: { name: 'Error', code: 'EACCES', statusCode: 503 } });
  expect(records.find(record => record.event === 'run.failed')).toMatchObject({ level: 'error', runId: run.id, projectId: project.id, nodeId: 'brief' });
  expect(records.find(record => record.event === 'rpc.failed' && record.requestId === 43)).toMatchObject({ method: 'project.get', projectId: expect.stringMatching(/^sha256:/), durationMs: expect.any(Number), error: { name: 'Error' } });
  expect(records.find(record => record.event === 'provider.request_failed')).toMatchObject({ runId: run.id, projectId: project.id, nodeId: 'brief', nodeKind: 'brief', modelId: model.id, provider: 'openai-compatible', durationMs: expect.any(Number), error: { statusCode: 503 } });
  expect(records.find(record => record.event === 'node.execution_failed')).toMatchObject({ runId: run.id, nodeId: 'brief', durationMs: expect.any(Number) });
  for (const content of [secret, 'private-provider-response', 'private-project-title', 'private-project-brief', 'private-workflow-name', 'private-node-prompt', 'private-node-label', 'private-model-name', 'example.invalid']) expect(text).not.toContain(content);
});

it('records interrupted-run recovery and committed-result reuse without repeating work', async () => {
  const directory = await location(); let executions = 0;
  const first = open(directory, { failpoint(point) { if (point === 'after-commit') { executions++; throw new SimulatedProcessExit(); } } });
  const project = await workflow(first), run = runSchema.parse(await first.dispatch('run.start', { projectId: project.id }));
  await first.waitForIdle(); await close(first);
  const second = open(directory, { logger: createLogger({ dataDirectory: directory, component: 'runtime', level: 'debug' }) });
  await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle();
  expect(runSchema.parse(await second.dispatch('run.get', { runId: run.id })).status).toBe('succeeded');
  expect(executions).toBe(1); await close(second);
  const { records } = await logs(directory);
  expect(records.find(record => record.event === 'run.recovered')).toMatchObject({ runId: run.id, projectId: project.id, previousStatus: 'running', status: 'queued' });
  expect(records.find(record => record.event === 'activity.reused')).toMatchObject({ runId: run.id, activityId: 'brief', cached: true, status: 'completed' });
  expect(records.filter(record => record.event === 'activity.dispatched')).toHaveLength(1);
  expect(records.find(record => record.event === 'run.completed')).toMatchObject({ runId: run.id, status: 'succeeded' });
  expect(records.filter(record => record.event === 'node.execution_started')).toHaveLength(2);
  expect(records.filter(record => record.event === 'node.execution_completed')).toHaveLength(1);
  expect(records.find(record => record.event === 'node.execution_completed')).toMatchObject({ durationMs: expect.any(Number) });
});

it.each([429, 503])('records real model HTTP %i failures with safe status and request context', async status => {
  const baseUrl = await service((request, response) => { request.resume(); response.writeHead(status).end('private-provider-response'); });
  const directory = await location(), runtime = open(directory);
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: 'private-model-name', provider: 'openai-compatible', baseUrl, model: 'fixture', connectionType: 'text', capabilities: ['text'] } }));
  const project = await workflow(runtime, model.id), run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id }, { requestId: 55 }));
  await runtime.waitForIdle(); await close(runtime);
  const { records, text } = await logs(directory);
  expect(records.find(record => record.event === 'rpc.completed' && record.requestId === 55)).toMatchObject({ runId: run.id, projectId: project.id });
  expect(records.find(record => record.event === 'provider.request_failed')).toMatchObject({ level: 'error', runId: run.id, nodeId: 'brief', modelId: model.id, error: { statusCode: status } });
  expect(text).not.toContain('private-provider-response'); expect(text).not.toContain(baseUrl);
});

it('logs each media phase and restores a failed download without repeating a model submission', async () => {
  let posts = 0, polls = 0, downloads = 0;
  const secret = 'private-download-credential', remoteId = 'private-remote-task';
  const baseUrl = await service((request, response) => {
    request.resume(); response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST') { posts++; response.end(JSON.stringify({ id: remoteId })); }
    else if (request.url?.startsWith('/tasks/')) { polls++; response.end(JSON.stringify({ status: 'completed', url: `${baseUrl}/image?token=${secret}` })); }
    else if (++downloads === 1) response.writeHead(503).end(`private-provider-body ${secret}`);
    else response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  });
  const directory = await location(), runtime = open(directory, { executeActivity: createActivityExecutor(), preflightActivity: validateMediaActivity });
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: 'private-model-name', provider: 'custom-http', baseUrl, model: 'fixture', connectionType: 'image', capabilities: ['image'], parameters: { requestPath: 'generate', requestTemplate: { prompt: '{{prompt}}' }, taskIdPath: 'id', pollPath: 'tasks/{{taskId}}', statusPath: 'status', resultUrlPath: 'url' } } }));
  const initial = projectSchema.parse(await runtime.dispatch('project.create', { title: 'private-project-title', brief: 'private-project-brief' }));
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: initial.id, revision: initial.revision, patch: { shots: [{ id: 'private-shot-id', title: 'private-shot-title', narration: '', visualPrompt: 'private-prompt', durationUs: 1_000_000 }], workflow: { id: 'logging-media', name: 'private-workflow-name', version: 1, production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [workflowNodeSchema.parse({ id: 'assets', kind: 'assets', label: 'private-node-label', modelId: model.id })], edges: [] } } }));
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id }));
  await runtime.waitForIdle();
  expect(runSchema.parse(await runtime.dispatch('run.get', { runId: run.id })).status).toBe('failed');
  await runtime.dispatch('run.resume', { runId: run.id }); await runtime.waitForIdle();
  expect(runSchema.parse(await runtime.dispatch('run.get', { runId: run.id })).status).toBe('succeeded');
  await close(runtime);
  expect({ posts, polls, downloads }).toEqual({ posts: 1, polls: 1, downloads: 2 });
  const { records, text } = await logs(directory);
  const media = records.filter(record => record.event.startsWith('media.'));
  expect(media.every(record => record.runId === run.id && record.projectId === project.id && record.nodeId === 'assets' && record.modelId === model.id && record.shotId === media[0].shotId && record.shotCount === 1)).toBe(true);
  expect(media.find(record => record.event === 'media.started')).toMatchObject({ queueMs: expect.any(Number) });
  expect(media.find(record => record.event === 'media.request_completed')).toMatchObject({ phase: 'submit', statusCode: 200, byteSize: expect.any(Number) });
  expect(media.find(record => record.event === 'media.poll_completed')).toMatchObject({ pollCount: 1, durationMs: expect.any(Number) });
  expect(media.find(record => record.event === 'media.failed')).toMatchObject({ phase: 'download', error: { statusCode: 503 } });
  expect(media.find(record => record.event === 'media.receipt_loaded')).toMatchObject({ state: 'download', resumed: true, hasRemoteId: true });
  expect(media.find(record => record.event === 'media.validation_completed')).toMatchObject({ phase: 'validate', assetId: expect.any(String), byteSize: expect.any(Number) });
  expect(media.filter(record => record.event === 'media.completed')).toHaveLength(1);
  expect(media.some(record => record.event === 'media.request_started' && record.phase === 'poll')).toBe(false);
  for (const content of [secret, remoteId, baseUrl, 'private-provider-body', 'private-project-title', 'private-project-brief', 'private-prompt', 'private-model-name', 'private-shot-id']) expect(text).not.toContain(content);
});

it('finishes video production automatically after a broken progress connection and logs safe retry evidence', async () => {
  let posts = 0, polls = 0, downloads = 0;
  const remoteId = 'private-video-task', video = fixtureNativeVideo();
  const baseUrl = await service((request, response) => {
    request.resume();
    if (request.method === 'POST') { posts++; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ id: remoteId })); }
    else if (request.url === `/videos/${remoteId}`) {
      if (++polls === 1) { response.destroy(); return; }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ status: 'completed' }));
    } else if (request.url === `/videos/${remoteId}/content`) { downloads++; response.end(video); }
    else response.writeHead(404).end();
  });
  const directory = await location(), runtime = open(directory, { executeActivity: createActivityExecutor(), preflightActivity: validateMediaActivity });
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: 'private-video-model', provider: 'openai-compatible', baseUrl, model: 'fixture-video', connectionType: 'video', capabilities: ['video'] } }));
  const initial = projectSchema.parse(await runtime.dispatch('project.create', { title: 'private-video-project' }));
  const native = createNativeVideoWorkflow();
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: initial.id, revision: initial.revision, patch: { shots: [{ id: 'private-shot-id', title: 'private-shot-title', narration: '', visualPrompt: 'private-video-prompt', durationUs: 1_000_000 }], workflow: { ...native, id: 'logging-video', stages: undefined, nodes: native.nodes.filter(node => node.id === 'video').map(node => ({ ...node, modelId: model.id, config: { ...node.config, modelOverride: true } })), edges: [] } } }));
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await runtime.waitForIdle();
  expect(runSchema.parse(await runtime.dispatch('run.get', { runId: run.id })).status).toBe('succeeded');
  expect({ posts, polls, downloads }).toEqual({ posts: 1, polls: 2, downloads: 1 });
  await close(runtime);
  const { records, text } = await logs(directory);
  expect(records.find(record => record.event === 'media.poll_retry_scheduled')).toMatchObject({ level: 'warn', runId: run.id, nodeId: 'video', phase: 'poll', retryCount: 1, retryDelayMs: 1000, error: { name: 'TypeError', cause: { code: 'UND_ERR_SOCKET' } } });
  expect(records.find(record => record.event === 'media.poll_recovered')).toMatchObject({ level: 'info', retryCount: 1, phase: 'poll' });
  expect(records.find(record => record.event === 'media.poll_completed')).toMatchObject({ pollCount: 2 });
  expect(records.some(record => ['run.failed', 'media.failed'].includes(record.event))).toBe(false);
  for (const content of [remoteId, baseUrl, 'private-video-model', 'private-video-project', 'private-video-prompt']) expect(text).not.toContain(content);
});

it('records ambiguous-submission blocking and remote-receipt presence without exposing task identifiers', async () => {
  const directory = await location(), database = openDatabase(directory), logger = createLogger({ dataDirectory: directory, component: 'runtime', level: 'debug' });
  const journal = new ActivityJournal(database, { logger }); let calls = 0;
  try {
    await expect(journal.execute('private-run-id', 'private-activity-id', { prompt: 'private-activity-input' }, 'external', async () => { calls++; throw new Error('private-provider-body'); })).rejects.toThrow('外部调用未完成');
    await expect(journal.execute('private-run-id', 'private-activity-id', { prompt: 'private-activity-input' }, 'external', async () => { calls++; return 'duplicate'; })).rejects.toBeInstanceOf(AmbiguousActivityError);
    await journal.execute('private-run-id', 'with-receipt', {}, 'external', async context => { context.recordRemoteId('https://example.invalid/task?token=private-remote-token'); return { value: 'private-activity-result' }; });
  } finally { database.close(); }
  expect(calls).toBe(1);
  const { records, text } = await logs(directory);
  expect(records.find(record => record.event === 'activity.blocked')).toMatchObject({ level: 'warn', status: 'unknown', hasRemoteId: false });
  expect(records.find(record => record.event === 'activity.receipt_recorded')).toMatchObject({ level: 'debug', hasRemoteId: true });
  for (const content of ['private-run-id', 'private-activity-id', 'private-activity-input', 'private-provider-body', 'private-remote-token', 'private-activity-result', 'example.invalid']) expect(text).not.toContain(content);
});
