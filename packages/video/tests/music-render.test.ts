import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createHistoryWorkflow, DEFAULT_VIDEO_PROFILE, musicClipSchema, shotSchema, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';
import { probeMedia, renderProject, runMedia } from '../src/node.js';

const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const mediaAvailable = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0 && spawnSync(ffprobe, ['-version'], { windowsHide: true }).status === 0;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it.skipIf(!mediaAvailable)('mixes source-tail loops on project time with fades, preserves voice and burns explicit captions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-music-')); directories.push(directory);
  const musicPath = join(directory, 'music.wav'), voicePath = join(directory, 'voice.wav');
  await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1', '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]', '-c:a', 'pcm_s16le', musicPath]);
  await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=4', '-c:a', 'pcm_s16le', voicePath]);
  async function asset(id: string, path: string): Promise<AssetRecord> {
    const bytes = await readFile(path);
    return { id, projectId: 'music-project', name: id, path, kind: 'audio', mimeType: 'audio/wav', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, active: true, retained: false, provenance: 'isolated real audio fixture', createdAt: '' };
  }
  const music = await asset('music', musicPath), voice = await asset('voice', voicePath);
  const project: ProjectDocument = {
    id: 'music-project', title: '真实混音', brief: '', templateId: 'generic', revision: 1, archived: false, claims: [], style: '', createdAt: '', updatedAt: '', workflow: createHistoryWorkflow(),
    profile: { ...DEFAULT_VIDEO_PROFILE, width: 320, height: 180, previewScale: 1 },
    shots: [shotSchema.parse({ id: 'shot', title: '混音', narration: '', visualPrompt: '', durationUs: 4_000_000, sourceInUs: 0, audioAssetId: 'voice', animation: { transition: 'cut' }, captionTrack: { timeBase: 'scene', alignment: 'manual', cues: [{ id: 'cue', startUs: 1_000_000, endUs: 3_000_000, text: 'Explicit caption' }] } })],
    musicClips: [musicClipSchema.parse({ id: 'bgm', assetId: 'music', startUs: 500_000, sourceInUs: 1_000_000, durationUs: 3_000_000, gainDb: -6, fadeInUs: 500_000, fadeOutUs: 500_000, loop: true })],
  };
  const outputDirectory = join(directory, 'output');
  const result = await renderProject({ project, assets: [music, voice], outputDirectory, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  expect(await readFile(result.subtitlePath, 'utf8')).toContain('00:00:01,000 --> 00:00:03,000\nExplicit caption');
  expect((await probeMedia(result.videoPath, ffprobe)).audioDuration).toBeCloseTo(4, 1);
  const pcmPath = join(directory, 'mixed.pcm');
  await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', result.videoPath, '-ac', '1', '-ar', '8000', '-f', 's16le', pcmPath]);
  const pcm = await readFile(pcmPath);
  function amplitude(frequency: number, startSeconds: number, durationSeconds = .1): number {
    const first = Math.round(startSeconds * 8000), count = Math.round(durationSeconds * 8000);
    let real = 0, imaginary = 0;
    for (let index = 0; index < count; index++) {
      const value = pcm.readInt16LE((first + index) * 2) / 32768;
      const angle = 2 * Math.PI * frequency * index / 8000;
      real += value * Math.cos(angle); imaginary += value * Math.sin(angle);
    }
    return 2 * Math.hypot(real, imaginary) / count;
  }
  const plateau = amplitude(880, 1.5);
  expect(plateau).toBeGreaterThan(.03);
  expect(amplitude(220, 1.5)).toBeGreaterThan(.05);
  expect(amplitude(880, .2)).toBeLessThan(plateau * .1);
  expect(amplitude(880, .55)).toBeLessThan(plateau * .4);
  expect(amplitude(880, 2.5)).toBeGreaterThan(plateau * .9);
  expect(amplitude(880, 3.3)).toBeLessThan(plateau * .5);
  expect(amplitude(880, 3.7)).toBeLessThan(plateau * .1);
  expect(amplitude(440, 2.5)).toBeLessThan(plateau * .1);
  async function darkPixels(time: string, name: string): Promise<number> {
    const path = join(directory, name + '.rgb');
    await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', time, '-i', result.videoPath, '-frames:v', '1', '-vf', 'crop=320:45:0:135', '-pix_fmt', 'rgb24', '-f', 'rawvideo', path]);
    const pixels = await readFile(path); let dark = 0;
    for (let index = 0; index < pixels.length; index += 3) if (pixels[index] < 100 && pixels[index + 1] < 100 && pixels[index + 2] < 100) dark++;
    return dark;
  }
  expect(await darkPixels('1.5', 'caption')).toBeGreaterThan(await darkPixels('0.2', 'gap') + 50);
  const segments = (await readdir(outputDirectory)).filter(name => /^segment-.*\.mp4$/.test(name));
  const created = await Promise.all(segments.map(name => stat(join(outputDirectory, name)).then(value => value.mtimeMs)));
  const revised = { ...project, musicClips: project.musicClips?.map(clip => ({ ...clip, gainDb: -18, startUs: 3_500_000 })) };
  await renderProject({ project: revised, assets: [music, voice], outputDirectory, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  expect((await readdir(outputDirectory)).filter(name => /^segment-.*\.mp4$/.test(name))).toEqual(segments);
  expect(await Promise.all(segments.map(name => stat(join(outputDirectory, name)).then(value => value.mtimeMs)))).toEqual(created);
  expect(revised.musicClips?.[0].durationUs).toBe(3_000_000);
  expect(JSON.parse(await readFile(result.timelinePath, 'utf8'))).toMatchObject({ musicClips: [{ startUs: 3_500_000, durationUs: 3_000_000 }] });
  await expect(renderProject({ project, assets: [{ ...music, sha256: 'incorrect' }, voice], outputDirectory, ffmpegPath: ffmpeg, ffprobePath: ffprobe })).rejects.toThrow('校验失败');
  await expect(renderProject({ project, assets: [{ ...music, projectId: 'other-project' }, voice], outputDirectory, ffmpegPath: ffmpeg, ffprobePath: ffprobe })).rejects.toThrow('背景音乐必须引用');
}, 90_000);
