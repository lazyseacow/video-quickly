import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { afterEach, expect, it } from 'vitest';
import { createHistoryWorkflow, createSceneTemplate, DEFAULT_VIDEO_PROFILE, shotSchema, type AssetRecord, type ProjectDocument, type SceneTemplateKind } from '@video-quickly/contracts';
import { captionPages, createTimedSrt, drawSceneFrame } from '../src/index.js';
import { splitShot } from '../src/editing.js';
import { probeMedia, renderProject, runMedia } from '../src/node.js';
import { SCENE_TEMPLATE_FONT_FAMILY } from '../src/scene-templates.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const mediaAvailable = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0 && spawnSync(ffprobe, ['-version'], { windowsHide: true }).status === 0;

it.skipIf(!mediaAvailable)('encodes animated editable templates across three aspect ratios, preserving split time, real audio and subtitles over idle broken media', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-template-render-')); directories.push(directory);
  const audioPath = join(directory, 'voice.wav');
  await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=4', audioPath]);
  const bytes = await readFile(audioPath);
  const metadata = { projectId: 'templates', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: '', provenance: 'isolated template fixture', active: true, retained: false };
  const assets: AssetRecord[] = [
    { ...metadata, id: 'voice', path: audioPath, name: 'voice.wav', kind: 'audio', mimeType: 'audio/wav' },
    { ...metadata, id: 'idle-video', path: join(directory, 'missing.mp4'), name: 'missing.mp4', kind: 'video', mimeType: 'video/mp4' },
    { ...metadata, id: 'idle-image', path: join(directory, 'missing.png'), name: 'missing.png', kind: 'image', mimeType: 'image/png' },
  ];
  async function pixels(path: string, number: number, name: string) {
    const target = join(directory, `${name}.rgb`);
    await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vf', `select=eq(n\\,${number})`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', target]);
    return readFile(target);
  }
  const cases: Array<[SceneTemplateKind, number, number]> = [['process', 640, 360], ['comparison', 360, 640], ['bar-chart', 480, 480]];
  for (const [kind, width, height] of cases) {
    const captionText = 'A long aligned caption keeps its original segment identity while reading pages stay within the reserved caption area. '.repeat(3).trim();
    const template = createSceneTemplate(kind); template.heading = 'Editable science diagram';
    if (template.kind === 'process') template.steps = ['Ask', 'Observe', 'Test', 'Explain'].map(title => ({ title, detail: `Editable ${title.toLowerCase()} detail` }));
    if (template.kind === 'comparison') { template.left = { title: 'Option A', points: ['Low cost', 'Simple setup', 'Manual control'] }; template.right = { title: 'Option B', points: ['More capacity', 'Shared setup', 'Automatic control'] }; }
    if (template.kind === 'bar-chart') { template.unit = 'samples'; template.bars = [{ label: 'First', value: 10 }, { label: 'Second', value: 20 }, { label: 'Third', value: 15 }]; }
    const rate = { numerator: 30, denominator: 1 }, profile = { ...DEFAULT_VIDEO_PROFILE, width, height, frameRate: rate, previewScale: 1 };
    const original = shotSchema.parse({ id: 'whole', title: 'Template', narration: '', visualPrompt: '', durationUs: 4_000_000, sourceInUs: 0, audioAssetId: 'voice', videoAssetId: 'idle-video', assetId: 'idle-image', sceneTemplate: template, captionTrack: { timeBase: 'source', alignment: 'manual', cues: [{ id: 'caption', startUs: 2_000_000, endUs: 3_900_000, text: captionText }] }, animation: { transition: 'cut' } });
    const [, right] = splitShot(original, 2_000_000, rate, 'right');
    const project: ProjectDocument = { id: 'templates', title: 'Template render', brief: '', templateId: 'generic', revision: 1, profile, shots: [right], claims: [], style: '', archived: false, createdAt: '', updatedAt: '', workflow: createHistoryWorkflow() };
    const outputDirectory = join(directory, kind);
    const output = await renderProject({ project, assets, outputDirectory, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
    const probe = await probeMedia(output.videoPath, ffprobe);
    expect([probe.width, probe.height]).toEqual([width, height]); expect(probe.frameRate).toBe('30/1'); expect(probe.videoDuration).toBeCloseTo(2, 2); expect(probe.audioDuration).toBeCloseTo(2, 1);
    const count = JSON.parse(await runMedia(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', output.videoPath]));
    expect(count.streams[0].nb_read_frames).toBe('60');
    const early = await pixels(output.videoPath, 0, `${kind}-early`), late = await pixels(output.videoPath, 55, `${kind}-late`);
    let changed = 0;
    for (let offset = 0; offset < width * Math.floor(height * .8) * 3; offset += 3) if (Math.abs(early[offset] - late[offset]) + Math.abs(early[offset + 1] - late[offset + 1]) + Math.abs(early[offset + 2] - late[offset + 2]) > 35) changed++;
    expect(changed).toBeGreaterThan(width * height * .001);

    // Compare the decoded exported picture with the preview painter at original scene time 2.4s.
    // Separate assertions above verify actual animation and dimensions, rather than only image equality.
    const encoded = await pixels(output.videoPath, 12, `${kind}-preview`), canvas = createCanvas(width, height);
    drawSceneFrame(canvas as unknown as HTMLCanvasElement, { ...original, narration: '', captionTrack: undefined, shotIndex: 0, profile }, 2_400_000);
    const direct = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let error = 0; const samples = width * Math.floor(height * .58) * 3;
    for (let offset = 0; offset < samples; offset++) error += Math.abs(encoded[offset] - direct[Math.floor(offset / 3) * 4 + offset % 3]);
    expect(error / samples).toBeLessThan(6);
    const subtitleText = await readFile(output.subtitlePath, 'utf8');
    const measure = createCanvas(width, height).getContext('2d');
    measure.font = `500 ${Math.max(12, Math.min(width * .027, height * .047))}px ${SCENE_TEMPLATE_FONT_FAMILY}`;
    expect(subtitleText).toBe(createTimedSrt([right], text => captionPages(text, line => measure.measureText(line).width, width * .78, height > width ? 3 : 2)));
    const subtitleBlocks = subtitleText.trim().split(/\n\s*\n/).map(block => block.split('\n'));
    expect(subtitleBlocks.length).toBeGreaterThan(1);
    expect(subtitleBlocks.every(block => block.slice(2).length <= (height > width ? 3 : 2))).toBe(true);
    expect(subtitleBlocks.flatMap(block => block.slice(2)).join('').replaceAll(/\s/g, '')).toBe(captionText.replaceAll(/\s/g, ''));
    expect(subtitleBlocks[0][1]).toMatch(/^00:00:00,000 --> /); expect(subtitleBlocks.at(-1)?.[1]).toMatch(/ --> 00:00:01,900$/);
    const segment = (await readdir(outputDirectory)).find(name => name.startsWith('segment-') && name.endsWith('.mp4'));
    expect(segment).toBeDefined();
    const uncaptioned = await pixels(join(outputDirectory, segment!), 12, `${kind}-uncaptioned`);
    let captionPixels = 0;
    for (let offset = width * Math.floor(height * .8) * 3; offset < encoded.length; offset++) if (Math.abs(encoded[offset] - uncaptioned[offset]) > 40) captionPixels++;
    expect(captionPixels).toBeGreaterThan(100);
    let firstCaptionRow = height, lastDiagramRow = -1;
    for (let pixel = 0; pixel < width * height; pixel++) {
      const rgba = pixel * 4, rgb = pixel * 3;
      if (direct[rgba + 1] - direct[rgba] > 20 && direct[rgba + 1] - direct[rgba + 2] > 7 && direct[rgba + 1] < 210) lastDiagramRow = Math.floor(pixel / width);
      if (encoded[rgb] < 100 && encoded[rgb + 1] < 100 && encoded[rgb + 2] < 100 && uncaptioned[rgb] > 180 && uncaptioned[rgb + 1] > 180 && uncaptioned[rgb + 2] > 180) firstCaptionRow = Math.min(firstCaptionRow, Math.floor(pixel / width));
    }
    expect(firstCaptionRow).toBeLessThan(height); expect(firstCaptionRow).toBeGreaterThan(lastDiagramRow);
    if (kind === 'process') {
      const pcmPath = join(directory, 'voice.pcm');
      await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.2', '-i', output.videoPath, '-t', '0.4', '-ac', '1', '-ar', '8000', '-f', 's16le', pcmPath]);
      const pcm = await readFile(pcmPath); let crossings = 0;
      for (let offset = 2; offset < pcm.length; offset += 2) if (pcm.readInt16LE(offset - 2) <= 0 && pcm.readInt16LE(offset) > 0) crossings++;
      const frequency = crossings / (pcm.length / 2 / 8000); expect(frequency).toBeGreaterThan(800); expect(frequency).toBeLessThan(960);
    }
  }
}, 90_000);
