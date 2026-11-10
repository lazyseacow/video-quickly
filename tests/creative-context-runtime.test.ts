import { planningFixtureResponse, storyboardFixtureResponse } from './fixtures/planning-response';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assetRecoveryJobSchema, assetRecoveryPageSchema, assetSchema, characterProfileSchema, creativeContextSchema, createNativeVideoWorkflow, modelSchema, projectSchema, runSchema, type AssetRecord, type CharacterProfile, type ProjectDocument, type ShotCandidate } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src';
import { createActivityExecutor, validateMediaActivity } from '../packages/integrations/src';
import { probeMedia } from '../packages/video/src/node';
import { fixtureNativeVideo } from './fixtures/native-video';
import { fixtureCharacterViews } from './fixtures/character-views';
import { cropToolImage } from '../packages/video/src/image-tools';

const directories: string[] = [], servers: Server[] = [], releases: Array<() => void> = [];
const runtimes = new Set<ReturnType<typeof createRuntime>>();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const mediaAvailable = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0 && spawnSync(ffprobe, ['-version'], { windowsHide: true }).status === 0;

afterEach(async () => {
  releases.splice(0).forEach(release => release());
  await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); })));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const generatedScript = () => ({
  entities: [{ key: 'red-box', kind: 'prop', name: '红木盒', description: '磨损红漆与铜锁' }, { key: 'visitor', kind: 'character', name: '访客', description: '绿外套、银色短发' }],
  shots: [
    { title: '小青来到花园', narration: '盒子就在这里。', visualPrompt: '人物走向木门', soundPrompt: '自然说话，风声', durationUs: 2_000_000, characterKeys: ['role-1'], entityKeys: ['garden', 'red-box'] },
    { title: '小红发现访客', narration: '你看见他了吗？', visualPrompt: '人物转头看向访客', durationUs: 2_000_000, characterKeys: ['role-2'], entityKeys: ['visitor'] },
  ],
});

