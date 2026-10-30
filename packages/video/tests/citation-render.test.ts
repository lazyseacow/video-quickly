import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { createHistoryWorkflow, createSceneTemplate, DEFAULT_VIDEO_PROFILE, projectSchema, type AssetRecord } from '@video-quickly/contracts';
import { probeMedia, renderProject, runMedia } from '../src/node.js';
import { captionGeometry, captionPages, citationFooterTop, createTimedSrt } from '../src/index.js';
import { captionFontFamily } from '../src/caption-layout.js';

const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const mediaAvailable = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0 && spawnSync(ffprobe, ['-version'], { windowsHide: true }).status === 0;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it.skipIf(!mediaAvailable)('burns the same reference footer over real video, templates and sample art in three formats, keeping evidence metadata and hidden-mode cache semantics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-citation-render-')); directories.push(directory);
  const sourcePath = join(directory, 'blue-tone.mp4');
  await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath]);
  const bytes = await readFile(sourcePath), assetFields = { projectId: 'references', path: sourcePath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, active: true, retained: false, provenance: 'isolated real reference fixture', createdAt: '' };
  const assets: AssetRecord[] = [{ ...assetFields, id: 'video', name: 'blue.mp4', kind: 'video', mimeType: 'video/mp4' }, { ...assetFields, id: 'voice', name: 'tone.m4a', kind: 'audio', mimeType: 'audio/mp4' }];
  const content = 'Do not export this entire private source. The measured result was forty-two. Keep this private tail out of the manifest.', quote = 'The measured result was forty-two.';
  const sourceHash = createHash('sha256').update(content).digest('hex'), startOffset = content.indexOf(quote);
  const evidence = [{ sourceId: 'document', sourceSha256: sourceHash, startOffset, endOffset: startOffset + quote.length, quote, locator: 'Paragraph 2' }];
  async function pixels(path: string, time: string, name: string) {
    const target = join(directory, `${name}.rgb`);
    await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', time, '-i', path, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', target]);
    return readFile(target);
  }
  function footerPixels(values: Buffer, width: number, height: number) {
    let count = 0;
    for (let y = Math.ceil(height * .935); y < height * .99; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      if (values[offset] - values[offset + 1] > 8 && values[offset + 1] - values[offset + 2] > 8 && values[offset + 2] < 170) count++;
    }
    return count;
  }
  const formats = [[320, 180, 'contain'], [180, 320, 'cover'], [256, 256, 'blur']] as const;
  for (const [width, height, fitMode] of formats) {
    const profile = { ...DEFAULT_VIDEO_PROFILE, width, height, fitMode, previewScale: 1 }, outputDirectory = join(directory, fitMode);
    const project = projectSchema.parse({ id: 'references', title: 'Cited pictures', revision: 1, brief: '', workflow: createHistoryWorkflow(), profile, createdAt: '', updatedAt: '', referenceDisplay: 'numbers',
      researchSources: [{ id: 'document', title: 'Captured source', kind: 'text', content, sha256: sourceHash, capturedAt: '2026-10-30T00:00:00.000Z' }],
      claims: [{ id: 'pending', text: 'Result', source: 'Captured source', evidence }, { id: 'reviewed', text: 'Reviewed result', source: 'Captured source', evidence, status: 'verified', reviewedAt: '2026-10-30T01:00:00.000Z' }, { id: 'legacy', text: 'Old statement', source: 'Old book', locator: 'p. 12', status: 'verified' }],
      shots: [{ id: 'video', title: 'Video', narration: '', visualPrompt: '', durationUs: 1_000_000, sourceInUs: 0, videoAssetId: 'video', audioAssetId: 'voice', claimIds: ['pending'], captionTrack: { timeBase: 'scene', alignment: 'manual', cues: [{ id: 'voice-caption', startUs: 0, endUs: 1_000_000, text: 'Voice caption' }] }, animation: { transition: 'cut' } },
        { id: 'template', title: 'Diagram', narration: '', visualPrompt: '', durationUs: 1_000_000, sceneTemplate: { ...createSceneTemplate('bar-chart'), motion: 'none' }, claimIds: ['reviewed'], animation: { transition: 'cut' } },
        { id: 'sample', title: 'Sample', narration: '', visualPrompt: '', durationUs: 1_000_000, claimIds: ['legacy'], animation: { transition: 'cut' } },
        { id: 'uncited', title: ' ', narration: '', visualPrompt: '', durationUs: 1_000_000, sourceInUs: 0, videoAssetId: 'video', audioAssetId: 'voice', claimIds: [], captionTrack: { timeBase: 'scene', alignment: 'manual', cues: [{ id: 'long-uncited', startUs: 0, endUs: 1_000_000, text: 'Uncited pictures use the same reading pages and caption area as cited pictures in this project. '.repeat(4).trim() }] }, animation: { transition: 'cut' } }],
    });
    const output = await renderProject({ project, assets, outputDirectory, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
    const metadata = await probeMedia(output.videoPath, ffprobe);
    expect(metadata).toMatchObject({ width, height, frameRate: '30/1' }); expect(metadata.videoDuration).toBeCloseTo(4, 1);
    const aspect = JSON.parse(await runMedia(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=sample_aspect_ratio', '-of', 'json', output.videoPath]));
    expect(aspect.streams[0].sample_aspect_ratio).toBe('1:1');
    const timeline = JSON.parse(await readFile(output.timelinePath, 'utf8'));
    expect(timeline.citations).toMatchObject({ version: 1, display: 'numbers', references: [{ claimId: 'pending', number: 1, status: 'pending', evidenceState: 'valid', evidence: [{ sourceSha256: sourceHash, quote, startOffset, source: { title: 'Captured source', sha256: sourceHash } }] }, { claimId: 'reviewed', status: 'verified', evidenceState: 'valid' }, { claimId: 'legacy', status: 'verified', evidenceState: 'missing', issues: ['无证据摘录'] }] });
    expect(JSON.stringify(timeline)).not.toContain('Do not export this entire private source'); expect(JSON.stringify(timeline)).not.toContain('"content"');
    expect(timeline.citations.shots.map((value: { startUs: number; endUs: number }) => [value.startUs, value.endUs])).toEqual([[0, 1_000_000], [1_000_000, 2_000_000], [2_000_000, 3_000_000], [3_000_000, 4_000_000]]);
    expect(output.warnings.join('\n')).toContain('无证据摘录'); expect(output.warnings.join('\n')).toContain('待核验');
    const srt = await readFile(output.subtitlePath, 'utf8'); expect(srt).toContain('Voice caption'); expect(srt).not.toContain('资料'); expect(srt).not.toContain(quote);
    const measure = createCanvas(width, height).getContext('2d'), geometry = captionGeometry(width, height, true);
    const expected = createTimedSrt(project.shots, text => { measure.font = `500 ${geometry.fontSize}px ${captionFontFamily('sans')}`; return captionPages(text, line => measure.measureText(line).width, width * .78, geometry.lines); });
    expect(srt).toBe(expected);
    const uncited = await pixels(output.videoPath, '3.3', `${fitMode}-uncited`); let lastCaptionRow = -1;
    for (let pixel = 0; pixel < width * height; pixel++) if (uncited[pixel * 3] < 160 && uncited[pixel * 3 + 1] < 160 && uncited[pixel * 3 + 2] < 160) lastCaptionRow = Math.floor(pixel / width);
    expect(lastCaptionRow).toBeGreaterThan(height * .5); expect(lastCaptionRow).toBeLessThan(citationFooterTop(width, height)); expect(lastCaptionRow).toBeLessThanOrEqual(Math.ceil(geometry.bottom) + 1);
    const visible = await pixels(output.videoPath, '0.3', `${fitMode}-visible`);
    expect(footerPixels(visible, width, height)).toBeGreaterThan(100);
    // The other branches have no narration; their footer must be part of the encoded picture itself.
    for (const [time, name] of [['1.3', 'template'], ['2.3', 'sample']]) {
      const values = await pixels(output.videoPath, time, `${fitMode}-${name}`); let dark = 0;
      for (let offset = width * Math.ceil(height * .935) * 3; offset < width * Math.floor(height * .99) * 3; offset += 3) if (values[offset] < 120 && values[offset + 1] < 120 && values[offset + 2] < 120) dark++;
      expect(dark).toBeGreaterThan(100);
    }
    if (fitMode === 'contain') {
      const firstSegments = (await readdir(outputDirectory)).filter(name => /^segment-.*\.mp4$/.test(name));
      const originalTimes = await Promise.all(firstSegments.map(name => stat(join(outputDirectory, name)).then(value => value.mtimeMs)));
      const hidden = await renderProject({ project: { ...project, referenceDisplay: 'hidden' }, assets, outputDirectory, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
      expect(footerPixels(await pixels(hidden.videoPath, '0.3', 'hidden'), width, height)).toBeLessThan(10);
      const hiddenTimeline = JSON.parse(await readFile(hidden.timelinePath, 'utf8')); expect(hiddenTimeline.citations.references).toHaveLength(3); expect(hiddenTimeline.citations.display).toBe('hidden');
      await renderProject({ project: { ...project, claims: project.claims.map(claim => claim.id === 'pending' ? { ...claim, status: 'verified', reviewedAt: '2026-10-30T02:00:00.000Z' } : claim) }, assets, outputDirectory, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
      expect((await readdir(outputDirectory)).filter(name => /^segment-.*\.mp4$/.test(name))).toHaveLength(9);
      expect(await Promise.all(firstSegments.map(name => stat(join(outputDirectory, name)).then(value => value.mtimeMs)))).toEqual(originalTimes);
      const pcmPath = join(directory, 'voice.pcm');
      await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.2', '-i', output.videoPath, '-t', '0.4', '-ac', '1', '-ar', '8000', '-f', 's16le', pcmPath]);
      const pcm = await readFile(pcmPath); let crossings = 0;
      for (let offset = 2; offset < pcm.length; offset += 2) if (pcm.readInt16LE(offset - 2) <= 0 && pcm.readInt16LE(offset) > 0) crossings++;
      expect(crossings / (pcm.length / 2 / 8000)).toBeGreaterThan(800);
      await expect(renderProject({ project: { ...project, researchSources: project.researchSources?.map(source => ({ ...source, content: source.content + ' changed' })) }, assets, outputDirectory, ffmpegPath: ffmpeg, ffprobePath: ffprobe })).rejects.toThrow('正文校验失败');
    }
    expect((await readdir(outputDirectory)).some(name => name.endsWith('.references.png'))).toBe(false);
  }
}, 120_000);
