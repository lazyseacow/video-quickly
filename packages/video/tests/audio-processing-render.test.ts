import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createHistoryWorkflow, firstFrameAtUs, DEFAULT_AUDIO_MIX_SETTINGS, DEFAULT_AUDIO_PROCESSING, DEFAULT_CAPTION_STYLE, DEFAULT_VIDEO_PROFILE, projectSchema, shotSchema, timeAtFrame, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';
import { captureClipEditSource } from '../src/clip-edits.js';
import { detectAudioSilence, prepareAudioMix, readAudioLevelWindow } from '../src/audio-mix.js';
import { probeMedia, renderProject, runMedia } from '../src/node.js';

const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const available = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0 && spawnSync(ffprobe, ['-version'], { windowsHide: true }).status === 0;
const directories: string[] = [];
afterEach(async context => {
  const paths = directories.splice(0);
  if (context.task.result?.state === 'fail') {
    for (const path of paths.filter(path => basename(path).startsWith('vq-video-audio-ducking-'))) {
      try {
        if (dirname(resolve(path)) !== resolve(tmpdir())) throw new Error('Unexpected audio diagnostic fixture path');
        const output = resolve('.generated/audio-failure-diagnostics', basename(path));
        await mkdir(dirname(output), { recursive: true });
        await cp(path, output, { recursive: true, force: false, errorOnExist: true });
        console.info('Archived audio failure diagnostic:', output);
      } catch (error) { console.info('Audio diagnostic archive failed:', error instanceof Error ? error.message : String(error)); }
    }
    console.info('Retained audio fixture:', paths); return;
  }
  await Promise.all(paths.map(path => rm(path, { recursive: true, force: true })));
});

