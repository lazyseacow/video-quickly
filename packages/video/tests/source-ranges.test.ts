import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { afterEach, expect, it } from 'vitest';
import { createHistoryWorkflow, DEFAULT_VIDEO_PROFILE, shotSchema, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';
import { drawSceneFrame, frameTimeUs, type SceneFrame } from '../src/index.js';
import { probeMedia, renderProject, runMedia } from '../src/node.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const profile = { ...DEFAULT_VIDEO_PROFILE, width: 320, height: 180, previewScale: 1 };

it('renders a split scene at the original animation and caption time and clamps its tail', () => {
  const scene: SceneFrame = { title: '连续场景', narration: '第一行旁白。第二行旁白。', profile, shotIndex: 0, durationUs: 4_000_000, animation: { panX: .05, panY: 0, zoom: 1.3, transition: 'cut' } };
  function pixels(frame: SceneFrame, timeUs: number) {
    const canvas = createCanvas(profile.width, profile.height);
    drawSceneFrame(canvas as unknown as HTMLCanvasElement, frame, timeUs);
    return canvas.toBuffer('image/png');
  }
  const trimmed = { ...scene, shotIndex: 1, sceneIndex: 0, durationUs: 1_000_000, sceneInUs: 2_000_000, sceneDurationUs: 4_000_000 };
  expect(pixels(trimmed, 200_000)).toEqual(pixels(scene, 2_200_000));
  expect(pixels(trimmed, 8_000_000)).toEqual(pixels(scene, 4_000_000));
});

const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const mediaAvailable = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0 && spawnSync(ffprobe, ['-version'], { windowsHide: true }).status === 0;

it.skipIf(!mediaAvailable)('exports the selected picture and audio interval without extending an edited clip, and retains legacy narration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-source-ranges-')); directories.push(directory);
  const sourcePath = join(directory, 'red-blue-tones.mp4');
  await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a]concat=n=2:v=0:a=1[a]', '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath]);
  const bytes = await readFile(sourcePath);
  const metadata = { projectId: 'ranges', path: sourcePath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: '', provenance: 'isolated real media fixture', active: true, retained: false };
  const assets: AssetRecord[] = [{ ...metadata, id: 'video', name: 'source.mp4', kind: 'video', mimeType: 'video/mp4' }, { ...metadata, id: 'voice', name: 'source.m4a', kind: 'audio', mimeType: 'audio/mp4' }];
  const shot = shotSchema.parse({ id: 'trimmed', title: '裁剪片段', narration: '', visualPrompt: '', durationUs: 1_000_000, sourceInUs: 1_000_000, sceneInUs: 1_000_000, sceneDurationUs: 2_000_000, videoAssetId: 'video', audioAssetId: 'voice', animation: { transition: 'cut' } });
  const project: ProjectDocument = { id: 'ranges', title: '真实区间验收', brief: '', templateId: 'generic', revision: 1, profile, shots: [shot], claims: [], style: '', archived: false, createdAt: '', updatedAt: '', workflow: createHistoryWorkflow() };
  const trimmed = await renderProject({ project, assets, outputDirectory: join(directory, 'trimmed'), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  const output = await probeMedia(trimmed.videoPath, ffprobe);
  expect(output.videoDuration).toBeCloseTo(1, 1); expect(output.audioDuration).toBeCloseTo(1, 1);
  const pixelPath = join(directory, 'pixel.rgb');
  await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.2', '-i', trimmed.videoPath, '-frames:v', '1', '-vf', 'scale=2:2', '-pix_fmt', 'rgb24', '-f', 'rawvideo', pixelPath]);
  const pixel = await readFile(pixelPath); expect(pixel[2]).toBeGreaterThan(180); expect(pixel[0]).toBeLessThan(40);
  async function frequency(path: string, name: string) {
    const pcmPath = join(directory, `${name}.pcm`);
    await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.2', '-i', path, '-t', '0.4', '-ac', '1', '-ar', '8000', '-f', 's16le', pcmPath]);
    const pcm = await readFile(pcmPath); let crossings = 0;
    for (let index = 2; index < pcm.length; index += 2) if (pcm.readInt16LE(index - 2) <= 0 && pcm.readInt16LE(index) > 0) crossings++;
    return crossings / (pcm.length / 2 / 8000);
  }
  expect(await frequency(trimmed.videoPath, 'video')).toBeGreaterThan(750);
  const canvasTrim = await renderProject({ project: { ...project, shots: [{ ...shot, videoAssetId: undefined }] }, assets, outputDirectory: join(directory, 'canvas'), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  expect((await probeMedia(canvasTrim.videoPath, ffprobe)).videoDuration).toBeCloseTo(1, 1);
  expect(await frequency(canvasTrim.videoPath, 'canvas')).toBeGreaterThan(750);
  async function pixelAtStart(path: string, name: string) {
    const pixels = join(directory, `${name}.rgb`);
    await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.2', '-i', path, '-frames:v', '1', '-vf', 'scale=2:2', '-pix_fmt', 'rgb24', '-f', 'rawvideo', pixels]);
    return readFile(pixels);
  }
  const newVoiceShot = { ...shot, audioInUs: 0, captionTrack: { timeBase: 'source' as const, alignment: 'speech' as const, sourceAssetId: 'voice', sourceSha256: assets[1].sha256, cues: [{ id: 'first', startUs: 0, endUs: 800_000, text: 'New voice start' }] } };
  const newVoice = await renderProject({ project: { ...project, shots: [newVoiceShot] }, assets, outputDirectory: join(directory, 'new-voice'), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  const firstVoice = await frequency(newVoice.videoPath, 'new-voice');
  expect(firstVoice).toBeGreaterThan(350); expect(firstVoice).toBeLessThan(600);
  expect((await pixelAtStart(newVoice.videoPath, 'new-voice'))[2]).toBeGreaterThan(180);
  expect(await readFile(newVoice.subtitlePath, 'utf8')).toContain('00:00:00,000 --> 00:00:00,800\nNew voice start');
  const newVideo = await renderProject({ project: { ...project, shots: [{ ...shot, videoInUs: 0 }] }, assets, outputDirectory: join(directory, 'new-video'), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  expect((await pixelAtStart(newVideo.videoPath, 'new-video'))[0]).toBeGreaterThan(180);
  expect(await frequency(newVideo.videoPath, 'new-video')).toBeGreaterThan(750);
  const canvasVoice = await renderProject({ project: { ...project, shots: [{ ...shot, videoAssetId: undefined, audioInUs: 0 }] }, assets, outputDirectory: join(directory, 'canvas-new-voice'), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  const canvasFrequency = await frequency(canvasVoice.videoPath, 'canvas-new-voice');
  expect(canvasFrequency).toBeGreaterThan(350); expect(canvasFrequency).toBeLessThan(600);
  const explicitAudioOnly = await renderProject({ project: { ...project, shots: [{ ...shot, sourceInUs: undefined, videoAssetId: undefined, audioInUs: 0 }] }, assets, outputDirectory: join(directory, 'explicit-audio-only'), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  expect((await probeMedia(explicitAudioOnly.videoPath, ffprobe)).audioDuration).toBeCloseTo(1, 1);
  const { sourceInUs: _source, sceneInUs: _scene, sceneDurationUs: _duration, ...legacyShot } = shot;
  const legacy = await renderProject({ project: { ...project, shots: [legacyShot] }, assets, outputDirectory: join(directory, 'legacy'), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  expect((await probeMedia(legacy.videoPath, ffprobe)).audioDuration).toBeGreaterThanOrEqual(1.99);
  const rate = { numerator: 30000, denominator: 1001 };
  const durationUs = frameTimeUs(16, rate);
  const fractional = await renderProject({ project: { ...project, profile: { ...profile, frameRate: rate }, shots: [{ ...shot, sourceInUs: 0, durationUs }] }, assets, outputDirectory: join(directory, 'fractional'), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  const fractionalMetadata = await probeMedia(fractional.videoPath, ffprobe);
  expect(fractionalMetadata.videoDuration).toBeCloseTo(durationUs / 1e6, 3);
  expect(fractionalMetadata.frameRate).toBe('30000/1001');
}, 90_000);
