import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { afterEach, expect, it } from 'vitest';
import { createHistoryWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';
import { drawSceneFrame } from '../src/index.js';
import { deleteShotRanges } from '../src/clip-edits.js';
import { renderProject, runMedia } from '../src/node.js';
import { keyframeVideoFrames } from '../src/keyframe-video.js';
import { createRenderSchedule } from '../src/render-schedule.js';

const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const available = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0 && spawnSync(ffprobe, ['-version'], { windowsHide: true }).status === 0;
const directories: string[] = [];
afterEach(async context => { const paths = directories.splice(0); if (context.task.result?.state === 'fail') { console.info('Retained keyframe fixtures:', paths); return; } await Promise.all(paths.map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const result = await mkdtemp(join(tmpdir(), 'vq-keyframes-')); directories.push(result); return result; }
async function asset(path: string, id = 'video'): Promise<AssetRecord> { const bytes = await readFile(path); return { id, projectId: 'p', name: id, path, kind: id === 'image' ? 'image' : 'video', mimeType: id === 'image' ? 'image/png' : 'video/mp4', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, active: true, retained: false, provenance: 'keyframe fixture', createdAt: '' }; }
function project(): ProjectDocument { return projectSchema.parse({ id: 'p', title: 'keyframes', brief: '', revision: 1, templateId: 'custom', profile: { ...DEFAULT_VIDEO_PROFILE, width: 160, height: 90, previewScale: 1 }, workflow: createHistoryWorkflow(), shots: [{ id: 's', title: ' ', narration: '', visualPrompt: '', durationUs: 1_000_000, videoAssetId: 'video', animation: { transition: 'cut', panX: 0, panY: 0, zoom: 1, keyframes: [{ id: 'first', timeUs: 0, panX: -.1, panY: 0, zoom: .9, easing: 'cubic-bezier', curve: [.42, 0, .58, 1] }, { id: 'last', timeUs: 1_000_000, panX: .2, panY: .08, zoom: 1.5, easing: 'linear' }] } }], createdAt: '', updatedAt: '', audioMix: { version: 1, loudness: { enabled: false, targetLufs: -16, truePeakDb: -1.5 }, ducking: { enabled: false, thresholdDb: -30, ratio: 8, attackMs: 20, releaseMs: 250 } } }); }
async function frame(path: string, index: number, output: string) { await runMedia(ffmpeg, ['-v', 'error', '-y', '-i', path, '-vf', `select=eq(n\\,${index})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', output]); return readFile(output); }

it.skipIf(!available)('encodes image and video keyframes with the same Canvas pose across fit modes and fractional frame sampling', async () => {
  const dir = await directory(), source = createCanvas(240, 120), sourceCtx = source.getContext('2d');
  sourceCtx.fillStyle = '#df2020'; sourceCtx.fillRect(0, 0, 120, 120); sourceCtx.fillStyle = '#2050df'; sourceCtx.fillRect(120, 0, 120, 120);
  const png = join(dir, 'source.png'), mp4 = join(dir, 'source.mp4'); await writeFile(png, source.toBuffer('image/png'));
  await runMedia(ffmpeg, ['-v', 'error', '-y', '-loop', '1', '-i', png, '-t', '2', '-r', '24', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', mp4]);
  const assets = [await asset(mp4), await asset(png, 'image')];
  for (const fitMode of ['contain', 'cover', 'blur'] as const) {
    const p = project(); p.profile = { ...p.profile, fitMode, frameRate: { numerator: 30000, denominator: 1001 } }; p.shots[0].durationUs = 800_800;
    p.shots.push({ ...p.shots[0], id: 'second', videoAssetId: undefined, assetId: 'image' });
    const output = await renderProject({ project: p, outputDirectory: join(dir, fitMode), ffmpegPath: ffmpeg, ffprobePath: ffprobe, assets });
    const schedule = createRenderSchedule(p.shots, p.profile.frameRate);
    for (const [shotIndex, current] of p.shots.entries()) {
      const number = schedule[shotIndex].firstFrame + 12, localUs = Math.round(number * 1e6 * 1001 / 30000) - schedule[shotIndex].startUs;
      const actual = await frame(output.videoPath, number, join(dir, `${fitMode}-${shotIndex}.rgb`));
      const preview = createCanvas(160, 90); drawSceneFrame(preview as unknown as HTMLCanvasElement, { ...current, shotIndex, profile: p.profile, image: source as unknown as CanvasImageSource }, localUs);
      const expected = preview.getContext('2d').getImageData(0, 0, 160, 90).data;
      for (const [x, y] of [[35, 55], [80, 55], [130, 55]]) for (let channel = 0; channel < 3; channel++) expect(Math.abs(actual[(y * 160 + x) * 3 + channel] - expected[(y * 160 + x) * 4 + channel])).toBeLessThan(fitMode === 'blur' ? 25 : 16);
    }
  }
}, 90_000);

it.skipIf(!available)('never reintroduces a deleted one-frame video gap through the keyframe decoder', async () => {
  const dir = await directory(), path = join(dir, 'gap.mp4');
  await runMedia(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=30:d=1', '-vf', 'drawbox=c=red:t=fill:enable=eq(n\\,15),drawbox=c=blue:t=fill:enable=gte(n\\,16)', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path]);
  const a = await asset(path); let count = 0;
  const p = deleteShotRanges(project(), 's', [{ startUs: 500_000, endUs: 533_333 }], { numerator: 30, denominator: 1 }, [a], () => `id-${++count}`);
  const output = await renderProject({ project: p, outputDirectory: join(dir, 'cut'), ffmpegPath: ffmpeg, ffprobePath: ffprobe, assets: [a] });
  for (const index of [14, 15, 16]) {
    const data = await frame(output.videoPath, index, join(dir, `gap-${index}.rgb`)), offset = (55 * 160 + 80) * 3;
    expect(data[offset]).toBeLessThan(40);
    expect(data[offset + (index === 14 ? 1 : 2)]).toBeGreaterThan(90);
  }
});

it.skipIf(!available)('releases an interrupted raw-frame decoder and can immediately decode the same source again', async () => {
  const dir = await directory(), path = join(dir, 'cancel.mp4');
  await runMedia(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=2', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', path]);
  const p = project(), a = await asset(path), schedule = createRenderSchedule(p.shots, p.profile.frameRate)[0], signal = new AbortController();
  const interrupted = keyframeVideoFrames(p.shots[0], p, a, schedule, ffmpeg, ffprobe, signal.signal);
  expect((await interrupted.next()).done).toBe(false); signal.abort(); await interrupted.return(undefined);
  const fresh = keyframeVideoFrames(p.shots[0], p, a, schedule, ffmpeg, ffprobe);
  expect((await fresh.next()).done).toBe(false); await fresh.return(undefined);
});