async function asset(id: string, path: string, kind: 'audio' | 'video' = 'audio'): Promise<AssetRecord> {
  const bytes = await readFile(path);
  return { id, projectId: 'audio-project', name: id, path, kind, mimeType: kind === 'audio' ? 'audio/wav' : 'video/mp4', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, active: true, retained: false, provenance: 'isolated real sound fixture', createdAt: '' };
}
function project(shots: ProjectDocument['shots']): ProjectDocument {
  return projectSchema.parse({ id: 'audio-project', title: 'Sound timing', brief: '', revision: 1, profile: { ...DEFAULT_VIDEO_PROFILE, width: 320, height: 180, previewScale: 1 }, workflow: createHistoryWorkflow(), createdAt: '', updatedAt: '', shots, audioMix: { ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, enabled: false } } });
}
async function fixture(directory: string) {
  const path = join(directory, 'voice.wav');
  const tone = 'if(between(t,0.4,0.8)+between(t,1.4,2),0,sin(2*PI*if(lt(t,0.8),440,if(lt(t,2),880,1320))*t))';
  await runMedia(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=exprs='0.2*${tone}|0.1*${tone}':sample_rate=48000:duration=3`, '-c:a', 'pcm_s16le', path]);
  return asset('voice', path);
}
async function embeddedVideo(directory: string, delay = 0, silent = false) {
  const voice = await fixture(directory), path = join(directory, `embedded-${delay}-${silent}.mp4`);
  await runMedia(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=blue:size=320x180:rate=30:duration=3',
    ...(silent ? [] : ['-itsoffset', String(delay), '-i', voice.path]), '-map', '0:v:0', ...(silent ? ['-an'] : ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k']),
    '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path]);
  return asset('embedded-video', path, 'video');
}
async function pcm(path: string, directory: string, name: string) {
  const output = join(directory, `${name}.f32`); await runMedia(ffmpeg, ['-v', 'error', '-y', '-i', path, '-ar', '48000', '-ac', '2', '-f', 'f32le', output]); return readFile(output);
}
function amplitude(bytes: Buffer, frequency: number, start: number, duration = .1, channel = 0) {
  const first = Math.round(start * 48000), count = Math.round(duration * 48000); let real = 0, imaginary = 0;
  for (let index = 0; index < count; index++) { const value = bytes.readFloatLE((first + index) * 8 + channel * 4); const angle = 2 * Math.PI * frequency * index / 48000; real += value * Math.cos(angle); imaginary += value * Math.sin(angle); }
  return 2 * Math.hypot(real, imaginary) / count;
}
function edited(original: ReturnType<typeof shotSchema.parse>, assets: AssetRecord[]) {
  const source = captureClipEditSource(original, assets, 'source');
  const ranges = [[0, 400_000], [800_000, 1_400_000], [2_000_000, 3_000_000]];
  const plan = { id: 'plan', sourceId: source.id, spans: ranges.map(([start, end], index) => ({ id: `part-${index}`, durationUs: end - start, originInUs: start, sourceInUs: start, audioInUs: start, videoInUs: start, sceneInUs: start })) };
  const shot = { ...original, durationUs: 2_000_000, captionTrack: undefined, clipEdit: { planId: plan.id, inUs: 0, restoreInUs: 0, restoreDurationUs: 3_000_000 } };
  return { shot, clipEditSources: [source], clipEditPlans: [plan] };
}

it.skipIf(!available)('cuts actual source samples, reports stereo levels and silence, and rebuilds corrupted caches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-audio-edits-')); directories.push(directory);
  const voice = await fixture(directory), original = shotSchema.parse({ id: 'voice', title: 'Voice', narration: '', visualPrompt: '', sourceInUs: 0, durationUs: 3_000_000, audioAssetId: voice.id, animation: { transition: 'cut' } });
  const content = edited(original, [voice]), doc = { ...project([content.shot]), ...content, shots: [content.shot] }, before = structuredClone(doc);
  const options = { project: doc, assets: [voice], outputDirectory: join(directory, 'audio'), ffmpegPath: ffmpeg, ffprobePath: ffprobe };
  const mixed = await prepareAudioMix(options), bytes = await pcm(mixed.path, directory, 'mix');
  const originalBytes = await pcm(voice.path, directory, 'original');
  expect(bytes.subarray(0, 19_200 * 8).equals(originalBytes.subarray(0, 19_200 * 8))).toBe(true);
  expect(bytes.length / 8).toBe(96_000); expect(mixed.durationUs).toBe(2_000_000); expect(mixed.shotDurations).toEqual([{ shotId: 'voice', durationUs: 2_000_000 }]);
  expect(amplitude(bytes, 440, .1)).toBeCloseTo(.2, 2); expect(amplitude(bytes, 880, .5)).toBeCloseTo(.2, 2); expect(amplitude(bytes, 1320, 1.2)).toBeCloseTo(.2, 2);
  const levels = await readAudioLevelWindow({ mix: mixed, startUs: 12_345, durationUs: 100_000 });
  expect(levels.startUs).toBe(10_000); expect(levels.samples).toHaveLength(10); expect(levels.samples[0].peakLeft).toBeCloseTo(.2, 3); expect(levels.samples[0].peakRight).toBeCloseTo(.1, 3); expect(levels.samples[0].rmsLeft / levels.samples[0].rmsRight).toBeCloseTo(2, 2);
  const silence = await detectAudioSilence({ asset: voice, thresholdDb: -45, minimumDurationUs: 200_000, paddingUs: 50_000, ffmpegPath: ffmpeg });
  expect(silence.ranges).toHaveLength(2); expect(silence.ranges[0].startUs).toBeCloseTo(450_000, -2); expect(silence.ranges[0].endUs).toBeCloseTo(750_000, -2);
  const timestamp = (await stat(mixed.path)).mtimeMs; expect((await prepareAudioMix({ ...options, project: { ...doc, title: 'Visual only' } })).key).toBe(mixed.key); expect((await stat(mixed.path)).mtimeMs).toBe(timestamp);
  await writeFile(`${mixed.path}.levels`, Buffer.alloc(3200)); await expect(readAudioLevelWindow({ mix: mixed, startUs: 0, durationUs: 100_000 })).rejects.toThrow('缓存损坏');
  await prepareAudioMix(options); expect((await readAudioLevelWindow({ mix: mixed, startUs: 0, durationUs: 100_000 })).samples[0].peakLeft).toBeCloseTo(.2, 3);
  await writeFile(mixed.path, 'broken'); const repaired = await prepareAudioMix(options); expect(repaired.sha256).toBe(mixed.sha256);
  const quieter = await prepareAudioMix({ ...options, project: { ...doc, shots: [{ ...content.shot, audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, gainDb: -6.0206 } }] } });
  expect((await readAudioLevelWindow({ mix: quieter, startUs: 0, durationUs: 10_000 })).samples[0].peakLeft).toBeCloseTo(.1, 3);
  const controller = new AbortController(), concurrent = { ...options, project: { ...doc, shots: [{ ...content.shot, audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, gainDb: -3 } }] } };
  const cancelled = prepareAudioMix({ ...concurrent, signal: controller.signal, onProgress: value => { if (value > .1) controller.abort(); } });
  const cancellation = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  const retained = prepareAudioMix(concurrent); await cancellation; expect((await retained).durationUs).toBe(2_000_000);
  const replacement = { ...voice, id: 'replacement' };
  let outputUs = 0;
  const replacementPlan = { ...content.clipEditPlans[0], spans: content.clipEditPlans[0].spans.map(span => { const result = { ...span, audioInUs: outputUs }; outputUs += span.durationUs; return result; }) };
  const replaced = await prepareAudioMix({ ...options, project: { ...doc, shots: [{ ...content.shot, audioAssetId: replacement.id }], clipEditPlans: [replacementPlan] }, assets: [replacement] });
  expect(replaced.durationUs).toBe(2_000_000);
  await expect(prepareAudioMix({ ...options, assets: [{ ...voice, sha256: '0'.repeat(64) }] })).rejects.toThrow('校验失败'); expect(doc).toEqual(before);
}, 120_000);

it.skipIf(!available)('uses one global video frame grid and the same sound mix through real EDL cuts and ASS boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-audio-video-')); directories.push(directory);
  const voice = await fixture(directory), path = join(directory, 'frames.mp4');
  await runMedia(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', "nullsrc=s=320x180:r=60:d=3,geq=r='mod(N*17,256)':g='mod(N*43,256)':b='mod(N*71,256)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', path]);
  const video = await asset('video', path, 'video'), original = shotSchema.parse({ id: 'video', title: ' ', narration: '', visualPrompt: '', durationUs: 3_000_000, sourceInUs: 0, audioAssetId: voice.id, videoAssetId: video.id, animation: { transition: 'cut' } });
  const content = edited(original, [voice, video]), first = shotSchema.parse({ id: 'first', title: ' ', narration: '', visualPrompt: '', sourceInUs: 0, durationUs: 1_300_000, animation: { transition: 'cut' } });
  const doc = { ...project([first, { ...content.shot, durationUs: 1_300_000 }]), clipEditSources: content.clipEditSources, clipEditPlans: content.clipEditPlans };
  doc.profile.frameRate = { numerator: 24, denominator: 1 };
  const mix = await prepareAudioMix({ project: doc, assets: [voice, video], outputDirectory: join(directory, 'preview'), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  const rendered = await renderProject({ project: doc, assets: [voice, video], preparedAudioMix: mix, outputDirectory: join(directory, 'export'), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  expect((await runMedia(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', rendered.videoPath])).trim()).toBe('63');
  const actual = await pcm(rendered.videoPath, directory, 'export');
  expect(amplitude(actual, 440, 1.6)).toBeGreaterThan(.17); expect(amplitude(actual, 880, 2)).toBeGreaterThan(.17); expect(amplitude(actual, 1320, 2.4)).toBeGreaterThan(.17);
  const timeline = JSON.parse(await readFile(rendered.timelinePath, 'utf8')); expect(timeline.clips[1].startUs).toBe(1_300_000); expect(timeline.audioMix.sha256).toBe(mix.sha256); expect(timeline.renderSchedule.map((value: { frameCount: number }) => value.frameCount)).toEqual([32, 31]);
  async function pixel(file: string, frame: number, name: string) { const target = join(directory, `${name}.rgb`); await runMedia(ffmpeg, ['-v', 'error', '-y', '-i', file, '-vf', `select='eq(n,${frame})',scale=1:1`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', target]); return readFile(target); }
  for (const outputFrame of [32, 43, 56]) {
    const time = timeAtFrame(outputFrame, doc.profile.frameRate) - 1_300_000, source = time < 400_000 ? time : time < 1_000_000 ? time + 400_000 : time + 1_000_000;
    let sourceFrame = firstFrameAtUs(source, { numerator: 60, denominator: 1 }); if (timeAtFrame(sourceFrame, { numerator: 60, denominator: 1 }) > source) sourceFrame--;
    const expected = await pixel(path, sourceFrame, `source-${outputFrame}`), result = await pixel(rendered.videoPath, outputFrame, `result-${outputFrame}`);
    for (let channel = 0; channel < 3; channel++) expect(Math.abs(result[channel] - expected[channel]), JSON.stringify({ outputFrame, sourceFrame, expected: [...expected], actual: [...result] })).toBeLessThan(16);
  }
  const rate = { numerator: 30000, denominator: 1001 }, boundary = { ...original, durationUs: 1_001_000, audioAssetId: undefined, captionStyle: { ...DEFAULT_CAPTION_STYLE, textColor: '#FFFFFF', backgroundColor: '#000000', backgroundOpacity: 1 }, captionTrack: { timeBase: 'scene' as const, alignment: 'manual' as const, cues: [{ id: 'boundary', startUs: timeAtFrame(1, rate), endUs: timeAtFrame(3, rate), text: 'BOUNDARY' }] } };
  const boundaryDoc = project([boundary]); boundaryDoc.profile.frameRate = rate;
  const output = await renderProject({ project: boundaryDoc, assets: [video], outputDirectory: join(directory, 'boundary'), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  async function bottom(frame: number) { const target = join(directory, `bottom-${frame}.rgb`); await runMedia(ffmpeg, ['-v', 'error', '-y', '-i', output.videoPath, '-vf', `select='eq(n,${frame})',crop=260:30:30:140`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', target]); const bytes = await readFile(target); let count = 0; for (let offset = 0; offset < bytes.length; offset += 3) if (bytes[offset] < 12 && bytes[offset + 1] < 12 && bytes[offset + 2] < 12) count++; return count; }
  expect(await bottom(1)).toBeGreaterThan(1000); expect(await bottom(2)).toBeGreaterThan(1000); expect(await bottom(3)).toBeLessThan(100);
}, 180_000);

it.skipIf(!available)('ducks multiple music clips from real voice, measures two-pass loudness and bypasses source denoise', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-audio-dsp-')); directories.push(directory);
  const voice = await fixture(directory), music: AssetRecord[] = [];
  for (const frequency of [4000, 5000]) {
    const path = join(directory, `music-${frequency}.wav`);
    await runMedia(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=1`, '-c:a', 'pcm_s16le', path]); music.push(await asset(`music-${frequency}`, path));
  }
  const shot = shotSchema.parse({ id: 'voice', title: 'Voice', narration: '', visualPrompt: '', durationUs: 3_000_000, sourceInUs: 0, audioAssetId: voice.id });
  const doc = project([shot]); doc.musicClips = music.map((value, index) => ({ id: value.id, assetId: value.id, startUs: index ? 1_500_000 : 0, sourceInUs: 100_000, durationUs: index ? 1_000_000 : 3_000_000, gainDb: -6, fadeInUs: 50_000, fadeOutUs: 100_000, loop: true }));
  const options = { project: doc, assets: [voice, ...music], outputDirectory: join(directory, 'audio'), ffmpegPath: ffmpeg, ffprobePath: ffprobe };
  const dry = await prepareAudioMix(options), dryPcm = await pcm(dry.path, directory, 'dry');
  const ducked = await prepareAudioMix({ ...options, project: { ...doc, audioMix: { ...doc.audioMix!, ducking: { ...DEFAULT_AUDIO_MIX_SETTINGS.ducking, enabled: true } } } }), duckPcm = await pcm(ducked.path, directory, 'duck');
  expect(amplitude(dryPcm, 4000, .2)).toBeCloseTo(.125 * 10 ** (-6 / 20) / Math.sqrt(2), 3); expect(amplitude(duckPcm, 4000, .2)).toBeLessThan(amplitude(dryPcm, 4000, .2) * .5);
  expect(amplitude(duckPcm, 4000, 1.8)).toBeGreaterThan(amplitude(duckPcm, 4000, 1) * 2);
  expect(amplitude(duckPcm, 5000, 1)).toBeLessThan(.001); expect(amplitude(duckPcm, 5000, 1.8)).toBeGreaterThan(.03); expect(amplitude(duckPcm, 5000, 2.8)).toBeLessThan(.001);
  const normalized = await prepareAudioMix({ ...options, project: { ...doc, audioMix: { ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { enabled: true, targetLufs: -20, truePeakDb: -1.5 } } } });
  expect(normalized.analysis.integratedLufs).toBeCloseTo(-20, 0); expect(normalized.analysis.truePeakDb!).toBeLessThanOrEqual(-1.4);
  const noisyPath = join(directory, 'noisy.wav');
  await runMedia(ffmpeg, ['-v', 'error', '-y', '-i', voice.path, '-f', 'lavfi', '-i', 'anoisesrc=sample_rate=48000:duration=3:amplitude=0.015:seed=7', '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0[a]', '-map', '[a]', '-c:a', 'pcm_s16le', noisyPath]);
  const noisy = await asset('noisy', noisyPath), noiseProject = project([{ ...shot, audioAssetId: noisy.id }]);
  const raw = await prepareAudioMix({ ...options, project: noiseProject, assets: [noisy] });
  const cleaned = await prepareAudioMix({ ...options, project: { ...noiseProject, shots: [{ ...noiseProject.shots[0], audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, denoise: true, noiseReductionDb: 24 } }] }, assets: [noisy] });
  const rms = async (mix: typeof raw) => (await readAudioLevelWindow({ mix, startUs: 1_700_000, durationUs: 100_000 })).samples.reduce((sum, value) => sum + value.rmsLeft, 0) / 10;
  expect(await rms(cleaned)).toBeLessThan(await rms(raw) * .8);
  expect(amplitude(await pcm(cleaned.path, directory, 'cleaned'), 880, .9)).toBeGreaterThan(.15);
  expect((await prepareAudioMix({ ...options, project: noiseProject, assets: [noisy] })).sha256).toBe(raw.sha256);
  const controller = new AbortController(); controller.abort(); await expect(prepareAudioMix({ ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
}, 180_000);

it.skipIf(!available)('keeps embedded video sound opt-in and applies its own gain and mute independently of voice offsets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-video-audio-toggle-')); directories.push(directory);
  const video = await embeddedVideo(directory), shot = shotSchema.parse({ id: 'embedded', title: 'Embedded', narration: '', visualPrompt: '', durationUs: 1_000_000, videoInUs: 800_000, audioInUs: 2_100_000, videoAssetId: video.id });
  const options = { assets: [video], outputDirectory: join(directory, 'cache'), ffmpegPath: ffmpeg, ffprobePath: ffprobe };
  const legacy = await prepareAudioMix({ ...options, project: project([shot]) });
  expect(amplitude(await pcm(legacy.path, directory, 'legacy-muted'), 880, .1)).toBeLessThan(.001);
  const enabled = { ...shot, audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, version: 2 as const, videoAudio: { enabled: true, gainDb: -6 } } };
  const audible = await prepareAudioMix({ ...options, project: project([enabled]) });
  const level = amplitude(await pcm(audible.path, directory, 'enabled'), 880, .1);
  expect(level).toBeGreaterThan(.085); expect(level).toBeLessThan(.12);
  expect(audible.warnings.some(value => value.includes('本镜头使用静音'))).toBe(false);
  const muted = await prepareAudioMix({ ...options, project: project([{ ...enabled, audioProcessing: { ...enabled.audioProcessing, videoAudio: { enabled: false, gainDb: -6 } } }]) });
  expect(amplitude(await pcm(muted.path, directory, 'muted'), 880, .1)).toBeLessThan(.001);
  expect(muted.key).not.toBe(audible.key);
}, 60_000);

