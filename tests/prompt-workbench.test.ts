import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { modelSchema, projectSchema, promptLibraryItemSchema, promptPreviewSchema, promptSessionSchema, runSchema, runSummarySchema, shotSchema, workflowNodeSchema, subflowDefinitionSchema, type ProjectDocument, type PromptDraft } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src/index';
import { importSkillFixture } from './fixtures/import-skill';
import { planningFixtureResponse } from './fixtures/planning-response';

const directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(options: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-prompt-workbench-')); directories.push(directory);
  const prompts: string[] = [];
  const runtime = createRuntime({ dataDirectory: directory, seed: false, provider: async input => {
    prompts.push(input.prompt);
    const text = '实验生成的创意正文';
    return { text: planningFixtureResponse(input.prompt, text), usage: { source: 'provider', inputTokens: 11, outputTokens: 7 } };
  }, ...options }); runtimes.push(runtime);
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '实验文本', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', connectionType: 'text', capabilities: ['text'] } }));
  let project = projectSchema.parse(await runtime.dispatch('project.create', { title: '提示词实验项目', brief: '原始简报' }));
  project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, production: { ...project.workflow.production, textModelId: model.id } } } }));
  const node = project.workflow.nodes.find(node => node.kind === 'brief')!;
  const draft: PromptDraft = { projectId: project.id, projectRevision: project.revision, node: { ...node, prompt: '主题：{{theme}}', promptBindings: { theme: { projectPath: ['title'] } } }, context: { brief: '尚未保存的实验简报' } };
  return { runtime, directory, model, project, prompts, draft, current: async () => (await runtime.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project };
}
async function session(source: Awaited<ReturnType<typeof fixture>>, draft = source.draft) {
  const preview = promptPreviewSchema.parse(await source.runtime.dispatch('prompt.preview', draft));
  const session = promptSessionSchema.parse(await source.runtime.dispatch('promptSession.save', { draft, previewDigest: preview.digest }));
  return { preview, session };
}
it('previews offline, freezes input, deduplicates trial submissions and applies output only on explicit request', async () => {
  const source = await fixture(), { preview, session: saved } = await session(source);
  expect(source.prompts).toHaveLength(0); expect(preview.prompt).toContain('尚未保存的实验简报');
  const input = { sessionId: saved.id, revision: saved.revision, requestId: randomUUID() };
  const started = runSummarySchema.parse(await source.runtime.dispatch('promptTrial.start', input)); await source.runtime.waitForIdle();
  const repeated = runSummarySchema.parse(await source.runtime.dispatch('promptTrial.start', input));
  expect(repeated.id).toBe(started.id); expect(repeated.status, repeated.error).toBe('succeeded'); expect(source.prompts).toEqual([preview.prompt]);
  expect(await source.current()).toEqual(source.project);
  expect((await source.runtime.dispatch('project.get', { projectId: source.project.id }) as { latestRun?: unknown }).latestRun).toBeUndefined();
  const replay = await source.runtime.dispatch('run.replay', { runId: started.id }) as { externalCalls: number; matchesSnapshot: boolean };
  expect(replay).toMatchObject({ externalCalls: 0, matchesSnapshot: true }); expect(source.prompts).toHaveLength(1);
  expect(await source.runtime.dispatch('run.list', { purpose: 'production' })).toMatchObject({ items: [] });
  expect(await source.runtime.dispatch('run.list', { purpose: 'prompt-trial', promptSessionId: saved.id })).toMatchObject({ items: [{ id: started.id, promptSessionRevision: 1 }] });
  await expect(source.runtime.dispatch('run.start', { projectId: source.project.id, parentRunId: started.id })).rejects.toThrow('不能接续');
  const applied = projectSchema.parse(await source.runtime.dispatch('node.apply', { runId: started.id, nodeId: preview.node.id, revision: source.project.revision }));
  expect(applied.brief).toContain('实验生成的创意正文'); expect(applied.shots).toEqual(source.project.shots);
  expect(await source.runtime.dispatch('cost.summary', { runId: started.id })).toMatchObject({ total: 1 });
  expect(await source.runtime.dispatch('cost.tasks', { projectId: source.project.id })).toMatchObject({ items: [{ title: expect.stringContaining('提示词实验') }] });
  await expect(source.runtime.dispatch('promptTrial.start', { ...input, revision: 2 })).rejects.toThrow('标识已用于');
});
it('stores immutable library versions and keeps old sessions and executions after a template update', async () => {
  const source = await fixture();
  const first = promptLibraryItemSchema.parse(await source.runtime.dispatch('promptLibrary.save', { kind: 'template', name: '版本测试', prompt: '旧模板 {{theme}}', bindings: source.draft.node.promptBindings, nodeKinds: ['brief'] }));
  const draft = { ...source.draft, node: { ...source.draft.node, prompt: first.prompt, promptTemplate: { id: first.id, version: first.version } } };
  const { preview, session: saved } = await session(source, draft);
  const favorite = promptLibraryItemSchema.parse(await source.runtime.dispatch('promptLibrary.update', { id: first.id, revision: first.revision, favorite: true }));
  const second = promptLibraryItemSchema.parse(await source.runtime.dispatch('promptLibrary.save', { id: first.id, revision: favorite.revision, kind: 'template', name: first.name, prompt: '新模板', nodeKinds: first.nodeKinds }));
  expect(second.version).toBe(2); expect(second.favorite).toBe(true);
  expect(await source.runtime.dispatch('promptLibrary.get', { id: first.id, version: 1 })).toEqual(first);
  const started = runSchema.parse(await source.runtime.dispatch('promptTrial.start', { sessionId: saved.id, revision: saved.revision, requestId: randomUUID() })); await source.runtime.waitForIdle();
  expect(source.prompts).toEqual([preview.prompt]); expect(source.prompts[0]).toContain('旧模板'); expect(source.prompts[0]).not.toContain('新模板');
  expect(await source.runtime.dispatch('promptSession.get', { id: saved.id })).toEqual(saved);
  expect((await source.runtime.dispatch('run.replay', { runId: started.id }) as { matchesSnapshot: boolean }).matchesSnapshot).toBe(true);
  await expect(source.runtime.dispatch('promptLibrary.save', { id: first.id, revision: 1, kind: 'template', name: first.name, prompt: '冲突', nodeKinds: ['brief'] })).rejects.toThrow('已修改');
});
it('checks preview digests, session revisions, project revisions and request identities before submitting', async () => {
  const source = await fixture(), { preview, session: saved } = await session(source);
  await expect(source.runtime.dispatch('promptSession.save', { draft: { ...source.draft, node: { ...source.draft.node, prompt: 'changed' } }, previewDigest: preview.digest })).rejects.toThrow('重新预览');
  await expect(source.runtime.dispatch('promptSession.save', { id: saved.id, revision: 2, draft: source.draft, previewDigest: preview.digest })).rejects.toThrow('已修改');
  const next = promptSessionSchema.parse(await source.runtime.dispatch('promptSession.save', { id: saved.id, revision: 1, draft: source.draft, previewDigest: preview.digest }));
  await expect(source.runtime.dispatch('promptTrial.start', { sessionId: saved.id, revision: 1, requestId: randomUUID() })).rejects.toThrow('已修改');
  await source.runtime.dispatch('project.update', { projectId: source.project.id, revision: source.project.revision, patch: { title: '修订已更改' } });
  await expect(source.runtime.dispatch('promptTrial.start', { sessionId: next.id, revision: next.revision, requestId: randomUUID() })).rejects.toThrow();
  expect(source.prompts).toHaveLength(0);
});
it('uses only saved ancestor output as input and resolves upstream variables without running other steps', async () => {
  const source = await fixture();
  const production = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: source.project.id, nodeId: source.draft.node.id })); await source.runtime.waitForIdle();
  const finished = runSchema.parse(await source.runtime.dispatch('run.get', { runId: production.id })); expect(finished.status, finished.error).toBe('succeeded');
  const style = source.project.workflow.nodes.find(node => node.kind === 'style')!;
  const draft: PromptDraft = { ...source.draft, node: { ...style, prompt: '上游：{{prior}}', promptBindings: { prior: { nodeId: source.draft.node.id, path: ['text'] } } }, upstreamRunId: production.id };
  const { preview, session: saved } = await session(source, draft);
  expect(preview.upstream.map(node => node.nodeId)).toEqual([source.draft.node.id]); expect(preview.prompt).toContain('上游：主题\n实验生成的创意正文');
  await source.runtime.dispatch('promptTrial.start', { sessionId: saved.id, revision: saved.revision, requestId: randomUUID() }); await source.runtime.waitForIdle();
  expect(source.prompts).toHaveLength(2); expect(source.prompts[1]).toBe(preview.prompt); expect(await source.current()).toEqual(source.project);
});
it('recovers a committed trial after a process interruption without another model call', async () => {
  let exited = false;
  const source = await fixture({ failpoint(point) { if (!exited && point === 'after-commit') { exited = true; throw new SimulatedProcessExit(); } } });
  const { session: saved } = await session(source);
  const record = runSchema.parse(await source.runtime.dispatch('promptTrial.start', { sessionId: saved.id, revision: 1, requestId: randomUUID() })); await source.runtime.waitForIdle();
  await source.runtime.close(); runtimes.splice(runtimes.indexOf(source.runtime), 1);
  const recovered = createRuntime({ dataDirectory: source.directory, seed: false, provider: async input => { source.prompts.push(input.prompt); return '不应再提交'; } }); runtimes.push(recovered);
  await recovered.dispatch('run.resume', { runId: record.id }); await recovered.waitForIdle();
  expect(runSchema.parse(await recovered.dispatch('run.get', { runId: record.id })).status).toBe('succeeded'); expect(source.prompts).toHaveLength(1);
  expect(await recovered.dispatch('promptSession.get', { id: saved.id })).toEqual(saved);
});
it('retains prompt bindings in a version 6 project backup and refuses misleading old formats', async () => {
  const source = await fixture();
  const project = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: source.project.id, revision: source.project.revision, patch: { workflow: { ...source.project.workflow, nodes: source.project.workflow.nodes.map(node => node.id === source.draft.node.id ? source.draft.node : node) } } }));
  const backup = await source.runtime.dispatch('project.backup', { projectId: project.id }) as { path: string };
  const manifest = JSON.parse(await readFile(join(backup.path, 'project.json'), 'utf8')); expect(manifest.schemaVersion).toBe(6);
  const imported = projectSchema.parse(await source.runtime.dispatch('project.importBackup', { path: backup.path }));
  expect(imported.workflow.nodes.find(node => node.kind === 'brief')?.promptBindings).toEqual(source.draft.node.promptBindings);
  await writeFile(join(backup.path, 'project.json'), JSON.stringify({ ...manifest, schemaVersion: 5 }));
  await expect(source.runtime.dispatch('project.importBackup', { path: backup.path })).rejects.toThrow('格式 6');
});

