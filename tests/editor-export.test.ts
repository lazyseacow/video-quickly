import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createNativeVideoWorkflow, projectSchema, type AssetRecord } from '@video-quickly/contracts';
import { probeMedia, runMedia } from '../packages/video/src/node';
import { exportEditorProject } from '../packages/runtime/src/editor-export';
import { fixtureNativeVideo } from './fixtures/native-video';

const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const mediaAvailable = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0 && spawnSync(ffprobe, ['-version'], { windowsHide: true }).status === 0;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const project = () => projectSchema.parse({
  id: 'edit-project', title: '你好🎬', brief: '', templateId: 'generic', style: '', revision: 3,
  archived: false, createdAt: '', updatedAt: '', claims: [],
  profile: { width: 160, height: 90, frameRate: { numerator: 30000, denominator: 1001 }, fitMode: 'contain' },
  workflow: { ...createNativeVideoWorkflow(), production: { ...createNativeVideoWorkflow().production, subtitleMode: 'script' } },
  shots: [
    { id: 'one', title: '一', narration: '你好🎬', visualPrompt: '', durationUs: 510000, videoAssetId: 'movie', videoInUs: 100000, animation: { transition: 'cut' } },
    { id: 'two', title: '二', narration: '再见', visualPrompt: '', durationUs: 510000, videoAssetId: 'movie', videoInUs: 400000, animation: { transition: 'cut' } },
  ],
});
async function directory() { const value = await mkdtemp(join(tmpdir(), 'vq-editor-export-')); directories.push(value); return value; }
async function fixture(root: string): Promise<AssetRecord> {
  const bytes = fixtureNativeVideo(), path = join(root, 'source.mp4'); await writeFile(path, bytes);
  return { id: 'movie', projectId: 'edit-project', name: 'movie', path, kind: 'video', mimeType: 'video/mp4', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, active: true, retained: false, provenance: 'isolated fixture', createdAt: '' };
}

