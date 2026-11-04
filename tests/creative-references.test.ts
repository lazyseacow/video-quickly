import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { assetRecoveryJobSchema, assetRecoveryPageSchema, assetSchema, buildMediaPrompt, characterProfileSchema, creativeContextSchema, creativeReferenceAssetIds, createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, modelSchema, projectReadinessSchema, projectSchema, promptPreviewSchema, promptSessionSchema, runSchema, shotSchema, workDefaultsSchema, workSchema, workflowNodeSchema, type AssetRecord, type JsonValue, type ShotCandidate } from '@video-quickly/contracts';
import { resolveCharacterReferences } from '../packages/integrations/src/character-references';
import { createActivityExecutor, validateMediaActivity } from '../packages/integrations/src';
import { createRuntime, type RuntimeOptions } from '../packages/runtime/src/index';
import { buildWorkflowPrompt, parseWorkflowScript } from '../packages/runtime/src/workflow-prompts';

const directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [], servers: Server[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); }));
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })));
});
const context = (scene = 'scene-image', prop = 'prop-image') => creativeContextSchema.parse({ entities: [
  { key: 'garden', kind: 'scene', name: '花园', description: '石喷泉与木门', referenceAssetIds: [scene] },
  { key: 'box', kind: 'prop', name: '木盒', description: '红漆与铜锁', referenceAssetIds: [prop, scene] },
  { key: 'kitchen', kind: 'scene', name: '厨房', description: '银色水槽', referenceAssetIds: ['unused-image'] },
] });
const shot = () => shotSchema.parse({ id: 'first', title: '花园发现木盒', narration: '盒子在这里。', visualPrompt: '人物在花园中', durationUs: 1_000_000, creativeEntityKeys: ['garden', 'box'] });
async function fixture(extra: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-creative-reference-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ...extra }); runtimes.push(runtime);
  const path = join(directory, 'reference.png'); await writeFile(path, png);
  const assets: AssetRecord[] = [];
  for (let index = 0; index < 3; index++) assets.push(assetSchema.parse(await runtime.dispatch('asset.import', { path, kind: 'image' })));
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '场景参考' }));
  return { runtime, directory, path, assets, created };
}

