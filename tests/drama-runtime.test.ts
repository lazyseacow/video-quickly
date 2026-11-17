import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  assetSchema, characterProfileSchema, dramaWorkSchema, projectSchema, recordPageSchema, runSchema, shotSchema, voiceProfileSchema, workspaceSummarySchema,
  type AssetRecord, type CharacterProfile, type DramaWork, type ModelProfile, type ProjectDocument, type ProjectSummary, type VoiceProfile,
} from '@video-quickly/contracts';
import { createRuntime, type RuntimeOptions } from '../src/packages/runtime/src';
import { createActivityExecutor, validateMediaActivity } from '../src/packages/integrations/src';
import { probeMedia } from '../src/packages/video/src/node';
import { fixtureCharacterImage } from './fixtures/character-image';

const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const mediaAvailable = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0 && spawnSync(ffprobe, ['-version'], { windowsHide: true }).status === 0;
const directories: string[] = [], servers: Server[] = [], runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
function audioSample() {
  const data = Buffer.alloc(44 + 1600); data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24);
  data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(1600, 40);
  return data;
}
function open(directory: string, extra: Partial<RuntimeOptions> = {}) { const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/unused', ...extra }); runtimes.add(runtime); return runtime; }
async function fixture(extra: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-drama-runtime-')); directories.push(directory);
  const runtime = open(directory, extra), source = new Map<string, Buffer>();
  async function asset(name: string, kind: 'image' | 'audio', bytes: Buffer) {
    const path = join(directory, name); await writeFile(path, bytes);
    const imported = assetSchema.parse(await runtime.dispatch('asset.import', { path, kind })); source.set(imported.id, bytes); return imported;
  }
  const image = await asset('character.png', 'image', png), alternate = await asset('appearance.png', 'image', Buffer.concat([png, Buffer.from('alternate')]));
  const audio = await asset('voice.wav', 'audio', audioSample());
  const voice = voiceProfileSchema.parse(await runtime.dispatch('voice.save', { voice: { name: '林夏音色', description: '清晰而克制', language: 'zh-CN', referenceAssetIds: [audio.id] } }));
  const narrator = voiceProfileSchema.parse(await runtime.dispatch('voice.save', { voice: { name: '解说音色', description: '平稳自然', referenceAssetIds: [audio.id] } }));
  const character = characterProfileSchema.parse(await runtime.dispatch('character.save', { character: {
    name: '林夏', description: '短发，固定脸型', referenceAssetIds: [image.id], defaultVoiceId: voice.id,
    appearances: [{ id: 'office', name: '职场装', description: '深蓝西装', referenceAssetIds: [alternate.id] }, { id: 'home', name: '家居装', description: '浅色上衣', referenceAssetIds: [] }],
  } }));
  const work = dramaWorkSchema.parse(await runtime.dispatch('dramaWork.save', { work: { title: '会议之后', description: '同一组角色连续制作', visualStyle: 'live-action', narrativeMode: 'mixed', characterIds: [character.id] } }));
  return { directory, runtime, image, alternate, audio, voice, narrator, character, work, source };
}
async function current(runtime: ReturnType<typeof createRuntime>, projectId: string) {
  return projectSchema.parse((await runtime.dispatch('project.get', { projectId }) as { project: ProjectDocument }).project);
}
async function episode(source: Awaited<ReturnType<typeof fixture>>, number = 1) {
  return projectSchema.parse(await source.runtime.dispatch('project.create', { title: `第${number}集`, originalText: '原文中的角色和事件。', drama: { workId: source.work.id, number } }));
}
function authoredShot(source: Awaited<ReturnType<typeof fixture>>) {
  return shotSchema.parse({ id: 'shot-1', title: '会议室', narration: '', visualPrompt: '人物推门走入会议室', durationUs: 4_000_000,
    drama: { sceneId: 'scene-meeting', appearances: [{ characterId: source.character.id, appearanceId: 'office' }], lines: [
      { id: 'line-dialogue', kind: 'dialogue', speakerId: source.character.id, text: '这份方案，我不同意。', emotion: '克制', pauseAfterUs: 300_000 },
      { id: 'line-narration', kind: 'narration', voiceId: source.narrator.id, text: '所有人都看向了她。' },
    ] },
  });
}
async function author(source: Awaited<ReturnType<typeof fixture>>, initial: ProjectDocument) {
  return projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: initial.id, revision: initial.revision, patch: {
    drama: { ...initial.drama, scenes: [{ id: 'scene-meeting', title: '第一次会议', location: '公司会议室', timeOfDay: '白天', description: '落地窗在左' }] },
    shots: [authoredShot(source)],
  } }));
}

