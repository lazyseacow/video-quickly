import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeVideoWorkflow, assetSchema, projectSchema, runInspectionSchema, runSchema, runStepPayloadSchema, shotSchema, type ProjectDocument } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type ActivityExecutionContext, type RuntimeOptions } from '../packages/runtime/src';
import { planningFixtureFields, planningFixtureResponse, storyboardFixtureResponse } from './fixtures/planning-response';

const directories: string[] = [], runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function current(runtime: ReturnType<typeof createRuntime>, projectId: string) {
  return (await runtime.dispatch('project.get', { projectId }) as { project: ProjectDocument }).project;
}
async function fixture(extra: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-automatic-workflow-')); directories.push(directory);
  const provider = vi.fn<NonNullable<RuntimeOptions['provider']>>(async ({ prompt }) => {
    const document = (text: string) => planningFixtureResponse(prompt, text);
    if (prompt.includes('自动视频制作步骤：创意简报')) return document('面向新手介绍雨水循环，三幕叙事，时长六秒。');
    if (prompt.includes('自动视频制作步骤：风格与角色')) {
      expect(prompt).toContain('面向新手介绍雨水循环'); return document('蓝绿色水彩，柔和光线，角色与场景连续。');
    }
    expect(prompt).toContain('蓝绿色水彩'); expect(prompt).toContain('上游已完成步骤的实际产物');
    return storyboardFixtureResponse(prompt, JSON.stringify({ shots: [{ title: '水滴的旅程', narration: '水汽遇冷形成雨滴。', visualPrompt: '水彩雨滴从白云落向湖面', durationUs: 6_000_000 }] }));
  });
  const media = vi.fn(async (context: ActivityExecutionContext) => {
    expect(context.project.brief).toContain('三幕叙事'); expect(context.project.style).toContain('蓝绿色水彩');
    const shot = context.project.shots[0]; expect(shot.title).toBe('水滴的旅程');
    if (context.node.kind !== 'assets') expect(context.assets.some(asset => asset.id === shot.assetId)).toBe(true);
    if (context.node.kind === 'export') {
      expect(context.assets.some(asset => asset.id === shot.videoAssetId)).toBe(true);
      return { completed: true, shotIds: context.project.shots.map(shot => shot.id) };
    }
    if (context.node.config.operation === 'prepare-edit') return { source: 'local', shots: context.project.shots.length };
    const kind = context.node.kind === 'assets' ? 'image' : 'video';
    const bytes = Buffer.from(`controlled ${kind} boundary`), path = join(directory, `${kind}.fixture`);
    await writeFile(path, bytes);
    const asset = assetSchema.parse({ id: `generated-${kind}`, projectId: context.project.id, shotId: shot.id, name: kind, kind, path,
      mimeType: `${kind}/fixture`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), durationUs: 6_000_000,
      version: 1, createdAt: '', provenance: 'controlled activity boundary', retained: false, active: true });
    return { assets: [asset] };
  });
  const options: RuntimeOptions = { dataDirectory: directory, seed: false, provider, executeActivity: media, ...extra };
  const runtime = createRuntime(options); runtimes.add(runtime);
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '雨水循环', brief: '介绍雨水循环' }));
  const model = await runtime.dispatch('model.save', { model: { name: '本地测试边界', provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'fixture', connectionType: 'text', capabilities: ['text'] } }) as { id: string };
  const image = await runtime.dispatch('model.save', { model: { name: '参考图片边界', provider: 'openai-compatible', connectionType: 'image', capabilities: ['image'], baseUrl: 'http://127.0.0.1:1', model: 'fixture-image' } }) as { id: string };
  const video = await runtime.dispatch('model.save', { model: { name: '视频边界', provider: 'openai-compatible', connectionType: 'video', capabilities: ['video'], baseUrl: 'http://127.0.0.1:1', model: 'fixture-video', parameters: {  } } }) as { id: string };
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: { workflow: {
    ...createNativeVideoWorkflow(), production: { ...createNativeVideoWorkflow().production, textModelId: model.id, imageModelId: image.id, videoModelId: video.id, referenceMode: 'generate' }, nodes: createNativeVideoWorkflow().nodes.map(node => ['brief', 'style', 'script'].includes(node.kind) ? { ...node, modelId: model.id } : node),
  } } }));
  return { runtime, directory, project, provider, media, options };
}

