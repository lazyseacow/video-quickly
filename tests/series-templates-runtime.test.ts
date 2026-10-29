import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSceneTemplate, DEFAULT_CAPTION_STYLE, projectSchema, runSchema, seriesTemplateSchema, type CaptionStyle, type ModelProfile, type ProjectDocument, type RecordPage, type SeriesSettings, type SeriesTemplate, type ShotCandidate, type ShotCandidateKind } from '@video-quickly/contracts';
import { createActivityExecutor } from '../packages/integrations/src';
import { createRuntime } from '../packages/runtime/src';

const directories: string[] = [], servers: Server[] = [];
const runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => { await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear(); await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }))); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const settings: SeriesSettings = { style: '固定的系列画风与文字口吻', captionStyle: { ...DEFAULT_CAPTION_STYLE, fontSizeRatio: .04, textColor: '#E0F0FF' }, scenePreset: { kind: 'process', palette: 'amber', motion: 'none' } };
function open(directory: string) { const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/unused-by-series-tests', executeActivity: createActivityExecutor() }); runtimes.add(runtime); return runtime; }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-series-')); directories.push(directory); const runtime = open(directory);
  return { runtime, directory };
}
async function save(runtime: ReturnType<typeof createRuntime>, name: string, extra: Partial<SeriesTemplate> = {}) { return seriesTemplateSchema.parse(await runtime.dispatch('seriesTemplate.save', { template: { name, description: '可复用设置，不含题目事实', settings, ...extra } })); }
async function current(runtime: ReturnType<typeof createRuntime>, projectId: string) { return (await runtime.dispatch('project.get', { projectId }) as { project: ProjectDocument }).project; }

it('persists a bounded template library with stable cursor pages, optimistic revisions and reversible archival', async () => {
  const { runtime, directory } = await fixture(); const first = await save(runtime, '一号'), second = await save(runtime, '二号');
  const page = await runtime.dispatch('seriesTemplate.list', { limit: 1 }) as RecordPage<SeriesTemplate>; expect(page.items).toEqual([second]); expect(page.nextCursor).not.toBeNull();
  const third = await save(runtime, '后插入'); const next = await runtime.dispatch('seriesTemplate.list', { before: page.nextCursor, limit: 1 }) as RecordPage<SeriesTemplate>; expect(next.items).toEqual([first]); expect(next.nextCursor).toBeNull();
  const edited = await save(runtime, '改名', { id: first.id, revision: first.revision, settings: { ...settings, scenePreset: null } }); expect(edited.revision).toBe(2); expect(edited.settings.scenePreset).toBeNull(); expect(edited.createdAt).toBe(first.createdAt);
  await expect(save(runtime, '旧表单', { id: first.id, revision: first.revision })).rejects.toThrow('其他视图修改'); await expect(save(runtime, '漏修订', { id: first.id })).rejects.toThrow('其他视图修改');
  const archived = seriesTemplateSchema.parse(await runtime.dispatch('seriesTemplate.archive', { templateId: first.id, revision: edited.revision })); expect(archived.archived).toBe(true);
  expect((await runtime.dispatch('seriesTemplate.list', { archived: true }) as RecordPage<SeriesTemplate>).items).toEqual([archived]); expect((await runtime.dispatch('seriesTemplate.list') as RecordPage<SeriesTemplate>).items.map(template => template.id)).toEqual([third.id, second.id]);
  await expect(runtime.dispatch('seriesTemplate.restore', { templateId: first.id, revision: edited.revision })).rejects.toThrow('其他视图修改');
  const restored = seriesTemplateSchema.parse(await runtime.dispatch('seriesTemplate.restore', { templateId: first.id, revision: archived.revision })); expect(restored.revision).toBe(4); expect(restored.archived).toBe(false);
  await expect(runtime.dispatch('seriesTemplate.list', { limit: 101 })).rejects.toThrow();
  await runtime.close(); runtimes.delete(runtime); const reopened = open(directory); expect(await reopened.dispatch('seriesTemplate.get', { templateId: first.id })).toEqual(restored);
  const summary = await reopened.dispatch('workspace.summary'); expect(JSON.stringify(summary)).not.toContain('可复用设置，不含题目事实');
});