it('creates independent visual and narrative work defaults and inherits shared roles into new episodes', async () => {
  const source = await fixture();
  for (const [visualStyle, narrativeMode] of [['live-action', 'dialogue'], ['animation', 'mixed'], ['live-action', 'narration']] as const) {
    const work = dramaWorkSchema.parse(await source.runtime.dispatch('dramaWork.save', { work: { title: `${visualStyle}-${narrativeMode}`, visualStyle, narrativeMode, characterIds: [source.character.id] } }));
    const saved = dramaWorkSchema.parse(await source.runtime.dispatch('dramaWork.get', { workId: work.id })); expect(saved).toEqual(work);
    const created = projectSchema.parse(await source.runtime.dispatch('project.create', { title: '第一集', drama: { workId: work.id, number: 1 } }));
    expect(created.drama).toEqual({ workId: work.id, number: 1, visualStyle, narrativeMode, scenes: [] });
    expect(created.creativeContext?.characterIds).toEqual([source.character.id]);
  }
  const firstPage = recordPageSchema(dramaWorkSchema).parse(await source.runtime.dispatch('dramaWork.list', { limit: 2 }));
  expect(firstPage.items).toHaveLength(2); expect(firstPage.nextCursor).not.toBeNull();
  const nextPage = recordPageSchema(dramaWorkSchema).parse(await source.runtime.dispatch('dramaWork.list', { limit: 2, before: firstPage.nextCursor }));
  expect(nextPage.items).toHaveLength(2); expect(nextPage.nextCursor).toBeNull();
  expect(new Set([...firstPage.items, ...nextPage.items].map(work => work.id)).size).toBe(4);
});

it('freezes inherited episode choices while work revisions affect only newly created episodes', async () => {
  const source = await fixture(), first = await episode(source);
  const changed = dramaWorkSchema.parse(await source.runtime.dispatch('dramaWork.save', { work: { ...source.work, visualStyle: 'animation', narrativeMode: 'narration', characterIds: [] } }));
  const second = await episode({ ...source, work: changed }, 2);
  expect((await current(source.runtime, first.id)).drama).toEqual(first.drama);
  expect((await current(source.runtime, first.id)).creativeContext?.characterIds).toEqual([source.character.id]);
  expect(second.drama).toMatchObject({ visualStyle: 'animation', narrativeMode: 'narration' }); expect(second.creativeContext?.characterIds).toEqual([]);
  await expect(source.runtime.dispatch('dramaWork.save', { work: { ...source.work, title: '过期编辑' } })).rejects.toThrow('其他视图修改');
  expect(await source.runtime.dispatch('dramaWork.get', { workId: source.work.id })).toEqual(changed);
});

it('rejects duplicate episode numbers even when the original is archived and keeps episode listing ordered', async () => {
  const source = await fixture(), third = await episode(source, 3), first = await episode(source, 1);
  const archived = projectSchema.parse(await source.runtime.dispatch('project.archive', { projectId: first.id })); expect(archived.archived).toBe(true);
  await expect(episode(source, 1)).rejects.toThrow('已存在第 1 集');
  await expect(source.runtime.dispatch('project.update', { projectId: third.id, revision: third.revision, patch: { drama: { ...third.drama, number: 1 } } })).rejects.toThrow('已存在第 1 集');
  const listed = await source.runtime.dispatch('dramaWork.episodes', { workId: source.work.id }) as ProjectSummary[];
  expect(listed.map(item => item.id)).toEqual([first.id, third.id]); expect(listed[0].archived).toBe(true);
  expect((await current(source.runtime, third.id)).revision).toBe(third.revision);
});

it('persists scenes, shots, dialogue, appearances and voices across a real runtime restart', async () => {
  const source = await fixture(), saved = await author(source, await episode(source));
  await source.runtime.close(); runtimes.delete(source.runtime);
  const restarted = open(source.directory);
  expect(await current(restarted, saved.id)).toEqual(saved);
  expect(await restarted.dispatch('character.get', { characterId: source.character.id })).toEqual(source.character);
  expect(await restarted.dispatch('voice.get', { voiceId: source.voice.id })).toEqual(source.voice);
  expect(await restarted.dispatch('voice.get', { voiceId: source.narrator.id })).toEqual(source.narrator);
  expect(await restarted.dispatch('dramaWork.get', { workId: source.work.id })).toEqual(source.work);
});

