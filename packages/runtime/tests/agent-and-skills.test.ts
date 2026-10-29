import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { createRuntime, SimulatedProcessExit } from '../src/index.js';
import { workflowNodeSchema, type ModelProfile, type RunRecord, type SkillPackage, type WorkspaceSnapshot } from '@video-quickly/contracts';

const directories: string[] = [];
const runtimes: ReturnType<typeof createRuntime>[] = [];
const servers: Server[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 'video-quickly-agent-')); directories.push(path); return path; }
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Skill resources and tools', () => {
  it('imports a ZIP with resources, keeps scripts disabled until selected, and versions edits', async () => {
    const dataDirectory = await directory();
    const source = join(dataDirectory, 'fixture.zip');
    const bytes = zipSync({
      'fixture/SKILL.md': strToU8('---\nname: video-fixture\ndescription: 可重复的测试 Skill\n---\n读取 references/guide.md。'),
      'fixture/references/guide.md': strToU8('测试资源'),
      'fixture/scripts/check.mjs': strToU8('process.stdout.write("ready")'),
    });
    await writeFile(source, bytes);
    const runtime = createRuntime({ dataDirectory }); runtimes.push(runtime);
    const skill = await runtime.dispatch('skill.import', { path: source }) as SkillPackage;
    expect(skill.resources).toContain('references/guide.md');
    expect(skill.tools[0].enabled).toBe(false);
    const enabled = await runtime.dispatch('skill.tool.toggle', { skillId: skill.id, toolId: 'scripts/check.mjs', enabled: true }) as SkillPackage;
    expect(enabled.tools[0].enabled).toBe(true);
    const edited = await runtime.dispatch('skill.update', { skillId: skill.id, instructions: '调整后的制作说明。' }) as SkillPackage;
    expect(edited.version).not.toBe(skill.version);
    expect(await readFile(join(dataDirectory, 'skills', skill.id, 'references/guide.md'), 'utf8')).toBe('测试资源');
  });

  it('rejects ZIP paths outside the Skill directory', async () => {
    const dataDirectory = await directory();
    const source = join(dataDirectory, 'fixture.zip');
    await writeFile(source, zipSync({ '../escape/SKILL.md': strToU8('---\nname: unsafe\ndescription: fixture\n---\n') }));
    const runtime = createRuntime({ dataDirectory }); runtimes.push(runtime);
    await expect(runtime.dispatch('skill.import', { path: source })).rejects.toThrow('不安全路径');
  });
});

