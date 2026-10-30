import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  assetSchema, characterProfileSchema, modelSchema, projectDetailSchema, projectSchema, recordPageSchema, runInspectionSchema, runPlanSchema, runSchema, skillSchema, workflowNodeSchema,
  type AssetRecord, type ProjectDocument, type RunPlan, type WorkflowNode, type WorkspaceSummary,
} from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src';

const runtimes: ReturnType<typeof createRuntime>[] = [], directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('vq-run-selection-')) throw new Error('Unexpected cleanup directory');
    await rm(directory, { recursive: true, force: true });
  }
});

const node = (id: string, kind: WorkflowNode['kind'] = 'brief', extra: Partial<WorkflowNode> = {}) => workflowNodeSchema.parse({ id, kind, label: id, ...extra });
async function setup(options: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-run-selection-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ...options }); runtimes.push(runtime);
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '局部重生成验收' }));
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: {
    shots: [{ id: 'locked', title: '已经确认的镜头', narration: '人工旁白', visualPrompt: '', durationUs: 1_000_000, locked: true }, { id: 'editable', title: '可编辑镜头', narration: '另一段人工旁白', visualPrompt: '', durationUs: 1_000_000 }],
    workflow: { id: 'scope', name: '分支与汇合', version: 1,
      nodes: [node('tail'), node('no'), node('outside'), node('root', 'condition', { config: { value: true } }), node('yes'), node('join', 'join'), node('upstream'), node('unrelated')],
      edges: [{ id: 'ur', source: 'upstream', target: 'root' }, { id: 'ry', source: 'root', target: 'yes', condition: 'true' }, { id: 'rn', source: 'root', target: 'no', condition: 'false' }, { id: 'yj', source: 'yes', target: 'join' }, { id: 'nj', source: 'no', target: 'join' }, { id: 'oj', source: 'outside', target: 'join' }, { id: 'jt', source: 'join', target: 'tail' }],
    },
  } }));
  const current = async () => projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id })).project!;
  return { runtime, directory, project, current };
}
async function plan(runtime: ReturnType<typeof createRuntime>, project: ProjectDocument, nodeId = 'root', mode: 'node' | 'downstream' = 'downstream') {
  return runPlanSchema.parse(await runtime.dispatch('run.plan', { projectId: project.id, selection: { nodeId, mode } }));
}
async function start(runtime: ReturnType<typeof createRuntime>, preview: RunPlan, parentRunId?: string) {
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: preview.projectId, selection: { ...preview.selection, previewDigest: preview.digest }, ...(parentRunId ? { parentRunId } : {}) }));
  await runtime.waitForIdle(); return run;
}
async function inspection(runtime: ReturnType<typeof createRuntime>, runId: string) {
  return runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId }));
}

it('previews all possible descendants and boundary inputs without starting tasks, charging or changing workspace state', async () => {
  const provider = vi.fn(async () => 'should not be called');
  const { runtime, project, current } = await setup({ provider });
  const before = await runtime.dispatch('workspace.summary') as WorkspaceSummary;
  const preview = await plan(runtime, project);
  expect(preview.steps.map(step => step.id)).toEqual(['root', 'no', 'yes', 'join', 'tail']);
  expect(preview).toMatchObject({ projectRevision: project.revision, workflowVersion: project.workflow.version, lockedShotCount: 1, shotCount: 2, hasConditions: true, blockedReason: '' });
  expect(preview.boundary).toEqual([{ sourceId: 'upstream', sourceLabel: 'upstream', targetId: 'root', targetLabel: 'root' }, { sourceId: 'outside', sourceLabel: 'outside', targetId: 'join', targetLabel: 'join' }]);
  expect((await plan(runtime, project, 'yes', 'node')).steps.map(step => step.id)).toEqual(['yes']);
  await expect(plan(runtime, project, 'missing')).rejects.toThrow('未找到');
  expect((await runtime.dispatch('run.list', { projectId: project.id }) as { items: unknown[] }).items).toEqual([]);
  expect(await runtime.dispatch('cost.summary', { projectId: project.id })).toMatchObject({ total: 0 });
  expect((await runtime.dispatch('workspace.summary') as WorkspaceSummary).version).toBe(before.version);
  expect(await current()).toEqual(project); expect(provider).not.toHaveBeenCalled();
  const withReview = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, nodes: [...project.workflow.nodes, node('manual', 'review')] } } }));
  expect((await plan(runtime, withReview, 'manual', 'node')).steps[0].requiresReview).toBe(true);
});