it('rejects dangling scene, role, appearance and voice references without mutating the episode', async () => {
  const source = await fixture(), saved = await author(source, await episode(source)), initialShot = saved.shots[0];
  const changes = [
    { ...initialShot.drama!, sceneId: 'missing-scene' },
    { ...initialShot.drama!, appearances: [{ characterId: source.character.id, appearanceId: 'missing-appearance' }] },
    { ...initialShot.drama!, appearances: [{ characterId: 'missing-character', appearanceId: 'office' }] },
    { ...initialShot.drama!, lines: [{ ...initialShot.drama!.lines[0], speakerId: 'missing-speaker' }] },
    { ...initialShot.drama!, lines: [{ id: 'narration', kind: 'narration' as const, text: '旁白', voiceId: 'missing-voice' }] },
  ];
  for (const drama of changes) {
    await expect(source.runtime.dispatch('project.update', { projectId: saved.id, revision: saved.revision, patch: { shots: [{ ...initialShot, drama }] } })).rejects.toThrow('不存在');
    expect(await current(source.runtime, saved.id)).toEqual(saved);
  }
  await expect(source.runtime.dispatch('dramaWork.save', { work: { ...source.work, characterIds: ['missing-role'] } })).rejects.toThrow('公共角色库');
});

it('creates a drama episode through the quick API and permits existing episodes to be edited under an archived work', async () => {
  const source = await fixture(), initial = await episode(source);
  const ordinary = projectSchema.parse(await source.runtime.dispatch('project.create', { title: '普通剪辑项目' }));
  expect(ordinary.drama).toMatchObject({ number: 1, visualStyle: 'live-action', narrativeMode: 'mixed' });
  const renamed = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: ordinary.id, revision: ordinary.revision, patch: { title: '修改普通项目' } }));
  expect(renamed.drama).toEqual(ordinary.drama);
  const archived = dramaWorkSchema.parse(await source.runtime.dispatch('dramaWork.archive', { workId: source.work.id, revision: source.work.revision }));
  await expect(episode(source, 2)).rejects.toThrow('已归档');
  const updated = await author(source, initial); expect(updated.shots[0].drama?.lines).toHaveLength(2);
  await expect(source.runtime.dispatch('project.update', { projectId: initial.id, revision: initial.revision, patch: { title: '过期保存' } })).rejects.toThrow('修改');
  const restore = dramaWorkSchema.parse(await source.runtime.dispatch('dramaWork.restore', { workId: source.work.id, revision: archived.revision }));
  expect(restore.archived).toBe(false); expect((await episode({ ...source, work: restore }, 2)).drama?.number).toBe(2);
});

it('returns light episode summaries without full scene, dialogue or original-text collections', async () => {
  const source = await fixture(), saved = await author(source, await episode(source));
  const summary = workspaceSummarySchema.parse(await source.runtime.dispatch('workspace.summary'));
  const item = summary.projects.find(project => project.id === saved.id)!;
  expect(item.drama).toEqual({ workId: source.work.id, number: 1, visualStyle: 'live-action', narrativeMode: 'mixed' });
  expect(item.drama).not.toHaveProperty('scenes'); expect(item).not.toHaveProperty('originalText'); expect(item).not.toHaveProperty('shots');
  expect(item.shotCount).toBe(1);
  const episodes = await source.runtime.dispatch('dramaWork.episodes', { workId: source.work.id }) as ProjectSummary[];
  expect(episodes[0].drama).toEqual(item.drama);
  expect(episodes[0]).not.toHaveProperty('originalText'); expect(episodes[0].drama).not.toHaveProperty('scenes');
});

it('exports a format-10 backup with work, voices, every appearance and portable image/audio bytes', async () => {
  const source = await fixture(), saved = await author(source, await episode(source));
  const result = await source.runtime.dispatch('project.backup', { projectId: saved.id }) as { path: string; assets: number };
  const manifest = JSON.parse(await readFile(join(result.path, 'project.json'), 'utf8')) as {
    schemaVersion: number; project: ProjectDocument; dramaWork: DramaWork; voices: VoiceProfile[]; characters: CharacterProfile[]; assets: AssetRecord[];
  };
  expect(manifest.schemaVersion).toBe(10); expect(manifest.project).toEqual(saved); expect(manifest.dramaWork).toEqual(source.work);
  expect(manifest.characters).toEqual([source.character]); expect(manifest.voices).toEqual(expect.arrayContaining([source.voice, source.narrator]));
  expect(manifest.voices).toHaveLength(2); expect(manifest.assets.map(asset => asset.id).sort()).toEqual([source.image.id, source.alternate.id, source.audio.id].sort());
  expect(result.assets).toBe(3);
  for (const asset of manifest.assets) {
    expect(asset.path).toMatch(/^assets\//); expect(await readFile(join(result.path, asset.path))).toEqual(source.source.get(asset.id));
  }
});

it('starts and completes a scoped planning run with an existing bound scene and authored dialogue', async () => {
  const source = await fixture(), initial = await author(source, await episode(source));
  const configured = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: initial.id, revision: initial.revision, patch: {
    brief: '保留已保存的场次、人物和台词。', workflow: { ...initial.workflow, production: { ...initial.workflow.production, manualPlanningSteps: ['brief'] } },
  } }));
  const started = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: configured.id, revision: configured.revision, nodeId: 'brief' }));
  await source.runtime.waitForIdle();
  const finished = runSchema.parse(await source.runtime.dispatch('run.get', { runId: started.id }));
  expect(finished.status, finished.error).toBe('succeeded');
  expect(await current(source.runtime, configured.id)).toEqual(configured);
});

