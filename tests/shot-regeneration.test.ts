import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assetSchema, projectSchema, type AssetRecord, type ModelProfile, type ProjectDocument, type RunRecord, type RunSummary, type ShotCandidate, type ShotCandidateKind, type WorkspaceSnapshot } from '@video-quickly/contracts';
import { createActivityExecutor } from '../packages/integrations/src';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src';

const directories: string[] = [], servers: Server[] = [];
const runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

type Page = { items: ShotCandidate[]; total: number; activeRun?: RunSummary };
function open(directory: string, options: Partial<RuntimeOptions> = {}) {
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/unused-by-generation', executeActivity: createActivityExecutor(), ...options }); runtimes.add(runtime); return runtime;
}
async function current(runtime: ReturnType<typeof createRuntime>, projectId: string) {
  return (await runtime.dispatch('project.get', { projectId }) as { project: ProjectDocument }).project;
}
async function candidates(runtime: ReturnType<typeof createRuntime>, project: ProjectDocument, extra: Record<string, unknown> = {}) {
  return runtime.dispatch('shot.candidates', { projectId: project.id, shotId: project.shots[1].id, ...extra }) as Promise<Page>;
}
async function regenerate(runtime: ReturnType<typeof createRuntime>, project: ProjectDocument, kind: ShotCandidateKind, modelId?: string, instruction?: string) {
  const run = await runtime.dispatch('shot.regenerate', { projectId: project.id, shotId: project.shots[1].id, kind, modelId, instruction, revision: project.revision }) as RunRecord;
  await runtime.waitForIdle(); return run;
}
async function fixture(options: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-regeneration-')); directories.push(directory);
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const script = { title: '候选标题', narration: '候选旁白', visualPrompt: '候选画面', durationUs: 4_000_000 };
  const state = { scriptShots: [script], dropRequests: false };
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const server = createServer((request, response) => { void (async () => {
    let text = ''; for await (const chunk of request) text += chunk.toString();
    const path = request.url ?? ''; requests.push({ path, body: JSON.parse(text) as Record<string, unknown> });
    if (state.dropRequests) { response.destroy(); return; }
    if (path.endsWith('/images/generations')) response.end(JSON.stringify({ data: [{ b64_json: png }] }));
    else if (path.endsWith('/audio/speech')) response.end(Buffer.from('generated audio bytes'));
    else if (path.endsWith('/video')) response.end(JSON.stringify({ data: Buffer.from('generated video bytes').toString('base64') }));
    else if (path.endsWith('/chat/completions')) response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ shots: state.scriptShots }) } }] }));
    else { response.statusCode = 404; response.end(); }
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务地址无效');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const runtime = open(directory, options);
  const original = projectSchema.parse(await runtime.dispatch('project.create', { title: '单镜头候选' }));
  let project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: original.id, revision: original.revision, patch: { shots: [0, 1, 2].map(index => ({ id: `shot-${index}`, title: `原始镜头 ${index}`, narration: `原始旁白 ${index}`, visualPrompt: `原始画面 ${index}`, durationUs: 2_000_000, ...(index === 1 ? { sourceInUs: 500_000, sceneInUs: 500_000, sceneDurationUs: 3_000_000 } : {}) })) } }));
  const oldAssets: Partial<Record<'image' | 'audio' | 'video', AssetRecord>> = {};
  for (const [kind, extension] of [['image', 'png'], ['audio', 'mp3'], ['video', 'mp4']] as const) {
    const path = join(directory, `old.${extension}`); await writeFile(path, `original ${kind}`);
    oldAssets[kind] = assetSchema.parse(await runtime.dispatch('asset.import', { projectId: project.id, shotId: project.shots[1].id, path, kind }));
  }
  project = await current(runtime, project.id);
  // Legacy projects share sourceInUs until a new association explicitly creates an override.
  project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map((shot, index) => index === 1 ? { ...shot, audioInUs: undefined, videoInUs: undefined } : shot) } }));
  project = await current(runtime, project.id);
  const models = {} as Record<ShotCandidateKind, ModelProfile>;
  for (const [kind, capability] of [['script', 'text'], ['image', 'image'], ['audio', 'tts'], ['video', 'video']] as const) {
    models[kind] = await runtime.dispatch('model.save', { model: { name: `候选${kind}`, provider: kind === 'video' ? 'custom-http' : 'openai-compatible', baseUrl, model: `fixture-${kind}`, capabilities: [capability], parameters: kind === 'video' ? { requestPath: 'video', requestTemplate: { prompt: '{{prompt}}', instruction: '{{instruction}}' }, resultBase64Path: 'data' } : {} } }) as ModelProfile;
  }
  return { runtime, directory, project, models, requests, oldAssets, state, script };
}

