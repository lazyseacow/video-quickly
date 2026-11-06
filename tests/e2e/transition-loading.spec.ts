import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { DEFAULT_AUDIO_MIX_SETTINGS, DEFAULT_AUDIO_PROCESSING, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';
import { decodeTransitionFrames, transitionPixels, writeColdTransitionVideo, type PixelPoint, type Rgb } from '../fixtures/transition-media';
import { openProjectFromList } from './workspace-navigation';

// Compare the changing colour interiors; the moving test pattern remains visible
// between these rows, where another H.264 encode can alter its hard pixel edges.
const coldPoints = [36, 144].flatMap(y => [38, 115, 204, 281].map(x => ({ x, y })));
type Sample = { wallMs: number; frame: number; uiMs: number; audioMs: number; audioPaused: boolean; width: number; height: number; buffered: boolean; cachePixels: number; visible: boolean; busy: boolean; status: string; pixels: Rgb[] };
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = []; pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
});
test.afterEach(async ({ page }) => { await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(pageErrors.get(page)).toEqual([]); pageErrors.delete(page); });
async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok(), JSON.stringify(payload.error)).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

async function fixture(request: APIRequestContext, info: TestInfo, transition: 'fade' | 'wipe' = 'fade') {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `冷加载转场 ${randomUUID().slice(0, 8)}`, profile: { width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: 1 } });
  const videos: AssetRecord[] = [];
  for (const index of [0, 1]) {
    const path = info.outputPath(`independent-long-gop-${index}.mp4`); await writeColdTransitionVideo(path, index);
    videos.push(await rpc(request, 'asset.import', { projectId: created.id, path, kind: 'video' }));
  }
  expect(videos[0].sha256).not.toBe(videos[1].sha256);
  const current = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: created.id })).project;
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: current.id, revision: current.revision, patch: {
    workflow: { ...current.workflow, production: { ...current.workflow.production, subtitleMode: 'off' } },
    audioMix: { ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, enabled: false } },
    shots: videos.map((video, index) => ({ id: `cold-${index}`, title: `独立长GOP视频 ${index + 1}`, narration: '', visualPrompt: '', durationUs: 1_500_000, videoAssetId: video.id, videoInUs: 0, animation: { zoom: 1, panX: 0, panY: 0, transition: index ? transition : 'cut' }, audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, version: 2, videoAudio: { enabled: true, gainDb: 0 } } })),
  } });
  return { project, videos, current: async () => (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project };
}

async function mediaGate(page: Page, paths: string[]) {
  let release!: () => void, blocked = true;
  const pending = new Promise<void>(resolve => { release = () => { blocked = false; resolve(); }; });
  const requests: { path: string; range?: string; wallMs: number }[] = [];
  const beginning = Date.now();
  await page.route(url => url.pathname === '/__desktop_asset' && paths.includes(url.searchParams.get('path') ?? ''), async route => {
    requests.push({ path: new URL(route.request().url()).searchParams.get('path')!, range: route.request().headers().range, wallMs: Date.now() - beginning });
    if (blocked) await pending;
    await route.continue();
  });
  return { release, requests, get blocked() { return blocked; } };
}

async function open(page: Page, project: ProjectDocument, ready = true) {
  await page.addInitScript(() => localStorage.setItem('vq-preview-scale', '1'));
  await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await openProjectFromList(page, project.title);
  const canvas = page.locator('.preview-frame canvas[role="img"]'); await expect(canvas).toHaveCount(1);
  await expect(page.locator('.preview-panel .prepared-mix-preview')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  if (ready) { await expect(canvas).toBeVisible(); await expect(canvas).toHaveAttribute('data-rendered-frame', '0'); }
  return canvas;
}

async function seek(page: Page, frame: number) {
  const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true }); await ruler.press('Home');
  for (let index = 0; index < Math.floor(frame / 10); index++) await ruler.press('Shift+ArrowRight');
  for (let index = 0; index < frame % 10; index++) await ruler.press('ArrowRight');
  await expect(ruler).toHaveAttribute('aria-valuenow', String(Math.round(frame * 1000 / 30)));
}