it('copies a selected template revision into a new project without a live link or any facts, media or shots', async () => {
  const { runtime } = await fixture(), template = await save(runtime, '复制设置');
  await expect(runtime.dispatch('project.create', { title: '缺修订', seriesTemplateId: template.id })).rejects.toThrow('当前修订'); await expect(runtime.dispatch('project.create', { title: '旧修订', seriesTemplateId: template.id, seriesTemplateRevision: 2 })).rejects.toThrow('其他视图修改');
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '全新选题', brief: '新的简报', seriesTemplateId: template.id, seriesTemplateRevision: template.revision })); expect(project).toMatchObject({ ...settings, title: '全新选题', brief: '新的简报', revision: 1, shots: [], claims: [] }); expect(project.researchSources).toBeUndefined();
  const edited = await save(runtime, '修改库但不修改项目', { id: template.id, revision: template.revision, settings: { style: '后来的库风格', captionStyle: null, scenePreset: null } });
  expect(await current(runtime, project.id)).toEqual(project);
  const archived = seriesTemplateSchema.parse(await runtime.dispatch('seriesTemplate.archive', { templateId: edited.id, revision: edited.revision })); expect(await current(runtime, project.id)).toEqual(project);
  await expect(runtime.dispatch('project.create', { title: '使用归档', seriesTemplateId: archived.id, seriesTemplateRevision: archived.revision })).rejects.toThrow('已归档');
  const legacy = projectSchema.parse(await runtime.dispatch('project.create', { title: '未选择预设' })); expect(legacy.captionStyle).toBeUndefined(); expect(legacy.scenePreset).toBeUndefined();
});

it('saves style edits and explicit inheritance exactly, rejects a stale external edit, and restores them from backup', async () => {
  const { runtime } = await fixture(), template = await save(runtime, '外部边界'), original = projectSchema.parse(await runtime.dispatch('project.create', { title: '项目', seriesTemplateId: template.id, seriesTemplateRevision: template.revision }));
  const shotStyle: CaptionStyle = { ...DEFAULT_CAPTION_STYLE, fontId: 'serif', position: 'top', fontWeight: 700 };
  const saved = projectSchema.parse(await runtime.dispatch('project.update', { projectId: original.id, revision: original.revision, patch: { captionStyle: null, scenePreset: null, shots: [{ id: 'shot', title: '镜头', narration: '', visualPrompt: '', durationUs: 1_000_000, captionStyle: shotStyle }] } })); expect(saved.captionStyle).toBeNull(); expect(saved.scenePreset).toBeNull(); expect(saved.shots[0].captionStyle).toEqual(shotStyle);
  await expect(runtime.dispatch('project.update', { projectId: original.id, revision: original.revision, patch: { style: '过期表单的系列风格', captionStyle: settings.captionStyle } })).rejects.toThrow('其他视图修改'); expect(await current(runtime, original.id)).toEqual(saved);
  const inherited = projectSchema.parse(await runtime.dispatch('project.saveShot', { projectId: saved.id, revision: saved.revision, shot: { ...saved.shots[0], captionStyle: null } })); expect(inherited.shots[0].captionStyle).toBeNull();
  const backup = await runtime.dispatch('project.backup', { projectId: saved.id }) as { path: string }, restored = projectSchema.parse(await runtime.dispatch('project.importBackup', { path: backup.path })); expect(restored.captionStyle).toBeNull(); expect(restored.scenePreset).toBeNull(); expect(restored.shots[0].captionStyle).toBeNull();
  const manifest = JSON.parse(await readFile(join(backup.path, 'project.json'), 'utf8')) as { project: ProjectDocument }; expect(manifest.project.captionStyle).toBeNull();
});

