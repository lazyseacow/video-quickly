import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { modelSchema, projectSchema, promptPreviewSchema, promptSessionSchema, runSchema, skillImportJobSchema, workflowNodeSchema, type WorkspaceSnapshot } from '@video-quickly/contracts';
import { createRuntime, type RuntimeOptions } from '../src/index.js';
import { importSkillFixture } from '../../../../tests/fixtures/import-skill';

const directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
async function fixture(options: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-skill-library-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, ...options }); runtimes.push(runtime);
  return { directory, runtime };
}
const archive = () => zipSync({
  'repo-main/skills/write/SKILL.md': strToU8('---\nname: drama-write\ndescription: 写作方法\n---\n使用 references/guide.md 的方法。'),
  'repo-main/skills/write/references/guide.md': strToU8('旧版引用：每个场景有明确的戏剧目标。'),
  'repo-main/skills/style/SKILL.md': strToU8('---\nname: drama-style\ndescription: 风格方法\n---\n保持固定色彩。'),
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('owns background imports after subscribers leave and deduplicates repeated requests', async () => {
  const { runtime } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (String(input).startsWith('https://api.github.com/')) return Response.json({ default_branch: 'main' });
    await gate; return new Response(archive());
  });
  const stop = runtime.subscribe(() => {}), requestId = randomUUID();
  const source = { url: 'https://github.com/fixture/drama.git' };
  const job = skillImportJobSchema.parse(await runtime.dispatch('skill.import.start', { source, groupName: '短剧方法', requestId }));
  stop();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(await runtime.dispatch('skill.import.start', { source, groupName: '短剧方法', requestId: randomUUID() })).toMatchObject({ id: job.id });
  expect(await runtime.dispatch('skill.import.get', { id: job.id })).toMatchObject({ status: 'running' });
  release(); await runtime.waitForIdle();
  const snapshot = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(snapshot.skills.map(skill => skill.name)).toEqual(['drama-style', 'drama-write']);
  expect(snapshot.skillGroups).toHaveLength(1); expect(snapshot.skillGroups![0].name).toBe('短剧方法');
  expect(await runtime.dispatch('skill.import.get', { id: job.id })).toMatchObject({ status: 'succeeded', completed: 2, total: 2 });
  expect(fetch).toHaveBeenCalledTimes(2);
  await expect(runtime.dispatch('skill.import.start', { source: { path: 'other' }, requestId })).rejects.toThrow('标识');
});

it('publishes a group atomically, retries failures, and retains groups and records across restart', async () => {
  const { runtime, directory } = await fixture(), path = join(directory, 'drama.zip');
  await writeFile(path, zipSync({
    'repo/one/SKILL.md': strToU8('---\nname: first-method\ndescription: 有效方法\n---\n有效指令。'),
    'repo/two/SKILL.md': strToU8('invalid metadata'),
  }));
  const job = skillImportJobSchema.parse(await runtime.dispatch('skill.import.start', { source: { path }, requestId: randomUUID() }));
  await runtime.waitForIdle();
  expect(await runtime.dispatch('skill.import.get', { id: job.id })).toMatchObject({ status: 'failed' });
  const failed = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(failed.skills).toHaveLength(0); expect(failed.skillGroups).toHaveLength(0);
  await writeFile(path, archive());
  await runtime.dispatch('skill.import.retry', { id: job.id }); await runtime.waitForIdle();
  const imported = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(imported.skills).toHaveLength(2); expect(imported.skillGroups).toHaveLength(1);
  await runtime.dispatch('skill.group.update', { id: imported.skillGroups![0].id, name: '统一创作方法' });
  await runtime.close(); runtimes.splice(runtimes.indexOf(runtime), 1);
  const reopened = createRuntime({ dataDirectory: directory }); runtimes.push(reopened);
  const restored = await reopened.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(restored.skillGroups![0].name).toBe('统一创作方法');
  expect(restored.skillImports![0]).toMatchObject({ id: job.id, status: 'succeeded', completed: 2 });
  await importSkillFixture(reopened.dispatch, { path });
  const repeated = await reopened.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(repeated.skills).toHaveLength(2); expect(repeated.skillGroups).toHaveLength(1); expect(repeated.skillGroups![0].name).toBe('统一创作方法');
});

