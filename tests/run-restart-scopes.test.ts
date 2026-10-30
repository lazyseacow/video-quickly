import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { assetSchema, DEFAULT_VIDEO_PROFILE, exportBatchSchema, projectSchema, runInspectionSchema, runSchema, type AssetRecord, type ModelProfile, type ProjectDocument, type ShotCandidate, type UsageRecord, type WorkflowNode } from '@video-quickly/contracts';
import { createActivityExecutor } from '../packages/integrations/src';
import { createRuntime, type ActivityExecutionContext, type RuntimeOptions } from '../packages/runtime/src';
import { openDatabase } from '../packages/runtime/src/database';

const directories: string[] = [], servers: Server[] = [];
const runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); })));
  await Promise.all(directories.splice(0).map(directory => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('video-quickly-run-restart-')) throw new Error('Unexpected restart-test cleanup path');
    return rm(directory, { recursive: true, force: true });
  }));
});

async function setup(options: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-run-restart-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/unused-by-restart-tests', executeActivity: createActivityExecutor(), ...options }); runtimes.add(runtime);
  const original = projectSchema.parse(await runtime.dispatch('project.create', { title: '原项目' }));
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: original.id, revision: original.revision, patch: { shots: [0, 1, 2].map(index => ({ id: `shot-${index}`, title: `镜头${index}`, narration: `旁白${index}`, visualPrompt: `画面${index}`, durationUs: 1_000_000 })) } }));
  return { directory, runtime, project };
}
async function current(runtime: ReturnType<typeof createRuntime>, projectId: string) { return (await runtime.dispatch('project.get', { projectId }) as { project: ProjectDocument }).project; }
async function reopenLegacyRun(runtime: ReturnType<typeof createRuntime>, directory: string, runId: string, options: Partial<RuntimeOptions> = {}) {
  await runtime.close(); runtimes.delete(runtime);
  const database = openDatabase(directory);
  try {
    database.prepare("UPDATE documents SET body = json_remove(body, '$.selection', '$.stepCount') WHERE kind = 'run' AND id = ?").run(runId);
    database.prepare("UPDATE documents SET body = json_remove(body, '$.selection') WHERE kind = 'run-snapshot' AND id = ?").run(runId);
  } finally { database.close(); }
  const restored = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/unused-by-restart-tests', executeActivity: createActivityExecutor(), ...options }); runtimes.add(restored); return restored;
}
async function serverFixture() {
  const requests: Array<{ path: string; body: string }> = [];
  const server = createServer((request, response) => { void (async () => {
    let body = ''; for await (const chunk of request) body += chunk.toString();
    requests.push({ path: request.url ?? '', body });
    // Keep the first real request pending until cancellation reaches the HTTP client.
    if (requests.length === 1) return;
    if (request.url?.endsWith('/images/generations')) response.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }] }));
    else if (request.url?.endsWith('/audio/transcriptions')) response.end(JSON.stringify({ segments: [{ start: .1, end: .8, text: '新识别字幕' }] }));
    else { response.statusCode = 400; response.end('unexpected operation'); }
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务地址无效');
  return { requests, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

it('restarts a canceled shot candidate with its original target, model and instruction against the current revision', async () => {
  const { requests, baseUrl } = await serverFixture();
  const { runtime, project } = await setup();
  const model = await runtime.dispatch('model.save', { model: { name: '原图像模型', provider: 'openai-compatible', baseUrl, model: 'original-image-model', capabilities: ['image'] } }) as ModelProfile;
  const parent = runSchema.parse(await runtime.dispatch('shot.regenerate', { projectId: project.id, shotId: 'shot-1', kind: 'image', modelId: model.id, instruction: '固定调整要求', revision: project.revision }));
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  await runtime.dispatch('run.cancel', { runId: parent.id }); await runtime.waitForIdle();
  const otherModel = await runtime.dispatch('model.save', { model: { name: '后改默认模型', provider: 'openai-compatible', baseUrl, model: 'different-image-model', capabilities: ['image'] } }) as ModelProfile;
  const afterWorkflow = projectSchema.parse(await runtime.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow: { ...project.workflow, nodes: project.workflow.nodes.map(node => node.kind === 'assets' ? { ...node, modelId: otherModel.id } : node) } }));
  const edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: afterWorkflow.revision, patch: { shots: project.shots.map(shot => shot.id === 'shot-1' ? { ...shot, title: '当前目标标题', narration: '当前目标旁白', visualPrompt: '当前目标画面' } : shot) } }));
  await expect(runtime.dispatch('run.start', { projectId: project.id, parentRunId: parent.id, revision: project.revision })).rejects.toThrow('其他视图修改');
  await expect(runtime.dispatch('run.start', { projectId: project.id, parentRunId: parent.id, nodeId: 'export' })).rejects.toThrow('范围');
  const restarted = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, parentRunId: parent.id })); await runtime.waitForIdle();
  expect(restarted).toMatchObject({ parentRunId: parent.id, projectRevision: edited.revision }); expect(restarted.id).not.toBe(parent.id);
  expect(await runtime.dispatch('run.get', { runId: restarted.id })).toMatchObject({ status: 'succeeded' }); expect(requests).toHaveLength(2);
  const request = JSON.parse(requests[1].body) as { model: string; prompt: string };
  expect(requests[1].path).toBe('/v1/images/generations'); expect(request.model).toBe('original-image-model');
  expect(request.prompt).toContain('固定调整要求'); expect(request.prompt).toContain('当前目标画面'); expect(request.prompt).not.toContain('画面0'); expect(request.prompt).not.toContain('画面2');
  const page = await runtime.dispatch('shot.candidates', { projectId: project.id, shotId: 'shot-1' }) as { items: ShotCandidate[] };
  expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ kind: 'image', instruction: '固定调整要求', modelId: model.id, baseline: { title: '当前目标标题', narration: '当前目标旁白' } });
  const removed = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: edited.revision, patch: { shots: edited.shots.filter(shot => shot.id !== 'shot-1') } }));
  await expect(runtime.dispatch('run.start', { projectId: project.id, parentRunId: parent.id, revision: removed.revision })).rejects.toThrow('镜头不存在'); expect(requests).toHaveLength(2);
});