it.skipIf(!mediaAvailable)('exports real separated media and a portable compile spec with one global fractional frame grid', async () => {
  const root = await directory(), source = await fixture(root), input = project(), before = structuredClone(input);
  const result = await exportEditorProject({ project: input, assets: [source], dataDirectory: root, destinationDirectory: join(root, 'out'), target: 'capcut', ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  expect(result.format).toBe('handoff'); expect(result.draftPath).toBeUndefined(); expect(input).toEqual(before);
  const files = await readdir(result.directory); expect(files).not.toContain('draft_info.json'); expect(files).not.toContain('.render');
  const spec = JSON.parse(await readFile(result.specPath, 'utf8'));
  expect(spec.tracks[0].items).toEqual([
    { path: 'media/picture.mp4', start: 0, sourceStart: 0, duration: .533867, volume: 0 },
    { path: 'media/picture.mp4', start: .533867, sourceStart: .533867, duration: .5005, volume: 0 },
  ]);
  expect(spec.tracks[1].items).toEqual([{ path: 'media/mix.wav', start: 0, duration: 1.034367, volume: 1 }]);
  const picture = await probeMedia(join(result.directory, 'media', 'picture.mp4'), ffprobe), audio = await probeMedia(join(result.directory, 'media', 'mix.wav'), ffprobe);
  expect(picture.audio).toBe(false); expect(audio.audio).toBe(true); expect(audio.duration).toBeCloseTo(1.034367, 3);
  expect(picture.width).toBe(160); expect(picture.height).toBe(90); expect(picture.videoDuration).toBeCloseTo(31 * 1001 / 30000, 5);
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  expect(manifest.projectRevision).toBe(3); expect(manifest.output).toBe('handoff-only'); expect(manifest.compatibility.desktopImportVerified).toBe(false);
  expect(manifest.sourceAssets).toEqual([{ assetId: 'movie', sha256: source.sha256, kind: 'video' }]);
  expect(manifest.cuts.map((cut: { firstFrame: number; endFrame: number }) => [cut.firstFrame, cut.endFrame])).toEqual([[0, 16], [16, 31]]);
  for (const file of manifest.files) { const bytes = await readFile(join(result.directory, file.path)); expect(file.size).toBe(bytes.length); expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex')); }
  expect(await readFile(join(result.directory, 'subtitles.srt'), 'utf8')).toContain('00:00:00,000 --> 00:00:00,510\n你好🎬');
  expect(await readFile(join(result.directory, 'THIRD_PARTY_NOTICES.txt'), 'utf8')).toContain('Copyright (c) 2026 Rene Zander');
  const moved = join(root, 'moved'); await import('node:fs/promises').then(fs => fs.rename(result.directory, moved));
  for (const track of spec.tracks) for (const item of track.items) if (item.path) expect((await stat(join(moved, item.path))).isFile()).toBe(true);
});

it.skipIf(!mediaAvailable)('uses the shared legacy narration duration before deriving the editor cut grid', async () => {
  const root = await directory(), movie = await fixture(root), voicePath = join(root, 'voice.wav');
  await runMedia(ffmpeg, ['-nostdin', '-v', 'error', '-i', movie.path, '-map', '0:a:0', '-c:a', 'pcm_s16le', voicePath]);
  const bytes = await readFile(voicePath), voice: AssetRecord = { ...movie, id: 'voice', kind: 'audio', mimeType: 'audio/wav', name: 'voice.wav', path: voicePath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const input = project(); input.profile.frameRate = { numerator: 30, denominator: 1 }; input.shots = [{ ...input.shots[0], audioAssetId: voice.id }];
  const result = await exportEditorProject({ project: input, assets: [movie, voice], dataDirectory: root, target: 'capcut', ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  expect(manifest.cuts[0].authoredDurationUs).toBeGreaterThanOrEqual(1_000_000);
  expect(input.shots[0].durationUs).toBe(510000);
  expect((await probeMedia(join(result.directory, 'media', 'mix.wav'), ffprobe)).duration).toBeCloseTo(manifest.durationUs / 1_000_000, 4);
});

it.skipIf(!mediaAvailable).each([
  [{ numerator: 30, denominator: 1 }, 122, 4_066_667],
  [{ numerator: 60, denominator: 1 }, 243, 4_050_000],
  [{ numerator: 30000, denominator: 1001 }, 122, 4_070_733],
] as const)('preserves the exact MP4 frame clock for a 97-frame 24 fps source at %j', async (frameRate, frames, durationUs) => {
  const root = await directory(), path = join(root, '97-frames-at-24fps.mp4'), silent = join(root, 'silent-source.mp4');
  await runMedia(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=24', '-frames:v', '97', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
  await runMedia(ffmpeg, ['-nostdin', '-v', 'error', '-i', silent, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=32000:duration=4.096', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', path]);
  const bytes = await readFile(path), source: AssetRecord = { id: 'movie', projectId: 'edit-project', name: '24fps-source', path, kind: 'video', mimeType: 'video/mp4', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, active: true, retained: false, provenance: 'self-generated frame-boundary fixture', createdAt: '' };
  const input = project(); input.profile.frameRate = frameRate;
  input.shots = [{ ...input.shots[0], durationUs: 4_041_667, videoInUs: 0, audioProcessing: { version: 2, gainDb: 0, denoise: false, noiseReductionDb: 12, videoAudio: { enabled: true, gainDb: 0 } } }];
  const before = structuredClone(input), sourceHash = source.sha256;
  const result = await exportEditorProject({ project: input, assets: [source], dataDirectory: root, target: 'capcut', ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  expect(manifest.durationUs).toBe(durationUs); expect(manifest.cuts[0]).toMatchObject({ firstFrame: 0, endFrame: frames, durationUs });
  const timing = JSON.parse(await runMedia(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base,nb_frames', '-of', 'json', join(result.directory, 'media', 'picture.mp4')]));
  expect(timing.streams[0].time_base).toBe(`1/${frameRate.numerator}`); expect(Number(timing.streams[0].nb_frames)).toBe(frames);
  const picture = await probeMedia(join(result.directory, 'media', 'picture.mp4'), ffprobe), audio = await probeMedia(join(result.directory, 'media', 'mix.wav'), ffprobe);
  expect(picture.audio).toBe(false); expect(picture.videoDuration).toBeCloseTo(durationUs / 1_000_000, 5); expect(audio.duration).toBeCloseTo(durationUs / 1_000_000, 4);
  expect(input).toEqual(before); expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(sourceHash);
});

it.skipIf(!mediaAvailable)('creates an experimental draft from a frozen local empty template and registers all media without changing the template', async () => {
  const root = await directory(), source = await fixture(root), templatePath = join(root, 'draft_info.json');
  const template = JSON.stringify({ id: 'donor', name: 'empty', main_timeline_id: 'do-not-copy', platform: { app_source: 'lv', app_version: '11.4.0', os: 'windows' }, new_version: '111', version: 360000, tracks: [], materials: { videos: [], texts: [] }, config: { maintrack_adsorb: true } });
  await writeFile(templatePath, template);
  const result = await exportEditorProject({ project: project(), assets: [source], dataDirectory: root, target: 'jianying', templatePath, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  expect(result.format).toBe('draft'); expect(result.editorVersion).toBe('11.4.0'); expect(await readFile(templatePath, 'utf8')).toBe(template);
  const draft = JSON.parse(await readFile(result.draftPath!, 'utf8')), mirror = JSON.parse(await readFile(join(result.directory, 'draft_content.json'), 'utf8')), meta = JSON.parse(await readFile(join(result.directory, 'draft_meta_info.json'), 'utf8'));
  expect(draft).toEqual(mirror); expect(draft.platform.app_version).toBe('11.4.0'); expect(draft.version).toBe(360000); expect(draft.config).toEqual({ maintrack_adsorb: true });
  expect(draft.id).not.toBe('donor'); expect(draft.main_timeline_id).toBeUndefined(); expect(draft.tracks.map((track: { type: string }) => track.type)).toEqual(['video', 'audio', 'text']);
  const picture = draft.materials.videos[0], audio = draft.materials.audios[0];
  expect(picture.path).toBe(join(result.directory, 'media', 'picture.mp4')); expect(audio.path).toBe(join(result.directory, 'media', 'mix.wav'));
  expect(picture.has_audio).toBe(false); expect(draft.tracks[0].segments.every((segment: { volume: number }) => segment.volume === 0)).toBe(true);
  expect(draft.tracks[1].segments[1].source_timerange.start).toBe(533867);
  const text = JSON.parse(draft.materials.texts[0].content); expect(text.text).toBe('你好🎬'); expect(text.styles[0].range).toEqual([0, 4]);
  const registry = meta.draft_materials[0].value; expect(registry.map((entry: { id: string }) => entry.id)).toEqual([picture.local_material_id, audio.local_material_id]);
  expect(registry.map((entry: { file_Path: string }) => entry.file_Path)).toEqual([picture.path, audio.path]);
  const materialIds = Object.values(draft.materials).flatMap(items => (items as Array<{ id: string }>).map(item => item.id));
  for (const track of draft.tracks) for (const segment of track.segments) for (const id of segment.extra_material_refs) expect(materialIds).toContain(id);
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')); expect(manifest.template.sha256).toBe(createHash('sha256').update(template).digest('hex'));
  expect(manifest.compatibility).toEqual({ desktopImportVerified: false, windowsVerified: false, macosVerified: false });
});

it.each([
  ['encrypted', 'not plaintext JSON', /不是明文/],
  ['nonempty', JSON.stringify({ platform: { app_source: 'cc', app_version: '9' }, tracks: [{ segments: [{ id: 'x' }] }], materials: {} }), /不含片段/],
  ['materials', JSON.stringify({ platform: { app_source: 'cc', app_version: '9' }, tracks: [], materials: { videos: [{}] } }), /已有素材/],
  ['wrong-target', JSON.stringify({ platform: { app_source: 'lv', app_version: '9' }, tracks: [], materials: {} }), /平台/],
  ['unsafe-field', '{"platform":{"app_source":"cc","app_version":"9"},"tracks":[],"materials":{},"__proto__":{}}', /无效字段/],
] as const)('rejects %s templates before any output or media processing', async (_name, value, message) => {
  const root = await directory(), template = join(root, 'template.json'), output = join(root, 'exports'); await writeFile(template, value);
  await expect(exportEditorProject({ project: project(), assets: [], dataDirectory: root, destinationDirectory: output, target: 'capcut', templatePath: template })).rejects.toThrow(message);
  expect(await stat(output).catch(() => undefined)).toBeUndefined();
});

it('refuses a live draft-store destination and leaves existing user files untouched', async () => {
  const root = await directory(), path = join(root, 'com.lveditor.draft');
  const value = project(); value.shots = value.shots.map(shot => ({ ...shot, videoAssetId: undefined }));
  await expect(exportEditorProject({ project: value, assets: [], dataDirectory: root, destinationDirectory: path, target: 'capcut' })).rejects.toThrow(/草稿库以外/);
  expect(await stat(path).catch(() => undefined)).toBeUndefined();
});

it('refuses a missing bound visual instead of rendering an unrelated fallback illustration', async () => {
  const root = await directory(), output = join(root, 'exports');
  await expect(exportEditorProject({ project: project(), assets: [], dataDirectory: root, destinationDirectory: output, target: 'capcut' })).rejects.toThrow(/画面素材缺失/);
  expect(await stat(output).catch(() => undefined)).toBeUndefined();
});

it.skipIf(!mediaAvailable)('does not publish partial artifacts after source corruption or an aborted local export', async () => {
  const root = await directory(), source = await fixture(root), output = join(root, 'exports');
  await expect(exportEditorProject({ project: project(), assets: [{ ...source, sha256: '0'.repeat(64) }], dataDirectory: root, destinationDirectory: output, target: 'capcut', ffmpegPath: ffmpeg, ffprobePath: ffprobe })).rejects.toThrow(/校验失败/);
  expect(await readdir(output)).toEqual([]);
  const controller = new AbortController(); controller.abort(new Error('local stop'));
  await expect(exportEditorProject({ project: project(), assets: [source], dataDirectory: root, destinationDirectory: output, target: 'capcut', signal: controller.signal })).rejects.toThrow('local stop');
  expect(await readdir(output)).toEqual([]);
  const duringRender = new AbortController();
  await expect(exportEditorProject({ project: project(), assets: [source], dataDirectory: root, destinationDirectory: output, target: 'capcut', ffmpegPath: ffmpeg, ffprobePath: ffprobe, signal: duringRender.signal, onProgress: value => { if (value > 0) duringRender.abort(new Error('render stop')); } })).rejects.toThrow(/abort|render stop|取消/i);
  expect(await readdir(output)).toEqual([]);
});