async function fixture(extra: { full?: boolean; scriptOutput?: string; failpoint?: RuntimeOptions['failpoint']; holdScript?: boolean; automaticCasting?: 'first-frame' | 'multi-reference'; relay?: boolean; imageResponse?: (prompt: string) => Buffer; clipsByFrame?: ReadonlyMap<string, Buffer>; acceptImageRequest?: (path: string, body: Record<string, unknown>) => boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-creative-context-')); directories.push(directory);
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let entered!: () => void, release!: () => void;
  const enteredScript = new Promise<void>(resolve => { entered = resolve; });
  const scriptGate = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  const video = extra.full ? fixtureNativeVideo() : undefined;
  const clipResults = new Map<string, Buffer>();
  let baseUrl = '';
  const server = createServer((request, response) => { void (async () => {
    response.setHeader('content-type', 'application/json');
    if (request.method !== 'POST') {
      const url = new URL(request.url ?? '/', baseUrl);
      if (url.pathname === '/video.mp4') {
        response.setHeader('content-type', 'video/mp4'); response.end(clipResults.get(url.searchParams.get('task') ?? '') ?? video);
      } else {
        const task = url.pathname.split('/').at(-1) ?? '';
        response.end(JSON.stringify({ status: 'succeeded', content: { video_url: `${baseUrl}/video.mp4?task=${encodeURIComponent(task)}` } }));
      }
      return;
    }
    const path = request.url ?? '';
    if (path === '/v1/videos') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const form = await new Response(new Uint8Array(Buffer.concat(chunks)), { headers: { 'content-type': request.headers['content-type'] ?? '' } }).formData();
      const images = await Promise.all(form.getAll('input_reference').map(async value => typeof value === 'string' ? value : Buffer.from(await value.arrayBuffer()).toString('base64')));
      requests.push({ path, body: { model: form.get('model'), prompt: form.get('prompt'), images } });
      const id = `video-task-${requests.length}`, clip = extra.clipsByFrame?.get(images[0]);
      if (clip) clipResults.set(id, clip);
      response.end(JSON.stringify({ id }));
      return;
    }
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>; requests.push({ path, body });
    if (path.endsWith('/chat/completions')) {
      const script = raw.includes('自动视频制作步骤：旁白与分镜');
      if (script) { entered(); if (extra.holdScript) await scriptGate; }
      const content = script ? storyboardFixtureResponse(JSON.parse(raw).messages[0].content, extra.scriptOutput ?? JSON.stringify(generatedScript())) : planningFixtureResponse(raw, '柔和的傍晚光线，服装和空间保持连续。');
      response.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 30 } }));
    } else if (/\/images\/(edits|generations)$/.test(path)) {
      if (extra.acceptImageRequest && !extra.acceptImageRequest(path, body)) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { message: 'Unsupported canvas or image request fields' } }));
        return;
      }
      const bytes = extra.imageResponse?.(String(body.prompt)) ?? (extra.automaticCasting ? Buffer.concat([png, Buffer.from(String(requests.length))]) : png);
      response.end(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }));
    }
    else response.end(JSON.stringify({ id: `video-task-${requests.length}` }));
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('本地创作夹具未启动'); baseUrl = `http://127.0.0.1:${address.port}`;
  const options: RuntimeOptions = { dataDirectory: directory, seed: false, ffmpegPath: ffmpeg, preflightActivity: validateMediaActivity, executeActivity: createActivityExecutor({ ffmpegPath: ffmpeg }), failpoint: extra.failpoint };
  const runtime = createRuntime(options); runtimes.add(runtime);
  const profiles: CharacterProfile[] = [], references: AssetRecord[] = [], referenceBytes: Buffer[] = [];
  for (const [index, name, description] of [[0, '小青', '蓝外衣、黑色短发'], [1, '小红', '红外衣、棕色长发']] as const) {
    const bytes = Buffer.concat([png, Buffer.from(String(index))]), path = join(directory, `reference-${index}.png`); await writeFile(path, bytes); referenceBytes.push(bytes);
    const asset = assetSchema.parse(await runtime.dispatch('asset.import', { path, kind: 'image' })); references.push(asset);
    profiles.push(characterProfileSchema.parse(await runtime.dispatch('character.save', { character: { name, description, referenceAssetIds: [asset.id] } })));
  }
  const text = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '本地文本', provider: 'openai-compatible', baseUrl: `${baseUrl}/v1`, connectionType: 'text', capabilities: ['text'], model: 'fixture-text' } }));
  const image = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '本地图片', provider: 'openai-compatible', baseUrl: `${baseUrl}/v1`, connectionType: 'image', capabilities: ['image'], model: 'gpt-image-fixture' } }));
  const videoModel = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '本地视频', connectionType: 'video', capabilities: ['video'], model: 'seedance-2-0-fixture',
    ...(extra.relay ? { provider: 'openai-compatible', baseUrl: `${baseUrl}/v1` } : { provider: 'seedance', baseUrl, parameters: { characterReferenceMode: extra.automaticCasting === 'first-frame' ? 'first_frame' : 'reference_image' } }),
  } }));
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '花园中的角色', brief: '小青与小红在花园找到红木盒', profile: { width: 160, height: 90, frameRate: { numerator: 30, denominator: 1 } } }));
  const workflow = createNativeVideoWorkflow();
  const nodes = extra.full ? workflow.nodes : workflow.nodes.filter(node => ['script', 'assets'].includes(node.id));
  const ids = new Set(nodes.map(node => node.id));
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: {
    creativeContext: creativeContextSchema.parse({ characterIds: extra.automaticCasting ? [] : profiles.map(profile => profile.id), continuity: '同一个傍晚，衣服保持不变', entities: [
      { key: 'garden', kind: 'scene', name: '花园', description: '左侧木门，右侧石喷泉' }, { key: 'kitchen', kind: 'scene', name: '厨房', description: '白色瓷砖与银色水槽' },
    ] }),
    workflow: { ...workflow, nodes, edges: workflow.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)), stages: workflow.stages?.flatMap(stage => { const nodeIds = stage.nodeIds.filter(id => ids.has(id)); return nodeIds.length ? [{ ...stage, nodeIds }] : []; }), production: { ...workflow.production, textModelId: text.id, imageModelId: extra.relay || extra.automaticCasting === 'first-frame' ? undefined : image.id, videoModelId: videoModel.id, referenceMode: extra.relay || extra.automaticCasting === 'first-frame' ? 'none' : 'generate' } },
  } }));
  const current = async (target = runtime): Promise<ProjectDocument> => (await target.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project;
  return { runtime, project, directory, profiles, references, referenceBytes, requests, options, current, enteredScript, release, image, text };
}

