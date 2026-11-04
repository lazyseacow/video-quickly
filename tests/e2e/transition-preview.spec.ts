import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type CDPSession, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createSceneTemplate, DEFAULT_AUDIO_PROCESSING, DEFAULT_CAPTION_STYLE, firstFrameAtUs, timeAtFrame, type AssetRecord, type FrameRate, type ProjectDocument, type Shot } from '@video-quickly/contracts';
import { coloredCaptionPixels, decodeTransitionFrames, transitionPixels, transitionPoints, writeTransitionImage, writeTransitionVideo, type PixelPoint, type Rgb } from '../fixtures/transition-media';
import { openProjectFromList } from './workspace-navigation';

type Transition = 'cut' | 'fade' | 'wipe';
type PaintedFrame = { frame: number; timeUs: number; pixels: Rgb[]; transition: string | undefined; visible?: boolean; busy?: boolean };
const rates = [{ label: '30', value: { numerator: 30, denominator: 1 }, boundaryUs: 1_000_000 }, { label: '60', value: { numerator: 60, denominator: 1 }, boundaryUs: 1_000_000 }, { label: '30000-1001', value: { numerator: 30000, denominator: 1001 }, boundaryUs: 1_017_000 }];
const stillAnimation = { zoom: 1, panX: 0, panY: 0, transition: 'cut' as const };
const silentVideo = { ...DEFAULT_AUDIO_PROCESSING, version: 2 as const, videoAudio: { enabled: false, gainDb: 0 } };

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok(), JSON.stringify(payload.error)).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

async function fixture(request: APIRequestContext, info: TestInfo, options: { transition?: Transition; rate?: FrameRate; boundaryUs?: number; captions?: boolean; video?: boolean; animatedVideo?: boolean; mixed?: boolean } = {}) {
  const width = options.captions || options.mixed ? 640 : 320, height = width * 9 / 16;
  const rate = options.rate ?? rates[0].value, durationUs = options.boundaryUs ?? 1_000_000;
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `转场预览 ${randomUUID().slice(0, 8)}` });
  const paths = ['previous', 'incoming'].map(name => info.outputPath(`${name}.png`));
  await writeTransitionImage(paths[0], options.captions ? '101820' : 'e02020', width, height);
  await writeTransitionImage(paths[1], options.captions ? '202030' : '2030e0', width, height);
  const images: AssetRecord[] = [];
  for (const path of paths) images.push(await rpc<AssetRecord>(request, 'asset.import', { projectId: created.id, path, kind: 'image' }));
  let video: AssetRecord | undefined;
  if (options.video || options.mixed) {
    const path = info.outputPath('green-last-red-following-blue.mp4'); await writeTransitionVideo(path, options.animatedVideo);
    video = await rpc<AssetRecord>(request, 'asset.import', { projectId: created.id, path, kind: 'video' });
  }
  const shot = (index: number, transition: Transition): Partial<Shot> & { id: string; title: string; durationUs: number } => ({
    id: `transition-${index}`, title: `转场镜头 ${index}`, narration: '', visualPrompt: '', durationUs: index === 1 ? durationUs : 1_000_000,
    assetId: images[index === 1 ? 0 : 1].id, animation: { ...stillAnimation, transition },
    ...(options.captions ? { captionStyle: { ...DEFAULT_CAPTION_STYLE, textColor: index === 1 ? '#ff0000' : '#00ff00', backgroundOpacity: 0, fontSizeRatio: .09, fontWeight: 700 }, captionTrack: { timeBase: 'clip' as const, alignment: 'manual' as const, cues: [{ id: `cue-${index}`, text: index === 1 ? 'OUTGOING' : 'INCOMING', startUs: 0, endUs: index === 1 ? durationUs : 1_000_000 }] } } : {}),
  });
  let shots = [shot(1, 'cut'), shot(2, options.transition ?? 'fade')];
  if (options.video) shots = [1, 2, 3, 4].map(index => ({ ...shot(index === 1 ? 1 : 2, index === 1 ? 'cut' : options.transition ?? 'fade'), id: `shared-video-${index}`, title: `同源视频 ${index}`, assetId: undefined, videoAssetId: video!.id, videoInUs: 0, audioProcessing: silentVideo }));
  if (options.mixed) shots = [shot(1, 'cut'), { ...shot(2, 'fade'), id: 'template', title: '流程图', assetId: undefined, sceneTemplate: { ...createSceneTemplate('process'), motion: 'none' } }, { ...shot(2, 'wipe'), id: 'video', title: '真实视频', assetId: undefined, videoAssetId: video!.id, videoInUs: 0, audioProcessing: silentVideo }, { ...shot(2, 'fade'), id: 'last-image', title: '结束图片' }];
  const current = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: created.id })).project;
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: current.id, revision: current.revision, patch: { profile: { ...current.profile, width, height, frameRate: rate, previewScale: 1 }, workflow: { ...current.workflow, production: { ...current.workflow.production, subtitleMode: options.captions ? 'script' : 'off' } }, shots } });
  return { project, width, height, images, video, current: async () => (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project };
}

