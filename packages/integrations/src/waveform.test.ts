import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AssetRecord } from '@video-quickly/contracts';
import { createWaveformReader } from './waveform';

const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
const mediaAvailable = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;
const directories: string[] = [];
const readers: ReturnType<typeof createWaveformReader>[] = [];
afterEach(async () => {
  await Promise.all(readers.splice(0).map(reader => reader.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-waveform-'));
  directories.push(directory);
  const sampleRate = 16_000, samples = sampleRate * 2;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + samples * 2, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    const amplitude = index < sampleRate / 2 ? 0 : index < sampleRate ? .2 : index < sampleRate * 1.5 ? .8 : .4;
    bytes.writeInt16LE(Math.round(amplitude * 32767 * Math.sin(2 * Math.PI * 400 * index / sampleRate)), 44 + index * 2);
  }
  const path = join(directory, 'source.wav'); await writeFile(path, bytes);
  const asset: AssetRecord = { id: 'audio-one', kind: 'audio', name: '源音频', path, mimeType: 'audio/wav', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: new Date().toISOString(), provenance: '测试音频', retained: false, active: true };
  return { directory, asset, bytes };
}

it.skipIf(!mediaAvailable)('streams real PCM peaks, deduplicates requests and reuses validated disk cache after restart', async () => {
  const { directory, asset } = await fixture();
  let decoders = 0;
  const reader = createWaveformReader({ dataDirectory: directory, ffmpegPath: ffmpeg, spawnDecoder: (file, args) => { decoders++; return spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } }); readers.push(reader);
  const results = await Promise.all(Array.from({ length: 8 }, () => reader.read(asset)));
  expect(decoders).toBe(1);
  const result = results[0];
  expect(result.durationUs).toBe(2_000_000);
  expect(result.peaks).toHaveLength(200);
  expect(result.peaks.slice(0, 50).every(peak => peak === 0)).toBe(true);
  expect(result.peaks[70]).toBeCloseTo(.2, 3);
  expect(result.peaks[120]).toBeCloseTo(.8, 3);
  expect(result.peaks[170]).toBeCloseTo(.4, 3);
  await reader.close();
  const restarted = createWaveformReader({ dataDirectory: directory, ffmpegPath: '/not-a-real-decoder' }); readers.push(restarted);
  expect(await restarted.read({ ...asset, id: 'same-content-new-record' })).toEqual({ ...result, assetId: 'same-content-new-record' });
  await writeFile(asset.path, 'changed media');
  await expect(restarted.read(asset)).rejects.toThrow('校验失败');
}, 30_000);

it.skipIf(!mediaAvailable)('cancels one consumer without canceling the shared decoder and cleans canceled queued work', async () => {
  const { directory, asset } = await fixture();
  const reader = createWaveformReader({ dataDirectory: directory, ffmpegPath: ffmpeg, maxConcurrent: 1, spawnDecoder: (file, args) => spawn(file, ['-re', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }); readers.push(reader);
  const controller = new AbortController();
  const canceled = reader.read(asset, { signal: controller.signal });
  const surviving = Promise.allSettled([reader.read(asset)]);
  controller.abort(new Error('消费者取消'));
  await expect(canceled).rejects.toThrow('消费者取消');
  const secondPath = join(directory, 'second.wav'); await writeFile(secondPath, await readFile(asset.path));
  const queuedController = new AbortController();
  const queued = reader.read({ ...asset, id: 'queued', path: secondPath }, { signal: queuedController.signal });
  queuedController.abort(new Error('队列取消'));
  await expect(queued).rejects.toThrow('队列取消');
  const [result] = await surviving;
  if (result.status === 'rejected') throw result.reason;
  expect(result.value.peaks).toHaveLength(200);
  await reader.close();
  const cache = join(directory, 'derived', 'waveforms', 'v1-mono-16000-peak-100hz');
  expect((await readdir(cache)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  await expect(reader.read(asset)).rejects.toThrow('已关闭');
}, 30_000);

it.skipIf(!mediaAvailable)('rejects undecodable sources and leaves no partial derived files', async () => {
  const { directory, asset } = await fixture();
  const bytes = Buffer.from('invalid audio'); await writeFile(asset.path, bytes);
  const reader = createWaveformReader({ dataDirectory: directory, ffmpegPath: ffmpeg }); readers.push(reader);
  await expect(reader.read({ ...asset, sha256: createHash('sha256').update(bytes).digest('hex') })).rejects.toThrow('无法读取音频波形');
  await expect(reader.read({ ...asset, kind: 'image' })).rejects.toThrow('不包含音频波形');
  expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
}, 30_000);

it.skipIf(!mediaAvailable)('terminates an active real decoder when its last consumer cancels', async () => {
  const { directory, asset } = await fixture();
  let decoder: ReturnType<typeof spawn> | undefined;
  const reader = createWaveformReader({ dataDirectory: directory, ffmpegPath: ffmpeg, spawnDecoder: (file, args) => {
    const child = spawn(file, ['-re', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); decoder = child; return child;
  } }); readers.push(reader);
  const controller = new AbortController();
  const result = Promise.allSettled([reader.read(asset, { signal: controller.signal })]);
  await vi.waitFor(() => expect(decoder?.pid).toBeGreaterThan(0));
  controller.abort(new Error('终止读取'));
  expect((await result)[0]).toMatchObject({ status: 'rejected', reason: new Error('终止读取') });
  await reader.close();
  expect(decoder?.exitCode !== null || decoder?.signalCode !== null).toBe(true);
  expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
}, 30_000);