it('records an interrupted background import on shutdown and allows retrying it after restart', async () => {
  const { runtime, directory } = await fixture();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
  }));
  const job = skillImportJobSchema.parse(await runtime.dispatch('skill.import.start', { source: { url: 'https://github.com/fixture/drama.git' }, requestId: randomUUID() }));
  await runtime.close(); runtimes.splice(runtimes.indexOf(runtime), 1);
  vi.mocked(globalThis.fetch).mockImplementation(async input => String(input).startsWith('https://api.github.com/') ? Response.json({ default_branch: 'main' }) : new Response(archive()));
  const reopened = createRuntime({ dataDirectory: directory }); runtimes.push(reopened);
  expect(await reopened.dispatch('skill.import.get', { id: job.id })).toMatchObject({ status: 'interrupted' });
  await reopened.dispatch('skill.import.retry', { id: job.id }); await reopened.waitForIdle();
  expect(await reopened.dispatch('skill.import.get', { id: job.id })).toMatchObject({ status: 'succeeded', completed: 2 });
});

it('applies creation selections to text tasks and the editing Agent and freezes trial context', async () => {
  const prompts: string[] = [];
  const { runtime, directory } = await fixture({ provider: async input => { prompts.push(input.prompt); return '完成的创作简报'; } });
  const source = join(directory, 'method'); await mkdir(join(source, 'references'), { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '---\nname: writing-method\ndescription: 写作规则\n---\n使用 references/guide.md 的叙事方法。');
  await writeFile(join(source, 'references/guide.md'), '旧版引用：场景必须有戏剧目标。');
  const skill = (await importSkillFixture(runtime.dispatch, { path: source })).skills[0];
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '使用 Skill 的新任务', skillIds: [skill.id] }));
  expect(project.workflow.production).toMatchObject({ agentSkillIds: [skill.id], agentMcpServerIds: [] });
  expect(project.workflow.nodes.filter(node => ['brief', 'style', 'script'].includes(node.kind)).every(node => node.skillIds.includes(skill.id))).toBe(true);
  expect(project.workflow.nodes.filter(node => ['assets', 'animation', 'export'].includes(node.kind)).every(node => !node.skillIds.length)).toBe(true);
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: 'fixture', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', connectionType: 'text', capabilities: ['text'] } }));
  const node = workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label: '简报', skillIds: [skill.id], modelId: model.id });
  const saved = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, nodes: [node], edges: [] } } }));
  const draft = { projectId: project.id, projectRevision: saved.revision, node };
  const preview = promptPreviewSchema.parse(await runtime.dispatch('prompt.preview', draft));
  expect(preview.prompt).toContain('使用 references/guide.md 的叙事方法'); expect(preview.prompt).toContain('旧版引用：场景必须有戏剧目标');
  const session = promptSessionSchema.parse(await runtime.dispatch('promptSession.save', { draft, previewDigest: preview.digest }));
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await runtime.waitForIdle();
  expect(runSchema.parse(await runtime.dispatch('run.get', { runId: run.id })).status).toBe('succeeded');
  expect(prompts[0]).toContain('旧版引用：场景必须有戏剧目标');
  await writeFile(join(directory, 'skills', skill.id, 'references/guide.md'), '更新的引用不影响实验快照');
  await runtime.dispatch('skill.update', { skillId: skill.id, instructions: '更新的指令不影响实验快照' });
  await runtime.dispatch('promptTrial.start', { sessionId: session.id, revision: session.revision, requestId: randomUUID() }); await runtime.waitForIdle();
  expect(prompts[1]).toBe(preview.prompt); expect(prompts[1]).not.toContain('更新的');
  await expect(runtime.dispatch('skill.resource.read', { skillId: skill.id, path: '../SKILL.md' })).rejects.toThrow('资源不存在');
  expect(await runtime.dispatch('skill.resource.read', { skillId: skill.id, path: 'references/guide.md' })).toMatchObject({ content: '更新的引用不影响实验快照' });
  await runtime.dispatch('skill.toggle', { skillId: skill.id, enabled: false });
  await expect(runtime.dispatch('project.create', { title: '停用校验', skillIds: [skill.id] })).rejects.toThrow('已停用');
  await runtime.dispatch('skill.uninstall', { skillId: skill.id });
  const removed = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(removed.skills).toHaveLength(0); expect(removed.skillGroups).toHaveLength(0);
  expect(await readFile(join(directory, 'skills', skill.id, 'references/guide.md'), 'utf8')).toBe('更新的引用不影响实验快照');
  await runtime.dispatch('promptTrial.start', { sessionId: session.id, revision: session.revision, requestId: randomUUID() }); await runtime.waitForIdle();
  expect(prompts[2]).toBe(preview.prompt);
  await expect(runtime.dispatch('project.create', { title: '卸载校验', skillIds: [skill.id] })).rejects.toThrow('不存在');
});