it('runs a single-shot image request through a local service while preserving the episode scene and voice snapshot', async () => {
  const generated = await fixtureCharacterImage(), prompts: string[] = [];
  const server = createServer((request, response) => { void (async () => {
    let body = ''; for await (const part of request) body += String(part); prompts.push(body);
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ b64_json: generated.toString('base64') }] }));
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('本地图片服务未启动');
  const source = await fixture({ executeActivity: createActivityExecutor(), preflightActivity: validateMediaActivity });
  const saved = await author(source, await episode(source));
  const model = await source.runtime.dispatch('model.save', { model: { name: '本地图片验证', provider: 'openai-compatible', connectionType: 'image', capabilities: ['image'], model: 'gpt-image-fixture', baseUrl: `http://127.0.0.1:${address.port}/v1` } }) as ModelProfile;
  const started = runSchema.parse(await source.runtime.dispatch('shot.regenerate', { projectId: saved.id, revision: saved.revision, shotId: saved.shots[0].id, kind: 'image', modelId: model.id }));
  await source.runtime.waitForIdle();
  const finished = runSchema.parse(await source.runtime.dispatch('run.get', { runId: started.id }));
  expect(finished.status, finished.error).toBe('succeeded'); expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('公司会议室'); expect(prompts[0]).toContain('深蓝西装');
  const candidates = await source.runtime.dispatch('shot.candidates', { projectId: saved.id, shotId: saved.shots[0].id }) as { items: { id: string }[] };
  expect(candidates.items).toHaveLength(1);
  const applied = projectSchema.parse(await source.runtime.dispatch('shot.candidate.apply', { projectId: saved.id, revision: saved.revision, candidateId: candidates.items[0].id }));
  expect(applied.drama).toEqual(saved.drama); expect(applied.shots[0].drama).toEqual(saved.shots[0].drama); expect(applied.shots[0].assetId).toBeTruthy();
});

it.skipIf(!mediaAvailable)('exports an actual MP4 from a scene-bound drama episode without losing its authored data', async () => {
  const source = await fixture({ executeActivity: createActivityExecutor({ ffmpegPath: ffmpeg }), preflightActivity: validateMediaActivity, ffmpegPath: ffmpeg });
  const initial = await author(source, await episode(source)), path = join(source.directory, 'render-source.png');
  await writeFile(path, await fixtureCharacterImage());
  const image = assetSchema.parse(await source.runtime.dispatch('asset.import', { path, kind: 'image' }));
  const configured = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: initial.id, revision: initial.revision, patch: {
    profile: { ...initial.profile, width: 160, height: 90, frameRate: { numerator: 24, denominator: 1 } }, shots: [{ ...initial.shots[0], assetId: image.id, durationUs: 1_000_000 }],
  } }));
  const started = await source.runtime.dispatch('render.export', { projectId: configured.id }) as { runId: string };
  await source.runtime.waitForIdle();
  const finished = runSchema.parse(await source.runtime.dispatch('run.get', { runId: started.runId })); expect(finished.status, finished.error).toBe('succeeded');
  const result = await source.runtime.dispatch('node.result', { runId: started.runId, nodeId: 'export' }) as { videoPath: string };
  const probe = await probeMedia(result.videoPath, ffprobe);
  expect(probe.width).toBe(160); expect(probe.height).toBe(90); expect(probe.duration).toBeCloseTo(1, 1);
  expect((await current(source.runtime, configured.id)).drama).toEqual(configured.drama);
  expect((await current(source.runtime, configured.id)).shots[0].drama).toEqual(configured.shots[0].drama);
});