async function capture(canvas: Locator, points: PixelPoint[]) {
  return canvas.evaluateHandle((element: HTMLCanvasElement, points) => {
    const state = { active: true, request: 0, samples: [] as Sample[], start: performance.now() };
    function sample() {
      if (!state.active) return;
      const style = getComputedStyle(element), audio = document.querySelector<HTMLAudioElement>('.preview-panel audio[data-audio-role="处理后混音"]'), parent = element.closest('.scene-preview');
      const bounds = element.getBoundingClientRect(), status = parent?.querySelector<HTMLElement>('[role="status"]'), statusBounds = status?.getBoundingClientRect(), statusStyle = status && getComputedStyle(status);
      const alpha = statusStyle?.backgroundColor.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/)?.[1];
      const occluded = Boolean(statusBounds && statusBounds.width >= bounds.width * .95 && statusBounds.height >= bounds.height * .95 && statusStyle?.backgroundColor !== 'transparent' && Number(alpha ?? 1) * Number(statusStyle?.opacity ?? 1) >= .95);
      state.samples.push({ wallMs: performance.now() - state.start, frame: Number(element.dataset.renderedFrame ?? -1), uiMs: Number(document.querySelector('[role="slider"][aria-label="预览播放位置"]')?.getAttribute('aria-valuenow')), audioMs: (audio?.currentTime ?? 0) * 1000, audioPaused: audio?.paused ?? true, width: element.width, height: element.height, buffered: element.dataset.transitionBuffered === 'true', cachePixels: Number(element.dataset.transitionCachePixels ?? 0), visible: style.visibility !== 'hidden' && style.display !== 'none' && bounds.width > 0 && !occluded, busy: parent?.getAttribute('aria-busy') === 'true', status: status?.textContent ?? '', pixels: points.map(({ x, y }) => [...element.getContext('2d')!.getImageData(Math.floor(x * element.width / 320), Math.floor(y * element.height / 180), 1, 1).data].slice(0, 3) as Rgb) });
      state.request = requestAnimationFrame(sample);
    }
    state.request = requestAnimationFrame(sample); return state;
  }, points);
}

async function oracle(request: APIRequestContext, source: Awaited<ReturnType<typeof fixture>>, info: TestInfo) {
  const { runId } = await rpc<{ runId: string }>(request, 'render.export', { projectId: source.project.id, destination: info.outputPath('actual-export.mp4') });
  await expect.poll(async () => (await rpc<{ status: string }>(request, 'run.get', { runId })).status, { timeout: 45_000 }).toBe('succeeded');
  const result = await rpc<{ videoPath: string }>(request, 'node.result', { runId, nodeId: 'export' });
  return decodeTransitionFrames(result.videoPath, Array.from({ length: 14 }, (_, index) => 40 + index), 320, 180);
}

function difference(actual: Rgb[], expected: Rgb[]) { return Math.max(...actual.flatMap((pixel, index) => pixel.map((value, channel) => Math.abs(value - expected[index][channel])))); }
async function stopCapture(handle: Awaited<ReturnType<typeof capture>>, info: TestInfo, requests: unknown[]) {
  const samples = await handle.evaluate(state => { state.active = false; cancelAnimationFrame(state.request); return state.samples; });
  await info.attach('visible-canvas-clock-audio-loading-observations', { body: JSON.stringify({ requests, samples }), contentType: 'application/json' }); await handle.dispose(); return samples;
}

async function liveVideos(page: Page, paths: string[]) {
  const session = await page.context().newCDPSession(page), group = 'cold-transition-resources';
  try {
    const prototype = await session.send('Runtime.evaluate', { expression: 'HTMLVideoElement.prototype', objectGroup: group });
    const objects = await session.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: group });
    const result = await session.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId, arguments: [{ value: paths }], returnByValue: true, functionDeclaration: `function (paths) { return this.filter(video => { if (!video.getAttribute('src')) return false; try { return paths.includes(new URL(video.src).searchParams.get('path')); } catch { return false; } }).map(video => ({ time: video.currentTime, paused: video.paused, ready: video.readyState, bufferedEnd: video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0 })); }` });
    return result.result.value as Array<{ time: number; paused: boolean; ready: number; bufferedEnd: number }>;
  } finally { await session.send('Runtime.releaseObjectGroup', { objectGroup: group }); await session.detach(); }
}

