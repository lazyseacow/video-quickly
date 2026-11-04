import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assetSchema, characterProfileSchema, modelSchema, projectSchema, promptPreviewSchema, promptSessionSchema, runSchema, shotSchema, type JsonValue, type PromptDraft, type ShotCandidate } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src/index';
import { createActivityExecutor, validateMediaActivity } from '../packages/integrations/src';
import { fixtureNativeVideo } from './fixtures/native-video';

const directories: string[] = [], servers: Server[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); }));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture(kind: 'image' | 'video') {
  const directory = await mkdtemp(join(tmpdir(), 'vq-prompt-media-')); directories.push(directory);
  const requests: { path: string; body: Record<string, JsonValue> }[] = [];
  let baseUrl = '';
  const server = createServer((request, response) => { void (async () => {
    response.setHeader('content-type', 'application/json');
    if (request.method !== 'POST') {
      if (request.url === '/video.mp4') { response.setHeader('content-type', 'video/mp4'); response.end(fixtureNativeVideo()); }
      else response.end(JSON.stringify({ status: 'succeeded', content: { video_url: `${baseUrl}/video.mp4` } }));
      return;
    }
    let raw = ''; for await (const bytes of request) raw += String(bytes);
    requests.push({ path: request.url ?? '', body: JSON.parse(raw) });
    response.end(JSON.stringify(kind === 'image' ? { data: [{ b64_json: png.toString('base64') }] } : { id: 'prompt-video-task' }));
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture'); baseUrl = `http://127.0.0.1:${address.port}`;
  const ffmpegPath = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath, preflightActivity: validateMediaActivity, executeActivity: createActivityExecutor({ ffmpegPath }) }); runtimes.push(runtime);
  const path = join(directory, 'reference.png'); await writeFile(path, png);
  const reference = assetSchema.parse(await runtime.dispatch('asset.import', { path, kind: 'image' }));
  const character = characterProfileSchema.parse(await runtime.dispatch('character.save', { character: { name: '小青', description: '蓝外衣、黑短发', referenceAssetIds: [reference.id] } }));
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '媒体实验', provider: kind === 'image' ? 'openai-compatible' : 'seedance', baseUrl, connectionType: kind, capabilities: [kind], model: kind === 'image' ? 'fixture-image' : 'seedance-2-0-fixture', parameters: kind === 'video' ? { characterReferenceMode: 'reference_image' } : {} } }));
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '媒体提示词实验', profile: { width: 160, height: 90, frameRate: { numerator: 30, denominator: 1 } } }));
  const scene = assetSchema.parse(await runtime.dispatch('asset.import', { projectId: created.id, path, kind: 'image' }));
  const shot = shotSchema.parse({ id: 'first', title: '第一镜', narration: '找到盒子了。', visualPrompt: '小青在花园找到木盒', durationUs: 1000000, assetId: scene.id, characterIds: [character.id] });
  const other = shotSchema.parse({ ...shot, id: 'other', title: '其他镜头', characterIds: [] });
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: { shots: [shot, other], workflow: { ...created.workflow, production: { ...created.workflow.production, referenceMode: 'existing' } } } }));
  const node = project.workflow.nodes.find(node => kind === 'image' ? node.kind === 'assets' : node.id === 'video')!;
  const draft: PromptDraft = { projectId: project.id, projectRevision: project.revision, node: { ...node, modelId: model.id, prompt: '画面节奏：{{voice}}', promptBindings: { voice: { shotPath: ['narration'] } } }, shotId: shot.id };
  return { runtime, directory, requests, draft, project, reference, model, scene };
}
for (const kind of ['image', 'video'] as const) it(`previews the exact ${kind} request, generates one candidate and keeps production untouched`, async () => {
  const source = await fixture(kind);
  const preview = promptPreviewSchema.parse(await source.runtime.dispatch('prompt.preview', source.draft));
  expect(source.requests).toHaveLength(0); expect(preview.prompt).toContain('画面节奏：找到盒子了。'); expect(preview.prompt).toContain('蓝外衣、黑短发');
  const session = promptSessionSchema.parse(await source.runtime.dispatch('promptSession.save', { draft: source.draft, previewDigest: preview.digest }));
  const run = runSchema.parse(await source.runtime.dispatch('promptTrial.start', { sessionId: session.id, revision: session.revision, requestId: randomUUID() })); await source.runtime.waitForIdle();
  const finished = runSchema.parse(await source.runtime.dispatch('run.get', { runId: run.id })); expect(finished.status, finished.error).toBe('succeeded');
  expect(source.requests).toHaveLength(1);
  if (kind === 'image') expect(source.requests[0].body.prompt).toBe(preview.prompt);
  else {
    expect(source.requests[0].body.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: preview.prompt })]));
    expect(preview.prompt).toContain('图片 2 为当前场景构图参考。');
  }
  expect((await source.runtime.dispatch('project.get', { projectId: source.project.id }) as { project: unknown }).project).toEqual(source.project);
  const page = await source.runtime.dispatch('shot.candidates', { projectId: source.project.id, shotId: source.draft.shotId }) as { items: ShotCandidate[] };
  expect(page.items).toHaveLength(1); expect(page.items[0].kind).toBe(kind); expect(page.items[0].runId).toBe(run.id);
  const changed = projectSchema.parse(await source.runtime.dispatch('shot.candidate.apply', { projectId: source.project.id, revision: source.project.revision, candidateId: page.items[0].id }));
  expect(changed.shots[1]).toEqual(source.project.shots[1]); expect(changed.shots[0]).not.toEqual(source.project.shots[0]);
});
it('rejects damaged reference images before preview or model submission', async () => {
  const source = await fixture('image'); await writeFile(source.reference.path, 'damaged');
  await expect(source.runtime.dispatch('prompt.preview', source.draft)).rejects.toThrow(); expect(source.requests).toHaveLength(0);
});

