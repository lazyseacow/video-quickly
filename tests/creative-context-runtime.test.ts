import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assetRecoveryJobSchema, assetRecoveryPageSchema, assetSchema, characterProfileSchema, creativeContextSchema, createNativeVideoWorkflow, modelSchema, projectSchema, runSchema, type AssetRecord, type CharacterProfile, type ProjectDocument, type ShotCandidate } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src';
import { createActivityExecutor, validateMediaActivity } from '../packages/integrations/src';
import { probeMedia } from '../packages/video/src/node';
import { fixtureNativeVideo } from './fixtures/native-video';

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

async function fixture(extra: { full?: boolean; scriptOutput?: string; failpoint?: RuntimeOptions['failpoint']; holdScript?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-creative-context-')); directories.push(directory);
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let entered!: () => void, release!: () => void;
  const enteredScript = new Promise<void>(resolve => { entered = resolve; });
  const scriptGate = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  const video = extra.full ? fixtureNativeVideo() : undefined;
  let baseUrl = '';
  const server = createServer((request, response) => { void (async () => {
    response.setHeader('content-type', 'application/json');
    if (request.method !== 'POST') {
      if (request.url === '/video.mp4') { response.setHeader('content-type', 'video/mp4'); response.end(video); }
      else response.end(JSON.stringify({ status: 'succeeded', content: { video_url: `${baseUrl}/video.mp4` } }));
      return;
    }
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const path = request.url ?? '', body = JSON.parse(raw) as Record<string, unknown>; requests.push({ path, body });
    if (path.endsWith('/chat/completions')) {
      const script = raw.includes('自动视频制作步骤：旁白与分镜');
      if (script) { entered(); if (extra.holdScript) await scriptGate; }
      response.end(JSON.stringify({ choices: [{ message: { content: script ? extra.scriptOutput ?? JSON.stringify(generatedScript()) : '柔和的傍晚光线，服装和空间保持连续。' } }], usage: { prompt_tokens: 20, completion_tokens: 30 } }));
    } else if (path.endsWith('/images/edits')) response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
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
  const videoModel = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '本地视频', provider: 'seedance', baseUrl, connectionType: 'video', capabilities: ['video'], model: 'seedance-2-0-fixture', parameters: { characterReferenceMode: 'reference_image' } } }));
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '花园中的角色', brief: '小青与小红在花园找到红木盒', profile: { width: 160, height: 90, frameRate: { numerator: 30, denominator: 1 } } }));
  const workflow = createNativeVideoWorkflow();
  const nodes = extra.full ? workflow.nodes : workflow.nodes.filter(node => ['script', 'assets'].includes(node.id));
  const ids = new Set(nodes.map(node => node.id));
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: {
    creativeContext: creativeContextSchema.parse({ characterIds: profiles.map(profile => profile.id), continuity: '同一个傍晚，衣服保持不变', entities: [
      { key: 'garden', kind: 'scene', name: '花园', description: '左侧木门，右侧石喷泉' }, { key: 'kitchen', kind: 'scene', name: '厨房', description: '白色瓷砖与银色水槽' },
    ] }),
    workflow: { ...workflow, nodes, edges: workflow.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)), stages: workflow.stages?.flatMap(stage => { const nodeIds = stage.nodeIds.filter(id => ids.has(id)); return nodeIds.length ? [{ ...stage, nodeIds }] : []; }), production: { ...workflow.production, textModelId: text.id, imageModelId: image.id, videoModelId: videoModel.id, referenceMode: 'generate' } },
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
  expect(source.requests).toHaveLength(1); expect((await source.current()).shots).toEqual([]);
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
  expect(source.requests.filter(request => request.path.endsWith('/chat/completions'))).toHaveLength(1);
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