async function generationFixture() {
  const { runtime, directory } = await fixture(), requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const state = { shots: [{ title: '新脚本文案', narration: '新旁白', visualPrompt: '新画面', captionStyle: { ...DEFAULT_CAPTION_STYLE, textColor: '#FF0000' } }] };
  const server = createServer((request, response) => { void (async () => {
    let text = ''; for await (const chunk of request) text += chunk.toString(); const path = request.url ?? ''; requests.push({ path, body: JSON.parse(text) });
    if (path.endsWith('/chat/completions')) response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ shots: state.shots }) } }] }));
    else if (path.endsWith('/images/generations')) response.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }] }));
    else if (path.endsWith('/audio/speech')) response.end(Buffer.from('new audio fixture bytes'));
    else if (path.endsWith('/video')) response.end(JSON.stringify({ data: Buffer.from('new video fixture bytes').toString('base64') }));
    else { response.statusCode = 404; response.end(); }
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); }); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务地址无效');
  const models = {} as Record<ShotCandidateKind, ModelProfile>;
  for (const [kind, capability] of [['script', 'text'], ['image', 'image'], ['audio', 'tts'], ['video', 'video']] as const) models[kind] = await runtime.dispatch('model.save', { model: { name: `${kind}模型`, provider: kind === 'video' ? 'custom-http' : 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: `fixture-${kind}`, capabilities: [capability], parameters: kind === 'video' ? { requestPath: '/video', requestTemplate: { prompt: '{{prompt}}' }, resultBase64Path: 'data' } : {} } }) as ModelProfile;
  const template = await save(runtime, '固定系列'), created = projectSchema.parse(await runtime.dispatch('project.create', { title: '生成项目', seriesTemplateId: template.id, seriesTemplateRevision: template.revision }));
  const diagram = { ...createSceneTemplate('comparison'), heading: '已有真实题目的人工图解' }, shotStyle: CaptionStyle = { ...DEFAULT_CAPTION_STYLE, fontId: 'serif', fontWeight: 700 };
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: { shots: [{ id: 'shot-1', title: '人工镜头1', narration: '人工旁白1', visualPrompt: '人工画面1', durationUs: 1_000_000, sceneTemplate: diagram, captionStyle: shotStyle }, { id: 'shot-2', title: '人工镜头2', narration: '人工旁白2', visualPrompt: '人工画面2', durationUs: 1_000_000, captionStyle: null }] } }));
  return { runtime, directory, project, models, template, state, requests, diagram, shotStyle };
}
async function candidate(runtime: ReturnType<typeof createRuntime>, project: ProjectDocument, kind: ShotCandidateKind, model: ModelProfile) {
  await runtime.dispatch('shot.regenerate', { projectId: project.id, shotId: 'shot-1', kind, modelId: model.id, revision: project.revision }); await runtime.waitForIdle();
  const page = await runtime.dispatch('shot.candidates', { projectId: project.id, shotId: 'shot-1', limit: 1 }) as { items: ShotCandidate[] }; expect(page.items).toHaveLength(1); return page.items[0];
}

it('retains authored shot styles and diagrams while applying a copied preset only to newly generated shots', async () => {
  const { runtime, project, models, template, state, requests, diagram, shotStyle } = await generationFixture();
  state.shots = [0, 1, 2].map(index => ({ ...state.shots[0], title: `模型镜头${index}` }));
  const ready = projectSchema.parse(await runtime.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow: { ...project.workflow, nodes: project.workflow.nodes.map(node => node.kind === 'script' ? { ...node, modelId: models.script.id, requiresReview: false } : node) } }));
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'script' })); await runtime.waitForIdle();
  const result = await runtime.dispatch('node.result', { runId: run.id, nodeId: 'script' }) as { shots: ProjectDocument['shots'] }; expect(result.shots[0].captionStyle).toEqual(shotStyle); expect(result.shots[0].sceneTemplate).toEqual(diagram); expect(result.shots[1].captionStyle).toBeNull(); expect(result.shots[1].sceneTemplate).toBeUndefined(); expect(result.shots[2].captionStyle).toBeUndefined(); expect(result.shots[2].sceneTemplate).toMatchObject({ ...settings.scenePreset, heading: expect.stringContaining('示例') });
  expect(JSON.stringify(requests[0].body)).not.toContain('fontSizeRatio');
  const edited = await save(runtime, '后来修改的库', { id: template.id, revision: template.revision, settings: { style: '后来的库风格', captionStyle: null, scenePreset: null } }); await runtime.dispatch('seriesTemplate.archive', { templateId: edited.id, revision: edited.revision });
  const applied = projectSchema.parse(await runtime.dispatch('node.apply', { runId: run.id, nodeId: 'script', revision: ready.revision })); expect(applied.style).toBe(settings.style); expect(applied.captionStyle).toEqual(settings.captionStyle); expect(applied.scenePreset).toEqual(settings.scenePreset);
  const laterRun = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'script' })); await runtime.waitForIdle(); const changed = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: applied.revision, patch: { style: '项目真实生成风格已更改' } })); await expect(runtime.dispatch('node.apply', { runId: laterRun.id, nodeId: 'script', revision: changed.revision })).rejects.toThrow('生成后修改');
});