async function imageService() {
  const requests: { path: string; body: Record<string, JsonValue> }[] = [];
  const server = createServer((request, response) => { void (async () => {
    let raw = ''; for await (const bytes of request) raw += String(bytes);
    requests.push({ path: request.url ?? '', body: JSON.parse(raw) });
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
  return { requests, baseUrl: `http://127.0.0.1:${address.port}` };
}

it('keeps legacy entities unchanged and bounds typed visual references', () => {
  const entity = { key: 'garden', kind: 'scene', name: '花园', description: '' };
  expect(creativeContextSchema.parse({ entities: [entity] }).entities).toEqual([entity]);
  for (const invalid of [{ ...entity, referenceAssetIds: ['a', 'a'] }, { ...entity, referenceAssetIds: ['a', 'b', 'c', 'd', 'e'] }, { ...entity, kind: 'character', referenceAssetIds: ['a'] }]) expect(creativeContextSchema.safeParse({ entities: [invalid] }).success).toBe(false);
  expect(creativeReferenceAssetIds({ creativeContext: context() }, shot())).toEqual(['scene-image', 'prop-image']);
  expect(creativeReferenceAssetIds({ creativeContext: context() })).toEqual(['scene-image', 'prop-image', 'unused-image']);
  expect(creativeReferenceAssetIds({ creativeContext: context() }, { creativeEntityKeys: [] })).toEqual([]);
});

it('resolves only the shot’s selected references, with role-first deduplication and file verification', async () => {
  const source = await fixture(), [scene, prop, role] = source.assets;
  const character = characterProfileSchema.parse({ id: 'role', name: '小青', description: '蓝衣', referenceAssetIds: [role.id, scene.id], revision: 1, createdAt: '', updatedAt: '' });
  const project = { creativeContext: context(scene.id, prop.id) }, selected = { ...shot(), characterIds: [character.id] };
  const resolved = await resolveCharacterReferences({ project, shot: selected, characters: [character], assets: source.assets });
  expect(resolved.images.map(image => image.assetId)).toEqual([role.id, scene.id, prop.id]);
  expect(resolved.images.every(image => image.dataUrl === `data:image/png;base64,${png.toString('base64')}`)).toBe(true);
  await expect(resolveCharacterReferences({ project, shot: { creativeEntityKeys: ['kitchen'] }, assets: source.assets })).rejects.toThrow('公共图片');
  await writeFile(prop.path, Buffer.alloc(prop.size, 0));
  await expect(resolveCharacterReferences({ project, shot: selected, characters: [character], assets: source.assets })).rejects.toThrow('校验失败');
  await expect(resolveCharacterReferences({ project, shot: { creativeEntityKeys: ['garden'] }, assets: source.assets })).resolves.toMatchObject({ images: [{ assetId: scene.id }] });
});

it('uses identical reference numbering in shared generation and edit prompts', () => {
  const project = projectSchema.parse({ id: 'p', title: '场景', brief: '', revision: 1, createdAt: '', updatedAt: '', creativeContext: context(), shots: [shot()], profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow() });
  const character = characterProfileSchema.parse({ id: 'role', name: '小青', description: '蓝衣', referenceAssetIds: ['role-image'], revision: 1, createdAt: '', updatedAt: '' });
  const selected = { ...shot(), characterIds: [character.id] };
  const node = workflowNodeSchema.parse({ id: 'image', kind: 'assets', label: '图片' });
  const prompt = buildMediaPrompt(project, node, selected, [character]);
  expect(prompt).toContain('参考图：图片 1'); expect(prompt).toContain('场景「花园」参考图：图片 2'); expect(prompt).toContain('道具「木盒」参考图：图片 3、图片 2'); expect(prompt).not.toContain('银色水槽');
  const edit = buildMediaPrompt(project, { ...node, config: { imageEdit: { sourceAssetId: 'source-image' } } }, selected, [character]);
  expect(edit).toContain('图片 1 为待修改原图'); expect(edit).toContain('参考图：图片 2'); expect(edit).toContain('场景「花园」参考图：图片 3');
});

it('keeps reference identities out of text prompts and rejects model-authored image bindings', async () => {
  const source = await fixture();
  const project = { ...source.created, creativeContext: context(), shots: [shot()] };
  const node = project.workflow.nodes.find(node => node.kind === 'script')!;
  const prompt = buildWorkflowPrompt(project, node, [], false, []);
  expect(prompt).not.toContain('referenceAssetIds'); expect(prompt).not.toContain('scene-image');
  const output = { shots: [{ ...shot(), entityKeys: ['garden'] }], entities: [{ key: 'garden', kind: 'scene', name: '花园', description: '石喷泉与木门' }] };
  expect(parseWorkflowScript(JSON.stringify(output), project).creativeContext?.entities[0].referenceAssetIds).toEqual(['scene-image']);
  expect(() => parseWorkflowScript(JSON.stringify({ ...output, entities: [{ ...output.entities[0], referenceAssetIds: ['fabricated'] }] }), project)).toThrow('不能设置参考图');
});

it('validates project and work references and retains archived work defaults', async () => {
  const source = await fixture(), [scene, prop] = source.assets;
  const privateImage = assetSchema.parse(await source.runtime.dispatch('asset.import', { path: source.path, kind: 'image', projectId: source.created.id }));
  await expect(source.runtime.dispatch('project.update', { projectId: source.created.id, revision: source.created.revision, patch: { creativeContext: context(privateImage.id, prop.id) } })).rejects.toThrow('公共素材库');
  const valid = creativeContextSchema.parse({ entities: context(scene.id, prop.id).entities.slice(0, 2) });
  const work = workSchema.parse(await source.runtime.dispatch('work.save', { title: '参考作品', defaults: { ...workDefaultsSchema.parse({}), creativeContext: valid } }));
  await expect(source.runtime.dispatch('asset.delete', { assetId: scene.id })).rejects.toThrow('正在使用');
  await source.runtime.dispatch('work.archive', { workId: work.id, revision: work.revision });
  await expect(source.runtime.dispatch('asset.delete', { assetId: prop.id })).rejects.toThrow('正在使用');
  const result = await source.runtime.dispatch('work.episodes.create', { workId: work.id, revision: work.revision, requestId: randomUUID(), episodes: [{ number: 1, title: '一', originalText: '' }] }).catch(error => error);
  expect(result).toBeInstanceOf(Error);
});

it('backs up public scene and prop references and remaps restored identities', async () => {
  const source = await fixture(), [scene, prop] = source.assets;
  const creativeContext = creativeContextSchema.parse({ entities: context(scene.id, prop.id).entities.slice(0, 2) });
  const project = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: source.created.id, revision: source.created.revision, patch: { creativeContext, shots: [shot()] } }));
  const backup = await source.runtime.dispatch('project.backup', { projectId: project.id }) as { path: string };
  const manifest = JSON.parse(await readFile(join(backup.path, 'project.json'), 'utf8')) as { schemaVersion: number; assets: AssetRecord[] };
  expect(manifest.schemaVersion).toBeGreaterThanOrEqual(8);
  expect(manifest.assets.map(asset => asset.id)).toEqual(expect.arrayContaining([scene.id, prop.id]));
  const restored = projectSchema.parse(await source.runtime.dispatch('project.importBackup', { path: backup.path }));
  const ids = creativeReferenceAssetIds(restored);
  expect(ids).toHaveLength(2); expect(ids).not.toContain(scene.id); expect(ids).not.toContain(prop.id);
  const restoredAssets = assetSchema.array().parse(await source.runtime.dispatch('asset.getMany', { assetIds: ids }));
  expect(restoredAssets.every(asset => asset.projectId === undefined && asset.sha256 === createHash('sha256').update(png).digest('hex'))).toBe(true);
  await expect(source.runtime.dispatch('asset.delete', { assetId: ids[0] })).rejects.toThrow('正在使用');
});

it('sends selected scene and prop images through the actual adapter and rejects stale candidate references', async () => {
  const { requests, baseUrl } = await imageService();
  const ffmpegPath = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
  const source = await fixture({ ffmpegPath, preflightActivity: validateMediaActivity, executeActivity: createActivityExecutor({ ffmpegPath }) });
  const [scene, prop, role] = source.assets;
  const character = characterProfileSchema.parse(await source.runtime.dispatch('character.save', { character: { name: '小青', description: '蓝衣黑发', referenceAssetIds: [role.id] } }));
  const model = modelSchema.parse(await source.runtime.dispatch('model.save', { model: { name: '场景图片夹具', provider: 'openai-compatible', connectionType: 'image', capabilities: ['image'], model: 'fixture-image', baseUrl } }));
  const creativeContext = creativeContextSchema.parse({ entities: context(scene.id, prop.id).entities.slice(0, 2) });
  const selected = { ...shot(), characterIds: [character.id] };
  const project = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: source.created.id, revision: source.created.revision, patch: { creativeContext, shots: [selected] } }));
  const node = project.workflow.nodes.find(node => node.kind === 'assets')!;
  const preview = promptPreviewSchema.parse(await source.runtime.dispatch('prompt.preview', { projectId: project.id, projectRevision: project.revision, node: { ...node, modelId: model.id }, shotId: selected.id }));
  const session = promptSessionSchema.parse(await source.runtime.dispatch('promptSession.save', { draft: { projectId: project.id, projectRevision: project.revision, node: { ...node, modelId: model.id }, shotId: selected.id }, previewDigest: preview.digest }));
  const run = runSchema.parse(await source.runtime.dispatch('promptTrial.start', { sessionId: session.id, revision: session.revision, requestId: randomUUID() })); await source.runtime.waitForIdle();
  const finished = runSchema.parse(await source.runtime.dispatch('run.get', { runId: run.id })); expect(finished.status, finished.error).toBe('succeeded');
  expect(requests).toHaveLength(1); expect(requests[0].path).toBe('/images/edits'); expect(requests[0].body.prompt).toBe(preview.prompt);
  expect(requests[0].body.images).toHaveLength(3); expect(preview.prompt).toContain('场景「花园」参考图：图片 2'); expect(preview.prompt).not.toContain('厨房');
  const page = await source.runtime.dispatch('shot.candidates', { projectId: project.id, shotId: selected.id }) as { items: ShotCandidate[] }; expect(page.items).toHaveLength(1);
  const changed = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { creativeContext: { ...creativeContext, entities: creativeContext.entities.map(entity => entity.key === 'garden' ? { ...entity, referenceAssetIds: [prop.id] } : entity) } } }));
  await expect(source.runtime.dispatch('shot.candidate.apply', { projectId: project.id, revision: changed.revision, candidateId: page.items[0].id })).rejects.toThrow('创作设定');
});