it('starts from no shots, binds frozen roles and sends each real reference only to its own image request', async () => {
  const source = await fixture();
  const started = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: source.project.id })); await source.runtime.waitForIdle();
  const finished = runSchema.parse(await source.runtime.dispatch('run.get', { runId: started.id })); expect(finished.status, finished.error).toBe('succeeded');
  const project = await source.current();
  expect(project.shots.map(shot => shot.characterIds)).toEqual(source.profiles.map(profile => [profile.id]));
  expect(project.creativeContext?.entities.map(entity => entity.key)).toEqual(['garden', 'kitchen', 'red-box', 'visitor']);
  const imageCalls = source.requests.filter(request => request.path.endsWith('/images/edits')); expect(imageCalls).toHaveLength(2);
  imageCalls.forEach((request, index) => {
    expect(request.body.images).toEqual([{ image_url: `data:image/png;base64,${source.referenceBytes[index].toString('base64')}` }]);
    expect(request.body.prompt).toEqual(expect.stringContaining(source.profiles[index].description));
    expect(request.body.prompt).not.toEqual(expect.stringContaining(source.profiles[1 - index].description));
    expect(request.body.prompt).toEqual(expect.stringContaining('同一个傍晚'));
    expect(request.body.prompt).not.toEqual(expect.stringContaining('白色瓷砖'));
  });
  expect(imageCalls[0].body.prompt).toEqual(expect.stringContaining('磨损红漆')); expect(imageCalls[1].body.prompt).toEqual(expect.stringContaining('银色短发'));
  const count = source.requests.length; await source.runtime.dispatch('run.replay', { runId: started.id }); expect(source.requests).toHaveLength(count);
  const backup = await source.runtime.dispatch('project.backup', { projectId: project.id }) as { path: string };
  const restored = projectSchema.parse(await source.runtime.dispatch('project.importBackup', { path: backup.path }));
  expect(restored.shots.map(shot => shot.characterIds)).toEqual(restored.creativeContext?.characterIds.map(id => [id]));
  expect(restored.shots.map(shot => shot.creativeEntityKeys)).toEqual(project.shots.map(shot => shot.creativeEntityKeys));
  expect(restored.creativeContext?.entities).toEqual(project.creativeContext?.entities);
});

it.each(['character', 'entity'] as const)('stops an unknown %s key before any media submission', async kind => {
  const script = generatedScript();
  if (kind === 'character') script.shots[0].characterKeys = ['role-999']; else script.shots[0].entityKeys = ['unknown-scene'];
  const source = await fixture({ scriptOutput: JSON.stringify(script) });
  const started = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: source.project.id })); await source.runtime.waitForIdle();
  const failed = runSchema.parse(await source.runtime.dispatch('run.get', { runId: started.id })); expect(failed.status).toBe('failed');
  expect(source.requests).toHaveLength(2); expect((await source.current()).shots).toEqual([]);
});

it('protects pool-only characters and their images, rejecting invalid pool and entity references without saving', async () => {
  const source = await fixture();
  await expect(source.runtime.dispatch('character.archive', { characterId: source.profiles[0].id, revision: source.profiles[0].revision })).rejects.toThrow('项目角色池');
  await expect(source.runtime.dispatch('asset.delete', { assetId: source.references[0].id })).rejects.toThrow('正在使用');
  await expect(source.runtime.dispatch('project.update', { projectId: source.project.id, revision: source.project.revision, patch: { creativeContext: { ...source.project.creativeContext, characterIds: ['invented'] } } })).rejects.toThrow('角色不存在');
  await expect(source.runtime.dispatch('project.update', { projectId: source.project.id, revision: source.project.revision, patch: { shots: [{ id: 'bad', title: '不存在的设定', narration: '', visualPrompt: '', durationUs: 1_000_000, creativeEntityKeys: ['missing'] }] } })).rejects.toThrow('不存在');
  expect(await source.current()).toEqual(source.project); expect(source.requests).toHaveLength(0);
});

it('includes missing pool-only reference files in project-scoped recovery without collecting unrelated library files', async () => {
  const source = await fixture();
  await source.runtime.dispatch('asset.import', { path: join(source.directory, 'reference-0.png'), kind: 'image' });
  await unlink(source.references[0].path);
  const job = assetRecoveryJobSchema.parse(await source.runtime.dispatch('asset.recovery.start', { projectId: source.project.id })); await source.runtime.waitForIdle();
  const inventory = assetRecoveryPageSchema.parse(await source.runtime.dispatch('asset.recovery.get', { jobId: job.id }));
  expect(inventory.items.map(item => item.assetId).sort()).toEqual(source.references.map(asset => asset.id).sort());
  expect(inventory.items.find(item => item.assetId === source.references[0].id)).toMatchObject({ status: 'missing', sources: expect.arrayContaining([{ kind: 'character', id: source.profiles[0].id }]) });
});

it('cancels a running text generation without changing its project or submitting downstream media', async () => {
  const source = await fixture({ holdScript: true });
  const started = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: source.project.id })); await source.enteredScript;
  await source.runtime.dispatch('run.cancel', { runId: started.id }); await source.runtime.waitForIdle();
  expect(runSchema.parse(await source.runtime.dispatch('run.get', { runId: started.id })).status).toBe('canceled');
  expect(await source.current()).toEqual(source.project); expect(source.requests).toHaveLength(1);
});

