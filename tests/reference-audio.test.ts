import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MAX_REFERENCE_AUDIO_BYTES, assetSchema, productionSettingsSchema, projectSchema } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src';
import { resolveReferenceAudio } from '../packages/integrations/src/audio-references';

const directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function directory() { const path = await mkdtemp(join(tmpdir(), 'vq-reference-audio-')); directories.push(path); return path; }

it('keeps reference audio optional and round-trips ordered unique selections through production settings', () => {
  expect(productionSettingsSchema.parse({ mode: 'native-video' }).referenceAudioAssetIds).toBeUndefined();
  const settings = productionSettingsSchema.parse({ mode: 'native-video', referenceAudioAssetIds: ['voice', 'music'] });
  expect(productionSettingsSchema.parse(JSON.parse(JSON.stringify(settings))).referenceAudioAssetIds).toEqual(['voice', 'music']);
  expect(productionSettingsSchema.safeParse({ ...settings, referenceAudioAssetIds: ['voice', 'voice'] }).success).toBe(false);
});

it('encodes selected WAV and MP3 assets in order and rejects changed or foreign inputs', async () => {
  const path = await directory(), content = Buffer.from('audio reference fixture');
  const assets = await Promise.all(['wav', 'mp3'].map(async (format, index) => {
    const file = join(path, `voice.${format}`); await writeFile(file, content);
    return assetSchema.parse({ id: `audio-${index}`, projectId: 'project', name: `voice.${format}`, kind: 'audio', mimeType: format === 'mp3' ? 'audio/mpeg' : 'audio/wav', path: file, size: content.length, sha256: createHash('sha256').update(content).digest('hex'), version: 1, provenance: 'fixture', createdAt: '' });
  }));
  const input = { assetIds: assets.map(asset => asset.id).reverse(), assets, projectId: 'project' };
  expect(await resolveReferenceAudio(input)).toEqual([
    { assetId: 'audio-1', dataUrl: 'data:audio/mp3;base64,' + content.toString('base64') },
    { assetId: 'audio-0', dataUrl: 'data:audio/wav;base64,' + content.toString('base64') },
  ]);
  await expect(resolveReferenceAudio({ ...input, projectId: 'other' })).rejects.toThrow('不属于');
  await expect(resolveReferenceAudio({ ...input, assets: [] })).rejects.toThrow('已移除');
  await writeFile(assets[0].path, Buffer.alloc(content.length));
  await expect(resolveReferenceAudio(input)).rejects.toThrow('校验失败');
});

it('validates reference imports before copying while keeping ordinary audio imports available', async () => {
  const path = await directory(), runtime = createRuntime({ dataDirectory: path, seed: false }); runtimes.push(runtime);
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '音频导入' }));
  const file = join(path, 'reference.wav'); await writeFile(file, Buffer.from('reference'));
  await truncate(file, MAX_REFERENCE_AUDIO_BYTES + 1);
  await expect(runtime.dispatch('asset.import', { projectId: project.id, path: file, kind: 'audio', purpose: 'reference-audio' })).rejects.toThrow('15 MB');
  const ordinary = assetSchema.parse(await runtime.dispatch('asset.import', { projectId: project.id, path: file, kind: 'audio' }));
  expect(ordinary.size).toBe(MAX_REFERENCE_AUDIO_BYTES + 1);
  await expect(resolveReferenceAudio({ assetIds: [ordinary.id], assets: [ordinary], projectId: project.id })).rejects.toThrow('15 MB');
  const other = join(path, 'reference.m4a'); await writeFile(other, 'reference');
  await expect(runtime.dispatch('asset.import', { projectId: project.id, path: other, kind: 'audio', purpose: 'reference-audio' })).rejects.toThrow('WAV 或 MP3');
});

it('protects selected audio and remaps its identity when a project backup is restored', async () => {
  const path = await directory(), runtime = createRuntime({ dataDirectory: path, seed: false }); runtimes.push(runtime);
  let project = projectSchema.parse(await runtime.dispatch('project.create', { title: '参考音频备份' }));
  const file = join(path, '声音参考.wav'); await writeFile(file, 'frozen reference audio');
  const asset = assetSchema.parse(await runtime.dispatch('asset.import', { projectId: project.id, path: file, kind: 'audio', purpose: 'reference-audio' }));
  project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, production: { ...project.workflow.production, referenceAudioAssetIds: [asset.id] } } } }));
  await expect(runtime.dispatch('asset.delete', { assetId: asset.id })).rejects.toThrow('正在使用');
  const backup = await runtime.dispatch('project.backup', { projectId: project.id }) as { path: string };
  const restored = projectSchema.parse(await runtime.dispatch('project.importBackup', { path: backup.path }));
  const [restoredId] = restored.workflow.production.referenceAudioAssetIds ?? [];
  expect(restoredId).toBeTruthy(); expect(restoredId).not.toBe(asset.id);
  const detail = await runtime.dispatch('project.get', { projectId: restored.id }) as { assets: unknown[] };
  const imported = detail.assets.map(value => assetSchema.parse(value)).find(asset => asset.id === restoredId);
  expect(imported?.projectId).toBe(restored.id);
  expect(await readFile(imported!.path, 'utf8')).toBe('frozen reference audio');
  await expect(runtime.dispatch('asset.delete', { assetId: restoredId })).rejects.toThrow('正在使用');
  project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, production: { ...project.workflow.production, referenceAudioAssetIds: [] } } } }));
  await expect(runtime.dispatch('asset.delete', { assetId: asset.id })).resolves.toEqual({ deleted: true });
});