async function open(page: Page, project: ProjectDocument) {
  await page.addInitScript(() => localStorage.setItem('vq-preview-scale', '1'));
  await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await openProjectFromList(page, project.title);
  const canvas = page.locator('.preview-frame canvas[role="img"]');
  await expect(canvas).toHaveCount(1); await expect(canvas).toBeVisible();
  await expect(canvas).toHaveJSProperty('width', project.profile.width); await expect(canvas).toHaveJSProperty('height', project.profile.height);
  await expect(page.locator('.preview-frame .scene-preview')).toHaveAttribute('aria-busy', 'false');
  await expect(canvas).toHaveAttribute('data-rendered-frame', '0'); return canvas;
}

async function seek(page: Page, canvas: Locator, frame: number) {
  const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true }); await ruler.press('Home');
  for (let index = 0; index < Math.floor(frame / 10); index++) await ruler.press('Shift+ArrowRight');
  for (let index = 0; index < frame % 10; index++) await ruler.press('ArrowRight');
  await expect(canvas).toHaveAttribute('data-rendered-frame', String(frame));
  await expect(page.locator('.preview-frame .scene-preview')).toHaveAttribute('aria-busy', 'false');
}

async function paint(canvas: Locator, points: readonly PixelPoint[]): Promise<PaintedFrame> {
  return canvas.evaluate((element: HTMLCanvasElement, points) => ({ frame: Number(element.dataset.renderedFrame), timeUs: Number(element.dataset.renderedTimeUs), transition: element.dataset.transition, pixels: points.map(({ x, y }) => [...element.getContext('2d')!.getImageData(x, y, 1, 1).data].slice(0, 3) as Rgb) }), [...points]);
}

function difference(actual: readonly Rgb[], expected: readonly Rgb[]) {
  return Math.max(...actual.flatMap((pixel, index) => pixel.map((channel, channelIndex) => Math.abs(channel - expected[index][channelIndex]))));
}

async function exportFrames(request: APIRequestContext, source: Awaited<ReturnType<typeof fixture>>, frames: number[], info: TestInfo) {
  const { runId } = await rpc<{ runId: string }>(request, 'render.export', { projectId: source.project.id, destination: info.outputPath('actual-export.mp4') });
  let run: { status: string; error?: string } = { status: 'queued' };
  await expect.poll(async () => { run = await rpc(request, 'run.get', { runId }); return ['succeeded', 'failed', 'canceled', 'needs_attention'].includes(run.status); }, { timeout: 45_000 }).toBe(true);
  expect(run.status, run.error).toBe('succeeded');
  const result = await rpc<{ videoPath: string }>(request, 'node.result', { runId, nodeId: 'export' });
  return decodeTransitionFrames(result.videoPath, frames, source.width, source.height);
}

