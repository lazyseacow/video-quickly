import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { modelSchema, projectSchema, runSchema, workflowNodeSchema } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit } from '../src/index.js';

const directories: string[] = [], servers: Server[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('resumes the Agent conversation after a durable tool result without reintroducing its initial user message', async () => {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk.toString();
    requests.push(JSON.parse(raw));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `message-${requests.length}`, object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0,
      finish_reason: requests.length === 1 ? 'tool_calls' : 'stop', message: requests.length === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'read-project', type: 'function', function: { name: 'read_project_snapshot', arguments: '{}' } }] }
        : { role: 'assistant', content: '已根据当前项目完成。' } }] }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。');
  const directory = await mkdtemp(join(tmpdir(), 'vq-agent-checkpoint-')); directories.push(directory);
  let crashed = false;
  const first = createRuntime({ dataDirectory: directory, seed: false, failpoint(point, id) {
    if (!crashed && point === 'before-dispatch' && id.startsWith('agent:model:') && requests.length === 1) { crashed = true; throw new SimulatedProcessExit(); }
  } });
  const project = projectSchema.parse(await first.dispatch('project.create', { title: 'Agent 持久会话恢复' }));
  const model = modelSchema.parse(await first.dispatch('model.save', { model: { name: 'fixture', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', connectionType: 'text', capabilities: ['text', 'tools'] } }));
  await first.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, nodes: [workflowNodeSchema.parse({ id: 'agent', kind: 'agent', label: 'Agent', modelId: model.id, prompt: '读取项目再交付结果。' })], edges: [] } } });
  const run = runSchema.parse(await first.dispatch('run.start', { projectId: project.id })); await first.waitForIdle();
  expect(crashed).toBe(true); expect(requests).toHaveLength(1);
  await first.close();
  const second = createRuntime({ dataDirectory: directory, seed: false }); runtimes.push(second);
  await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle();
  const completed = runSchema.parse(await second.dispatch('run.get', { runId: run.id }));
  expect(completed.status, completed.error).toBe('succeeded'); expect(requests).toHaveLength(2);
  expect(requests[1].messages.filter(message => message.role === 'user')).toHaveLength(1);
  expect(requests[1].messages.filter(message => message.role === 'tool')).toHaveLength(1);
});
