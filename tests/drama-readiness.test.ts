import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { characterProfileSchema, createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, voiceProfileSchema, workflowNodeSchema, type AssetRecord } from '@video-quickly/contracts';
import { createProjectReadiness, type ReadinessSnapshot } from '../src/packages/runtime/src/project-readiness';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-drama-readiness-'));
  const assets: AssetRecord[] = [];
  for (const [id, kind, mimeType] of [['appearance-image', 'image', 'image/png'], ['voice-audio', 'audio', 'audio/wav']] as const) {
    const bytes = Buffer.from(`saved reference ${id}`), path = join(directory, id);
    await writeFile(path, bytes);
    assets.push({ id, kind, mimeType, name: id, path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: '', provenance: 'isolated file fixture', retained: false, active: true });
  }
  const character = characterProfileSchema.parse({ id: 'lead', name: '阿青', description: '固定身份', referenceAssetIds: [], appearances: [{ id: 'coat', name: '雨衣', description: '黄色雨衣', referenceAssetIds: [assets[0].id] }], defaultVoiceId: 'voice', revision: 1, createdAt: '', updatedAt: '' });
  const voice = voiceProfileSchema.parse({ id: 'voice', name: '主角音色', description: '低沉清晰', referenceAssetIds: [assets[1].id], revision: 1, createdAt: '', updatedAt: '' });
  const project = projectSchema.parse({ id: 'episode', title: '雨夜', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(), createdAt: '', updatedAt: '', shots: [{ id: 'shot', title: '雨中对白', narration: '', visualPrompt: '', durationUs: 4_000_000, drama: { appearances: [{ characterId: character.id, appearanceId: 'coat' }], lines: [{ id: 'line', kind: 'dialogue', speakerId: character.id, text: '下雨了。' }] } }] });
  const saved: ReadinessSnapshot = { project, nodes: [workflowNodeSchema.parse({ id: 'local-script', label: '本地分镜', kind: 'script' })], models: [], skills: [], characters: [character], voices: [voice], assets };
  const readiness = createProjectReadiness({ snapshot: () => saved, system: { platform: process.platform, runtimeVersion: process.version, dataDirectory: directory, ffmpegAvailable: false, secureStorageAvailable: false, mode: 'development' }, directory, hasMediaExecutor: false, redactText: text => text });
  cleanups.push(async () => { await readiness.close(); await rm(directory, { recursive: true, force: true }); });
  return { saved, readiness, assets, character, voice };
}

it('checks all appearance images and voice-only speakers’ default references without contacting a service', async () => {
  const { saved, readiness, assets } = await fixture();
  const good = await readiness.check(saved.project.id);
  expect(good).toMatchObject({ ready: true, assetCount: 2, serviceCheck: 'not_contacted' });
  saved.project = { ...saved.project, shots: [{ ...saved.project.shots[0], drama: { appearances: [], lines: saved.project.shots[0].drama!.lines } }] };
  await writeFile(assets[1].path, Buffer.alloc(assets[1].size, 0));
  const bad = await readiness.check(saved.project.id);
  expect(bad.ready).toBe(false);
  expect(bad.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', assetId: assets[1].id, fix: 'assets' })]));
});

it('reports missing voices, selected appearances and invalid public audio metadata as blockers', async () => {
  const { saved, readiness, voice, assets } = await fixture();
  saved.voices = [];
  expect((await readiness.check(saved.project.id)).issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', message: expect.stringContaining('音色不存在') })]));
  saved.voices = [voice]; saved.assets = [assets[0], { ...assets[1], projectId: 'another-project' }];
  expect((await readiness.check(saved.project.id)).issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', assetId: assets[1].id, message: expect.stringContaining('公共素材库') })]));
  saved.assets = assets; saved.characters = [{ ...saved.characters[0], appearances: [] }];
  expect((await readiness.check(saved.project.id)).issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', category: 'workflow', message: expect.stringContaining('镜头形象不存在') })]));
});