it('generates only the selected existing-media shot and applies an image while preserving unrelated human edits', async () => {
  const { runtime, project, models, requests, oldAssets } = await fixture();
  const run = await regenerate(runtime, project, 'image', models.image.id, '换成夜景');
  expect(requests).toHaveLength(1); expect(requests[0].body.prompt).toContain('原始画面 1'); expect(requests[0].body.prompt).toContain('换成夜景'); expect(requests[0].body.prompt).not.toContain('原始画面 0');
  expect(await current(runtime, project.id)).toEqual(project);
  const page = await candidates(runtime, project); expect(page.total).toBe(1); expect(page.activeRun).toBeUndefined();
  const candidate = page.items[0]; expect(candidate).toMatchObject({ runId: run.id, kind: 'image', baseline: project.shots[1], modelId: models.image.id, instruction: '换成夜景' });
  expect(candidate.shot.assetId).not.toBe(oldAssets.image?.id);
  expect(await runtime.dispatch('shot.candidate.get', { projectId: project.id, candidateId: candidate.id })).toEqual(candidate);
  const edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map((shot, index) => index === 1 ? { ...shot, title: '人工标题' } : index === 0 ? { ...shot, narration: '其他镜头的新旁白' } : shot) } }));
  const applied = projectSchema.parse(await runtime.dispatch('shot.candidate.apply', { projectId: project.id, candidateId: candidate.id, revision: edited.revision }));
  expect(applied.shots[1]).toMatchObject({ title: '人工标题', assetId: candidate.shot.assetId, audioAssetId: oldAssets.audio?.id, sourceInUs: 500_000 });
  expect(applied.shots[1].videoAssetId).toBeUndefined(); expect(applied.shots[0]).toEqual(edited.shots[0]); expect(applied.shots[2]).toEqual(edited.shots[2]);
});

it('rejects relevant voice edits and starts a new voice at zero while preserving the old video trim', async () => {
  const { runtime, project, models, requests, oldAssets } = await fixture();
  await regenerate(runtime, project, 'audio', models.audio.id, '语气平和');
  const first = (await candidates(runtime, project)).items[0];
  expect(requests[0].body).toMatchObject({ input: '原始旁白 1', instructions: '语气平和' });
  const edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map((shot, index) => index === 1 ? { ...shot, narration: '人工修改旁白' } : shot) } }));
  await expect(runtime.dispatch('shot.candidate.apply', { projectId: project.id, candidateId: first.id, revision: edited.revision })).rejects.toThrow('已修改');
  await regenerate(runtime, edited, 'audio', models.audio.id);
  const fresh = (await candidates(runtime, edited)).items.find(candidate => candidate.id !== first.id)!;
  const applied = projectSchema.parse(await runtime.dispatch('node.apply', { runId: fresh.runId, nodeId: 'regenerate', revision: edited.revision }));
  expect(applied.shots[1]).toMatchObject({ narration: '人工修改旁白', audioAssetId: fresh.shot.audioAssetId, audioInUs: 0, videoAssetId: oldAssets.video?.id, sourceInUs: 500_000, sceneInUs: 500_000 });
  expect(applied.shots[1].videoInUs).toBeUndefined(); expect(applied.shots[0]).toEqual(project.shots[0]);
});