it('automatically chains all seven tasks, forwards generated text and media, and saves the finished project', async () => {
  const { runtime, project, provider, media } = await fixture();
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await runtime.waitForIdle();
  const inspection = runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: run.id }));
  expect(inspection.run.status, inspection.run.error).toBe('succeeded'); expect(inspection.steps.every(step => step.status === 'succeeded')).toBe(true);
  expect(provider).toHaveBeenCalledTimes(4); expect(media.mock.calls.map(([context]) => context.node.kind)).toEqual(['assets', 'animation', 'animation', 'export']);
  const saved = await current(runtime, project.id);
  expect(saved).toMatchObject({ revision: project.revision + 1, brief: expect.stringContaining('三幕叙事'), style: expect.stringContaining('蓝绿色水彩'),
    shots: [{ assetId: 'generated-image', videoAssetId: 'generated-video' }] });
  expect(saved.workflow.production.manualPlanningFields).toMatchObject({ brief: { topic: expect.stringContaining('三幕叙事') }, style: { artStyle: expect.stringContaining('蓝绿色水彩') } });
  expect((await runtime.dispatch('run.get', { runId: run.id }) as { events?: { type: string }[] }).events?.some(event => event.type === 'review.waiting')).not.toBe(true);
});

it('generates a field draft once for the same request and leaves production and project content untouched', async () => {
  const { runtime, project, provider, media } = await fixture();
  const input = { projectId: project.id, projectRevision: project.revision, node: project.workflow.nodes.find(node => node.id === 'brief')!, context: { brief: '表单中未保存的主题' }, requestId: randomUUID() };
  const [first, repeated] = await Promise.all([runtime.dispatch('planning.prefill.start', input), runtime.dispatch('planning.prefill.start', input)]);
  const run = runSchema.parse(first);
  expect(runSchema.parse(repeated).id).toBe(run.id);
  await runtime.waitForIdle();
  expect(await runtime.dispatch('node.result', { runId: run.id, nodeId: 'brief' })).toMatchObject({ fields: { topic: expect.stringContaining('雨水循环') } });
  expect(provider).toHaveBeenCalledTimes(1);
  expect(provider.mock.calls[0][0].prompt).toContain('表单中未保存的主题');
  expect(media).not.toHaveBeenCalled();
  expect(await current(runtime, project.id)).toEqual(project);
  expect(await runtime.dispatch('run.list', { projectId: project.id, purpose: 'production' })).toMatchObject({ items: [] });
  await expect(runtime.dispatch('planning.prefill.start', { ...input, context: { brief: '其他主题' } })).rejects.toThrow('标识已用于其他输入');
});

it('combines manual planning inputs and AI generation in the same production run', async () => {
  const { runtime, project: original, provider, media } = await fixture();
  const brief = '人工填写：面向新手介绍雨水循环，三幕叙事，时长六秒。';
  const shot = shotSchema.parse({ id: 'authored-shot', title: '水滴的旅程', narration: '我写的旁白', visualPrompt: '我写的画面要求', durationUs: 6_000_000 });
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: original.id, revision: original.revision, patch: {
    brief, shots: [shot], workflow: { ...original.workflow, production: { ...original.workflow.production, manualPlanningSteps: ['brief', 'script'] } },
  } }));
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await runtime.waitForIdle();
  const inspection = runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: run.id }));
  expect(inspection.run.status, inspection.run.error).toBe('succeeded');
  expect(inspection.steps.slice(0, 3).map(step => [step.id, step.modelGeneration, step.responseAvailable])).toEqual([
    ['brief', false, false], ['style', true, true], ['script', false, false],
  ]);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(provider.mock.calls[0][0]).toMatchObject({ outputSchemaName: 'video_style', prompt: expect.stringContaining(brief) });
  expect(await runtime.dispatch('node.result', { runId: run.id, nodeId: 'brief' })).toEqual({ text: brief, source: 'project' });
  expect(await runtime.dispatch('node.result', { runId: run.id, nodeId: 'script' })).toMatchObject({ shots: [shot], source: 'project' });
  expect(media.mock.calls[0][0].project.shots).toEqual([shot]);
  expect((await current(runtime, project.id)).workflow.nodes.find(node => node.id === 'brief')?.modelId).toBe(original.workflow.production.textModelId);
});

