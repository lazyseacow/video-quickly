import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { afterEach, expect, it } from 'vitest';
import { createNativeVideoWorkflow, DEFAULT_CAPTION_STYLE, projectSchema, timeAtFrame, type AssetRecord, type FrameRate } from '@video-quickly/contracts';
import { createTransitionTimeline, sampleTransition, wipeLeftIncomingStartX } from '../src/transitions.js';
import { probeMedia, renderProject, runMedia } from '../src/node.js';

const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const mediaAvailable = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0 && spawnSync(ffprobe, ['-version'], { windowsHide: true }).status === 0;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const colors = [[240, 20, 20], [20, 20, 240], [20, 220, 20], [230, 230, 230]];
async function fixture(rate: FrameRate, transitions: Array<'cut' | 'fade' | 'wipe'>, durations = [1_300_000, 700_000, 500_000]) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-transitions-')); directories.push(directory);
  const assets: AssetRecord[] = [];
  for (const [index, color] of colors.entries()) {
    const canvas = createCanvas(64, 64), context = canvas.getContext('2d'); context.fillStyle = `rgb(${color.join(',')})`; context.fillRect(0, 0, 64, 64);
    const bytes = canvas.toBuffer('image/png'), path = join(directory, `source-${index}.png`); await writeFile(path, bytes);
    assets.push({ id: `image-${index}`, projectId: 'transitions', name: 'color', kind: 'image', mimeType: 'image/png', path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), active: true, retained: false, version: 1, createdAt: '', provenance: 'isolated transition fixture' });
  }
  const project = projectSchema.parse({ id: 'transitions', title: 'Transitions', revision: 1, templateId: 'generic', brief: '', style: '', claims: [], archived: false, createdAt: '', updatedAt: '', workflow: createNativeVideoWorkflow(), profile: { width: 64, height: 64, frameRate: rate }, shots: durations.map((durationUs, index) => ({ id: `shot-${index}`, title: `Shot ${index}`, narration: '', visualPrompt: '', durationUs, assetId: assets[index].id, animation: { transition: transitions[index], zoom: 1, panX: 0, panY: 0 } })) });
  return { directory, assets, project };
}

it.skipIf(!mediaAvailable).each([1, 2, 3, 4, 5, 24, 30, 60, 30000 / 1001])('matches actual exported fade/wipe pictures and frame count at %s fps', async fps => {
  const rate = fps === 30000 / 1001 ? { numerator: 30000, denominator: 1001 } : { numerator: fps, denominator: 1 };
  const { directory, project, assets } = await fixture(rate, ['cut', 'fade', 'wipe']);
  const timeline = createTransitionTimeline(project.shots, rate), output = await renderProject({ project, assets, outputDirectory: join(directory, 'out'), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  const rgbPath = join(directory, 'frames.rgb'); await runMedia(ffmpeg, ['-v', 'error', '-i', output.videoPath, '-pix_fmt', 'rgb24', '-f', 'rawvideo', rgbPath]); const rgb = await readFile(rgbPath);
  expect(rgb.length).toBe(timeline.totalFrames * 64 * 64 * 3);
  for (let frame = 0; frame < timeline.totalFrames; frame++) {
    const sample = sampleTransition(timeline, timeAtFrame(frame, rate))!, incoming = colors[sample.shotIndex];
    for (const x of [8, 24, 40, 56]) {
      let expected = incoming;
      if (sample.outgoing && sample.effect) {
        const outgoing = colors[sample.outgoing.shotIndex];
        if (sample.effect.kind === 'fade') expected = incoming.map((value, channel) => value * sample.effect!.progress + outgoing[channel] * sample.effect!.outgoingProgress);
        else {
          const boundary = wipeLeftIncomingStartX(64, sample.effect.outgoingProgress);
          if (Math.abs(x - boundary) <= 5) continue;
          expected = x < boundary ? outgoing : incoming;
        }
      }
      const offset = (frame * 64 * 64 + 32 * 64 + x) * 3;
      for (let channel = 0; channel < 3; channel++) expect(Math.abs(rgb[offset + channel] - expected[channel]), `fps=${fps}, frame=${frame}, x=${x}, channel=${channel}, sample=${JSON.stringify(sample)}`).toBeLessThan(13);
    }
  }
  expect((await probeMedia(output.videoPath, ffprobe)).videoDuration).toBeCloseTo(timeline.durationUs / 1e6, 5);
});

it.skipIf(!mediaAvailable)('retains the strict wipeleft boundary in a real RGB FFmpeg filter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-wipe-boundary-')); directories.push(directory); const path = join(directory, 'frames.rgb');
  await runMedia(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x64:r=10:d=0.5,format=gbrp', '-f', 'lavfi', '-i', 'color=blue:s=64x64:r=10:d=0.5,format=gbrp', '-filter_complex', '[0:v]settb=AVTB,setpts=N*100000,tpad=stop_mode=clone:stop_duration=0.2[a];[1:v]settb=AVTB,setpts=N*100000[b];[a][b]xfade=transition=wipeleft:duration=0.2:offset=0.5[v]', '-map', '[v]', '-frames:v', '10', '-pix_fmt', 'rgb24', '-f', 'rawvideo', path]);
  const bytes = await readFile(path), pixel = (frame: number, x: number) => [...bytes.subarray((frame * 64 * 64 + 32 * 64 + x) * 3, (frame * 64 * 64 + 32 * 64 + x) * 3 + 3)];
  expect(pixel(6, 32)).toEqual(pixel(0, 32)); expect(pixel(6, 33)).toEqual(pixel(9, 33));
});