it('uses the template model and only the selected script fields, rejecting multi-shot output', async () => {
  const { runtime, project: initial, models, requests, state, script } = await fixture();
  await runtime.dispatch('workflow.save', { projectId: initial.id, workflow: { ...initial.workflow, nodes: initial.workflow.nodes.map(node => node.kind === 'script' ? { ...node, modelId: models.script.id, prompt: '保留模板约束', config: { marker: 'kept' } } : node) } });
  const project = await current(runtime, initial.id);
  await regenerate(runtime, project, 'script', undefined, '写得简洁');
  const candidate = (await candidates(runtime, project)).items[0];
  const prompt = JSON.stringify(requests[0].body.messages); expect(prompt).toContain('保留模板约束'); expect(prompt).toContain('写得简洁'); expect(prompt).toContain('原始旁白 1'); expect(prompt).not.toContain('原始旁白 0');
  const edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map((shot, index) => index === 1 ? { ...shot, title: '人工保留标题' } : shot) } }));
  await expect(runtime.dispatch('shot.candidate.apply', { projectId: project.id, candidateId: candidate.id, revision: edited.revision })).rejects.toThrow('已修改');
  const applied = projectSchema.parse(await runtime.dispatch('shot.candidate.apply', { projectId: project.id, candidateId: candidate.id, fields: ['narration'], revision: edited.revision }));
  expect(applied.shots[1]).toMatchObject({ title: '人工保留标题', narration: script.narration, visualPrompt: project.shots[1].visualPrompt, durationUs: project.shots[1].durationUs });
  state.scriptShots = [script, script];
  const invalid = await regenerate(runtime, applied, 'script', models.script.id);
  const snapshot = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(snapshot.runs.find(run => run.id === invalid.id)?.status).not.toBe('succeeded'); expect((await candidates(runtime, applied)).total).toBe(1); expect(requests).toHaveLength(2);
});

it('requires a real compatible model, current revision and an unlocked target before starting a request', async () => {
  const { runtime, project, models, requests } = await fixture();
  await expect(regenerate(runtime, project, 'image')).rejects.toThrow('模型');
  await expect(regenerate(runtime, project, 'image', models.script.id)).rejects.toThrow('模型');
  const qwen = await runtime.dispatch('model.save', { model: { ...models.audio, id: undefined, provider: 'qwen-tts', name: 'Qwen不支持调整指令' } }) as ModelProfile;
  await expect(regenerate(runtime, project, 'audio', qwen.id, '不要忽略这条指令')).rejects.toThrow('不支持单镜头调整要求');
  await expect(regenerate(runtime, { ...project, revision: project.revision - 1 }, 'image', models.image.id)).rejects.toThrow('其他视图修改');
  const locked = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map((shot, index) => index === 1 ? { ...shot, locked: true } : shot) } }));
  await expect(regenerate(runtime, locked, 'image', models.image.id)).rejects.toThrow('解锁');
  expect(requests).toHaveLength(0); expect((await candidates(runtime, project)).total).toBe(0);
});

it.each(['after-result', 'after-commit'] as const)('restores a single durable candidate after %s without repeating the media request', async point => {
  let crashed = false;
  const { runtime: first, directory, project, models, requests } = await fixture({ failpoint(current, id) { if (!crashed && current === point && id === 'regenerate') { crashed = true; throw new SimulatedProcessExit(); } } });
  const run = await regenerate(first, project, 'image', models.image.id);
  expect(crashed).toBe(true); expect(requests).toHaveLength(1);
  expect(await candidates(first, project)).toMatchObject({ total: 0, activeRun: { id: run.id } });
  if (point === 'after-commit') {
    const result = await first.dispatch('node.result', { runId: run.id, nodeId: 'regenerate' }) as { candidateId: string };
    await expect(first.dispatch('shot.candidate.get', { projectId: project.id, candidateId: result.candidateId })).rejects.toThrow('未完成');
  }
  expect((await candidates(first, project, { shotId: project.shots[0].id })).activeRun).toBeUndefined();
  await first.close(); runtimes.delete(first);
  const second = open(directory); await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle();
  expect((await candidates(second, project)).total).toBe(1); expect(requests).toHaveLength(1); expect(await current(second, project.id)).toEqual(project);
});