it('verifies saved upstream media before using it in an experiment', async () => {
  const source = await fixture('image');
  const project = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: source.project.id, revision: source.project.revision, patch: { workflow: { ...source.project.workflow, production: { ...source.project.workflow.production, referenceMode: 'generate', imageModelId: source.model.id } } } }));
  const run = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: project.id, nodeId: 'assets' })); await source.runtime.waitForIdle();
  const result = await source.runtime.dispatch('node.result', { runId: run.id, nodeId: 'assets' }) as { assets: unknown[] };
  const generated = result.assets.map(asset => assetSchema.parse(asset)); expect(generated).toHaveLength(2);
  await writeFile(generated[0].path, 'broken upstream');
  await expect(source.runtime.dispatch('prompt.preview', { ...source.draft, projectRevision: project.revision, node: project.workflow.nodes.find(node => node.id === 'video'), upstreamRunId: run.id })).rejects.toThrow('上游素材');
  expect(source.requests).toHaveLength(2);
});

it('checks the scene reference in preview and again before submitting a frozen trial', async () => {
  const source = await fixture('video');
  const preview = promptPreviewSchema.parse(await source.runtime.dispatch('prompt.preview', source.draft));
  const session = promptSessionSchema.parse(await source.runtime.dispatch('promptSession.save', { draft: source.draft, previewDigest: preview.digest }));
  await writeFile(source.scene.path, 'corrupt scene image');
  await expect(source.runtime.dispatch('prompt.preview', source.draft)).rejects.toThrow('实验输入素材');
  const run = runSchema.parse(await source.runtime.dispatch('promptTrial.start', { sessionId: session.id, revision: session.revision, requestId: randomUUID() })); await source.runtime.waitForIdle();
  expect(runSchema.parse(await source.runtime.dispatch('run.get', { runId: run.id })).status).toBe('needs_attention');
  expect(source.requests).toHaveLength(0); expect(await source.runtime.dispatch('cost.summary', { runId: run.id })).toMatchObject({ total: 0 });
});