it.skipIf(!available)('cuts embedded audio on the video source spans while retaining a separate voice and matching exported sound', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-video-audio-edl-')); directories.push(directory);
  const video = await embeddedVideo(directory), voicePath = join(directory, 'independent-voice.wav');
  await runMedia(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=exprs=0.1*sin(2*PI*220*t)|0.1*sin(2*PI*220*t):s=48000:d=3', '-c:a', 'pcm_s16le', voicePath]);
  const voice = await asset('independent-voice', voicePath), assets = [video, voice];
  const original = shotSchema.parse({ id: 'embedded', title: 'Edited embedded', narration: '', visualPrompt: '', durationUs: 2_200_000, sourceInUs: 0, audioInUs: 0, videoInUs: 800_000, videoAssetId: video.id, audioAssetId: voice.id, audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, version: 2, videoAudio: { enabled: true, gainDb: 0 } } });
  const source = captureClipEditSource(original, assets, 'original-source');
  const plan = { id: 'video-plan', sourceId: source.id, spans: [
    { id: 'first', durationUs: 400_000, originInUs: 0, sourceInUs: 0, audioInUs: 0, videoInUs: 800_000, sceneInUs: 0 },
    { id: 'second', durationUs: 600_000, originInUs: 1_200_000, sourceInUs: 1_200_000, audioInUs: 1_200_000, videoInUs: 2_000_000, sceneInUs: 1_200_000 },
  ] };
  const document = { ...project([{ ...original, durationUs: 1_000_000, clipEdit: { planId: plan.id, inUs: 0, restoreInUs: 0, restoreDurationUs: 2_200_000 } }]), clipEditSources: [source], clipEditPlans: [plan] };
  const options = { project: document, assets, outputDirectory: join(directory, 'cache'), ffmpegPath: ffmpeg, ffprobePath: ffprobe };
  const mix = await prepareAudioMix(options), actual = await pcm(mix.path, directory, 'cut-original');
  expect(mix.durationUs).toBe(1_000_000); expect(amplitude(actual, 880, .1)).toBeGreaterThan(.17);
  expect(amplitude(actual, 1320, .65)).toBeGreaterThan(.17); expect(amplitude(actual, 880, .65)).toBeLessThan(.01);
  expect(amplitude(actual, 220, .1)).toBeGreaterThan(.085); expect(amplitude(actual, 220, .65)).toBeGreaterThan(.085);
  const rendered = await renderProject({ ...options, outputDirectory: join(directory, 'export'), preparedAudioMix: mix }), exported = await pcm(rendered.videoPath, directory, 'exported-original');
  expect(amplitude(exported, 880, .1)).toBeGreaterThan(.16); expect(amplitude(exported, 1320, .65)).toBeGreaterThan(.16); expect(amplitude(exported, 220, .65)).toBeGreaterThan(.08);
  const changedBytes = Buffer.concat([await readFile(video.path), Buffer.from('changed after editing')]); await writeFile(video.path, changedBytes);
  const changedVideo = { ...await asset(video.id, video.path, 'video'), version: 2 };
  await expect(prepareAudioMix({ ...options, assets: [changedVideo, voice] })).rejects.toThrow('剪辑来源视频已变化');
}, 60_000);