it('freezes the selected model and Skill version and prevents applying a trial over a newer project', async () => {
  const calls: { prompt: string; model: string }[] = [];
  const source = await fixture({ provider: async input => { calls.push({ prompt: input.prompt, model: input.model.name }); return planningFixtureResponse(input.prompt, '旧快照的生成结果'); } });
  const skillDirectory = join(source.directory, 'story-skill'); await mkdir(skillDirectory); await writeFile(join(skillDirectory, 'SKILL.md'), '---\nname: story-method\ndescription: 实验夹具\n---\n沿用旧版叙事方法');
  const skill = (await importSkillFixture(source.runtime.dispatch, { path: skillDirectory })).skills[0];
  const { preview, session: saved } = await session(source, { ...source.draft, node: { ...source.draft.node, skillIds: [skill.id] } });
  await source.runtime.dispatch('skill.update', { skillId: skill.id, instructions: '新版方法不能改写旧快照' });
  await source.runtime.dispatch('model.save', { model: { ...source.model, name: '新版连接' } });
  const run = runSchema.parse(await source.runtime.dispatch('promptTrial.start', { sessionId: saved.id, revision: 1, requestId: randomUUID() })); await source.runtime.waitForIdle();
  expect(calls).toEqual([{ prompt: preview.prompt, model: source.model.name }]); expect(preview.skills[0].version).toBe(skill.version); expect(preview.prompt).toContain('沿用旧版叙事方法');
  const current = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: source.project.id, revision: source.project.revision, patch: { brief: '人工更新的简报' } }));
  await expect(source.runtime.dispatch('node.apply', { runId: run.id, nodeId: saved.preview.node.id, revision: current.revision })).rejects.toThrow('项目已在生成后修改');
  expect((await source.current()).brief).toBe('人工更新的简报');
});