function assertTransition(samples: Sample[], reference: Awaited<ReturnType<typeof oracle>>, points: PixelPoint[]) {
  const visible = samples.filter(sample => sample.visible && sample.frame >= 45 && sample.frame <= 51), frames = new Set(visible.map(sample => sample.frame));
  expect(frames.has(45), 'Recovery must start with the beginning of the transition.').toBe(true); expect(frames.size).toBeGreaterThanOrEqual(3); expect(frames.has(51)).toBe(true);
  for (const sample of visible) expect(difference(sample.pixels, transitionPixels(reference.get(sample.frame)!, 320, points)), `Visible frame ${sample.frame}`).toBeLessThanOrEqual(12);
}

for (const transition of ['fade', 'wipe'] as const) test(`holds the visible picture and audio clock for a cold ${transition}, then presents its complete transition`, async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const source = await fixture(request, info, transition), reference = await oracle(request, source, info), points = coldPoints, gate = await mediaGate(page, [source.videos[1].path]);
  let handle: Awaited<ReturnType<typeof capture>> | undefined, samples: Sample[] = [];
  try {
    const canvas = await open(page, source.project); await seek(page, 30); await expect(canvas).toHaveAttribute('data-rendered-frame', '30');
    handle = await capture(canvas, points); await page.getByRole('button', { name: '播放预览', exact: true }).click();
    // Hold the actual independent source beyond the 200ms transition. This is
    // deliberate fixture latency, not a synthetic media-ready callback.
    await page.waitForTimeout(1300);
    const waiting = await handle.evaluate(state => state.samples.at(-1)!);
    await info.attach('before-source-release', { body: JSON.stringify(waiting), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath(`cold-${transition}-waiting.png`) });
    const paths = source.videos.map(video => video.path), pendingVideos = await liveVideos(page, paths); expect(pendingVideos.length).toBeLessThanOrEqual(4);
    expect(gate.requests.length).toBeGreaterThan(0); expect(waiting.visible, 'A decoded previous picture must remain visible during source loading.').toBe(true);
    expect(waiting.uiMs, 'The clock must not consume the complete transition while its next source is blocked.').toBeLessThanOrEqual(1534);
    expect(waiting.audioPaused, 'Mixed audio must wait with the picture clock.').toBe(true); expect(Math.abs(waiting.audioMs - waiting.uiMs)).toBeLessThan(80);
    gate.release();
    await expect.poll(() => handle!.evaluate(state => state.samples.some(sample => sample.visible && sample.frame >= 52))).toBe(true);
    await page.getByRole('button', { name: '暂停预览', exact: true }).click(); samples = await stopCapture(handle, info, gate.requests); handle = undefined;
    assertTransition(samples, reference, points);
    expect(samples.filter(sample => sample.frame >= 40 && !sample.visible), 'The previous visible picture must survive the wait.').toEqual([]);
    await page.screenshot({ path: info.outputPath(`cold-${transition}-recovered.png`) });
    const readyVideos = await liveVideos(page, paths); expect(readyVideos.length).toBeLessThanOrEqual(4);
    const control = await rpc<ProjectDocument>(request, 'project.create', { title: `冷加载资源释放 ${randomUUID().slice(0, 8)}` }); await openProjectFromList(page, control.title);
    await expect.poll(async () => (await liveVideos(page, paths)).length).toBe(0);
    await info.attach('cold-transition-resources', { body: JSON.stringify({ pendingVideos, readyVideos, afterRelease: await liveVideos(page, paths) }), contentType: 'application/json' });
  } finally {
    gate.release(); if (handle) samples = await stopCapture(handle, info, gate.requests);
    await info.attach('project-isolation', { body: JSON.stringify({ unchanged: JSON.stringify(await source.current()) === JSON.stringify(source.project), errors }), contentType: 'application/json' });
  }
  expect(await source.current()).toEqual(source.project); expect(errors).toEqual([]);
});