it('runs only the confirmed induced graph and lets native conditions skip the inactive branch', async () => {
  const { runtime, project, current } = await setup();
  const preview = await plan(runtime, project), run = await start(runtime, preview);
  const detail = await inspection(runtime, run.id);
  expect(detail.run).toMatchObject({ status: 'succeeded', selection: preview.selection });
  expect(Object.fromEntries(detail.steps.map(step => [step.id, step.status]))).toEqual({ root: 'succeeded', no: 'skipped', yes: 'succeeded', join: 'succeeded', tail: 'succeeded' });
  expect(detail.checkpointAvailable).toBe(true); expect(await current()).toEqual(project);
  expect(runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: run.id, nodeId: 'root' })).selected?.handlerVersion).toBe(2);
  const single = await start(runtime, await plan(runtime, project, 'yes', 'node'));
  expect((await inspection(runtime, single.id)).steps.map(step => step.id)).toEqual(['yes']);
});

it.each(['project', 'workflow', 'model', 'skill', 'asset', 'character'] as const)('rejects an obsolete preview after a relevant %s change without creating a run', async change => {
  const provider = vi.fn(async () => 'must not submit');
  const { runtime, directory, project, current } = await setup({ provider });
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '步骤模型', provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'scope-test', capabilities: ['text'] } }));
  const skillPath = join(directory, 'skill'); await mkdir(skillPath); await writeFile(join(skillPath, 'SKILL.md'), '---\nname: scoped-style\ndescription: A reproducible style fixture\n---\nUse the saved project.');
  const skill = skillSchema.parse(await runtime.dispatch('skill.import', { path: skillPath }));
  const character = characterProfileSchema.parse(await runtime.dispatch('character.save', { character: { name: '已绑定角色', description: '', referenceAssetIds: [] } }));
  const imagePath = join(directory, 'reference.svg'); await writeFile(imagePath, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>');
  const asset = assetSchema.parse(await runtime.dispatch('asset.import', { projectId: project.id, path: imagePath }));
  const value = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map(shot => ({ ...shot, characterIds: [character.id] })), workflow: { ...project.workflow, nodes: project.workflow.nodes.map(node => node.id === 'root' ? { ...node, modelId: model.id, skillIds: [skill.id] } : node) } } }));
  const preview = await plan(runtime, value);
  if (change === 'project') await runtime.dispatch('project.update', { projectId: value.id, revision: value.revision, patch: { title: '重新预览之前的新标题' } });
  if (change === 'workflow') await runtime.dispatch('project.update', { projectId: value.id, revision: value.revision, patch: { workflow: { ...value.workflow, nodes: value.workflow.nodes.map(node => node.id === 'root' ? { ...node, config: { value: false } } : node) } } });
  if (change === 'model') await runtime.dispatch('model.save', { model: { ...model, parameters: { options: { temperature: .3 } } } });
  if (change === 'skill') await runtime.dispatch('skill.toggle', { skillId: skill.id, enabled: !skill.enabled });
  if (change === 'asset') await runtime.dispatch('asset.retain', { assetId: asset.id, retained: true });
  if (change === 'character') await runtime.dispatch('character.save', { character: { ...character, description: '新角色要求' }, revision: character.revision });
  const updated = await current();
  await expect(start(runtime, preview)).rejects.toThrow('重新预览');
  expect((await runtime.dispatch('run.list', { projectId: project.id }) as { items: unknown[] }).items).toEqual([]);
  expect(await current()).toEqual(updated); expect(provider).not.toHaveBeenCalled();
});

it('does not invalidate the chosen scope when an unrelated model is added', async () => {
  const { runtime, project } = await setup(); const preview = await plan(runtime, project);
  await runtime.dispatch('model.save', { model: { name: '未绑定模型', provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'unrelated', capabilities: ['text'] } });
  expect((await plan(runtime, project)).digest).toBe(preview.digest);
  expect((await inspection(runtime, (await start(runtime, preview)).id)).run.status).toBe('succeeded');
});