it('recovers a trial from its saved model response before committing the result', async () => {
  let exited = false;
  const source = await fixture({ failpoint(point) { if (!exited && point === 'after-result') { exited = true; throw new SimulatedProcessExit(); } } });
  const { session: saved } = await session(source);
  const run = runSchema.parse(await source.runtime.dispatch('promptTrial.start', { sessionId: saved.id, revision: 1, requestId: randomUUID() })); await source.runtime.waitForIdle();
  expect(source.prompts).toHaveLength(1);
  await source.runtime.dispatch('run.resume', { runId: run.id }); await source.runtime.waitForIdle();
  const recovered = runSchema.parse(await source.runtime.dispatch('run.get', { runId: run.id }));
  expect(recovered.status).toBe('succeeded'); expect(source.prompts).toHaveLength(1); expect(await source.current()).toEqual(source.project);
});
it('does not resubmit a paid trial when its response was never saved', async () => {
  const calls: string[] = [];
  const source = await fixture({ provider: async ({ prompt }) => { calls.push(prompt); throw new SimulatedProcessExit(); } });
  const { session: saved } = await session(source);
  const run = runSchema.parse(await source.runtime.dispatch('promptTrial.start', { sessionId: saved.id, revision: 1, requestId: randomUUID() })); await source.runtime.waitForIdle();
  await source.runtime.dispatch('run.resume', { runId: run.id }); await source.runtime.waitForIdle();
  expect(await source.runtime.dispatch('run.inspect', { runId: run.id })).toMatchObject({
    steps: [{ status: 'failed', unknownSubmission: true, retry: { allowed: false } }],
  });
  expect(calls).toHaveLength(1); expect(await source.current()).toEqual(source.project);
});
it('requires an unlocked single shot for media and rejects local or tool-enabled tasks', async () => {
  const source = await fixture();
  for (const kind of ['assets', 'animation', 'export', 'agent'] as const) {
    const node = source.project.workflow.nodes.find(node => node.kind === kind);
    if (node) await expect(source.runtime.dispatch('prompt.preview', { ...source.draft, node })).rejects.toThrow();
  }
  const shot = shotSchema.parse({ id: 'locked', title: '锁定镜头', narration: '', visualPrompt: '', durationUs: 1000000, locked: true });
  const project = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: source.project.id, revision: source.project.revision, patch: { shots: [shot] } }));
  await expect(source.runtime.dispatch('prompt.preview', { ...source.draft, projectRevision: project.revision, shotId: shot.id })).rejects.toThrow('解锁');
});