for (const transition of ['fade', 'wipe'] as const) test(`prepares the independent next ${transition} source before the boundary without replacing the picture`, async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const source = await fixture(request, info, transition), reference = await oracle(request, source, info), points = coldPoints, gate = await mediaGate(page, [source.videos[1].path]);
  let handle: Awaited<ReturnType<typeof capture>> | undefined;
  try {
    const canvas = await open(page, source.project); handle = await capture(canvas, points);
    await page.getByRole('button', { name: '播放预览', exact: true }).click(); await page.waitForTimeout(800); gate.release();
    await expect.poll(() => handle!.evaluate(state => state.samples.some(sample => sample.visible && sample.frame >= 52))).toBe(true);
    await page.getByRole('button', { name: '暂停预览', exact: true }).click();
    const samples = await stopCapture(handle, info, gate.requests); handle = undefined;
    expect(samples.filter(sample => sample.uiMs >= 200 && !sample.visible), 'Prefetch must avoid replacing any already displayed picture.').toEqual([]); assertTransition(samples, reference, points);
  } finally { gate.release(); if (handle) await stopCapture(handle, info, gate.requests); }
  expect(await source.current()).toEqual(source.project);
});

test('completes an automatic transition preview after cold media arrives and pauses its mixed audio', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const source = await fixture(request, info), reference = await oracle(request, source, info), points = coldPoints;
  const baseline = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: { shots: source.project.shots.map((shot, index) => index ? { ...shot, animation: { ...shot.animation, transition: 'cut' } } : shot) } });
  const gate = await mediaGate(page, [source.videos[1].path]); let handle: Awaited<ReturnType<typeof capture>> | undefined;
  try {
    const canvas = await open(page, baseline); handle = await capture(canvas, points);
    await page.locator('.outline-shot').filter({ hasText: baseline.shots[1].title }).click();
    const select = page.getByRole('combobox', { name: '转场', exact: true });
    await select.click(); await select.getByRole('option', { name: '柔和叠化', exact: true }).click();
    await expect(page.getByRole('button', { name: '暂停预览', exact: true })).toBeVisible();
    await page.waitForTimeout(1000);
    const waiting = await handle.evaluate(state => state.samples.at(-1)!);
    expect(waiting.visible).toBe(true); expect(waiting.uiMs).toBeGreaterThanOrEqual(1100); expect(waiting.uiMs).toBeLessThanOrEqual(1534);
    expect(waiting.audioPaused).toBe(true); expect(Math.abs(waiting.audioMs - waiting.uiMs)).toBeLessThan(80);
    gate.release(); await expect(canvas).toHaveAttribute('data-rendered-frame', '63');
    await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeVisible();
    await expect.poll(() => handle!.evaluate(state => state.samples.at(-1)!.audioPaused)).toBe(true);
    const samples = await stopCapture(handle, info, gate.requests); handle = undefined;
    assertTransition(samples, reference, points);
    expect(samples.at(-1)!.uiMs).toBe(2100); expect(Math.abs(samples.at(-1)!.audioMs - 2100)).toBeLessThan(80);
    await page.screenshot({ path: info.outputPath('automatic-transition-audio-paused.png') });
  } finally { gate.release(); if (handle) await stopCapture(handle, info, gate.requests); }
  expect(await source.current()).toEqual(baseline);
});