it.skipIf(!available)('preserves a delayed embedded audio start relative to the video origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-video-audio-delay-')); directories.push(directory);
  const video = await embeddedVideo(directory, .3), shot = shotSchema.parse({ id: 'delayed', title: 'Delayed source', narration: '', visualPrompt: '', durationUs: 1_000_000, videoInUs: 100_000, videoAssetId: video.id, audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, version: 2, videoAudio: { enabled: true, gainDb: 0 } } });
  const mix = await prepareAudioMix({ project: project([shot]), assets: [video], outputDirectory: join(directory, 'cache'), ffmpegPath: ffmpeg, ffprobePath: ffprobe }), actual = await pcm(mix.path, directory, 'delayed');
  expect(amplitude(actual, 440, .03)).toBeLessThan(.001); expect(amplitude(actual, 440, .3)).toBeGreaterThan(.17);
}, 60_000);

it.skipIf(!available)('keeps silent videos playable and reports the absent original audio track', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-video-audio-silent-')); directories.push(directory);
  const video = await embeddedVideo(directory, 0, true), shot = shotSchema.parse({ id: 'silent', title: 'Silent video', narration: '', visualPrompt: '', durationUs: 1_000_000, videoAssetId: video.id, audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, version: 2, videoAudio: { enabled: true, gainDb: 0 } } });
  const mix = await prepareAudioMix({ project: project([shot]), assets: [video], outputDirectory: join(directory, 'cache'), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  expect(mix.warnings.some(value => value.includes('视频没有音轨'))).toBe(true);
  expect((await readAudioLevelWindow({ mix, startUs: 0, durationUs: 500_000 })).samples.every(value => value.peakLeft === 0 && value.peakRight === 0)).toBe(true);
}, 60_000);