it.skipIf(!mediaAvailable)('keeps authored audio/caption time and visible-shot transitions across zero-frame pictures', async () => {
  const { directory, project, assets } = await fixture({ numerator: 1, denominator: 1 }, ['cut', 'wipe', 'cut', 'fade'], [500_000, 500_000, 500_000, 500_000]);
  project.workflow.production.subtitleMode = 'script'; project.shots[0].narration = 'FIRST'; project.shots[1].narration = 'ZERO'; project.shots[2].narration = 'THIRD'; project.shots[3].narration = 'TAIL';
  const voicePath = join(directory, 'zero-frame-voice.wav');
  await runMedia(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.5', '-c:a', 'pcm_s16le', voicePath]);
  const voice = await readFile(voicePath); assets.push({ ...assets[0], id: 'zero-frame-voice', kind: 'audio', mimeType: 'audio/wav', path: voicePath, size: voice.length, sha256: createHash('sha256').update(voice).digest('hex') });
  project.shots[1].audioAssetId = 'zero-frame-voice'; project.shots[1].audioInUs = 0;
  const timeline = createTransitionTimeline(project.shots, project.profile.frameRate); expect(timeline.clips.map(clip => clip.index)).toEqual([0, 2]);
  const output = await renderProject({ project, assets, outputDirectory: join(directory, 'out'), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  const subtitle = await readFile(output.subtitlePath, 'utf8'); expect(subtitle).toContain('00:00:00,500 --> 00:00:01,000'); expect(subtitle).toContain('ZERO'); expect(subtitle).toContain('00:00:01,500 --> 00:00:02,000');
  const probe = await probeMedia(output.videoPath, ffprobe); expect(probe.videoDuration).toBeCloseTo(2, 4); expect(probe.audioDuration).toBeCloseTo(2, 1);
  const pcmPath = join(directory, 'voice.pcm'); await runMedia(ffmpeg, ['-v', 'error', '-i', output.videoPath, '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', '-f', 's16le', pcmPath]); const pcm = await readFile(pcmPath);
  const rms = (seconds: number) => { let sum = 0; for (let sample = Math.round(seconds * 8000); sample < Math.round((seconds + .1) * 8000); sample++) sum += pcm.readInt16LE(sample * 2) ** 2; return Math.sqrt(sum / 800); };
  expect(rms(.65)).toBeGreaterThan(500); expect(rms(.15)).toBeLessThan(100);
});

it.skipIf(!mediaAvailable).each([
  { rate: { numerator: 30, denominator: 1 }, short: false },
  { rate: { numerator: 60, denominator: 1 }, short: false },
  { rate: { numerator: 30000, denominator: 1001 }, short: false },
  { rate: { numerator: 3, denominator: 1 }, short: true },
])('preserves every animated picture sample through fade, cut and wipe joins at %j', async ({ rate, short }) => {
  const { directory, project, assets } = await fixture(rate, short ? ['cut', 'fade', 'wipe', 'fade'] : ['cut', 'fade', 'cut', 'wipe'], short ? [500_000, 500_000, 500_000, 500_000] : [1_300_000, 700_000, 500_000, 700_000]);
  for (let index = 0; index < project.shots.length; index++) {
    const frames = Math.ceil(2 * rate.numerator / rate.denominator), rgb = Buffer.alloc(frames * 64 * 64 * 3), rawPath = join(directory, `animated-${index}.rgb`), videoPath = join(directory, `animated-${index}.mp4`);
    for (let frame = 0; frame < frames; frame++) {
      const factor = [.35, .675, 1][frame % 3];
      for (let pixel = 0; pixel < 64 * 64; pixel++) for (let channel = 0; channel < 3; channel++) rgb[(frame * 64 * 64 + pixel) * 3 + channel] = Math.round(colors[index][channel] * factor);
    }
    await writeFile(rawPath, rgb);
    await runMedia(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '64x64', '-framerate', `${rate.numerator}/${rate.denominator}`, '-i', rawPath, '-frames:v', String(frames), '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-pix_fmt', 'yuv444p', videoPath]);
    const bytes = await readFile(videoPath); assets[index] = { ...assets[index], kind: 'video', mimeType: 'video/mp4', path: videoPath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    project.shots[index] = { ...project.shots[index], assetId: undefined, videoAssetId: assets[index].id, videoInUs: 0 };
  }
  const output = await renderProject({ project, assets, outputDirectory: join(directory, 'out'), ffmpegPath: ffmpeg, ffprobePath: ffprobe }), timeline = createTransitionTimeline(project.shots, rate);
  if (short) expect(timeline.clips.map(clip => clip.frameCount)).toEqual([2, 1, 2, 1]);
  const decode = async (path: string, name: string) => { const target = join(directory, `${name}.rgb`); await runMedia(ffmpeg, ['-v', 'error', '-i', path, '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', target]); return readFile(target); };
  const paths = (await readFile(join(directory, 'out', 'segments.txt'), 'utf8')).trim().split('\n').map(line => join(directory, 'out', line.slice(6, -1))), segmentFrames: Buffer[] = [];
  for (const [index, path] of paths.entries()) segmentFrames.push(await decode(path, `decoded-${index}`));
  const final = await decode(output.videoPath, 'decoded-final'); expect(final.length).toBe(timeline.totalFrames * 64 * 64 * 3);
  const pixel = (bytes: Buffer, frame: number, x: number) => [...bytes.subarray((frame * 64 * 64 + 32 * 64 + x) * 3, (frame * 64 * 64 + 32 * 64 + x) * 3 + 3)];
  for (let frame = 0; frame < timeline.totalFrames; frame++) {
    const sample = sampleTransition(timeline, timeAtFrame(frame, rate))!, clip = timeline.clips.find(clip => clip.index === sample.shotIndex)!;
    for (const x of [12, 52]) {
      const incoming = pixel(segmentFrames[sample.shotIndex], frame - clip.firstFrame, x); let expected = incoming;
      if (sample.outgoing && sample.effect) {
        const previous = timeline.clips.find(clip => clip.index === sample.outgoing!.shotIndex)!, outgoing = pixel(segmentFrames[previous.index], previous.frameCount - 1, x);
        if (sample.effect.kind === 'fade') expected = incoming.map((value, channel) => value * sample.effect!.progress + outgoing[channel] * sample.effect!.outgoingProgress);
        else { const boundary = wipeLeftIncomingStartX(64, sample.effect.outgoingProgress); if (Math.abs(x - boundary) <= 5) continue; expected = x < boundary ? outgoing : incoming; }
      }
      const actual = pixel(final, frame, x);
      for (let channel = 0; channel < 3; channel++) expect(Math.abs(actual[channel] - expected[channel]), `${JSON.stringify(rate)} frame ${frame} channel ${channel}, sample=${JSON.stringify(sample)}, actual=${actual}, expected=${expected}`).toBeLessThan(15);
    }
  }
});

it.skipIf(!mediaAvailable)('paints the incoming caption after crossfade even on the fully outgoing first transition frame', async () => {
  const { directory, project, assets } = await fixture({ numerator: 30, denominator: 1 }, ['cut', 'fade'], [500_000, 1_000_000]);
  const canvas = createCanvas(320, 180), context = canvas.getContext('2d'); context.fillStyle = '#000000'; context.fillRect(0, 0, 320, 180);
  const bytes = canvas.toBuffer('image/png'), path = join(directory, 'black.png'); await writeFile(path, bytes);
  assets[0] = { ...assets[0], path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; project.shots.forEach(shot => { shot.assetId = assets[0].id; });
  project.profile.width = 320; project.profile.height = 180; project.workflow.production.subtitleMode = 'script'; project.shots[1].narration = 'VISIBLE';
  project.captionStyle = { ...DEFAULT_CAPTION_STYLE, fontSizeRatio: .09, fontWeight: 700, textColor: '#FFFFFF', backgroundColor: '#000000', backgroundOpacity: 1, maxLines: 1 };
  const output = await renderProject({ project, assets, outputDirectory: join(directory, 'out'), ffmpegPath: ffmpeg, ffprobePath: ffprobe }), raw = join(directory, 'caption.rgb');
  await runMedia(ffmpeg, ['-v', 'error', '-i', output.videoPath, '-vf', 'select=eq(n\\,15)', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw]); const picture = await readFile(raw);
  let captionPixels = 0;
  for (let y = 90; y < 180; y++) for (let x = 0; x < 320; x++) { const offset = (y * 320 + x) * 3; if (picture[offset] > 180 && picture[offset + 1] > 180 && picture[offset + 2] > 180) captionPixels++; }
  expect(sampleTransition(createTransitionTimeline(project.shots, project.profile.frameRate), 500_000)?.effect?.progress).toBe(0); expect(captionPixels).toBeGreaterThan(80);
});
