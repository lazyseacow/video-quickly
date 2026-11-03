import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { modelSchema, projectSchema, runSchema, workflowNodeSchema } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src/index';
import { ActivityJournal, AmbiguousActivityError } from '../packages/runtime/src/activities';
import { openDatabase } from '../packages/runtime/src/database';
import { createLogger } from '../packages/runtime/src/logging';

interface LogRecord { event: string; level: string; [field: string]: unknown }
const directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
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
  await runtime.dispatch('workflow.save', { projectId: project.id, workflow: { id: 'logging-fixture', version: 1, name: 'private-workflow-name', production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label, modelId, prompt: 'private-node-prompt' })], edges: [] } });
  return project;
}

it('records lifecycle and user changes by default, with protocol request correlation and no polling or content', async () => {
  const directory = await location(), runtime = open(directory);
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: 'private-project-title', brief: 'private-project-brief' }, { requestId: 42 }));
  await runtime.dispatch('workspace.summary');
  await close(runtime);
  const { records, text } = await logs(directory);
  expect(records.map(record => record.event)).toEqual(['runtime.initializing', 'runtime.initialized', 'rpc.completed', 'runtime.stopping', 'runtime.stopped']);
  expect(records.find(record => record.event === 'rpc.completed')).toMatchObject({ level: 'info', requestId: 42, method: 'project.create', durationMs: expect.any(Number) });
  expect(text).not.toContain('private-project-title'); expect(text).not.toContain('private-project-brief');
  expect(text).not.toContain('workspace.summary'); expect(text).not.toContain(project.id);
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
  expect(records.find(record => record.event === 'rpc.failed' && record.requestId === 43)).toMatchObject({ method: 'project.get', durationMs: expect.any(Number), error: { name: 'Error' } });
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