async function expectFrame(canvas: Locator, frame: number, points: readonly PixelPoint[], expected: readonly Rgb[], evidence: unknown[]) {
  await expect.poll(async () => difference((await paint(canvas, points)).pixels, expected), { message: `Rendered frame ${frame} must match the actual FFmpeg export.` }).toBeLessThanOrEqual(12);
  const rendered = await paint(canvas, points); expect(rendered.frame).toBe(frame); evidence.push({ ...rendered, expected, maximumChannelDifference: difference(rendered.pixels, expected) });
}

function observe(page: Page) { const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); }); return errors; }
async function healthy(page: Page, errors: string[]) { await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]); }

for (const transition of ['fade', 'wipe'] as const) test(`paints only the current caption once over the ${transition} composite`, async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const errors = observe(page), source = await fixture(request, info, { transition, captions: true }), frames = [29, 30, 31, 33, 35, 36, 40];
  const reference = await exportFrames(request, source, frames, info), canvas = await open(page, source.project);
  const captured: unknown[] = [];
  await seek(page, canvas, 40);
  const baseline = await canvas.evaluate((element: HTMLCanvasElement) => ({ bytes: [...element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data], width: element.width, height: element.height }));
  const greenBaseline = coloredCaptionPixels(baseline.bytes, baseline.width, baseline.height, 4).green; expect(greenBaseline).toBeGreaterThan(20);
  for (const frame of frames) {
    await seek(page, canvas, frame);
    const data = await canvas.evaluate((element: HTMLCanvasElement) => ({ bytes: [...element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data], width: element.width, height: element.height }));
    const actual = coloredCaptionPixels(data.bytes, data.width, data.height, 4), exported = coloredCaptionPixels(reference.get(frame)!, source.width, source.height, 3);
    if (frame < 30) { expect(actual.red).toBeGreaterThan(20); expect(actual.green).toBe(0); expect(exported.red).toBeGreaterThan(20); }
    else { expect(actual.red).toBe(0); expect(actual.green).toBeGreaterThanOrEqual(greenBaseline * .9); expect(exported.red).toBe(0); expect(exported.green).toBeGreaterThan(20); }
    captured.push({ frame, actual, exported, greenBaseline });
  }
  await seek(page, canvas, 33); await page.screenshot({ path: info.outputPath(`${transition}-single-current-caption.png`) });
  await info.attach('caption-composite-observations', { body: JSON.stringify(captured), contentType: 'application/json' }); expect(await source.current()).toEqual(source.project); await healthy(page, errors);
});

for (const rate of rates) for (const transition of ['cut', 'fade', 'wipe'] as const) test(`matches actual ${transition} export pixels before, during and after the boundary at ${rate.label}fps`, async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const errors = observe(page), source = await fixture(request, info, { rate: rate.value, boundaryUs: rate.boundaryUs, transition });
  const boundary = firstFrameAtUs(rate.boundaryUs, rate.value), end = firstFrameAtUs(timeAtFrame(boundary, rate.value) + 200_000, rate.value);
  const frames = [...new Set([boundary - 1, boundary, boundary + 1, Math.floor((boundary + end) / 2), end - 1, end, end + 1])];
  const reference = await exportFrames(request, source, frames, info), canvas = await open(page, source.project), points = transitionPoints(source.width, source.height), captured: unknown[] = [];
  for (const frame of [...frames, ...frames.toReversed()]) { await seek(page, canvas, frame); await expectFrame(canvas, frame, points, transitionPixels(reference.get(frame)!, source.width, points), captured); }
  await seek(page, canvas, Math.floor((boundary + end) / 2)); expect(await canvas.getAttribute('data-transition')).toBe(transition);
  await page.screenshot({ path: info.outputPath(`${transition}-${rate.label}-midpoint.png`) });
  await info.attach('transition-export-pixel-comparison', { body: JSON.stringify({ rate, transition, boundary, end, points, captured }), contentType: 'application/json' }); expect(await source.current()).toEqual(source.project); await healthy(page, errors);
});