it('includes public entity references in project readiness and missing-asset recovery', async () => {
  const source = await fixture(), [scene, prop] = source.assets;
  const creativeContext = creativeContextSchema.parse({ entities: context(scene.id, prop.id).entities.slice(0, 2) });
  const project = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: source.created.id, revision: source.created.revision, patch: { creativeContext, shots: [shot()] } }));
  await unlink(scene.path);
  const readiness = projectReadinessSchema.parse(await source.runtime.dispatch('project.readiness', { projectId: project.id }));
  expect(readiness.issues.some(issue => issue.assetId === scene.id && issue.severity === 'error')).toBe(true);
  const job = assetRecoveryJobSchema.parse(await source.runtime.dispatch('asset.recovery.start', { projectId: project.id })); await source.runtime.waitForIdle();
  const recovery = assetRecoveryPageSchema.parse(await source.runtime.dispatch('asset.recovery.get', { jobId: job.id }));
  expect(recovery.items.find(item => item.assetId === scene.id)?.status).toBe('missing');
  expect(recovery.items.find(item => item.assetId === prop.id)?.status).toBe('available');
});

it('uses and retains experiment-only scene references while keeping production context unchanged until explicit candidate application', async () => {
  const { requests, baseUrl } = await imageService(), ffmpegPath = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
  const source = await fixture({ ffmpegPath, preflightActivity: validateMediaActivity, executeActivity: createActivityExecutor({ ffmpegPath }) }), [original, alternate] = source.assets;
  const model = modelSchema.parse(await source.runtime.dispatch('model.save', { model: { name: '实验场景图片', provider: 'openai-compatible', connectionType: 'image', capabilities: ['image'], model: 'fixture-image', baseUrl } }));
  const creativeContext = creativeContextSchema.parse({ entities: [context(original.id).entities[0]] });
  const selected = { ...shot(), creativeEntityKeys: ['garden'] };
  const project = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: source.created.id, revision: source.created.revision, patch: { creativeContext, shots: [selected] } }));
  const node = project.workflow.nodes.find(node => node.kind === 'assets')!;
  const experimental = { ...creativeContext, entities: creativeContext.entities.map(entity => ({ ...entity, referenceAssetIds: [alternate.id] })) };
  const draft = { projectId: project.id, projectRevision: project.revision, shotId: selected.id, node: { ...node, modelId: model.id }, context: { creativeContext: experimental } };
  const preview = promptPreviewSchema.parse(await source.runtime.dispatch('prompt.preview', draft));
  expect(preview.references.map(reference => reference.id)).toEqual([alternate.id]);
  const session = promptSessionSchema.parse(await source.runtime.dispatch('promptSession.save', { draft, previewDigest: preview.digest }));
  const run = runSchema.parse(await source.runtime.dispatch('promptTrial.start', { sessionId: session.id, revision: session.revision, requestId: randomUUID() })); await source.runtime.waitForIdle();
  const finished = runSchema.parse(await source.runtime.dispatch('run.get', { runId: run.id })); expect(finished.status, finished.error).toBe('succeeded');
  expect(requests).toHaveLength(1); expect(requests[0].body.prompt).toBe(preview.prompt); expect(requests[0].body.images).toHaveLength(1);
  expect((await source.runtime.dispatch('project.get', { projectId: project.id }) as { project: unknown }).project).toEqual(project);
  const page = await source.runtime.dispatch('shot.candidates', { projectId: project.id, shotId: selected.id }) as { items: ShotCandidate[] }; expect(page.items).toHaveLength(1);
  const candidate = await source.runtime.dispatch('shot.candidate.get', { projectId: project.id, candidateId: page.items[0].id }); expect(candidate).toEqual(page.items[0]);
  await expect(source.runtime.dispatch('asset.delete', { assetId: alternate.id })).rejects.toThrow('正在使用');
  const applied = projectSchema.parse(await source.runtime.dispatch('shot.candidate.apply', { projectId: project.id, revision: project.revision, candidateId: page.items[0].id }));
  expect(applied.shots[0].assetId).toBe(page.items[0].shot.assetId); expect(applied.creativeContext).toEqual(project.creativeContext);
});