it('backs up and remaps the pool even before shots exist, rejecting incomplete and incorrectly versioned backups', async () => {
  const source = await fixture();
  const backup = await source.runtime.dispatch('project.backup', { projectId: source.project.id }) as { path: string };
  const path = join(backup.path, 'project.json'), manifest = JSON.parse(await readFile(path, 'utf8')) as { schemaVersion: number; project: ProjectDocument; characters: CharacterProfile[] };
  expect(manifest.schemaVersion).toBe(5); expect(manifest.characters).toEqual(source.profiles);
  const restored = projectSchema.parse(await source.runtime.dispatch('project.importBackup', { path: backup.path }));
  expect(restored.shots).toEqual([]); expect(restored.creativeContext?.entities).toEqual(source.project.creativeContext?.entities);
  for (const [index, id] of restored.creativeContext!.characterIds.entries()) {
    expect(id).not.toBe(source.profiles[index].id);
    const profile = characterProfileSchema.parse(await source.runtime.dispatch('character.get', { characterId: id }));
    const [asset] = await source.runtime.dispatch('character.references', { characterId: profile.id }) as AssetRecord[];
    expect(asset.projectId).toBeUndefined(); expect(await readFile(asset.path)).toEqual(source.referenceBytes[index]);
  }
  await writeFile(path, JSON.stringify({ ...manifest, schemaVersion: 4 })); await expect(source.runtime.dispatch('project.importBackup', { path: backup.path })).rejects.toThrow('格式 5');
  await writeFile(path, JSON.stringify({ ...manifest, characters: manifest.characters.slice(1) })); await expect(source.runtime.dispatch('project.importBackup', { path: backup.path })).rejects.toThrow('备份缺少');
});

it.each([false, true])('resumes committed script output with frozen context across reopening; edited library = %s', async edited => {
  let interrupted = false;
  const source = await fixture({ failpoint(point, id) { if (!interrupted && point === 'after-commit' && id === 'script') { interrupted = true; throw new SimulatedProcessExit(); } } });
  const started = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: source.project.id })); await source.runtime.waitForIdle(); expect(interrupted).toBe(true);
  await source.runtime.close(); runtimes.delete(source.runtime);
  const recovered = createRuntime({ ...source.options, failpoint: undefined }); runtimes.add(recovered);
  if (edited) await recovered.dispatch('character.save', { character: { ...source.profiles[0], description: '恢复前改变成黄色外衣' } });
  await recovered.dispatch('run.resume', { runId: started.id }); await recovered.waitForIdle();
  const record = runSchema.parse(await recovered.dispatch('run.get', { runId: started.id })); expect(record.status, record.error).toBe(edited ? 'needs_attention' : 'succeeded');
  expect(source.requests.filter(request => request.path.endsWith('/chat/completions'))).toHaveLength(2);
  const images = source.requests.filter(request => request.path.endsWith('/images/edits')); expect(images).toHaveLength(2);
  expect(images[0].body.prompt).toEqual(expect.stringContaining('蓝外衣')); expect(images[0].body.prompt).not.toEqual(expect.stringContaining('黄色外衣'));
  const project = await source.current(recovered); expect(project.shots).toHaveLength(edited ? 0 : 2);
});

it('retains new context as an isolated step result until explicit application and invalidates candidates after context edits', async () => {
  const source = await fixture();
  const started = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: source.project.id, nodeId: 'script' })); await source.runtime.waitForIdle();
  expect(await source.current()).toEqual(source.project);
  let applied = projectSchema.parse(await source.runtime.dispatch('node.apply', { runId: started.id, nodeId: 'script', revision: source.project.revision }));
  expect(applied.shots[0].characterIds).toEqual([source.profiles[0].id]); expect(applied.creativeContext?.entities).toHaveLength(4);
  const regenerated = runSchema.parse(await source.runtime.dispatch('shot.regenerate', { projectId: applied.id, shotId: applied.shots[0].id, revision: applied.revision, kind: 'image', modelId: source.image.id })); await source.runtime.waitForIdle();
  expect(runSchema.parse(await source.runtime.dispatch('run.get', { runId: regenerated.id })).status).toBe('succeeded');
  const candidates = await source.runtime.dispatch('shot.candidates', { projectId: applied.id, shotId: applied.shots[0].id }) as { items: ShotCandidate[] };
  applied = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: applied.id, revision: applied.revision, patch: { creativeContext: { ...applied.creativeContext, continuity: '改为深夜' } } }));
  await expect(source.runtime.dispatch('shot.candidate.apply', { projectId: applied.id, candidateId: candidates.items[0].id, revision: applied.revision })).rejects.toThrow('连续性要求已修改');
});