it('reports missing manual inputs during readiness and blocks the run before calling any model', async () => {
  const { runtime, project, provider, media } = await fixture();
  await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: {
    brief: '   ', workflow: { ...project.workflow, production: { ...project.workflow.production, manualPlanningSteps: ['brief', 'script'] } },
  } });
  expect(await runtime.dispatch('project.readiness', { projectId: project.id })).toMatchObject({ ready: false, issues: expect.arrayContaining([
    expect.objectContaining({ nodeId: 'brief', category: 'workflow', message: expect.stringContaining('手动创意简报结果校验失败') }),
    expect.objectContaining({ nodeId: 'script', category: 'workflow', message: expect.stringContaining('shots：不得小于 1 项') }),
  ]) });
  await expect(runtime.dispatch('run.start', { projectId: project.id })).rejects.toThrow('手动创意简报结果校验失败');
  await expect(runtime.dispatch('run.start', { projectId: project.id, nodeId: 'script' })).rejects.toThrow('手动分镜结果校验失败');
  expect(provider).not.toHaveBeenCalled(); expect(media).not.toHaveBeenCalled();
});

it('round-trips manual source choices through the project backup format', async () => {
  const { runtime, project } = await fixture();
  const brief = { topic: '雨水循环', audience: '初学者', coreMessage: '雨水的旅程', narrativeOrder: '', targetDuration: '6 秒', expression: '' };
  await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: {
    workflow: { ...project.workflow, production: { ...project.workflow.production, manualPlanningSteps: ['brief'], manualPlanningFields: { brief } } },
  } });
  const backup = await runtime.dispatch('project.backup', { projectId: project.id }) as { path: string };
  const manifestPath = join(backup.path, 'project.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  expect(manifest.schemaVersion).toBe(9);
  const imported = projectSchema.parse(await runtime.dispatch('project.importBackup', { path: backup.path }));
  expect(imported.workflow.production.manualPlanningSteps).toEqual(['brief']);
  expect(imported.workflow.production.manualPlanningFields).toEqual({ brief });
  await writeFile(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 8 }));
  await expect(runtime.dispatch('project.importBackup', { path: backup.path })).rejects.toThrow('需要格式 9 备份');
});

it.each(['brief', 'style'] as const)('blocks downstream work until the %s output passes its schema', async nodeId => {
  const { runtime, project, provider, media } = await fixture();
  if (nodeId === 'style') provider.mockResolvedValueOnce(JSON.stringify(planningFixtureFields('brief', '面向新手介绍雨水循环，三幕叙事，时长六秒。')));
  const field = nodeId === 'brief' ? 'topic' : 'artStyle';
  const invalid = JSON.stringify({ ...planningFixtureFields(nodeId, ''), [field]: ['格式错误'] });
  provider.mockResolvedValueOnce(invalid);
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id }));
  await runtime.waitForIdle();
  const payload = async () => runStepPayloadSchema.parse(await runtime.dispatch('run.step.payload', { runId: run.id, nodeId, kind: 'output' }));
  const callCount = nodeId === 'brief' ? 1 : 2;
  expect(provider).toHaveBeenCalledTimes(callCount);
  expect(provider.mock.calls.at(-1)?.[0]).toMatchObject({
    outputSchemaName: `video_${nodeId}`,
    outputSchema: { type: 'object', required: expect.arrayContaining([field]), additionalProperties: false },
  });
  expect(await payload()).toMatchObject({ available: false, modelResponse: { text: invalid, issues: [{ path: field, message: '应为字符串' }] } });
  expect(await current(runtime, project.id)).toEqual(project);
  expect(media).not.toHaveBeenCalled();

  await runtime.dispatch('run.resume', { runId: run.id }); await runtime.waitForIdle();
  expect(provider).toHaveBeenCalledTimes(callCount);
  await runtime.dispatch('run.step.retry', { runId: run.id, nodeId }); await runtime.waitForIdle();
  expect(provider).toHaveBeenCalledTimes(callCount + 1);
  expect(provider.mock.calls.at(-1)?.[0].prompt).toContain('返回的字段校验错误');
  expect(await payload()).toMatchObject({
    available: true,
    value: { text: expect.any(String) },
    modelResponseHistory: [{ attempt: 2, invalid: false }, { attempt: 1, invalid: true }],
  });
  expect(media).not.toHaveBeenCalled();
  await runtime.dispatch('run.resume', { runId: run.id }); await runtime.waitForIdle();
  expect(await runtime.dispatch('run.get', { runId: run.id })).toMatchObject({ status: 'succeeded' });
  expect(media.mock.calls.map(([context]) => context.node.id)).toEqual(['assets', 'video', 'animation', 'export']);
});