it('restarts canceled transcription only for its original shot and ASR model without invoking the project workflow', async () => {
  const { requests, baseUrl } = await serverFixture();
  const { runtime, directory, project } = await setup();
  const path = join(directory, 'voice.wav'); await writeFile(path, 'actual multipart fixture bytes');
  const audio = assetSchema.parse(await runtime.dispatch('asset.import', { projectId: project.id, shotId: 'shot-1', path, kind: 'audio' }));
  const linked = await current(runtime, project.id);
  const model = await runtime.dispatch('model.save', { model: { name: '原ASR模型', provider: 'openai-compatible', baseUrl, model: 'original-asr-model', capabilities: ['asr'] } }) as ModelProfile;
  const parent = runSchema.parse(await runtime.dispatch('caption.transcribe', { projectId: project.id, shotId: 'shot-1', modelId: model.id, revision: linked.revision }));
  await vi.waitFor(() => expect(requests).toHaveLength(1)); await runtime.dispatch('run.cancel', { runId: parent.id }); await runtime.waitForIdle();
  const edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: linked.revision, patch: { title: '识别前的新项目标题' } }));
  const restarted = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, parentRunId: parent.id })); await runtime.waitForIdle();
  expect(restarted).toMatchObject({ parentRunId: parent.id, projectRevision: edited.revision }); expect(requests).toHaveLength(2); expect(requests.every(request => request.path === '/v1/audio/transcriptions')).toBe(true);
  expect(requests[1].body).toContain('original-asr-model');
  const result = await runtime.dispatch('node.result', { runId: restarted.id, nodeId: 'caption' }) as { captionTrack: unknown; shotId: string };
  expect(result).toMatchObject({ shotId: 'shot-1', captionTrack: { sourceAssetId: audio.id, cues: [{ text: '新识别字幕' }] } }); expect(await current(runtime, project.id)).toEqual(edited);
});

async function localArtifacts(context: ActivityExecutionContext) {
  const directory = join(context.dataDirectory, 'local-export', context.runId); await mkdir(directory, { recursive: true });
  const assets: AssetRecord[] = [], output: Record<string, string> = {};
  for (const [field, kind, filename] of [['videoPath', 'video', 'video.mp4'], ['coverPath', 'image', 'cover.png'], ['subtitlePath', 'subtitle', 'subtitles.srt'], ['timelinePath', 'document', 'timeline.json']] as const) {
    const path = join(directory, filename), bytes = Buffer.from(`${context.project.title}:${context.project.profile.width}:${kind}`); await writeFile(path, bytes);
    output[field] = path; assets.push({ id: `${context.runId}:${kind}`, projectId: context.project.id, name: filename, kind, path, mimeType: 'application/octet-stream', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: '', provenance: 'controlled local render boundary', retained: false, active: true });
  }
  return { ...output, assets } as unknown as Awaited<ReturnType<NonNullable<RuntimeOptions['executeActivity']>>>;
}