test('composites an image, a scene template and a real video using the actual exported frames', async ({ page, request }, info) => {
  test.setTimeout(90_000);
  const errors = observe(page), source = await fixture(request, info, { mixed: true }), frames = [29, 30, 33, 36, 59, 60, 63, 66, 89, 90, 93, 96];
  const reference = await exportFrames(request, source, frames, info), canvas = await open(page, source.project), points = [.02, .98].flatMap(y => [.02, .98].map(x => ({ x: Math.floor(source.width * x), y: Math.floor(source.height * y) }))), captured: unknown[] = [];
  for (const frame of frames) { await seek(page, canvas, frame); await expectFrame(canvas, frame, points, transitionPixels(reference.get(frame)!, source.width, points), captured); }
  await info.attach('mixed-source-transition-pixels', { body: JSON.stringify({ points, captured }), contentType: 'application/json' }); await page.screenshot({ path: info.outputPath('mixed-source-video-transition.png') }); expect(await source.current()).toEqual(source.project); await healthy(page, errors);
});

async function sourcedVideos(session: CDPSession, sourcePath: string) {
  const group = 'transition-resource-check';
  const prototype = await session.send('Runtime.evaluate', { expression: 'HTMLVideoElement.prototype', objectGroup: group });
  const objects = await session.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: group });
  try {
    const result = await session.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId, arguments: [{ value: sourcePath }], returnByValue: true, functionDeclaration: `function (path) { return this.filter(video => { if (!video.getAttribute('src')) return false; try { return new URL(video.src).searchParams.get('path') === path; } catch { return false; } }).map(video => ({ time: video.currentTime, paused: video.paused, ready: video.readyState })); }` });
    return result.result.value as Array<{ time: number; paused: boolean; ready: number }>;
  } finally { await session.send('Runtime.releaseObjectGroup', { objectGroup: group }); }
}

test('freezes the outgoing last video frame, isolates a reused source and releases it after repeated seeks', async ({ page, request }, info) => {
  test.setTimeout(90_000);
  const errors = observe(page), source = await fixture(request, info, { video: true });
  const frames = [29, 30, 31, 33, 36, 40, 59, 60, 63, 66, 70, 89, 90, 93, 96, 100], reference = await exportFrames(request, source, frames, info), canvas = await open(page, source.project), points = transitionPoints(source.width, source.height), captured: unknown[] = [];
  const session = await page.context().newCDPSession(page); let maximumLive = 0;
  try {
    for (const frame of [...frames, 33, 29, 33, 30, 40, 93, 63, 100]) {
      await seek(page, canvas, frame); await expectFrame(canvas, frame, points, transitionPixels(reference.get(frame)!, source.width, points), captured);
      maximumLive = Math.max(maximumLive, (await sourcedVideos(session, source.video!.path)).length);
    }
    expect(maximumLive).toBeLessThanOrEqual(4);
    const held = transitionPixels(reference.get(30)!, source.width, points)[0]; expect(held[0]).toBeGreaterThan(200); expect(held[2]).toBeLessThan(60);
    const control = await rpc<ProjectDocument>(request, 'project.create', { title: `转场资源释放对照 ${randomUUID().slice(0, 8)}` });
    await openProjectFromList(page, control.title);
    await expect.poll(async () => (await sourcedVideos(session, source.video!.path)).length).toBe(0);
    await info.attach('same-source-video-transition-resources', { body: JSON.stringify({ maximumLive, captured, afterRelease: await sourcedVideos(session, source.video!.path) }), contentType: 'application/json' });
  } finally { await session.detach(); }
  expect(await source.current()).toEqual(source.project); await healthy(page, errors);
});