it.skipIf(!mediaAvailable)('carries roles and textual continuity through real video requests and an exported MP4 with audio', async () => {
  const source = await fixture({ full: true });
  const started = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: source.project.id })); await source.runtime.waitForIdle();
  const completed = runSchema.parse(await source.runtime.dispatch('run.get', { runId: started.id })); expect(completed.status, completed.error).toBe('succeeded');
  const current = await source.current(); expect(current.shots.every(shot => shot.videoAssetId && shot.characterIds?.length === 1)).toBe(true);
  const videoCalls = source.requests.filter(request => !request.path.endsWith('/chat/completions') && !request.path.endsWith('/images/edits')); expect(videoCalls).toHaveLength(2);
  videoCalls.forEach((request, index) => {
    expect(request.body.content).toEqual(expect.arrayContaining([{ type: 'image_url', image_url: { url: `data:image/png;base64,${source.referenceBytes[index].toString('base64')}` }, role: 'reference_image' }]));
    expect(JSON.stringify(request.body.content)).toContain(source.profiles[index].description);
    expect(JSON.stringify(request.body.content)).not.toContain(source.profiles[1 - index].description);
  });
  const exported = await source.runtime.dispatch('node.result', { runId: started.id, nodeId: 'export' }) as { videoPath: string };
  expect(exported.videoPath).toBeTruthy(); const media = await probeMedia(exported.videoPath, ffprobe);
  expect(media.width).toBe(160); expect(media.height).toBe(90); expect(media.audio).toBe(true); expect(media.duration).toBeGreaterThan(0);
});

it.skipIf(!mediaAvailable)('composes the existing role references before sending a single image to an OpenAI-compatible Seedance relay', async () => {
  const shots = [
    { id: 'meeting', title: '双人见面', narration: '', visualPrompt: '小青与小红在门口见面', durationUs: 4_000_000, characterKeys: ['role-1', 'role-2'] },
    { id: 'talking', title: '双人交谈', narration: '', visualPrompt: '小青与小红在喷泉边交谈', durationUs: 4_000_000, characterKeys: ['role-1', 'role-2'] },
    { id: 'leaving', title: '小青离开', narration: '', visualPrompt: '小青独自走向木门', durationUs: 4_000_000, characterKeys: ['role-1'] },
  ];
  const source = await fixture({ full: true, relay: true, scriptOutput: JSON.stringify({ shots }) });
  const project = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: source.project.id, revision: source.project.revision, patch: {
    shots: shots.map(({ characterKeys, ...shot }) => ({ ...shot, characterIds: characterKeys.map(key => source.profiles[key === 'role-1' ? 0 : 1].id) })),
  } }));
  const readiness = await source.runtime.dispatch('project.readiness', { projectId: project.id });
  expect(readiness).toMatchObject({ ready: true });
  expect(source.requests).toHaveLength(0);

  const started = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: project.id }));
  await source.runtime.waitForIdle();
  const finished = runSchema.parse(await source.runtime.dispatch('run.get', { runId: started.id }));
  expect(finished.status, finished.error).toBe('succeeded');
  const pictureCalls = source.requests.filter(request => request.path.endsWith('/images/edits'));
  expect(pictureCalls).toHaveLength(2);
  for (const picture of pictureCalls) {
    expect(picture.body.images).toEqual(source.referenceBytes.map(bytes => ({ image_url: `data:image/png;base64,${bytes.toString('base64')}` })));
  }
  const videoCalls = source.requests.filter(request => request.path === '/v1/videos');
  expect(videoCalls).toHaveLength(3);
  for (const request of videoCalls.slice(0, 2)) {
    expect(request.body).toMatchObject({ model: 'seedance-2-0-fixture', images: [png.toString('base64')], prompt: expect.stringContaining('以镜头首帧中的人物形象和构图为准') });
  }
  expect(videoCalls[2].body.images).toEqual([source.referenceBytes[0].toString('base64')]);
});