it('allows library and caption-only edits after a shot generation while preserving current display settings', async () => {
  const { runtime, project, models, template, shotStyle } = await generationFixture(); const generated = await candidate(runtime, project, 'script', models.script);
  await save(runtime, '只改库', { id: template.id, revision: template.revision, settings: { ...settings, style: '库另一个版本' } });
  const updatedCaption: CaptionStyle = { ...DEFAULT_CAPTION_STYLE, textColor: '#102030', position: 'top' }, edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { captionStyle: updatedCaption, scenePreset: null, shots: project.shots.map(shot => shot.id === 'shot-1' ? { ...shot, captionStyle: { ...shotStyle, textColor: '#654321' } } : shot) } }));
  const applied = projectSchema.parse(await runtime.dispatch('shot.candidate.apply', { projectId: project.id, revision: edited.revision, candidateId: generated.id })); expect(applied.captionStyle).toEqual(updatedCaption); expect(applied.scenePreset).toBeNull(); expect(applied.shots[0].captionStyle).toEqual({ ...shotStyle, textColor: '#654321' }); expect(applied.style).toBe(settings.style); expect(applied.shots[0].title).toBe('新脚本文案');
});

it.each(['script', 'image', 'video'] as const)('rejects a %s candidate after its actual project style input changes', async kind => {
  const { runtime, project, models } = await generationFixture(), generated = await candidate(runtime, project, kind, models[kind]);
  const edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { style: '人工切换了项目的生成风格' } }));
  await expect(runtime.dispatch('shot.candidate.apply', { projectId: project.id, revision: edited.revision, candidateId: generated.id })).rejects.toThrow('项目风格已修改'); expect(await current(runtime, project.id)).toEqual(edited);
});

it('keeps a voice candidate usable after visual generation style changes', async () => {
  const { runtime, project, models } = await generationFixture(), generated = await candidate(runtime, project, 'audio', models.audio);
  const edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { style: '只改视觉风格' } }));
  const applied = projectSchema.parse(await runtime.dispatch('shot.candidate.apply', { projectId: project.id, revision: edited.revision, candidateId: generated.id })); expect(applied.style).toBe(edited.style); expect(applied.shots[0].audioAssetId).toBe(generated.shot.audioAssetId); expect(applied.shots[0].captionStyle).toEqual(project.shots[0].captionStyle);
});

it('guards a custom voice request that really maps the visual prompt into its payload', async () => {
  const { runtime, project, models, requests } = await generationFixture();
  const model = await runtime.dispatch('model.save', { model: { ...models.audio, provider: 'custom-http', parameters: { requestPath: '/video', requestTemplate: { prompt: '{{prompt}}', narration: '{{narration}}' }, resultBase64Path: 'data' } } }) as ModelProfile;
  const generated = await candidate(runtime, project, 'audio', model); expect(JSON.stringify(requests[0].body)).toContain(project.style);
  const edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { style: '自定义请求实际使用的风格发生更改' } }));
  await expect(runtime.dispatch('shot.candidate.apply', { projectId: project.id, revision: edited.revision, candidateId: generated.id })).rejects.toThrow('项目风格已修改');
});

it('does not invalidate a custom image request that never consumed the project style', async () => {
  const { runtime, project, models, requests } = await generationFixture();
  const model = await runtime.dispatch('model.save', { model: { ...models.image, provider: 'custom-http', parameters: { requestPath: '/images/generations', requestTemplate: { narration: '{{narration}}' }, resultBase64Path: 'data.0.b64_json' } } }) as ModelProfile;
  const generated = await candidate(runtime, project, 'image', model); expect(JSON.stringify(requests[0].body)).not.toContain(project.style);
  const edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { style: '没有用于本次图片请求的风格变更' } }));
  const applied = projectSchema.parse(await runtime.dispatch('shot.candidate.apply', { projectId: project.id, revision: edited.revision, candidateId: generated.id })); expect(applied.style).toBe(edited.style); expect(applied.shots[0].assetId).toBe(generated.shot.assetId);
});
