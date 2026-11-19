import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { createRuntime, SimulatedProcessExit } from '../src/index.js';
import { workflowNodeSchema, type ModelProfile, type ProjectDocument, type RunRecord, type SkillPackage, type WorkspaceSnapshot } from '@video-quickly/contracts';
import { importSkillFixture } from '../../../../tests/fixtures/import-skill';

const directories: string[] = [];
const runtimes: ReturnType<typeof createRuntime>[] = [];
const servers: Server[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 'video-quickly-agent-')); directories.push(path); return path; }
async function createEpisode(runtime: ReturnType<typeof createRuntime>) {
  const { project } = await runtime.dispatch('dramaStudio.create', { mode: 'upload', originalText: '一名值班员在桌前整理信件。',
    work: { title: 'Agent 测试作品', visualStyle: 'live-action', narrativeMode: 'mixed' } }) as { project: ProjectDocument };
  return project;
}
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
    const skill = (await importSkillFixture(runtime.dispatch, { path: source })).skills[0];
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
    await expect(importSkillFixture(runtime.dispatch, { path: source })).rejects.toThrow('不安全路径');
  });
});

describe('Deep Agents integration', () => {
  it('discovers a Skill, reads its resources, and executes its enabled script once across replay', async () => {
    const dataDirectory = await directory(), source = join(dataDirectory, 'capabilities.zip');
    await writeFile(source, zipSync({
      'fixture/SKILL.md': strToU8('---\nname: video-script-fixture\ndescription: 创建视频创作资料\n---\n先读取 references/guide.md，再调用已启用的脚本。'),
      'fixture/references/guide.md': strToU8('reference-marker: use the selected visual method'),
      'fixture/scripts/prepare.mjs': strToU8("import { appendFileSync } from 'node:fs'; let input=''; for await (const chunk of process.stdin) input += chunk; appendFileSync('invocations.txt','called\\n'); process.stdout.write('script-marker:' + input);"),
    }));
    const runtime = createRuntime({ dataDirectory, seed: false }); runtimes.push(runtime);
    await createEpisode(runtime);
    const skill = (await importSkillFixture(runtime.dispatch, { path: source })).skills[0];
    await runtime.dispatch('skill.tool.toggle', { skillId: skill.id, toolId: 'scripts/prepare.mjs', enabled: true });
    let calls = 0, sawReference = false, sawScript = false;
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk.toString();
      const payload = JSON.parse(body) as { tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: string }> };
      calls++;
      sawReference ||= payload.messages.some(message => message.role === 'tool' && message.content?.includes('reference-marker'));
      sawScript ||= payload.messages.some(message => message.role === 'tool' && message.content?.includes('script-marker:agent-input'));
      const scriptTool = payload.tools.find(item => item.function.name.startsWith('skill_'))?.function.name;
      expect(scriptTool).toBeDefined();
      const invocation = calls === 1 ? { id: 'discover-skill', name: 'list_capabilities', input: {} }
        : calls === 2 ? { id: 'read-reference', name: 'read_skill', input: { skillId: skill.id, resource: 'references/guide.md' } }
        : calls === 3 ? { id: 'execute-script', name: scriptTool!, input: { input: 'agent-input' } } : undefined;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ id: `skill-response-${calls}`, object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: invocation ? 'tool_calls' : 'stop', message: invocation ? { role: 'assistant', content: null, tool_calls: [{ id: invocation.id, type: 'function', function: { name: invocation.name, arguments: JSON.stringify(invocation.input) } }] } : { role: 'assistant', content: '已使用 Skill 和脚本完成任务。' } }] }));
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。');
    const initial = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const model = await runtime.dispatch('model.save', { model: { name: 'fixture', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', connectionType: 'text', capabilities: ['text', 'tools'] } }) as ModelProfile;
    await runtime.dispatch('project.update', { projectId: initial.projects[0].id, patch: { workflow: { id: 'skill', version: 1, name: 'Skill fixture', production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [workflowNodeSchema.parse({ id: 'agent', kind: 'agent', label: 'Agent', modelId: model.id, skillIds: [skill.id] })], edges: [] } } });
    const run = await runtime.dispatch('run.start', { projectId: initial.projects[0].id }) as RunRecord;
    await runtime.waitForIdle();
    const after = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    expect(after.runs[0].status, after.runs[0].error).toBe('succeeded');
    expect(sawReference).toBe(true); expect(sawScript).toBe(true);
    expect(after.runs[0].activities.find(item => item.id === 'agent:tool:execute-script')?.status).toBe('completed');
    await runtime.dispatch('run.replay', { runId: run.id });
    expect(await readFile(join(dataDirectory, 'skills', skill.id, 'invocations.txt'), 'utf8')).toBe('called\n');
    expect(calls).toBe(4);
  });

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
    const runtime = createRuntime({ dataDirectory: await directory(), seed: false }); runtimes.push(runtime);
    await createEpisode(runtime);
    const initial = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const model = await runtime.dispatch('model.save', { model: { name: 'Agent fixture', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', connectionType: 'text', capabilities: ['text', 'tools'] } }) as ModelProfile;
    const agent = workflowNodeSchema.parse({ id: 'agent', kind: 'agent', label: 'Agent', modelId: model.id });
    await runtime.dispatch('project.update', { projectId: initial.projects[0].id, patch: { workflow: { id: 'agent', version: 1, name: 'Agent fixture', production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [agent], edges: [] } } });
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
    const first = createRuntime({ dataDirectory, seed: false, failpoint(point, id) { if (!crashed && point === 'after-commit' && id.startsWith('agent:model:')) { crashed = true; throw new SimulatedProcessExit(); } } });
    await createEpisode(first);
    const initial = await first.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const model = await first.dispatch('model.save', { model: { name: 'fixture', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', connectionType: 'text', capabilities: ['text', 'tools'] } }) as ModelProfile;
    await first.dispatch('project.update', { projectId: initial.projects[0].id, patch: { workflow: { id: 'durable-agent', version: 1, name: 'durable Agent', production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [workflowNodeSchema.parse({ id: 'agent', kind: 'agent', label: 'Agent', modelId: model.id })], edges: [] } } });
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