for (const scenario of [{ label: 'image fade', transition: 'fade', video: false }, { label: 'changing-video fade', transition: 'fade', video: true }, { label: 'changing-video wipe', transition: 'wipe', video: true }] as const) test(`presents export-matching composite frames continuously while crossing a ${scenario.label}`, async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const errors = observe(page), source = await fixture(request, info, { transition: scenario.transition, video: scenario.video, animatedVideo: scenario.video }), frames = Array.from({ length: 31 }, (_, index) => 23 + index), reference = await exportFrames(request, source, frames, info), canvas = await open(page, source.project), points = transitionPoints(source.width, source.height);
  await seek(page, canvas, 23); await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeEnabled();
  const observations = await canvas.evaluateHandle((element: HTMLCanvasElement, points) => {
    const state = { active: true, raf: 0, samples: [] as PaintedFrame[] };
    function observe() {
      if (!state.active) return;
      const frame = Number(element.dataset.renderedFrame);
      const style = getComputedStyle(element), bounds = element.getBoundingClientRect(), status = element.closest('.scene-preview')?.querySelector<HTMLElement>('[role="status"]'), statusBounds = status?.getBoundingClientRect(), statusStyle = status && getComputedStyle(status);
      const alpha = statusStyle?.backgroundColor.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/)?.[1];
      const occluded = Boolean(statusBounds && statusBounds.width >= bounds.width * .95 && statusBounds.height >= bounds.height * .95 && statusStyle?.backgroundColor !== 'transparent' && Number(alpha ?? 1) * Number(statusStyle?.opacity ?? 1) >= .95);
      const visible = style.visibility !== 'hidden' && style.display !== 'none' && bounds.width > 0 && !occluded, busy = element.closest('.scene-preview')?.getAttribute('aria-busy') === 'true';
      if (state.samples.at(-1)?.frame !== frame || state.samples.at(-1)?.visible !== visible || state.samples.at(-1)?.busy !== busy) state.samples.push({ frame, timeUs: Number(element.dataset.renderedTimeUs), transition: element.dataset.transition, visible, busy, pixels: points.map(({ x, y }) => [...element.getContext('2d')!.getImageData(x, y, 1, 1).data].slice(0, 3) as Rgb) });
      state.raf = requestAnimationFrame(observe);
    }
    state.raf = requestAnimationFrame(observe); return state;
  }, points);
  try {
    await page.getByRole('button', { name: '播放预览', exact: true }).click();
    await expect.poll(() => observations.evaluate(value => value.samples.at(-1)?.frame ?? 0)).toBeGreaterThanOrEqual(45);
    await page.getByRole('button', { name: '暂停预览', exact: true }).click();
    const samples = await observations.evaluate(value => { value.active = false; cancelAnimationFrame(value.raf); return value.samples; });
    const visibleTransitionFrames = new Set(samples.filter(sample => sample.frame >= 30 && sample.frame < 36 && sample.visible).map(sample => sample.frame));
    expect(visibleTransitionFrames.size, 'The transition must actually be visible, rather than read back from a hidden canvas.').toBeGreaterThanOrEqual(2);
    expect(samples.filter(sample => sample.frame >= 29 && sample.frame <= 36 && !sample.visible), 'Do not replace an already displayed picture with a full loading screen.').toEqual([]);
    const transitionSamples = samples.filter(sample => sample.frame >= 30 && sample.frame <= 36);
    for (const sample of samples.filter(sample => reference.has(sample.frame) && (!scenario.video || transitionSamples.includes(sample)))) expect(difference(sample.pixels, transitionPixels(reference.get(sample.frame)!, source.width, points)), `Playing frame ${sample.frame}`).toBeLessThanOrEqual(12);
    await info.attach('continuous-transition-paints', { body: JSON.stringify({ samples, points }), contentType: 'application/json' });
  } finally { await observations.evaluate(value => { value.active = false; cancelAnimationFrame(value.raf); }); await observations.dispose(); }
  expect(await source.current()).toEqual(source.project); await healthy(page, errors);
});
