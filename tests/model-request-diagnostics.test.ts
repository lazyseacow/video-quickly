import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { modelSchema, projectSchema, runSchema, workflowNodeSchema } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src/index';
import { createLogger } from '../packages/runtime/src/logging';

const directories: string[] = [], servers: Server[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
  })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it.each([
  { requestPhase: 'send', error: { name: 'TypeError', cause: { code: 'UND_ERR_SOCKET' } } },
  { requestPhase: 'read', error: { name: 'TypeError', cause: { code: 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH' } } },
  { requestPhase: 'parse', error: { name: 'SyntaxError' } },
  { requestPhase: 'headers', error: { name: 'Error', statusCode: 503 } },
  { requestPhase: 'validate', error: { name: 'Error' } },
])('records the $requestPhase failure stage through a real model request without private content', async ({ requestPhase, error }) => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the actual request before closing its connection. */ }
    requests++;
    if (requestPhase === 'send') { request.socket.destroy(); return; }
    if (requestPhase === 'read') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1024', Connection: 'close' });
      response.end('{"choices":[');
      return;
    }
    response.writeHead(requestPhase === 'headers' ? 503 : 200, { 'Content-Type': 'application/json' });
    response.end(requestPhase === 'validate' ? JSON.stringify({ choices: [{ message: { content: '' } }] }) : 'private-provider-body');
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。');
  const directory = await mkdtemp(join(tmpdir(), 'vq-model-request-diagnostics-')); directories.push(directory);
  const secrets = new Map<string, string>();
  const runtime = createRuntime({ dataDirectory: directory, seed: false, secretStore: {
    async get(key) { return secrets.get(key); }, async set(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); },
  } });
  runtimes.push(runtime);
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: 'private-model-name', provider: 'openai-compatible', connectionType: 'text', capabilities: ['text'], baseUrl: `http://127.0.0.1:${address.port}/private-base-path/v1`, model: 'fixture' }, secret: 'fixture-private-credential' }));
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: 'private-project-title' }));
  await runtime.dispatch('workflow.save', { projectId: project.id, workflow: { id: 'request-diagnostics', version: 1, name: '请求诊断', production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label: '简报', modelId: model.id, prompt: 'private-node-prompt' })], edges: [] } });
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id }));
  await runtime.waitForIdle();
  expect(runSchema.parse(await runtime.dispatch('run.get', { runId: run.id })).status).toBe('failed');
  const text = await readFile(join(directory, 'logs/runtime.log'), 'utf8');
  const records = text.trim().split('\n').map((line): Record<string, unknown> => JSON.parse(line));
  const failures = records.filter(record => record.event === 'provider.request_failed');
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ runId: run.id, projectId: project.id, nodeId: 'brief', modelId: model.id, requestPhase, error });
  expect(requests).toBe(1);
  for (const privateValue of ['private-provider-body', 'fixture-private-credential', 'private-model-name', 'private-project-title', 'private-node-prompt', 'private-base-path']) expect(text).not.toContain(privateValue);
});

it('accepts only fixed request phase labels in automatic logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-request-phase-privacy-')); directories.push(directory);
  const logger = createLogger({ dataDirectory: directory, component: 'runtime' });
  const phases = ['prepare', 'send', 'headers', 'read', 'parse', 'validate'];
  for (const requestPhase of phases) logger.error('provider.request_failed', { requestPhase });
  logger.error('provider.request_failed', { requestPhase: 'private-request-context' });
  const text = await readFile(join(directory, 'logs/runtime.log'), 'utf8');
  const records = text.trim().split('\n').map((line): Record<string, unknown> => JSON.parse(line));
  expect(records.map(record => record.requestPhase)).toEqual([...phases, undefined]);
  expect(text).not.toContain('private-request-context');
});
