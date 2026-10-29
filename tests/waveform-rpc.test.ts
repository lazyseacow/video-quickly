import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { assetSchema, projectDetailSchema, projectSchema, type AssetRecord } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src';

const directories: string[] = [];
const runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('reads a waveform through the injected boundary without changing project revision or workspace state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-waveform-rpc-')); directories.push(directory);
  let wrongSource = false;
  const readAudioWaveform = vi.fn(async (asset: AssetRecord) => ({ version: 1 as const, assetId: wrongSource ? 'different-asset' : asset.id, sha256: asset.sha256, durationUs: 20_000, peaksPerSecond: 100 as const, peaks: [.1, .8] }));
  const runtime = createRuntime({ dataDirectory: directory, seed: false, readAudioWaveform }); runtimes.push(runtime);
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '只读波形' }));
  const path = join(directory, 'source.wav'); await writeFile(path, 'source fixture');
  const asset = assetSchema.parse(await runtime.dispatch('asset.import', { path, projectId: project.id }));
  const before = projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id }));
  const changed = vi.fn(); runtime.subscribe(changed);
  expect(await runtime.dispatch('asset.waveform', { assetId: asset.id })).toMatchObject({ assetId: asset.id, peaks: [.1, .8] });
  expect(readAudioWaveform).toHaveBeenCalledWith(asset);
  expect(changed).not.toHaveBeenCalled();
  const after = projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id }));
  expect(after).toEqual(before);
  wrongSource = true;
  await expect(runtime.dispatch('asset.waveform', { assetId: asset.id })).rejects.toThrow('不匹配');
  await expect(runtime.dispatch('asset.waveform', { assetId: 'missing' })).rejects.toThrow('不存在');
  const imagePath = join(directory, 'picture.png'); await writeFile(imagePath, 'image fixture');
  const image = assetSchema.parse(await runtime.dispatch('asset.import', { path: imagePath }));
  await expect(runtime.dispatch('asset.waveform', { assetId: image.id })).rejects.toThrow('音频或视频');
  expect(readAudioWaveform).toHaveBeenCalledTimes(2);
});