it('paginates candidates by the target shot and preserves the old audio when applying a new video', async () => {
  const { runtime, project, models, requests, oldAssets } = await fixture();
  for (let index = 0; index < 3; index++) await regenerate(runtime, project, 'video', models.video.id, `版本 ${index}`);
  const first = await candidates(runtime, project, { limit: 1 }), second = await candidates(runtime, project, { limit: 1, offset: 1 });
  expect(first.total).toBe(3); expect(first.items).toHaveLength(1); expect(second.items).toHaveLength(1); expect(second.items[0].id).not.toBe(first.items[0].id);
  expect((await candidates(runtime, project, { offset: 3 })).items).toEqual([]); expect((await candidates(runtime, project, { shotId: project.shots[0].id })).total).toBe(0);
  const applied = projectSchema.parse(await runtime.dispatch('shot.candidate.apply', { projectId: project.id, candidateId: first.items[0].id, revision: project.revision }));
  expect(applied.shots[1]).toMatchObject({ videoAssetId: first.items[0].shot.videoAssetId, videoInUs: 0, audioAssetId: oldAssets.audio?.id, sourceInUs: 500_000 }); expect(applied.shots[1].audioInUs).toBeUndefined(); expect(requests).toHaveLength(3);
});

it('checks candidate asset integrity and rejects deletion interleaved with apply', async () => {
  const { runtime, project, models } = await fixture();
  await regenerate(runtime, project, 'image', models.image.id);
  const candidate = (await candidates(runtime, project)).items[0];
  const applying = runtime.dispatch('shot.candidate.apply', { projectId: project.id, candidateId: candidate.id, revision: project.revision });
  const rejected = expect(applying).rejects.toThrow('素材');
  await runtime.dispatch('asset.delete', { assetId: candidate.assetIds[0] }); await rejected;
  expect(await current(runtime, project.id)).toEqual(project);
  await expect(runtime.dispatch('shot.candidate.get', { projectId: project.id, candidateId: candidate.id })).rejects.toThrow('素材');
});

it('rejects corrupt candidate bytes, cross-project access and application after an interval edit', async () => {
  const { runtime, project, models } = await fixture();
  await regenerate(runtime, project, 'image', models.image.id);
  const candidate = (await candidates(runtime, project)).items[0];
  const other = projectSchema.parse(await runtime.dispatch('project.create', { title: '另一个项目' }));
  await expect(runtime.dispatch('shot.candidate.get', { projectId: other.id, candidateId: candidate.id })).rejects.toThrow('不属于');
  const edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map((shot, index) => index === 1 ? { ...shot, sourceInUs: 600_000 } : shot) } }));
  await expect(runtime.dispatch('shot.candidate.apply', { projectId: project.id, candidateId: candidate.id, revision: edited.revision })).rejects.toThrow('已修改');
  const snapshot = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  const asset = snapshot.assets.find(asset => asset.id === candidate.assetIds[0])!;
  await writeFile(asset.path, Buffer.alloc(asset.size, 1));
  await expect(runtime.dispatch('shot.candidate.get', { projectId: project.id, candidateId: candidate.id })).rejects.toThrow('校验失败');
  await expect(runtime.dispatch('shot.candidate.apply', { projectId: project.id, candidateId: candidate.id, revision: edited.revision })).rejects.toThrow('校验失败');
  expect(await current(runtime, project.id)).toEqual(edited);
});

it('rechecks project revision after asynchronous asset validation instead of overwriting a concurrent edit', async () => {
  const { runtime, project, models } = await fixture();
  await regenerate(runtime, project, 'image', models.image.id);
  const candidate = (await candidates(runtime, project)).items[0];
  const applying = runtime.dispatch('shot.candidate.apply', { projectId: project.id, candidateId: candidate.id, revision: project.revision });
  const rejected = expect(applying).rejects.toThrow('其他视图修改');
  const edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { title: '正在校验时的人工编辑' } }));
  await rejected; expect(await current(runtime, project.id)).toEqual(edited);
});

