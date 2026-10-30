import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { DEFAULT_AUDIO_MIX_SETTINGS, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';
import { deleteShotRanges } from '../../packages/video/src/clip-edits';

const execute = promisify(execFile);
type Color = 'green' | 'red' | 'blue' | 'other';
interface PaintSample { wallMs: number; uiMs: number; audioMs: number; paused: boolean; color: Color; rgb: number[] }

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

function color(rgb: readonly number[]): Color {
  return rgb[1] > 160 && rgb[0] < 80 && rgb[2] < 80 ? 'green' : rgb[0] > 160 && rgb[1] < 80 && rgb[2] < 80 ? 'red' : rgb[2] > 160 && rgb[0] < 80 && rgb[1] < 80 ? 'blue' : 'other';
}

async function fixture(request: APIRequestContext, info: TestInfo, sourceFps = 30) {
  const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', videoPath = info.outputPath(`green-red-blue-${sourceFps}fps.mp4`), voicePath = info.outputPath('voice.wav');
  const redFrame = sourceFps / 2;
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x00ff00:s=320x180:r=${sourceFps}:d=1`, '-vf', `drawbox=x=0:y=0:w=iw:h=ih:color=0xff0000:t=fill:enable='eq(n,${redFrame})',drawbox=x=0:y=0:w=iw:h=ih:color=0x0000ff:t=fill:enable='gte(n,${redFrame + 1})'`, '-frames:v', String(sourceFps), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-g', '1', '-bf', '0', '-pix_fmt', 'yuv420p', videoPath]);
  const decoded = await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', videoPath, '-vf', `select='between(n,${redFrame - 1},${redFrame + 1})',scale=1:1`, '-frames:v', '3', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
  const pixels = Buffer.from(decoded.stdout);
  expect(pixels).toHaveLength(9); expect([0, 3, 6].map(offset => color([...pixels.subarray(offset, offset + 3)]))).toEqual(['green', 'red', 'blue']);
  await info.attach('source-colors-around-deletion.json', { body: JSON.stringify({ sourceFps, firstFrame: redFrame - 1, pixels: [...pixels] }), contentType: 'application/json' });
  const rate = 48_000, data = Buffer.alloc(44 + rate * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(rate * 2, 40);
  for (let sample = 0; sample < rate; sample++) data.writeInt16LE(Math.round(Math.sin(sample * Math.PI * 2 * 880 / rate) * 6000), 44 + sample * 2);
  await writeFile(voicePath, data);
  let project = await rpc<ProjectDocument>(request, 'project.create', { title: `一帧视频跳切与真实混音验收 ${sourceFps}fps ${randomUUID().slice(0, 8)}` });
  const video = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path: videoPath, kind: 'video' });
  const voice = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path: voicePath, kind: 'audio' });
  project = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { profile: { ...project.profile, width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, previewScale: 1 }, audioMix: { ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, enabled: false } }, shots: [{ id: 'short-cut', title: '删除红色一帧', narration: '', visualPrompt: '', durationUs: 1_000_000, sourceInUs: 0, audioInUs: 0, videoInUs: 0, sceneInUs: 0, sceneDurationUs: 1_000_000, audioAssetId: voice.id, videoAssetId: video.id, animation: { panX: 0, panY: 0, zoom: 1, transition: 'cut' }, captionTrack: { timeBase: 'source', alignment: 'manual', cues: [] } }] } });
  const edited = deleteShotRanges(project, 'short-cut', [{ startUs: 500_000, endUs: 533_333 }], project.profile.frameRate, [video, voice], () => randomUUID());
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: edited.shots, clipEditSources: edited.clipEditSources, clipEditPlans: edited.clipEditPlans } });
  expect(project.shots[0].durationUs).toBe(966_667); expect(project.clipEditPlans![0].spans.map(span => [span.durationUs, span.videoInUs])).toEqual([[500_000, 0], [466_667, 533_333]]);
  return { project, voice };
}

async function exportBoundaryColors(request: APIRequestContext, project: ProjectDocument, info: TestInfo): Promise<Color[]> {
  const { runId } = await rpc<{ runId: string }>(request, 'render.export', { projectId: project.id, destination: info.outputPath('rendered.mp4') });
  let run: { status: string; error?: string } = { status: 'queued' };
  await expect.poll(async () => { run = await rpc(request, 'run.get', { runId }); return ['succeeded', 'failed', 'cancelled'].includes(run.status); }, { timeout: 40_000 }).toBe(true);
  expect(run.status, run.error).toBe('succeeded');
  const result = await rpc<{ videoPath: string }>(request, 'node.result', { runId, nodeId: 'export' });
  const decoded = await execute(process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', result.videoPath, '-vf', "select='between(n,14,16)',scale=1:1", '-frames:v', '3', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
  const pixels = Buffer.from(decoded.stdout); expect(pixels).toHaveLength(9);
  const colors = [0, 3, 6].map(offset => color([...pixels.subarray(offset, offset + 3)]));
  await info.attach('actual-export-frame-14-15-16.json', { body: JSON.stringify({ path: result.videoPath, colors, pixels: [...pixels] }), contentType: 'application/json' });
  return colors;
}

async function seek(page: Page, frame: number) {
  const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true }); await ruler.press('Home');
  for (let index = 0; index < Math.floor(frame / 10); index++) await ruler.press('Shift+ArrowRight');
  for (let index = 0; index < frame % 10; index++) await ruler.press('ArrowRight');
  await expect(ruler).toHaveAttribute('aria-valuenow', String(Math.round(frame * 1000 / 30)));
}

test('never paints a deleted one-frame video gap during real playback or scrubbing while the mixed WAV follows program time', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const { project, voice } = await fixture(request, info);
  await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('删除红色一帧');
  await expect(page.locator('.preview-panel .prepared-mix-preview')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeEnabled();
  const canvas = page.locator('.preview-frame canvas'), audio = page.locator('.preview-panel audio[data-audio-role="处理后混音"]');
  await expect(audio).toHaveCount(1);
  expect(await audio.evaluate((element: HTMLAudioElement) => new URL(element.src).searchParams.get('path'))).not.toBe(voice.path);
  expect(await audio.evaluate((element: HTMLAudioElement) => element.duration)).toBeCloseTo(966_667 / 1_000_000, 3);
  const pixel = () => canvas.evaluate((element: HTMLCanvasElement) => [...element.getContext('2d')!.getImageData(Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1).data].slice(0, 3));
  await expect.poll(async () => color(await pixel())).toBe('green');
  await seek(page, 14); await expect.poll(async () => color(await pixel())).toBe('green');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeCloseTo(14 / 30, 2);
  await seek(page, 15); await expect.poll(async () => color(await pixel())).toBe('blue');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeCloseTo(.5, 2);
  await page.screenshot({ path: info.outputPath('short-gap-scrub-blue.png') });
  await seek(page, 0); await expect.poll(async () => color(await pixel())).toBe('green');
  const capture = await canvas.evaluateHandle((element: HTMLCanvasElement) => {
    const startedAt = performance.now(), state = { samples: [] as PaintSample[], redImage: '', active: true, request: 0 };
    function sample() {
      if (!state.active) return;
      const rgb = [...element.getContext('2d')!.getImageData(Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1).data].slice(0, 3);
      const color: Color = rgb[1] > 160 && rgb[0] < 80 && rgb[2] < 80 ? 'green' : rgb[0] > 160 && rgb[1] < 80 && rgb[2] < 80 ? 'red' : rgb[2] > 160 && rgb[0] < 80 && rgb[1] < 80 ? 'blue' : 'other';
      const audio = document.querySelector<HTMLAudioElement>('.preview-panel audio[data-audio-role="处理后混音"]');
      const ruler = document.querySelector<HTMLElement>('[role="slider"][aria-label="预览播放位置"]');
      state.samples.push({ wallMs: performance.now() - startedAt, color, rgb, uiMs: Number(ruler?.getAttribute('aria-valuenow')), audioMs: (audio?.currentTime ?? 0) * 1000, paused: audio?.paused ?? true });
      if (color === 'red' && !state.redImage) state.redImage = element.toDataURL('image/png');
      state.request = requestAnimationFrame(sample);
    }
    state.request = requestAnimationFrame(sample);
    return { state, stop() { state.active = false; cancelAnimationFrame(state.request); } };
  });
  let paints: PaintSample[] = [];
  try {
    await page.getByRole('button', { name: '播放预览', exact: true }).click(); await expect(page.getByRole('button', { name: '暂停预览', exact: true })).toBeVisible();
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(.05);
    await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeVisible({ timeout: 5000 });
  } finally {
    const captured = await capture.evaluate(value => { value.stop(); return value.state; }); paints = captured.samples;
    await info.attach('actual-canvas-and-mixed-audio-clock.json', { body: JSON.stringify(paints, null, 2), contentType: 'application/json' });
    if (captured.redImage) await info.attach('deleted-red-frame-painted.png', { body: Buffer.from(captured.redImage.split(',')[1], 'base64'), contentType: 'image/png' });
    await capture.dispose();
  }
  expect(paints.length).toBeGreaterThanOrEqual(20);
  expect(paints.filter(value => value.color === 'green').length).toBeGreaterThanOrEqual(3); expect(paints.filter(value => value.color === 'blue').length).toBeGreaterThanOrEqual(3);
  expect(paints.filter(value => value.color === 'red'), 'A deleted source frame reached the production Canvas').toEqual([]);
  const transitions = paints.map(value => value.color).filter((value, index, values) => !index || value !== values[index - 1]);
  expect(transitions).toEqual(['green', 'blue']);
  const playing = paints.filter(value => !value.paused && value.uiMs >= 100 && value.uiMs <= 800); expect(playing.length).toBeGreaterThanOrEqual(8);
  expect(Math.max(...playing.map(value => Math.abs(value.uiMs - value.audioMs)))).toBeLessThan(120);
  await expect.poll(async () => color(await pixel())).toBe('blue'); await page.screenshot({ path: info.outputPath('short-gap-playback-blue.png') });
  expect(await exportBoundaryColors(request, project, info)).toEqual(['green', 'blue', 'blue']);
  expect(errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

test('uses the containing native frame for a 24-to-30fps EDL start and matches actual export sampling', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { project } = await fixture(request, info, 24);
  await page.goto('/'); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await expect(page.locator('.preview-panel .prepared-mix-preview')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  const canvas = page.locator('.preview-frame canvas');
  const pixel = () => canvas.evaluate((element: HTMLCanvasElement) => [...element.getContext('2d')!.getImageData(element.width / 2, element.height / 2, 1, 1).data].slice(0, 3));
  const scrubbed: Color[] = [];
  // Source 533333us lies inside native frame 12 [500000,541667), so its
  // surviving tail is red; rejecting its earlier PTS would freeze the preview.
  for (const [frame, expected] of [[14, 'green'], [15, 'red'], [16, 'blue']] as const) {
    await seek(page, frame); await expect.poll(async () => color(await pixel())).toBe(expected); scrubbed.push(color(await pixel()));
  }
  expect(await exportBoundaryColors(request, project, info)).toEqual(scrubbed);
  await seek(page, 0); await expect.poll(async () => color(await pixel())).toBe('green');
  await page.getByRole('button', { name: '播放预览', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停预览', exact: true })).toBeVisible();
  await expect.poll(async () => color(await pixel())).toBe('blue');
  await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('24-to-30-boundary-playback.png') });
  expect(errors).toEqual([]);
});

test('keeps EDL playback advancing across the short gap without decoded-frame callbacks', async ({ page, request }, info) => {
  await page.addInitScript(() => { Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', { value: undefined }); });
  const { project } = await fixture(request, info);
  await page.goto('/'); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await expect(page.locator('.preview-panel .prepared-mix-preview')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  const canvas = page.locator('.preview-frame canvas');
  const pixel = () => canvas.evaluate((element: HTMLCanvasElement) => [...element.getContext('2d')!.getImageData(element.width / 2, element.height / 2, 1, 1).data].slice(0, 3));
  await expect.poll(async () => color(await pixel())).toBe('green');
  const samples = await canvas.evaluateHandle((element: HTMLCanvasElement) => {
    const state = { colors: [] as Color[], active: true, request: 0 };
    function sample() {
      if (!state.active) return;
      const [r, g, b] = element.getContext('2d')!.getImageData(element.width / 2, element.height / 2, 1, 1).data;
      state.colors.push(g > 160 && r < 80 && b < 80 ? 'green' : r > 160 && g < 80 && b < 80 ? 'red' : b > 160 && r < 80 && g < 80 ? 'blue' : 'other');
      state.request = requestAnimationFrame(sample);
    }
    state.request = requestAnimationFrame(sample);
    return { state, stop() { state.active = false; cancelAnimationFrame(state.request); } };
  });
  await page.getByRole('button', { name: '播放预览', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停预览', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeVisible({ timeout: 5000 });
  // The clock stops before an asynchronous accurate seek necessarily paints its final frame.
  await expect.poll(async () => color(await pixel())).toBe('blue');
  const colors = await samples.evaluate(value => { value.stop(); return value.state.colors; }); await samples.dispose();
  expect(colors.filter((value, index) => !index || value !== colors[index - 1])).toEqual(['green', 'blue']);
  await info.attach('fallback-canvas-colors.json', { body: JSON.stringify(colors), contentType: 'application/json' });
});