it('rejects storyboard fields outside the advertised production schema', async () => {
  const { runtime, project, provider } = await fixture();
  const invalid = JSON.stringify({ shots: [{ number: 1, title: '水滴的旅程', narration: '', visualPrompt: '', assetId: 'untrusted-asset' }] });
  provider.mockResolvedValueOnce(JSON.stringify({ outline: '水滴的旅程', shots: [{ title: '水滴的旅程', beat: '水滴落下。' }] })).mockResolvedValueOnce(invalid);
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'script' }));
  await runtime.waitForIdle();
  expect(provider.mock.calls[1][0].outputSchema).toMatchObject({ required: ['shots'], properties: { shots: { items: { additionalProperties: false } } } });
  expect(await runtime.dispatch('run.step.payload', { runId: run.id, nodeId: 'script', kind: 'output' })).toMatchObject({
    available: false, modelResponse: { text: invalid, issues: [{ path: 'shots[0]', message: '含有未定义的字段' }] },
  });
});

it.each(['assets', 'video'] as const)('rejects incompatible %s assets before committing the step', async nodeId => {
  const { runtime, project: original, media } = await fixture();
  const project = nodeId === 'video' ? projectSchema.parse(await runtime.dispatch('project.update', { projectId: original.id, revision: original.revision, patch: {
    workflow: { ...original.workflow, execution: { maxConcurrentShots: 1, modelLimits: {} } },
  } })) : original;
  const produce = media.getMockImplementation()!;
  media.mockImplementation(async context => {
    const output = await produce(context);
    if (context.node.id !== nodeId || !output.assets) return output;
    const assets = output.assets.map(asset => ({ ...asset, kind: 'audio' as const }));
    if (nodeId === 'assets') context.onAsset?.(assets[0]);
    return { assets };
  });
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id }));
  await runtime.waitForIdle();
  const inspection = runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: run.id }));
  expect(inspection.steps.find(step => step.id === nodeId)).toMatchObject({
    status: 'failed', outputAvailable: false, unknownSubmission: false, error: expect.stringContaining(nodeId === 'assets' ? 'kind' : 'assets[0].kind'),
  });
  expect(media.mock.calls.map(([context]) => context.node.id)).toEqual(nodeId === 'assets' ? ['assets'] : ['assets', 'video']);
  expect(await current(runtime, project.id)).toEqual(project);
  expect(await runtime.dispatch('asset.list')).toMatchObject({ items: expect.not.arrayContaining([expect.objectContaining({ kind: 'audio' })]) });
  media.mockImplementation(produce);
  await runtime.dispatch('run.step.retry', { runId: run.id, nodeId }); await runtime.waitForIdle();
  expect(await runtime.dispatch('run.get', { runId: run.id })).toMatchObject({ stepRetry: { nodeId, status: 'completed' } });
  expect(media.mock.calls.filter(([context]) => context.node.id === nodeId)).toHaveLength(2);
});

it('publishes generated video and its storyboard before export despite a save with unchanged content', async () => {
  const { runtime, project, media } = await fixture();
  const videoStarted = Promise.withResolvers<void>(), resumeVideo = Promise.withResolvers<void>();
  const exportStarted = Promise.withResolvers<void>(), resumeExport = Promise.withResolvers<void>();
  const executeMedia = media.getMockImplementation()!;
  media.mockImplementation(async context => {
    if (context.node.id === 'video') { videoStarted.resolve(); await resumeVideo.promise; }
    if (context.node.kind === 'export') { exportStarted.resolve(); await resumeExport.promise; }
    return executeMedia(context);
  });
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id }));
  let revisionAtVideo = 0;
  try {
    await videoStarted.promise;
    const resaved = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { title: project.title } }));
    expect(resaved.revision).toBeGreaterThan(project.revision);
    resumeVideo.resolve(); await exportStarted.promise;
    const published = await current(runtime, project.id);
    expect(published).toMatchObject({ revision: resaved.revision + 1, shots: [{ assetId: 'generated-image', videoAssetId: 'generated-video' }] });
    revisionAtVideo = published.revision;
  } finally { resumeVideo.resolve(); resumeExport.resolve(); }
  await runtime.waitForIdle();
  expect(await current(runtime, project.id)).toMatchObject({ revision: revisionAtVideo });
  expect(await runtime.dispatch('run.get', { runId: run.id })).toMatchObject({ status: 'succeeded' });
});