it('restarts an older single-step task without executing the rest of the current workflow', async () => {
  const { runtime, directory, project } = await setup();
  const parent = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'style' })); await runtime.waitForIdle();
  expect(await runtime.dispatch('run.get', { runId: parent.id })).toMatchObject({ status: 'waiting_review' });
  await runtime.dispatch('run.cancel', { runId: parent.id }); await runtime.waitForIdle();
  const restored = await reopenLegacyRun(runtime, directory, parent.id);
  const edited = projectSchema.parse(await restored.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { title: '旧任务之后的新标题', workflow: { ...project.workflow, nodes: [...project.workflow.nodes, { ...project.workflow.nodes[0], id: 'new-unrelated', label: '新增独立步骤' }] } } }));
  await expect(restored.dispatch('run.start', { projectId: project.id, parentRunId: parent.id, nodeId: 'assets' })).rejects.toThrow('原单步骤范围');
  const restarted = runSchema.parse(await restored.dispatch('run.start', { projectId: project.id, parentRunId: parent.id })); await restored.waitForIdle();
  const detail = runInspectionSchema.parse(await restored.dispatch('run.inspect', { runId: restarted.id }));
  expect(detail.steps.map(step => step.id)).toEqual(['style']); expect(restarted.id).not.toBe(parent.id); expect(await current(restored, project.id)).toEqual(edited);
});

it('keeps a standalone export scope, exact fractional profile and destination after cancellation and project edits', async () => {
  let hold = true, entered = false; const calls: Array<{ node: WorkflowNode; profile: ProjectDocument['profile']; title: string }> = [];
  const executeActivity: NonNullable<RuntimeOptions['executeActivity']> = async context => {
    calls.push({ node: context.node, profile: context.project.profile, title: context.project.title });
    if (hold) { entered = true; await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('canceled export')), { once: true })); }
    return localArtifacts(context);
  };
  const { runtime, directory, project } = await setup({ executeActivity });
  const profile = { ...project.profile, width: 320, height: 180, frameRate: { numerator: 30000, denominator: 1001 } }, destination = join(directory, 'chosen-output.mp4');
  const parent = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'export', profile, destination }));
  await vi.waitFor(() => expect(entered).toBe(true)); await runtime.dispatch('run.cancel', { runId: parent.id }); await runtime.waitForIdle(); hold = false;
  const edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { title: '重新导出的当前标题', profile: { ...project.profile, width: 640, height: 360 }, workflow: { ...project.workflow, nodes: project.workflow.nodes.map(node => node.id === 'export' ? { ...node, kind: 'agent', config: { destination: join(directory, 'changed-output.mp4') } } : node) } } }));
  await expect(runtime.dispatch('run.start', { projectId: project.id, parentRunId: parent.id, profile: edited.profile })).rejects.toThrow('保留原规格和路径');
  const restarted = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, parentRunId: parent.id })); await runtime.waitForIdle();
  expect(runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: restarted.id })).steps.map(step => step.id)).toEqual(['export']);
  expect(await runtime.dispatch('run.get', { runId: restarted.id })).toMatchObject({ status: 'succeeded', projectRevision: edited.revision });
  expect(calls).toHaveLength(2); expect(calls[1]).toMatchObject({ node: { id: 'export', kind: 'export', config: { destination } }, profile, title: edited.title });
  expect(await current(runtime, project.id)).toEqual(edited);
  expect(await runtime.dispatch('cost.summary', { projectId: project.id })).toMatchObject({ total: 0 });
});

it.each(['removed', 'kind'] as const)('rejects an older single-step restart when the selected node was %s without creating a broader task', async change => {
  const { runtime, directory, project } = await setup();
  const parent = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'style' })); await runtime.waitForIdle(); await runtime.dispatch('run.cancel', { runId: parent.id });
  const restored = await reopenLegacyRun(runtime, directory, parent.id);
  const workflow = change === 'removed'
    ? { ...project.workflow, nodes: project.workflow.nodes.filter(node => node.id !== 'style'), edges: project.workflow.edges.filter(edge => edge.source !== 'style' && edge.target !== 'style') }
    : { ...project.workflow, nodes: project.workflow.nodes.map(node => node.id === 'style' ? { ...node, kind: 'agent' } : node) };
  const edited = projectSchema.parse(await restored.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow } }));
  await expect(restored.dispatch('run.start', { projectId: project.id, parentRunId: parent.id })).rejects.toThrow('已删除或变更类型');
  expect((await restored.dispatch('run.list', { projectId: project.id }) as { items: unknown[] }).items).toHaveLength(1); expect(await current(restored, project.id)).toEqual(edited);
});

it('keeps a full one-node workflow distinct from an older partial single-step task', async () => {
  const { runtime, project } = await setup();
  const single = projectSchema.parse(await runtime.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow: { id: 'one', name: '原完整流程', version: 1, nodes: [{ id: 'one', kind: 'brief', label: '原步骤', requiresReview: true }], edges: [] } }));
  const parent = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await runtime.waitForIdle(); await runtime.dispatch('run.cancel', { runId: parent.id });
  await runtime.dispatch('workflow.save', { projectId: project.id, revision: single.revision, workflow: { ...single.workflow, nodes: [{ ...single.workflow.nodes[0], requiresReview: false }, { id: 'two', kind: 'brief', label: '新步骤' }] } });
  const restarted = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, parentRunId: parent.id })); await runtime.waitForIdle();
  expect(runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: restarted.id })).steps.map(step => step.id)).toEqual(['one', 'two']);
});