test('keeps the last presented picture while seeking directly into a cold transition and paints the requested frame after loading', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const source = await fixture(request, info), reference = await oracle(request, source, info), points = coldPoints, gate = await mediaGate(page, [source.videos[1].path]);
  let handle: Awaited<ReturnType<typeof capture>> | undefined;
  try {
    const canvas = await open(page, source.project); handle = await capture(canvas, points); await seek(page, 48); await page.waitForTimeout(350);
    const waiting = await handle.evaluate(state => state.samples.at(-1)!); expect(waiting.visible).toBe(true); expect(waiting.uiMs).toBe(1600); expect(waiting.audioPaused).toBe(true);
    gate.release(); await expect(canvas).toHaveAttribute('data-rendered-frame', '48'); await expect(canvas).toBeVisible();
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement, points) => points.map(({ x, y }) => [...element.getContext('2d')!.getImageData(x, y, 1, 1).data].slice(0, 3) as Rgb), points).then(pixels => difference(pixels, transitionPixels(reference.get(48)!, 320, points)))).toBeLessThanOrEqual(12);
    await page.waitForTimeout(250); expect((await handle.evaluate(state => state.samples.at(-1)!)).uiMs).toBe(1600); await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeVisible();
  } finally { gate.release(); if (handle) await stopCapture(handle, info, gate.requests); }
  expect(await source.current()).toEqual(source.project);
});

test('does not advance the picture or mixed audio clock when play is requested before the first video is decoded', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const source = await fixture(request, info), gate = await mediaGate(page, [source.videos[0].path]); let handle: Awaited<ReturnType<typeof capture>> | undefined;
  try {
    const canvas = await open(page, source.project, false); handle = await capture(canvas, coldPoints);
    const play = page.getByRole('button', { name: '播放预览', exact: true }); if (await play.isEnabled()) await play.click();
    await page.waitForTimeout(500); const waiting = await handle.evaluate(state => state.samples.at(-1)!);
    expect(waiting.uiMs).toBe(0); expect(waiting.audioPaused).toBe(true); expect(waiting.audioMs).toBeLessThan(35);
    gate.release(); await expect(canvas).toBeVisible();
    await expect.poll(() => handle!.evaluate(state => state.samples.some(sample => sample.visible && sample.frame === 0))).toBe(true);
    if (await play.isVisible()) await play.click(); await expect.poll(() => handle!.evaluate(state => state.samples.at(-1)!.uiMs)).toBeGreaterThanOrEqual(200);
    await page.getByRole('button', { name: '暂停预览', exact: true }).click();
  } finally { gate.release(); if (handle) await stopCapture(handle, info, gate.requests); }
  expect(await source.current()).toEqual(source.project);
});

for (const action of ['pause', 'seek'] as const) test(`honours a newer user ${action} while a cold transition is waiting and ignores the old source-ready callback`, async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const source = await fixture(request, info), gate = await mediaGate(page, [source.videos[1].path]); let handle: Awaited<ReturnType<typeof capture>> | undefined;
  try {
    const canvas = await open(page, source.project); await seek(page, 30); await expect(canvas).toHaveAttribute('data-rendered-frame', '30'); handle = await capture(canvas, coldPoints);
    await page.getByRole('button', { name: '播放预览', exact: true }).click(); await page.waitForTimeout(1000);
    if (action === 'pause') await page.getByRole('button', { name: '暂停预览', exact: true }).click(); else await seek(page, 10);
    const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true }), expectedMs = Number(await ruler.getAttribute('aria-valuenow'));
    gate.release(); await page.waitForTimeout(800);
    await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeVisible(); await expect(ruler).toHaveAttribute('aria-valuenow', String(expectedMs));
    expect((await handle.evaluate(state => state.samples.at(-1)!)).audioPaused).toBe(true);
    if (action === 'seek') { expect(expectedMs).toBe(333); await expect(canvas).toHaveAttribute('data-rendered-frame', '10'); }
  } finally { gate.release(); if (handle) await stopCapture(handle, info, gate.requests); }
  expect(await source.current()).toEqual(source.project);
});