it('persists individual and group enable states without changing Skill versions or tool permissions', async () => {
  const { runtime, directory } = await fixture(), path = join(directory, 'methods.zip');
  await writeFile(path, archive());
  const result = await importSkillFixture(runtime.dispatch, { path });
  await runtime.dispatch('skill.group.toggle', { id: result.group.id, enabled: false });
  expect((await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot).skills.every(skill => !skill.enabled)).toBe(true);
  const selected = result.skills[0];
  expect(await runtime.dispatch('skill.toggle', { skillId: selected.id, enabled: true })).toMatchObject({ enabled: true, version: selected.version, tools: selected.tools });
  expect((await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot).skills.filter(skill => skill.enabled)).toHaveLength(1);
  await runtime.dispatch('skill.group.toggle', { id: result.group.id, enabled: true });
  await runtime.close(); runtimes.splice(runtimes.indexOf(runtime), 1);
  const reopened = createRuntime({ dataDirectory: directory }); runtimes.push(reopened);
  expect((await reopened.dispatch('workspace.snapshot') as WorkspaceSnapshot).skills).toEqual(result.skills);
});

it('uninstalls groups without removing shared Skills and cleans up membership for individual removals', async () => {
  const { runtime, directory } = await fixture(), first = join(directory, 'first.zip'), second = join(directory, 'second.zip');
  await writeFile(first, archive());
  await writeFile(second, zipSync({ 'style/SKILL.md': strToU8('---\nname: drama-style\ndescription: 风格方法\n---\n保持固定色彩。') }));
  const batch = await importSkillFixture(runtime.dispatch, { path: first });
  const shared = (await importSkillFixture(runtime.dispatch, { path: second })).skills[0];
  const exclusive = batch.skills.find(skill => skill.id !== shared.id)!;
  const removed = await runtime.dispatch('skill.group.uninstall', { id: batch.group.id });
  expect(removed).toEqual({ skillIds: [exclusive.id], groupIds: [batch.group.id], retainedSkillIds: [shared.id] });
  let snapshot = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(snapshot.skills).toEqual([shared]); expect(snapshot.skillGroups).toHaveLength(1);
  expect(snapshot.skillGroups![0].skillIds).toEqual([shared.id]);
  await runtime.dispatch('skill.uninstall', { skillId: shared.id });
  snapshot = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(snapshot.skills).toHaveLength(0); expect(snapshot.skillGroups).toHaveLength(0);
  expect(await runtime.dispatch('skill.uninstall', { skillId: shared.id })).toEqual({ skillIds: [], groupIds: [], retainedSkillIds: [] });
  await importSkillFixture(runtime.dispatch, { path: first });
  snapshot = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(snapshot.skills).toHaveLength(2); expect(snapshot.skillGroups).toHaveLength(1);
});

it('prevents an in-flight reimport from restoring a group during uninstall', async () => {
  const { runtime } = await fixture();
  const source = { url: 'https://github.com/fixture/drama.git' };
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input).startsWith('https://api.github.com/') ? Response.json({ default_branch: 'main' }) : new Response(archive()));
  const result = await importSkillFixture(runtime.dispatch, source);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fetch.mockImplementation(async input => { if (String(input).startsWith('https://api.github.com/')) return Response.json({ default_branch: 'main' }); await gate; return new Response(archive()); });
  await runtime.dispatch('skill.import.start', { source, requestId: randomUUID() });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  try {
    await expect(runtime.dispatch('skill.group.uninstall', { id: result.group.id })).rejects.toThrow('正在导入');
    await expect(runtime.dispatch('skill.uninstall', { skillId: result.skills[0].id })).rejects.toThrow('正在导入');
  } finally { release(); }
  await runtime.waitForIdle();
  expect((await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot).skills).toHaveLength(2);
});

it('allows an already-running task to finish from its snapshot after uninstall', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider = vi.fn(async () => { await gate; return '按原快照完成的简报'; });
  const { runtime, directory } = await fixture({ provider });
  const source = join(directory, 'method'); await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), '---\nname: active-method\ndescription: 运行中快照方法\n---\n沿用原来的创作规则。');
  const skill = (await importSkillFixture(runtime.dispatch, { path: source })).skills[0];
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: 'fixture', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', connectionType: 'text', capabilities: ['text'] } }));
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '运行中卸载验收' }));
  const node = workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label: '简报', modelId: model.id, skillIds: [skill.id] });
  await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, nodes: [node], edges: [] } } });
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id }));
  try {
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
    await runtime.dispatch('skill.uninstall', { skillId: skill.id });
  } finally { release(); }
  await runtime.waitForIdle();
  expect(runSchema.parse(await runtime.dispatch('run.get', { runId: run.id })).status).toBe('succeeded');
  expect(await runtime.dispatch('node.result', { runId: run.id, nodeId: 'brief' })).toMatchObject({ text: '按原快照完成的简报' });
  const snapshot = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(snapshot.skills).toHaveLength(0);
  expect(snapshot.projects.find(item => item.id === project.id)?.workflow.nodes[0].skillIds).toEqual([skill.id]);
});