it.skipIf(!available)('mixes original sound separately so it does not trigger voice-only music ducking', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-video-audio-ducking-')); directories.push(directory);
  const video = await embeddedVideo(directory), musicPath = join(directory, 'music.wav');
  await runMedia(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=exprs=0.15*sin(2*PI*660*t)|0.15*sin(2*PI*660*t):s=48000:d=1', '-c:a', 'pcm_s16le', musicPath]);
  const music = await asset('music', musicPath), shot = shotSchema.parse({ id: 'original', title: 'Original with music', narration: '', visualPrompt: '', durationUs: 1_000_000, videoInUs: 800_000, videoAssetId: video.id, audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, version: 2, videoAudio: { enabled: true, gainDb: 0 } } });
  const document = project([shot]); document.musicClips = [{ id: 'music-clip', assetId: music.id, startUs: 0, sourceInUs: 0, durationUs: 1_000_000, gainDb: 0, loop: false, fadeInUs: 0, fadeOutUs: 0 }];
  document.audioMix = { ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, enabled: false }, ducking: { ...DEFAULT_AUDIO_MIX_SETTINGS.ducking, enabled: true, thresholdDb: -40, ratio: 20 } };
  const cache = join(directory, 'cache'), raw = join(directory, 'raw-mix.wav');
  let rawCaptureError: string | undefined;
  const mix = await prepareAudioMix({ project: document, assets: [video, music], outputDirectory: cache, ffmpegPath: ffmpeg, ffprobePath: ffprobe, onProgress: value => {
    if (value !== .55) return;
    // The float mix is removed after preparation; retain this isolated fixture
    // before loudness/PCM conversion so a Windows failure can locate its origin.
    try {
      const pending = readdirSync(cache, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('.mix-'));
      if (pending.length !== 1) throw new Error('Expected one isolated pending audio mix');
      copyFileSync(join(cache, pending[0].name, 'raw.wav'), raw);
    } catch (error) { rawCaptureError = error instanceof Error ? error.message : String(error); }
  } }), actual = await pcm(mix.path, directory, 'original-with-music');
  try {
    expect(amplitude(actual, 880, .1)).toBeGreaterThan(.17); expect(amplitude(actual, 660, .1)).toBeGreaterThan(.13);
    expect(amplitude(actual, 660, .1)).toBeGreaterThan(amplitude(actual, 660, .75) * .9);
  } catch (error) {
    try {
      const paths = [music.path, video.path, ...(await readdir(cache)).filter(name => name.startsWith('source-') && name.endsWith('.wav')).map(name => join(cache, name)), raw, mix.path];
      const stages = [];
      for (const [index, path] of paths.entries()) {
        try {
          const probe = JSON.parse(await runMedia(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,channels,channel_layout,sample_rate', '-of', 'json', path]));
          const samples = await pcm(path, directory, `diagnostic-${index}`);
          stages.push({ path, probe, amplitudes: [.1, .75].map(start => ({ start, music660: [0, 1].map(channel => amplitude(samples, 660, start, .1, channel)), original880: [0, 1].map(channel => amplitude(samples, 880, start, .1, channel)) })) });
        } catch (diagnosticError) { stages.push({ path, error: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError) }); }
      }
      const diagnostic = { ffmpeg: (await runMedia(ffmpeg, ['-version'])).split('\n')[0], rawCaptureError, stages };
      await writeFile(join(directory, 'audio-diagnostics.json'), JSON.stringify(diagnostic, null, 2));
      console.info('Original-audio ducking failure stages:', JSON.stringify(diagnostic));
    } catch (diagnosticError) { console.info('Audio stage diagnostic failed:', diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)); }
    throw error;
  }
}, 60_000);