it('sends one fixed-size full-color character board request through a Seedream relay', async () => {
  const board = await fixtureCharacterViews();
  const source = await fixture({ imageResponse: () => board, acceptImageRequest: (path, body) =>
    path === '/v1/images/generations' && body.size === '2048x2048' && !('n' in body) && !('stream' in body) && !('sequential_image_generation' in body) && !('images' in body) });
  const model = modelSchema.parse(await source.runtime.dispatch('model.save', { model: {
    name: 'Seedream 兼容中转', provider: 'openai-compatible', baseUrl: source.image.baseUrl, model: 'doubao-seedream-5-0-lite-260128',
    connectionType: 'image', capabilities: ['image'], parameters: { size: '2560x1440', n: 4, stream: true, sequential_image_generation: 'auto', sequential_image_generation_options: { max_images: 4 } },
  } }));
  const specifiedDesign = '蓝外衣、黑色短发，背景为竹林晨雾。';
  const inferredDesign = '性格沉静的古风剑客。';
  for (const design of [{ description: specifiedDesign }, { description: inferredDesign, referenceAssetId: source.references[0].id }]) {
    const views = assetSchema.array().parse(await source.runtime.dispatch('character.generateViews', {
      requestId: randomUUID(), modelId: model.id, name: '小青', ...design,
    }));
    expect(views).toHaveLength(4);
  }

  expect(source.requests).toHaveLength(2);
  const [textOnly, withReference] = source.requests.map(request => request.body);
  expect(textOnly).not.toHaveProperty('image');
  expect(textOnly.prompt).toContain(specifiedDesign);
  expect(textOnly.prompt).toContain('未指定的颜色根据角色设定补齐');
  expect(withReference.image).toEqual([`data:image/png;base64,${source.referenceBytes[0].toString('base64')}`]);
  expect(withReference.prompt).toContain(inferredDesign);
  expect(withReference.prompt).toContain('未指定的颜色根据角色设定和参考图补齐');
  for (const body of [textOnly, withReference]) {
    expect(body.model).toBe(model.model);
    expect(body.prompt).toContain('1:1 正方形画布');
    expect(body.prompt).toContain('全彩四视角角色设定图');
    expect(body.prompt).toContain('以角色设定中指定的配色和背景为准');
    expect(body.prompt).toContain('背景未指定时，选择与人物有明暗或色相对比的素色底');
    expect(body.prompt).toContain('四个视角保持配色、背景和光照一致');
    expect(body).not.toHaveProperty('sequential_image_generation_options');
  }
});