it('can apply a saved video step with its missing storyboard when the project is back to its original content', async () => {
  const { runtime, directory, project, media } = await fixture();
  const videoStarted = Promise.withResolvers<void>(), resumeVideo = Promise.withResolvers<void>();
  const executeMedia = media.getMockImplementation()!;
  media.mockImplementation(async context => {
    if (context.node.id === 'video') { videoStarted.resolve(); await resumeVideo.promise; }
    return executeMedia(context);
  });
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id }));
  try {
    await videoStarted.promise;
    await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { title: '制作期间修改的标题' } });
  } finally { resumeVideo.resolve(); }
  await runtime.waitForIdle();
  const edited = await current(runtime, project.id);
  expect(edited).toMatchObject({ title: '制作期间修改的标题', shots: [] });
  await expect(runtime.dispatch('node.apply', { runId: run.id, nodeId: 'video', revision: edited.revision })).rejects.toThrow();
  const restored = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: edited.revision, patch: { title: project.title } }));
  const request = { runId: run.id, nodeId: 'video', revision: restored.revision };
  const reference = join(directory, 'image.fixture'), bytes = await readFile(reference);
  await writeFile(reference, Buffer.alloc(bytes.length));
  await expect(runtime.dispatch('node.apply', request)).rejects.toThrow('素材校验失败');
  expect(await current(runtime, project.id)).toEqual(restored);
  await writeFile(reference, bytes);
  const applied = projectSchema.parse(await runtime.dispatch('node.apply', request));
  expect(applied).toMatchObject({ revision: restored.revision + 1, shots: [{ title: '水滴的旅程', assetId: 'generated-image', videoAssetId: 'generated-video' }] });
  expect(media.mock.calls.filter(([context]) => context.node.id === 'video')).toHaveLength(1);
});

it('continues after a committed media result across reopening without regenerating earlier steps', async () => {
  let interrupted = false;
  const { runtime, project, provider, media, options } = await fixture({ failpoint(point, activityId) {
    if (!interrupted && point === 'after-commit' && activityId === 'video') { interrupted = true; throw new SimulatedProcessExit(); }
  } });
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await runtime.waitForIdle();
  await runtime.close(); runtimes.delete(runtime);
  const recovered = createRuntime({ ...options, failpoint: undefined }); runtimes.add(recovered);
  await recovered.dispatch('run.resume', { runId: run.id }); await recovered.waitForIdle();
  expect(runSchema.parse(await recovered.dispatch('run.get', { runId: run.id })).status).toBe('succeeded');
  expect(provider).toHaveBeenCalledTimes(4); expect(media.mock.calls.map(([context]) => context.node.kind)).toEqual(['assets', 'animation', 'animation', 'export']);
  expect(await current(recovered, project.id)).toMatchObject({ revision: project.revision + 1, shots: [{ videoAssetId: 'generated-video' }] });
});

it('saves a complete production workflow whose only top-level node calls a multi-step subflow', async () => {
  const { runtime, project } = await fixture();
  const nodes = project.workflow.nodes.filter(node => ['brief', 'style'].includes(node.kind));
  const configured = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: {
    id: 'subflow-production', name: '完整子流程制作', version: 1,
    production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [{ id: 'production', kind: 'subflow', label: '自动制作', subflow: { id: 'planning', version: 1, inputs: {} } }], edges: [],
    subflows: [{ id: 'planning', name: '生成简报与风格', version: 1, inputs: [], outputs: [], nodes, edges: [{ id: 'bs', source: 'brief', target: 'style' }] }],
  } } }));
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await runtime.waitForIdle();
  const inspection = runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: run.id }));
  expect(inspection.run.status, inspection.run.error).toBe('succeeded');
  expect(await current(runtime, project.id)).toMatchObject({ revision: configured.revision + 1, brief: expect.stringContaining('三幕叙事'), style: expect.stringContaining('蓝绿色水彩') });
});

it('preserves edits made during production while retaining the complete generated outputs', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const { runtime, project } = await fixture({ provider: async ({ prompt }) => { entered(); await gate; return planningFixtureResponse(prompt, '新的风格'); } });
  const configured = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: {
    ...project.workflow, nodes: project.workflow.nodes.filter(node => ['brief', 'style'].includes(node.kind)), edges: [{ id: 'bs', source: 'brief', target: 'style' }], stages: undefined,
  } } }));
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await started;
  const edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: configured.revision, patch: { title: '制作期间修改的标题' } }));
  release(); await runtime.waitForIdle();
  expect(await current(runtime, project.id)).toEqual(edited);
  expect(runSchema.parse(await runtime.dispatch('run.get', { runId: run.id })).status).toBe('succeeded');
  expect(await runtime.dispatch('node.result', { runId: run.id, nodeId: 'style' })).toMatchObject({ fields: { artStyle: '新的风格' } });
  expect(await runtime.dispatch('run.events', { runId: run.id })).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ type: 'project.apply_conflict' })]) });
});