test('advances the warm ordinary video and mixed audio by one real second without slowing the program clock', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const source = await fixture(request, info), canvas = await open(page, source.project);
  await expect.poll(async () => { const videos = await liveVideos(page, [source.videos[0].path]); return videos.length > 0 && videos.every(video => video.ready >= 3 && video.bufferedEnd >= 1.25); }).toBe(true);
  const handle = await capture(canvas, coldPoints);
  try {
    await page.getByRole('button', { name: '播放预览', exact: true }).click();
    // Select an actual one-second observation window, independently of Node's
    // polling schedule. It stays entirely inside the first 1.5-second shot.
    await expect.poll(() => handle.evaluate(state => { const start = state.samples.find(sample => !sample.audioPaused && sample.uiMs > 0); return Boolean(start && state.samples.some(sample => sample.wallMs >= start.wallMs + 1000)); })).toBe(true);
    const window = await handle.evaluate(state => {
      const start = state.samples.find(sample => !sample.audioPaused && sample.uiMs > 0)!;
      const end = state.samples.find(sample => sample.wallMs >= start.wallMs + 1000)!;
      return { start, end, samples: state.samples.filter(sample => sample.wallMs >= start.wallMs && sample.wallMs <= end.wallMs) };
    });
    const wallDeltaMs = window.end.wallMs - window.start.wallMs, programDeltaMs = window.end.uiMs - window.start.uiMs, audioDeltaMs = window.end.audioMs - window.start.audioMs;
    await info.attach('warm-ordinary-video-cadence', { body: JSON.stringify({ wallDeltaMs, programDeltaMs, audioDeltaMs, toleranceMs: 200, window }), contentType: 'application/json' });
    expect(window.end.uiMs, 'This measurement must precede the first transition.').toBeLessThan(1500);
    expect(Math.abs(programDeltaMs - wallDeltaMs), 'Warm playback program time must follow real elapsed time.').toBeLessThanOrEqual(200);
    expect(Math.abs(audioDeltaMs - wallDeltaMs), 'Warm mixed audio must follow real elapsed time.').toBeLessThanOrEqual(200);
    expect(window.samples.every(sample => sample.visible)).toBe(true);
    const pause = page.getByRole('button', { name: '暂停预览', exact: true }); if (await pause.isVisible()) await pause.click();
  } finally { await stopCapture(handle, info, []); }
  expect(await source.current()).toEqual(source.project);
});

test('rebuilds the waiting transition at the latest preview quality without applying an old cache or editing the project', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const source = await fixture(request, info), reference = await oracle(request, source, info), gate = await mediaGate(page, [source.videos[1].path]); let handle: Awaited<ReturnType<typeof capture>> | undefined;
  try {
    const canvas = await open(page, source.project); await seek(page, 30); await expect(canvas).toHaveAttribute('data-rendered-frame', '30'); handle = await capture(canvas, coldPoints);
    await page.getByRole('button', { name: '播放预览', exact: true }).click(); await page.waitForTimeout(1000);
    const quality = page.locator('.preview-controls').getByRole('combobox', { name: '预览质量', exact: true }); await quality.selectOption('0.5');
    expect((await handle.evaluate(state => state.samples.at(-1)!)).visible).toBe(true); gate.release();
    await expect.poll(() => handle!.evaluate(state => state.samples.some(sample => sample.frame >= 52 && sample.visible))).toBe(true);
    await page.getByRole('button', { name: '暂停预览', exact: true }).click(); const samples = await stopCapture(handle, info, gate.requests); handle = undefined;
    assertTransition(samples, reference, coldPoints);
    const transition = samples.filter(sample => sample.frame >= 45 && sample.frame < 51);
    expect(transition.length).toBeGreaterThan(0); expect(transition.every(sample => sample.visible && sample.buffered && sample.width === 160 && sample.height === 90 && sample.cachePixels > 0 && sample.cachePixels <= 6 * 160 * 90)).toBe(true);
    await expect(canvas).toHaveJSProperty('width', 160); await expect(canvas).toHaveJSProperty('height', 90); await expect(quality).toHaveValue('0.5');
    await info.attach('quality-transition-cache-ownership', { body: JSON.stringify({ expectedWidth: 160, expectedHeight: 90, maximumCachePixels: 6 * 160 * 90, transition }), contentType: 'application/json' });
  } finally { gate.release(); if (handle) await stopCapture(handle, info, gate.requests); }
  expect(await source.current()).toEqual(source.project);
});