it('resets only newly associated media offsets and refuses inactive manual selections', async () => {
  const { runtime, project, oldAssets, directory } = await fixture();
  const same = projectSchema.parse(await runtime.dispatch('asset.select', { projectId: project.id, shotId: project.shots[1].id, assetId: oldAssets.audio!.id, revision: project.revision }));
  expect(same.shots[1].audioInUs).toBeUndefined(); expect(same.shots[1].videoInUs).toBeUndefined(); expect(same.shots[1].sourceInUs).toBe(500_000);
  const shifted = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: same.revision, patch: { shots: same.shots.map((shot, index) => index === 1 ? { ...shot, audioInUs: 250_000, videoInUs: 750_000 } : shot) } }));
  const videoPath = join(directory, 'replacement.mp4'); await writeFile(videoPath, 'replacement video');
  const video = assetSchema.parse(await runtime.dispatch('asset.import', { projectId: project.id, shotId: project.shots[1].id, kind: 'video', path: videoPath }));
  const imported = await current(runtime, project.id);
  expect(imported.revision).toBe(shifted.revision + 1); expect(imported.shots[1]).toMatchObject({ videoAssetId: video.id, videoInUs: 0, audioInUs: 250_000, sourceInUs: 500_000 });
  const audioPath = join(directory, 'replacement.mp3'); await writeFile(audioPath, 'replacement audio');
  const audio = assetSchema.parse(await runtime.dispatch('asset.import', { projectId: project.id, kind: 'audio', path: audioPath }));
  const selected = projectSchema.parse(await runtime.dispatch('asset.select', { projectId: project.id, shotId: project.shots[1].id, assetId: audio.id, revision: imported.revision }));
  expect(selected.shots[1]).toMatchObject({ audioAssetId: audio.id, audioInUs: 0, videoInUs: 0, sourceInUs: 500_000 });
  const unused = assetSchema.parse(await runtime.dispatch('asset.import', { projectId: project.id, kind: 'audio', path: audioPath }));
  await runtime.dispatch('asset.delete', { assetId: unused.id });
  await expect(runtime.dispatch('asset.select', { projectId: project.id, shotId: project.shots[1].id, assetId: unused.id, revision: selected.revision })).rejects.toThrow('已移除');
  expect(await current(runtime, project.id)).toEqual(selected);
});

it('never resubmits an unknown single-shot provider request after restart', async () => {
  const { runtime: first, directory, project, models, requests, state } = await fixture();
  state.dropRequests = true;
  const run = await regenerate(first, project, 'image', models.image.id);
  const failed = await first.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(failed.runs.find(record => record.id === run.id)?.activities[0].status).toBe('unknown');
  expect(requests).toHaveLength(1); expect((await candidates(first, project)).total).toBe(0);
  await first.close(); runtimes.delete(first);
  const second = open(directory); await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle();
  expect(requests).toHaveLength(1); expect((await candidates(second, project)).total).toBe(0); expect(await current(second, project.id)).toEqual(project);
});

it('passes only the target shot and its referenced media to the real generation adapter', async () => {
  const observed: Array<{ shotIds: string[]; assetIds: string[] }> = [];
  const execute = createActivityExecutor();
  const { runtime, project, models, directory, oldAssets } = await fixture({ executeActivity: async context => { observed.push({ shotIds: context.project.shots.map(shot => shot.id), assetIds: context.assets.map(asset => asset.id) }); return execute(context); } });
  const path = join(directory, 'unrelated.png'); await writeFile(path, 'unrelated media');
  const unrelated = assetSchema.parse(await runtime.dispatch('asset.import', { path, kind: 'image' }));
  await regenerate(runtime, project, 'image', models.image.id);
  expect(observed[0].shotIds).toEqual([project.shots[1].id]);
  expect(observed[0].assetIds.sort()).toEqual(Object.values(oldAssets).map(asset => asset!.id).sort());
  expect(observed[0].assetIds).not.toContain(unrelated.id);
});