it('gives explicitly repeated generation new run and activity identifiers while preserving current manual content', async () => {
  const provider = vi.fn<NonNullable<RuntimeOptions['provider']>>(async () => '新的风格候选');
  const { runtime, project, current } = await setup({ provider });
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '风格模型', provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'style', capabilities: ['text'] } }));
  const value = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, nodes: [...project.workflow.nodes, node('style', 'style', { modelId: model.id })] } } }));
  const preview = await plan(runtime, value, 'style', 'node'); const first = await start(runtime, preview), second = await start(runtime, preview);
  expect(first.id).not.toBe(second.id); expect(provider).toHaveBeenCalledTimes(2);
  const operationIds = provider.mock.calls.map(([request]) => request.operationId);
  expect(new Set(operationIds).size).toBe(2);
  expect(operationIds.every(id => id.length > 0)).toBe(true);
  expect(await current()).toEqual(value);
});

it('passes newly generated upstream media into later scoped activities alongside frozen input assets', async () => {
  let generated: AssetRecord | undefined, received = false;
  const { runtime, directory, project, current } = await setup({ executeActivity: async context => {
    if (context.node.kind === 'assets') {
      const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="blue"/></svg>');
      const path = join(context.dataDirectory, 'generated.svg'); await writeFile(path, bytes);
      generated = assetSchema.parse({ id: 'generated-image', projectId: context.project.id, shotId: 'editable', name: 'generated.svg', kind: 'image', path, mimeType: 'image/svg+xml', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: '', provenance: 'controlled media boundary', retained: false, active: true });
      return { assets: [generated] };
    }
    expect(context.assets).toContainEqual(generated); expect(context.assets.some(asset => asset.name === 'input.svg')).toBe(true); received = true; return { assets: [] };
  } });
  const path = join(directory, 'input.svg'); await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>');
  await runtime.dispatch('asset.import', { projectId: project.id, path });
  const value = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, nodes: [node('image', 'assets'), node('voice', 'voice')], edges: [{ id: 'iv', source: 'image', target: 'voice' }] } } }));
  const run = await start(runtime, await plan(runtime, value, 'image'));
  expect((await inspection(runtime, run.id)).run.status).toBe('succeeded'); expect(received).toBe(true); expect(await current()).toEqual(value);
  const applied = projectSchema.parse(await runtime.dispatch('node.apply', { runId: run.id, nodeId: 'image', revision: value.revision }));
  expect(applied.shots[0]).toEqual(value.shots[0]); expect(applied.shots[1].assetId).toBe(generated?.id);
  expect(recordPageSchema(assetSchema).parse(await runtime.dispatch('asset.list')).items.some(asset => asset.id === generated?.id)).toBe(true);
});

it('resumes the same frozen selection after a process exit without repeating a completed provider call', async () => {
  const provider = vi.fn(async () => '已持久化的候选风格'); let exited = false;
  const { runtime, directory, project } = await setup({ provider, failpoint(point, activityId) { if (!exited && point === 'after-commit' && activityId === 'style') { exited = true; throw new SimulatedProcessExit(); } } });
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '恢复模型', provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'style', capabilities: ['text'] } }));
  const value = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, nodes: [node('upstream'), node('style', 'style', { modelId: model.id }), node('tail')], edges: [{ id: 'us', source: 'upstream', target: 'style' }, { id: 'st', source: 'style', target: 'tail' }] } } }));
  const run = await start(runtime, await plan(runtime, value, 'style')); expect(exited).toBe(true); expect(provider).toHaveBeenCalledTimes(1);
  await runtime.close(); runtimes.splice(runtimes.indexOf(runtime), 1);
  const restored = createRuntime({ dataDirectory: directory, seed: false, provider }); runtimes.push(restored);
  const edited = projectSchema.parse(await restored.dispatch('project.update', { projectId: value.id, revision: value.revision, patch: { brief: '崩溃后的人工输入', workflow: { ...value.workflow, nodes: [...value.workflow.nodes, node('new-unrelated')] } } }));
  await restored.dispatch('run.resume', { runId: run.id }); await restored.waitForIdle();
  const detail = await inspection(restored, run.id); expect(detail.run.status).toBe('succeeded'); expect(detail.steps.map(step => step.id)).toEqual(['style', 'tail']);
  expect(provider).toHaveBeenCalledTimes(1); expect(projectDetailSchema.parse(await restored.dispatch('project.get', { projectId: value.id })).project).toEqual(edited);
});

