import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { afterEach, expect, it } from 'vitest';
import { createHistoryWorkflow, createSceneTemplate, DEFAULT_CAPTION_STYLE, DEFAULT_VIDEO_PROFILE, effectiveCaptionStyle, projectSchema, shotSchema, timeAtFrame, type AssetRecord, type CaptionStyle } from '@video-quickly/contracts';
import { captionAtTime, captionBox, captionPages, citationOverlayForShot, createCitationManifest, createTimedSrt, drawSceneFrame, resolveCaptionLayout } from '../src/index.js';
import { splitShot } from '../src/editing.js';
import { probeMedia, renderProject, runMedia } from '../src/node.js';

const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const mediaAvailable = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0 && spawnSync(ffprobe, ['-version'], { windowsHide: true }).status === 0;
const directories: string[] = [];
afterEach(async ({ task }) => {
  const paths = directories.splice(0);
  if (task.result?.state === 'fail') { console.info('字幕媒体诊断夹具保留：', paths); return; }
  await Promise.all(paths.map(path => rm(path, { recursive: true, force: true })));
});

it.skipIf(!mediaAvailable)('burns inherited and per-shot font/color/opacity/position styles over real video and safe diagrams without changing speech timing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-caption-style-')); directories.push(directory);
  const path = join(directory, 'blue-voice.mp4');
  await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=30:d=5', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path]);
  const bytes = await readFile(path), sha256 = createHash('sha256').update(bytes).digest('hex');
  const metadata = { projectId: 'styles', path, size: bytes.length, sha256, version: 1, active: true, retained: false, createdAt: '', provenance: 'isolated styled-caption fixture' };
  const assets: AssetRecord[] = [{ ...metadata, id: 'video', name: 'blue.mp4', kind: 'video', mimeType: 'video/mp4' }, { ...metadata, id: 'voice', name: 'voice.m4a', kind: 'audio', mimeType: 'audio/mp4' }];
  const rate = { numerator: 30000, denominator: 1001 }, half = timeAtFrame(60, rate), duration = timeAtFrame(120, rate);
  const inherited: CaptionStyle = { ...DEFAULT_CAPTION_STYLE, fontSizeRatio: .06, fontWeight: 700, textColor: '#00FF00', backgroundColor: '#FF0000', backgroundOpacity: .8, maxLines: 2 };
  const override: CaptionStyle = { ...inherited, fontId: 'serif', fontWeight: 400, position: 'top', textColor: '#FFDD00', backgroundColor: '#1122DD', backgroundOpacity: .35, maxLines: 1 };
  const narration = '真实语音句段保持不变。 Literal {\\pos(0,0)\\fs999} and \\N stay plain text. '.repeat(5).trim();
  const whole = shotSchema.parse({ id: 'left', title: ' ', narration: '', visualPrompt: '', sourceInUs: 0, durationUs: duration, videoAssetId: 'video', audioAssetId: 'voice', claimIds: ['claim'], captionTrack: { timeBase: 'source', alignment: 'speech', sourceAssetId: 'voice', sourceSha256: sha256, granularity: 'segment', cues: [{ id: 'speech-original', startUs: 0, endUs: duration, text: narration }] }, animation: { transition: 'cut' } });
  const [left, splitRight] = splitShot(whole, half, rate, 'right');
  const right = { ...splitRight, sceneTemplate: { ...createSceneTemplate('bar-chart'), motion: 'none' as const }, captionStyle: override };
  async function framePixels(video: string, frame: number, name: string) {
    const target = join(directory, `${name}.rgb`);
    await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', target]);
    return readFile(target);
  }
  for (const [width, height] of [[640, 360], [360, 640], [480, 480]]) {
    const profile = { ...DEFAULT_VIDEO_PROFILE, width, height, frameRate: rate, previewScale: 1 }, outputDirectory = join(directory, `${width}x${height}`);
    const project = projectSchema.parse({ id: 'styles', title: 'Styled captions', revision: 1, brief: '', profile, workflow: createHistoryWorkflow(), createdAt: '', updatedAt: '', captionStyle: inherited, referenceDisplay: 'numbers', claims: [{ id: 'claim', text: '引用示例', source: '旧资料', status: 'pending' }], shots: [left, right] });
    const before = structuredClone(project), result = await renderProject({ project, assets, outputDirectory, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
    const probe = await probeMedia(result.videoPath, ffprobe); expect(probe).toMatchObject({ width, height, frameRate: '30000/1001' }); expect(probe.videoDuration).toBeCloseTo(duration / 1e6, 3);
    expect(project).toEqual(before); expect(project.shots.every(shot => shot.captionTrack?.alignment === 'speech' && shot.captionTrack.cues[0].id === 'speech-original')).toBe(true);
    const ass = await readFile(join(outputDirectory, 'subtitles.ass'), 'utf8'); expect(ass).not.toContain('{\\pos(0,0)'); expect(ass).toContain('\\\u2060fs999'); expect(ass).toContain('\\\u2060N');
    const timeline = JSON.parse(await readFile(result.timelinePath, 'utf8')); expect(timeline.captionLayouts[0].layout.style.fontId).toBe('sans'); expect(timeline.captionLayouts[1].layout.style.fontId).toBe('serif'); expect(timeline.captionLayouts[0].fontName).not.toBe(timeline.captionLayouts[1].fontName);
    const measure = createCanvas(width, height).getContext('2d');
    const resolved = project.shots.map(shot => ({ ...shot, captionStyle: effectiveCaptionStyle(project, shot) }));
    expect(await readFile(result.subtitlePath, 'utf8')).toBe(createTimedSrt(resolved, (text, shot) => { const layout = resolveCaptionLayout(width, height, shot.captionStyle, { referenceFooter: true, template: Boolean(shot.sceneTemplate) }); measure.font = layout.font; return captionPages(text, line => measure.measureText(line).width, layout.textWidth, layout.maxLines); }));
    const citations = createCitationManifest(project);
    for (const [index, frame, test] of [[0, 15, 'green'], [1, 75, 'yellow']] as const) {
      const shot = resolved[index], layout = resolveCaptionLayout(width, height, shot.captionStyle, { referenceFooter: true, template: Boolean(shot.sceneTemplate) });
      const encoded = await framePixels(result.videoPath, frame, `${width}-${test}`), preview = createCanvas(width, height), image = createCanvas(640, 360);
      image.getContext('2d').fillStyle = '#0000FF'; image.getContext('2d').fillRect(0, 0, 640, 360);
      const localTime = timeAtFrame(frame - index * 60, rate);
      drawSceneFrame(preview as unknown as HTMLCanvasElement, { ...shot, profile, shotIndex: index, image: image as unknown as CanvasImageSource, referenceFooter: true, citation: citationOverlayForShot(citations, shot.id) }, localTime);
      const direct = preview.getContext('2d').getImageData(0, 0, width, height).data;
      function bounds(values: Uint8Array | Uint8ClampedArray, stride: number) {
        let count = 0, top = height, bottom = -1;
        for (let pixel = 0; pixel < width * Math.floor(height * .92); pixel++) {
          const offset = pixel * stride, colored = test === 'green' ? values[offset + 1] > 140 && values[offset] < 120 && values[offset + 2] < 140 : values[offset] > 150 && values[offset + 1] > 120 && values[offset + 2] < 100;
          if (colored) { count++; top = Math.min(top, Math.floor(pixel / width)); bottom = Math.floor(pixel / width); }
        }
        return { count, top, bottom };
      }
      const actual = bounds(encoded, 3), expected = bounds(direct, 4);
      expect(actual.count).toBeGreaterThan(20); expect(actual.top).toBeGreaterThanOrEqual(layout.position === 'top' ? Math.floor(layout.top) - 2 : Math.floor(layout.bottom - layout.maxLines * layout.lineHeight - layout.paddingY * 2) - 2);
      expect(Math.abs(actual.top - expected.top),JSON.stringify({test,actual,expected,layout})).toBeLessThan(layout.fontSize * .6 + 3); expect(Math.abs(actual.bottom - expected.bottom),JSON.stringify({test,actual,expected})).toBeLessThan(layout.fontSize * .6 + 3);
      measure.font=layout.font;
      const visible=captionAtTime(shot,localTime,text=>captionPages(text,line=>measure.measureText(line).width,layout.textWidth,layout.maxLines));
      const box = captionBox(layout, visible?.text.split('\n').length??layout.maxLines), sampleX = Math.ceil(box.x + 4), sampleY = Math.floor(box.y+box.height/2), offset = (sampleY * width + sampleX) * 3;
      const underlay=createCanvas(width,height);
      drawSceneFrame(underlay as unknown as HTMLCanvasElement,{...shot,captionTrack:{...shot.captionTrack!,cues:[]},profile,shotIndex:index,image:image as unknown as CanvasImageSource,referenceFooter:true,citation:citationOverlayForShot(citations,shot.id)},localTime);
      const base=underlay.getContext('2d').getImageData(sampleX,sampleY,1,1).data;
      const target=[1,3,5].map((start,channel)=>parseInt(layout.backgroundColor.slice(start,start+2),16)*layout.backgroundOpacity+base[channel]*(1-layout.backgroundOpacity));
      target.forEach((value, channel) => expect(Math.abs(encoded[offset + channel] - value)).toBeLessThan(25));
    }
    if (width === 640) {
      const boundaryShot = shotSchema.parse({ ...left, id: 'boundary', claimIds: [], durationUs: half, captionTrack: { ...whole.captionTrack!, cues: [{ id: 'early', startUs: 200_000, endUs: 500_501, text: 'EARLY' }, { id: 'late', startUs: 1_301_301, endUs: 1_600_000, text: 'LATE' }] } });
      const boundary = await renderProject({ project: { ...project, referenceDisplay: 'hidden', shots: [boundaryShot] }, assets, outputDirectory: join(outputDirectory, 'boundary'), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
      const selected = [5, 6, 15, 16, 39, 40, 47, 48], boundaryPath = join(directory, 'boundary-frames.rgb');
      await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', boundary.videoPath, '-vf', `select=${selected.map(frame => `eq(n\\,${frame})`).join('+')}`, '-frames:v', String(selected.length), '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', boundaryPath]);
      const boundaryPixels = await readFile(boundaryPath), frameBytes = width * height * 3;
      expect(boundaryPixels.length).toBe(frameBytes * selected.length);
      const counts = selected.map((_frame, index) => { let count = 0; for (let offset = index * frameBytes; offset < (index + 1) * frameBytes; offset += 3) if (boundaryPixels[offset + 1] > 140 && boundaryPixels[offset] < 120 && boundaryPixels[offset + 2] < 140) count++; return count; });
      expect(counts.map(count => count > 20)).toEqual([false, true, true, false, false, true, true, false]);
      const segments = (await readdir(outputDirectory)).filter(name => /^segment-.*\.mp4$/.test(name)), times = await Promise.all(segments.map(name => stat(join(outputDirectory, name)).then(value => value.mtimeMs)));
      await renderProject({ project: { ...project, captionStyle: { ...inherited, textColor: '#FF00FF' } }, assets, outputDirectory, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
      expect((await readdir(outputDirectory)).filter(name => /^segment-.*\.mp4$/.test(name))).toHaveLength(3); expect(await Promise.all(segments.map(name => stat(join(outputDirectory, name)).then(value => value.mtimeMs)))).toEqual(times);
      const legacy = shotSchema.parse({ id: 'legacy', title: ' ', narration: 'Legacy caption', visualPrompt: '', durationUs: 1_000_000, sourceInUs: 0, videoAssetId: 'video', audioAssetId: 'voice', animation: { transition: 'cut' } });
      const mixed = await renderProject({ project: { ...project, captionStyle: undefined, shots: [{ ...left, captionStyle: inherited }, right, legacy] }, assets, outputDirectory, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
      const legacyPixels = await framePixels(mixed.videoPath, 135, 'mixed-legacy');
      const layout = resolveCaptionLayout(width, height, undefined, { referenceFooter: true }), box = captionBox(layout, 1);
      const preview = createCanvas(width, height), image = createCanvas(width, height);
      image.getContext('2d').fillStyle = '#0000FF'; image.getContext('2d').fillRect(0, 0, width, height);
      drawSceneFrame(preview as unknown as HTMLCanvasElement, { ...legacy, profile, shotIndex: 2, referenceFooter: true, image: image as unknown as CanvasImageSource }, 500_000);
      // Small antialiased glyphs blend with the dark box, especially after YUV420 chroma subsampling.
      // Compare visible ink and its preview bounds rather than requiring opaque cream-colored pixels.
      function ink(values: Uint8Array | Uint8ClampedArray, stride: number) {
        let count = 0, left = width, right = -1, top = height, bottom = -1;
        for (let y = Math.ceil(box.y); y < box.y + box.height; y++) for (let x = Math.ceil(box.x); x < box.x + box.width; x++) {
          const offset = (y * width + x) * stride;
          if (values[offset] > 130 && values[offset + 1] > 130 && values[offset + 2] > 100) {
            count++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
          }
        }
        return { count, left, right, top, bottom };
      }
      const actual = ink(legacyPixels, 3), expected = ink(preview.getContext('2d').getImageData(0, 0, width, height).data, 4);
      expect(actual.count).toBeGreaterThan(20); expect(expected.count).toBeGreaterThan(20);
      expect(Math.abs((actual.left + actual.right) / 2 - (expected.left + expected.right) / 2)).toBeLessThan(3);
      for (const edge of ['top', 'bottom'] as const) expect(Math.abs(actual[edge] - expected[edge]), JSON.stringify({ actual, expected })).toBeLessThan(layout.fontSize * .6 + 3);
    }
  }
}, 120_000);