it('routes a canceled batch child restart back to the same frozen batch and never invokes models or charges', async () => {
  let hold = true, entered = false; const calls: Array<{ width: number; title: string }> = [], provider = vi.fn(async () => 'must not call a text model');
  const { runtime, project } = await setup({ provider, executeActivity: async context => {
    expect(context.node.kind).toBe('export'); expect(context.model).toBeUndefined(); calls.push({ width: context.project.profile.width, title: context.project.title });
    if (hold && context.project.profile.width === 180) { entered = true; await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('canceled locally')), { once: true })); }
    return localArtifacts(context);
  } });
  const batch = exportBatchSchema.parse(await runtime.dispatch('render.batch.start', { projectId: project.id, revision: project.revision, targets: [{ id: 'wide', label: '横屏', profile: { ...DEFAULT_VIDEO_PROFILE, width: 320, height: 180 } }, { id: 'portrait', label: '竖屏', profile: { ...DEFAULT_VIDEO_PROFILE, width: 180, height: 320 } }] }));
  await vi.waitFor(() => expect(entered).toBe(true));
  const pending = exportBatchSchema.parse(await runtime.dispatch('render.batch.get', { batchId: batch.id })), childId = pending.targets[1].runId!;
  const firstStat = await stat(pending.targets[0].videoPath!); await runtime.dispatch('run.cancel', { runId: childId });
  await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { title: '批量启动之后的新标题' } }); hold = false;
  const restarted = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, parentRunId: childId }));
  expect(restarted.id).toBe(childId); await runtime.waitForIdle();
  const completed = exportBatchSchema.parse(await runtime.dispatch('render.batch.get', { batchId: batch.id })); expect(completed.status).toBe('succeeded'); expect(completed.targets[1].runId).toBe(childId);
  expect(calls).toEqual([{ width: 320, title: project.title }, { width: 180, title: project.title }, { width: 180, title: project.title }]); expect((await stat(completed.targets[0].videoPath!)).mtimeMs).toBe(firstStat.mtimeMs);
  expect(provider).not.toHaveBeenCalled(); expect((await runtime.dispatch('cost.list', { projectId: project.id }) as { items: UsageRecord[] }).items).toEqual([]);
  expect((await runtime.dispatch('render.batch.list', { projectId: project.id }) as { items: unknown[] }).items).toHaveLength(1);
});

it('keeps ordinary canceled workflow restarts as new full runs and rejects cross-project parent reuse', async () => {
  let hold = true, entered = false; const prompts: string[] = [];
  const { runtime, project } = await setup({ provider: async request => {
    prompts.push(request.prompt);
    if (hold) { entered = true; await new Promise<void>((_resolve, reject) => request.signal?.addEventListener('abort', () => reject(new Error('cancel text request')), { once: true })); }
    return '普通工作流文本';
  } });
  const model = await runtime.dispatch('model.save', { model: { name: '本地注入模型', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'text-fixture', capabilities: ['text'] } }) as ModelProfile;
  const nodes = project.workflow.nodes.filter(node => node.kind === 'brief' || node.kind === 'style').map(node => ({ ...node, modelId: model.id, requiresReview: false })); expect(nodes).toHaveLength(2);
  const ready = projectSchema.parse(await runtime.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow: { ...project.workflow, nodes, edges: [{ id: 'brief-to-style', source: nodes[0].id, target: nodes[1].id }] } }));
  const parent = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await vi.waitFor(() => expect(entered).toBe(true));
  await runtime.dispatch('run.cancel', { runId: parent.id }); await runtime.waitForIdle(); hold = false;
  const other = projectSchema.parse(await runtime.dispatch('project.create', { title: '其他项目' })); await expect(runtime.dispatch('run.start', { projectId: other.id, parentRunId: parent.id })).rejects.toThrow('不属于');
  const restarted = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, parentRunId: parent.id })); await runtime.waitForIdle();
  expect(restarted).toMatchObject({ parentRunId: parent.id, projectRevision: ready.revision }); expect(restarted.id).not.toBe(parent.id); expect(prompts).toHaveLength(3);
  expect(await runtime.dispatch('run.get', { runId: restarted.id })).toMatchObject({ status: 'succeeded' });
  for (const node of nodes) expect(await runtime.dispatch('node.result', { runId: restarted.id, nodeId: node.id })).toBeDefined();
});