it('requires a current, matching preview to restart a canceled scoped run and reports active-run blocking', async () => {
  const { runtime, project } = await setup();
  const value = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, nodes: project.workflow.nodes.map(node => node.id === 'root' ? { ...node, requiresReview: true } : node) } } }));
  const preview = await plan(runtime, value), parent = await start(runtime, preview);
  expect((await plan(runtime, value)).blockedReason).toContain('未完成');
  await runtime.dispatch('run.cancel', { runId: parent.id }); await runtime.waitForIdle();
  await expect(runtime.dispatch('run.start', { projectId: value.id, parentRunId: parent.id })).rejects.toThrow('预览原任务');
  const changed = projectSchema.parse(await runtime.dispatch('project.update', { projectId: value.id, revision: value.revision, patch: { title: '停止之后的新标题' } }));
  await expect(start(runtime, preview, parent.id)).rejects.toThrow('重新预览');
  await expect(start(runtime, await plan(runtime, changed, 'root', 'node'), parent.id)).rejects.toThrow('预览原任务');
  const restarted = await start(runtime, await plan(runtime, changed), parent.id);
  expect(restarted).toMatchObject({ parentRunId: parent.id, projectRevision: changed.revision, selection: preview.selection });
  expect((await inspection(runtime, restarted.id)).steps.map(step => step.id)).toEqual(preview.steps.map(step => step.id));
});

it('keeps locked shots and manually selected media when a scoped script candidate is explicitly applied', async () => {
  const provider = vi.fn(async () => JSON.stringify({ shots: [{ title: '模型想改的锁定标题', narration: '模型想改的锁定旁白', visualPrompt: '' }, { title: '新的未锁定标题', narration: '新的旁白', visualPrompt: '新的画面要求' }] }));
  const { runtime, directory, project, current } = await setup({ provider });
  const path = join(directory, 'chosen.svg'); await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>');
  const asset = assetSchema.parse(await runtime.dispatch('asset.import', { projectId: project.id, shotId: 'editable', path }));
  const imported = await current();
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '脚本模型', provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'script', capabilities: ['text'] } }));
  const value = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: imported.revision, patch: { workflow: { ...project.workflow, nodes: [node('script', 'script', { modelId: model.id }), node('tail')], edges: [{ id: 'st', source: 'script', target: 'tail' }] } } }));
  const run = await start(runtime, await plan(runtime, value, 'script'));
  expect((await inspection(runtime, run.id)).run.status).toBe('succeeded'); expect(await current()).toEqual(value);
  const applied = projectSchema.parse(await runtime.dispatch('node.apply', { runId: run.id, nodeId: 'script', revision: value.revision }));
  expect(applied.shots[0]).toEqual(value.shots[0]); expect(applied.shots[1]).toMatchObject({ title: '新的未锁定标题', assetId: asset.id });
});

it('stops a shortened script result from dropping a later locked shot or running its downstream steps', async () => {
  const provider = vi.fn(async () => JSON.stringify({ shots: [{ title: '唯一的新镜头', narration: '新的旁白', visualPrompt: '' }] }));
  const { runtime, project, current } = await setup({ provider });
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '脚本模型', provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'script', capabilities: ['text'] } }));
  const value = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map(shot => ({ ...shot, locked: shot.id === 'editable' })), workflow: { ...project.workflow, nodes: [node('script', 'script', { modelId: model.id }), node('tail')], edges: [{ id: 'st', source: 'script', target: 'tail' }] } } }));
  const run = await start(runtime, await plan(runtime, value, 'script')), detail = await inspection(runtime, run.id);
  expect(detail.run).toMatchObject({ status: 'needs_attention', error: expect.stringContaining('锁定镜头') });
  expect(detail.steps.find(step => step.id === 'script')?.outputAvailable).toBe(false); expect(detail.steps.find(step => step.id === 'tail')?.inputAvailable).toBe(false);
  expect(await current()).toEqual(value); expect(provider).toHaveBeenCalledTimes(1);
});

it('retains the one-step scope of a direct execution when it is canceled and recreated', async () => {
  const { runtime, project } = await setup();
  const value = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, nodes: project.workflow.nodes.map(node => node.id === 'root' ? { ...node, requiresReview: true } : node) } } }));
  const parent = runSchema.parse(await runtime.dispatch('run.start', { projectId: value.id, nodeId: 'root' })); await runtime.waitForIdle();
  expect(parent.selection).toEqual({ nodeId: 'root', mode: 'node' }); await runtime.dispatch('run.cancel', { runId: parent.id });
  await expect(runtime.dispatch('run.start', { projectId: value.id, parentRunId: parent.id })).rejects.toThrow('预览原任务');
  const restarted = await start(runtime, await plan(runtime, value, 'root', 'node'), parent.id);
  expect((await inspection(runtime, restarted.id)).steps.map(step => step.id)).toEqual(['root']);
});