describe('Deep Agents integration', () => {
  it('uses native persistence, invokes the project tool, and journals each model response', async () => {
    let calls = 0;
    let sawToolResult = false;
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk.toString();
      const payload = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> };
      calls++;
      sawToolResult ||= payload.messages.some(message => message.role === 'tool');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ id: `response-${calls}`, object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: calls === 1 ? 'tool_calls' : 'stop', message: calls === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-project', type: 'function', function: { name: 'read_project_snapshot', arguments: '{}' } }] } : { role: 'assistant', content: '已根据固定项目快照完成草案，事实主张仍待核验。' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。');
    const runtime = createRuntime({ dataDirectory: await directory() }); runtimes.push(runtime);
    const initial = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const model = await runtime.dispatch('model.save', { model: { name: 'Agent fixture', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', capabilities: ['text', 'tools'] } }) as ModelProfile;
    const agent = workflowNodeSchema.parse({ id: 'agent', kind: 'agent', label: 'Agent', modelId: model.id });
    await runtime.dispatch('workflow.save', { projectId: initial.projects[0].id, workflow: { id: 'agent', version: 1, name: 'Agent fixture', nodes: [agent], edges: [] } });
    const run = await runtime.dispatch('run.start', { projectId: initial.projects[0].id }) as RunRecord;
    await runtime.waitForIdle();
    const snapshot = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const completed = snapshot.runs.find(value => value.id === run.id)!;
    expect(completed.error).toBeUndefined();
    expect(completed.status).toBe('succeeded');
    expect(calls).toBe(2);
    expect(sawToolResult).toBe(true);
    expect(completed.activities.filter(activity => activity.id.startsWith('agent:model:'))).toHaveLength(2);
    const costs = await runtime.dispatch('cost.list', { runId: run.id }) as { items: Array<{ operationId: string; providerUsage?: { inputTokens?: number; outputTokens?: number }; actualAmount?: number }> };
    expect(costs.items).toHaveLength(2);
    expect(costs.items.every(record => record.operationId.startsWith(`${run.id}:agent:model:`))).toBe(true);
    expect(costs.items.every(record => record.providerUsage?.inputTokens === 1 && record.providerUsage.outputTokens === 1 && record.actualAmount === undefined)).toBe(true);
    const replay = await runtime.dispatch('run.replay', { runId: run.id }) as { externalCalls: number };
    expect(replay.externalCalls).toBe(0);
    expect(calls).toBe(2);
  }, 30_000);

  it('connects an enabled stdio MCP server and persists a real tool response', async () => {
    const dataDirectory = await directory();
    const fixture = join(dataDirectory, 'mcp-fixture.mjs');
    await writeFile(fixture, `import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } };
  else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Return a fixture value', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] };
  else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'mcp:' + message.params.arguments.value }] };
  else result = {};
  send({ jsonrpc: '2.0', id: message.id, result });
});`);
    const runtime = createRuntime({ dataDirectory }); runtimes.push(runtime);
    const registered = await runtime.dispatch('tool.register', { server: { name: 'fixture', transport: 'stdio', command: process.execPath, args: [fixture], enabled: true } }) as { id: string };
    const inspected = await runtime.dispatch('tool.inspect', { serverId: registered.id }) as { tools: Array<{ name: string }> };
    expect(inspected.tools[0].name).toBe('echo');
    let calls = 0; let sawMcp = false;
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk.toString();
      const payload = JSON.parse(body) as { tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: string }> };
      const mcpTool = payload.tools.find(item => item.function.name.startsWith('mcp_'))!;
      calls++;
      sawMcp ||= payload.messages.some(message => message.role === 'tool' && message.content?.includes('mcp:hello'));
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ id: `mcp-response-${calls}`, object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: calls === 1 ? 'tool_calls' : 'stop', message: calls === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-mcp', type: 'function', function: { name: mcpTool.function.name, arguments: '{"input":{"value":"hello"}}' } }] } : { role: 'assistant', content: 'MCP 已执行。' } }] }));
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。');
    const initial = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const model = await runtime.dispatch('model.save', { model: { name: 'fixture', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', capabilities: ['text', 'tools'] } }) as ModelProfile;
    const agent = workflowNodeSchema.parse({ id: 'agent', kind: 'agent', label: 'Agent', modelId: model.id, config: { mcpServerIds: [registered.id] } });
    await runtime.dispatch('workflow.save', { projectId: initial.projects[0].id, workflow: { id: 'mcp', version: 1, name: 'MCP fixture', nodes: [agent], edges: [] } });
    const run = await runtime.dispatch('run.start', { projectId: initial.projects[0].id }) as RunRecord;
    await runtime.waitForIdle();
    const after = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    expect(after.runs[0].error).toBeUndefined();
    expect(after.runs[0].status).toBe('succeeded');
    expect(sawMcp).toBe(true);
    expect(after.runs[0].activities.find(item => item.id === 'agent:tool:call-mcp')?.status).toBe('completed');
    await runtime.dispatch('run.replay', { runId: run.id }); expect(calls).toBe(2);
  }, 30_000);

  it('recovers a committed child model response when the native agent checkpoint lags', async () => {
    let calls = 0;
    const server = createServer(async (request, response) => {
      for await (const _ of request) { /* Consume the real SDK request body. */ }
      calls++;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ id: 'durable-agent-response', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '只生成一次的 Agent 草案。' } }] }));
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。');
    const dataDirectory = await directory(); let crashed = false;
    const first = createRuntime({ dataDirectory, failpoint(point, id) { if (!crashed && point === 'after-commit' && id.startsWith('agent:model:')) { crashed = true; throw new SimulatedProcessExit(); } } });
    const initial = await first.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const model = await first.dispatch('model.save', { model: { name: 'fixture', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', capabilities: ['text', 'tools'] } }) as ModelProfile;
    await first.dispatch('workflow.save', { projectId: initial.projects[0].id, workflow: { id: 'durable-agent', version: 1, name: 'durable Agent', nodes: [workflowNodeSchema.parse({ id: 'agent', kind: 'agent', label: 'Agent', modelId: model.id })], edges: [] } });
    const run = await first.dispatch('run.start', { projectId: initial.projects[0].id }) as RunRecord;
    await first.waitForIdle();
    expect(calls).toBe(1);
    await first.close();
    const second = createRuntime({ dataDirectory }); runtimes.push(second);
    await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle();
    const snapshot = await second.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    expect(snapshot.runs[0].error).toBeUndefined();
    expect(snapshot.runs[0].status).toBe('succeeded');
    expect(calls).toBe(1);
  });
});