it.skipIf(!mediaAvailable)('shares one cast across six shots and uses the confirmed sixth frame in an ordinary video redo', async () => {
  const board = await fixtureCharacterViews();
  const [frontFrame, sideFrame] = await cropToolImage(board, [{ x: 0, y: 0, width: 320, height: 320 }, { x: 0, y: 320, width: 320, height: 320 }]);
  const clipsByFrame = new Map([frontFrame, sideFrame].map(frame => [frame.toString('base64'), fixtureNativeVideo(frame)]));
  const shots = Array.from({ length: 6 }, (_, index) => ({
    title: `分片 ${index + 1}`, narration: '', durationUs: 4_000_000,
    visualPrompt: index === 0 ? '小青正脸站在木门前' : index === 5 ? '小青侧身握住门把手' : `花园空镜 ${index + 1}`,
    characterKeys: index === 0 || index === 5 ? ['role-1'] : [],
  }));
  const source = await fixture({ full: true, relay: true, clipsByFrame, scriptOutput: JSON.stringify({ shots }), imageResponse: prompt =>
    prompt.includes('四视角角色设定图') ? board : prompt.includes('侧身握住') ? sideFrame : frontFrame });
  const { runtime } = source;
  const viewInput = { requestId: randomUUID(), modelId: source.image.id, name: source.profiles[0].name, description: source.profiles[0].description, referenceAssetId: source.references[0].id };
  const [first, duplicate] = await Promise.all([runtime.dispatch('character.generateViews', viewInput), runtime.dispatch('character.generateViews', viewInput)]);
  const views = assetSchema.array().length(4).parse(first);
  expect(duplicate).toEqual(views);
  expect(await runtime.dispatch('character.generateViews', viewInput)).toEqual(views);
  expect(views.map(view => view.name)).toEqual(['小青 · 正面.png', '小青 · 四分之三侧面.png', '小青 · 侧面.png', '小青 · 背面.png']);
  expect(views.every(view => view.projectId === undefined && view.shotId === undefined && view.width === 320 && view.height === 320)).toBe(true);
  expect(new Set(views.map(view => view.sha256)).size).toBe(4);
  const viewCalls = source.requests.filter(request => request.path.endsWith('/images/edits'));
  expect(viewCalls).toHaveLength(1);
  expect(viewCalls[0].body).toMatchObject({ size: '1024x1024', n: 1 });
  expect(viewCalls[0].body.images).toEqual([{ image_url: `data:image/png;base64,${source.referenceBytes[0].toString('base64')}` }]);
  expect(viewCalls[0].body.prompt).toContain('同一个角色');
  const role = characterProfileSchema.parse(await runtime.dispatch('character.save', { character: { ...source.profiles[0], referenceAssetIds: views.map(view => view.id) } }));

  const started = runSchema.parse(await runtime.dispatch('run.start', { projectId: source.project.id }));
  await runtime.waitForIdle();
  const production = runSchema.parse(await runtime.dispatch('run.get', { runId: started.id }));
  expect(production.status, production.error).toBe('succeeded');
  expect(source.requests.filter(request => request.path.endsWith('/chat/completions') && JSON.stringify(request.body).includes('分镜生成阶段：第'))).toHaveLength(2);
  const project = await source.current();
  expect(project.shots.map(shot => shot.characterIds)).toEqual([[role.id], [], [], [], [], [role.id]]);
  const frameRequests = source.requests.filter(request => request.path.endsWith('/images/edits')).slice(1);
  const referenceInputs = await Promise.all(views.map(async asset => ({ image_url: `data:image/png;base64,${(await readFile(asset.path)).toString('base64')}` })));
  expect(frameRequests.map(request => request.body.images)).toEqual([referenceInputs, referenceInputs]);
  const videos = () => source.requests.filter(request => request.path === '/v1/videos');
  const sixVideos = videos();
  expect(sixVideos).toHaveLength(6);
  expect(sixVideos.find(request => String(request.body.prompt).includes('正脸站在'))?.body.images).toEqual([frontFrame.toString('base64')]);
  const sixthRequest = sixVideos.find(request => String(request.body.prompt).includes('侧身握住'));
  expect(sixthRequest?.body.images).toEqual([sideFrame.toString('base64')]);

  const sixth = project.shots[5];
  const regenerate = { projectId: project.id, revision: project.revision, shotId: sixth.id, kind: 'video', instruction: '延长回头动作' };
  const redo = runSchema.parse(await runtime.dispatch('shot.regenerate', regenerate));
  await runtime.waitForIdle();
  const redone = runSchema.parse(await runtime.dispatch('run.get', { runId: redo.id }));
  expect(redone.status, redone.error).toBe('succeeded');
  expect(videos()).toHaveLength(7);
  expect(videos()[6].body.images).toEqual(sixthRequest?.body.images);
  expect(videos()[6].body.prompt).toContain('延长回头动作');
  expect(source.requests.filter(request => request.path.endsWith('/images/edits'))).toHaveLength(3);
  expect(await source.current()).toEqual(project);
  const candidates = await runtime.dispatch('shot.candidates', { projectId: project.id, shotId: sixth.id }) as { items: ShotCandidate[] };
  const candidate = candidates.items.find(item => item.runId === redo.id)!;
  const applied = projectSchema.parse(await runtime.dispatch('shot.candidate.apply', { projectId: project.id, revision: project.revision, candidateId: candidate.id }));
  expect(applied.shots.slice(0, 5)).toEqual(project.shots.slice(0, 5));
  expect(applied.shots[5]).toMatchObject({ assetId: sixth.assetId, characterIds: [role.id], videoAssetId: candidate.shot.videoAssetId });
  expect(applied.shots[5].videoAssetId).not.toBe(sixth.videoAssetId);
  const evidence = process.env.VIDEO_QUICKLY_ACCEPTANCE_ARTIFACTS;
  if (evidence) {
    const exported = await runtime.dispatch('node.result', { runId: started.id, nodeId: 'export' }) as { videoPath: string };
    const [redoneClip] = assetSchema.array().parse(await runtime.dispatch('asset.getMany', { assetIds: [candidate.shot.videoAssetId] }));
    await mkdir(evidence, { recursive: true });
    await copyFile(exported.videoPath, join(evidence, 'six-shot-fixture.mp4'));
    await copyFile(redoneClip.path, join(evidence, 'shot-06-redo-fixture.mp4'));
  }

  const [frame] = assetSchema.array().parse(await runtime.dispatch('asset.getMany', { assetIds: [sixth.assetId] }));
  await unlink(frame.path);
  const missing = runSchema.parse(await runtime.dispatch('shot.regenerate', { ...regenerate, revision: applied.revision }));
  await runtime.waitForIdle();
  expect(await runtime.dispatch('run.get', { runId: missing.id })).toMatchObject({ status: 'needs_attention', error: expect.stringContaining('镜头首帧缺失或损坏') });
  expect(videos()).toHaveLength(7);
});