it('resolves upstream prompt bindings inside production subflows using their actual nested identities', async () => {
  const source = await fixture();
  const first = workflowNodeSchema.parse({ id: 'first', kind: 'brief', label: '子流程简报', modelId: source.model.id });
  const second = workflowNodeSchema.parse({ id: 'second', kind: 'style', label: '子流程风格', modelId: source.model.id, prompt: '子流程上游 {{prior}}', promptBindings: { prior: { nodeId: 'first', path: ['text'] } } });
  const definition = subflowDefinitionSchema.parse({ id: 'nested-prompts', version: 1, name: '嵌套提示词', nodes: [first, second], edges: [{ id: 'next', source: first.id, target: second.id }], inputs: [], outputs: [{ name: 'style', nodeId: second.id, path: ['text'], type: 'string' }] });
  const call = workflowNodeSchema.parse({ id: 'call', kind: 'subflow', label: '执行子流程', subflow: { id: definition.id, version: 1, inputs: {} } });
  const project = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: source.project.id, revision: source.project.revision, patch: { workflow: { id: 'prompt-composition', version: 1, name: '提示词组合', nodes: [call], edges: [], production: source.project.workflow.production, subflows: [definition] } } }));
  const run = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: project.id })); await source.runtime.waitForIdle();
  const finished = runSchema.parse(await source.runtime.dispatch('run.get', { runId: run.id })); expect(finished.status, finished.error).toBe('succeeded');
  expect(source.prompts).toHaveLength(2); expect(source.prompts[1]).toContain('子流程上游 实验生成的创意正文');
});

it('uses a selected shot as brief context while preserving the text output contract', async () => {
  const source = await fixture();
  const shot = shotSchema.parse({ id: 'context-shot', title: '上下文镜头', narration: '花园里的木盒', visualPrompt: '木盒特写', durationUs: 1000000 });
  const project = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: source.project.id, revision: source.project.revision, patch: { shots: [shot] } }));
  const { preview, session: saved } = await session(source, { ...source.draft, projectRevision: project.revision, shotId: shot.id, node: { ...source.draft.node, prompt: '{{voice}}', promptBindings: { voice: { shotPath: ['narration'] } } } });
  expect(preview.node.id).toBe(source.draft.node.id); expect(preview.prompt).toContain(shot.narration);
  const run = runSchema.parse(await source.runtime.dispatch('promptTrial.start', { sessionId: saved.id, revision: 1, requestId: randomUUID() })); await source.runtime.waitForIdle();
  const finished = runSchema.parse(await source.runtime.dispatch('run.get', { runId: run.id })); expect(finished.status, finished.error).toBe('succeeded');
  expect(await source.current()).toEqual(project); expect(await source.runtime.dispatch('node.result', { runId: run.id, nodeId: preview.node.id })).toMatchObject({ fields: { topic: '实验生成的创意正文' } });
});