it.skipIf(!mediaAvailable).each(['first-frame', 'multi-reference'] as const)('reuses one library reference and one generated look across shots with %s video', async automaticCasting => {
  const scriptOutput = JSON.stringify({
    entities: [
      { key: 'qing', kind: 'character', name: '小青', description: '蓝外衣、黑色短发' },
      { key: 'chen', kind: 'character', name: '老陈', description: '圆眼镜、棕色外套' },
      { key: 'passerby', kind: 'character', name: '路人', description: '黑帽子' },
    ],
    shots: [
      { title: '花园见面', narration: '他们在木门见面。', visualPrompt: '小青与老陈在花园相遇', entityKeys: ['qing', 'chen'], durationUs: 4_000_000 },
      { title: '交谈', narration: '两人聊起木盒。', visualPrompt: '小青与老陈在喷泉旁交谈', entityKeys: ['qing', 'chen'], durationUs: 4_000_000 },
      { title: '路人经过', narration: '', visualPrompt: '一个戴黑帽的路人走过', entityKeys: ['passerby'], durationUs: 4_000_000 },
    ],
  });
  let interrupted = false;
  const source = await fixture({ full: true, scriptOutput, automaticCasting, failpoint(point, id) {
    if (automaticCasting === 'first-frame' && point === 'after-result' && id === 'assets:casting:looks' && !interrupted) {
      interrupted = true;
      throw new SimulatedProcessExit();
    }
  } });
  let runtime = source.runtime;
  const started = runSchema.parse(await runtime.dispatch('run.start', { projectId: source.project.id }));
  await runtime.waitForIdle();
  if (automaticCasting === 'first-frame') {
    expect(interrupted).toBe(true);
    expect(source.requests.filter(request => request.path.endsWith('/images/generations'))).toHaveLength(1);
    await runtime.close(); runtimes.delete(runtime);
    runtime = createRuntime({ ...source.options, failpoint: undefined }); runtimes.add(runtime);
    await runtime.dispatch('run.resume', { runId: started.id });
    await runtime.waitForIdle();
  }
  const completed = runSchema.parse(await runtime.dispatch('run.get', { runId: started.id }));
  expect(completed.status, completed.error).toBe('succeeded');
  const result = await source.current(runtime);
  const cast = result.creativeContext!.entities;
  expect(cast.find(entity => entity.key === 'qing')?.referenceAssetIds).toEqual([source.references[0].id]);
  expect(cast.find(entity => entity.key === 'passerby')?.referenceAssetIds).toBeUndefined();
  const lookId = cast.find(entity => entity.key === 'chen')!.referenceAssetIds![0];
  const { assets } = await runtime.dispatch('node.result', { runId: started.id, nodeId: 'assets' }) as { assets: AssetRecord[] };
  const look = assets.find(asset => asset.id === lookId)!;
  expect(look).toMatchObject({ projectId: result.id, name: '老陈 · 定妆图.png' });
  expect(look.shotId).toBeUndefined();
  const imageUrl = async (asset: AssetRecord) => `data:image/png;base64,${(await readFile(asset.path)).toString('base64')}`;
  const appearance = await imageUrl(look);
  const looks = source.requests.filter(request => request.path.endsWith('/images/generations') && String(request.body.prompt).includes('定妆设定图'));
  expect(looks).toHaveLength(1);
  expect(looks[0].body.prompt).toContain('老陈');
  const images = source.requests.filter(request => request.path.endsWith('/images/edits'));
  expect(images).toHaveLength(2);
  for (const request of images) {
    expect(request.body.images).toEqual([{ image_url: `data:image/png;base64,${source.referenceBytes[0].toString('base64')}` }, { image_url: appearance }]);
    expect(request.body.prompt).toContain('人物「老陈」参考图：图片 2');
  }
  const videoCalls = source.requests.filter(request => request.path.endsWith('/contents/generations/tasks'));
  expect(videoCalls).toHaveLength(3);
  for (const [index, request] of videoCalls.entries()) {
    const inputs = (request.body.content as Array<{ type: string }>).filter(item => item.type === 'image_url');
    if (index === 2) {
      expect(inputs).toHaveLength(automaticCasting === 'first-frame' ? 0 : 1);
    } else if (automaticCasting === 'first-frame') {
      const frame = assets.find(asset => asset.id === result.shots[index].assetId)!;
      expect(inputs).toEqual([{ type: 'image_url', image_url: { url: await imageUrl(frame) }, role: 'first_frame' }]);
      expect(frame.sha256).not.toEqual(look.sha256);
    } else {
      expect(inputs).toContainEqual({ type: 'image_url', image_url: { url: appearance }, role: 'reference_image' });
    }
  }
  if (automaticCasting === 'first-frame') {
    const shotId = result.shots[0].id;
    const regenerated = runSchema.parse(await runtime.dispatch('shot.regenerate', { projectId: result.id, shotId, revision: result.revision, kind: 'image',
      source: { runId: started.id, nodeId: 'assets', requestId: randomUUID() } }));
    await runtime.waitForIdle();
    const finished = runSchema.parse(await runtime.dispatch('run.get', { runId: regenerated.id }));
    expect(finished.status, finished.error).toBe('succeeded');
    expect(source.requests.at(-1)?.body.images).toEqual(images[0].body.images);
  }
  const backup = await runtime.dispatch('project.backup', { projectId: result.id }) as { path: string };
  const restored = projectSchema.parse(await runtime.dispatch('project.importBackup', { path: backup.path }));
  const restoredLookId = restored.creativeContext!.entities.find(entity => entity.key === 'chen')!.referenceAssetIds![0];
  const { assets: workspaceAssets } = await runtime.dispatch('workspace.snapshot') as { assets: AssetRecord[] };
  expect(workspaceAssets.find(asset => asset.id === restoredLookId)).toMatchObject({ projectId: restored.id, sha256: look.sha256 });
  expect(restoredLookId).not.toBe(lookId);
});
