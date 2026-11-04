import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { DEFAULT_AUDIO_MIX_SETTINGS, DEFAULT_AUDIO_PROCESSING, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';
import { test } from './isolated-workspace';
import { openProjectFromList } from './workspace-navigation';
import { decodeTransitionFrames, transitionPixels, type Rgb } from '../fixtures/transition-media';

const execute = promisify(execFile), points = [108, 972].flatMap(y => [230, 691, 1228, 1689].map(x => ({ x, y })));
type AuditEvent = { kind: string; wallMs: number; path: string | null; value?: number; uiMs: number; frame: number };
type Sample = { wallMs: number; uiMs: number; frame: number; width: number; height: number; visible: boolean; badge: boolean; audioPaused: boolean; audioMs: number; buffered: boolean; cachePixels: number; pixels: Rgb[] };
async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), body = await response.json(); expect(response.ok(), JSON.stringify(body.error)).toBe(true); expect(body.error).toBeUndefined(); return body.result;
}
async function probeVideo(path: string, info: TestInfo, label: string, source = false) {
  const { stdout } = await execute(process.env.VIDEO_QUICKLY_FFPROBE ?? 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', `stream=width,height,r_frame_rate,color_space,color_transfer,color_primaries${source ? ':frame=key_frame,pict_type' : ''}`, ...(source ? ['-show_frames'] : []), '-of', 'json', path], { windowsHide: true });
  const data = JSON.parse(stdout); await info.attach(`${label}-ffprobe`, { body: stdout, contentType: 'application/json' });
  expect(data.streams[0]).toMatchObject({ width: 1920, height: 1080, r_frame_rate: source ? '24/1' : '60/1' });
  if (source) {
    expect(data.streams[0]).toMatchObject({ color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709' });
    expect(data.frames.flatMap((frame: { key_frame: number }, index: number) => frame.key_frame ? [index] : [])).toEqual([0, 48]); expect(data.frames.some((frame: { pict_type: string }) => frame.pict_type === 'B')).toBe(true);
  }
}
async function fixture(request: APIRequestContext, info: TestInfo, transition: 'fade' | 'wipe') {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `1080长GOP闪烁 ${randomUUID().slice(0, 8)}`, profile: { width: 1920, height: 1080, previewScale: 1, fitMode: 'contain', frameRate: { numerator: 60, denominator: 1 } } });
  const assets: AssetRecord[] = [];
  for (const index of [0, 1]) {
    const path = info.outputPath(`independent-1080p24-gop48-${index}.mp4`), palette = index ? ['10c0b0', '1020e0', '10b030'] : ['e02010', 'e08010', 'd0c010'];
    const changes = palette.map((color, phase) => `drawbox=x=0:y=0:w=iw:h=ih:color=0x${color}:t=fill:enable='eq(mod(floor(n/6),3),${phase})'`).join(',');
    await execute(process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=1920x1080:r=24:d=3', '-f', 'lavfi', '-i', 'testsrc2=s=256x256:r=24:d=3', '-f', 'lavfi', '-i', `sine=frequency=${index ? 660 : 330}:sample_rate=48000:duration=3`, '-filter_complex', `[0:v]${changes}[base];[base][1:v]overlay=x='mod(t*200,1664)':y=420,colorspace=iall=bt601-6-625:all=bt709[v]`, '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-bf', '2', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', path], { windowsHide: true });
    await probeVideo(path, info, `source-${index}`, true);
    assets.push(await rpc(request, 'asset.import', { projectId: created.id, path, kind: 'video' }));
  }
  expect(assets[0].sha256).not.toBe(assets[1].sha256);
  const current = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: created.id })).project;
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: current.id, revision: current.revision, patch: { workflow: { ...current.workflow, production: { ...current.workflow.production, subtitleMode: 'off' } }, audioMix: { ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, enabled: false } }, shots: assets.map((asset, index) => ({ id: `long-gop-${index}`, title: `独立1080长GOP ${index + 1}`, narration: '', visualPrompt: '', durationUs: 2_500_000, videoAssetId: asset.id, videoInUs: 0, animation: { zoom: 1, panX: 0, panY: 0, transition: index ? transition : 'cut' }, audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, version: 2, videoAudio: { enabled: true, gainDb: 0 } } })) } });
  return { project, assets };
}
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const events: AuditEvent[] = [], registered = new WeakSet<HTMLMediaElement>();
    (window as unknown as { transitionAudit: AuditEvent[] }).transitionAudit = events;
    function record(element: HTMLMediaElement, kind: string, value?: number) {
      if (!(element instanceof HTMLVideoElement) && element.dataset.audioRole !== '处理后混音') return;
      let path: string | null = null; try { path = new URL(element.currentSrc || element.src).searchParams.get('path'); } catch { /* src is not assigned yet */ }
      events.push({ kind, value, path, wallMs: performance.now(), uiMs: Number(document.querySelector('[role="slider"][aria-label="预览播放位置"]')?.getAttribute('aria-valuenow') ?? 0), frame: Number(document.querySelector<HTMLCanvasElement>('.preview-frame canvas')?.dataset.renderedFrame ?? -1) });
    }
    function register(element: HTMLMediaElement) {
      if (registered.has(element)) return; registered.add(element);
      for (const event of ['seeking', 'seeked', 'play', 'pause']) element.addEventListener(event, () => record(element, `${element instanceof HTMLVideoElement ? 'video' : 'audio'}-${event}`));
    }
    for (const property of ['src', 'currentTime'] as const) {
      const original = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, property)!;
      // Observe the real setter and delegate unchanged. Offscreen decoders have
      // no DOM ancestors, so document-level seeking listeners cannot see them.
      Object.defineProperty(HTMLMediaElement.prototype, property, { ...original, set(this: HTMLMediaElement, value: string | number) { register(this); if (property === 'currentTime') record(this, 'set-currentTime', Number(value)); original.set!.call(this, value); } });
    }
  });
}
async function seek(page: Page, frame: number) {
  const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true }); await ruler.press('Home');
  for (let index = 0; index < Math.floor(frame / 10); index++) await ruler.press('Shift+ArrowRight'); for (let index = 0; index < frame % 10; index++) await ruler.press('ArrowRight');
  await expect(page.locator('.preview-frame canvas')).toHaveAttribute('data-rendered-frame', String(frame));
}

for (const scenario of [{ transition: 'fade', cold: false }, { transition: 'wipe', cold: false }, { transition: 'fade', cold: true }] as const) test(`${scenario.cold ? 'cold' : 'warm'} 1080p24 long-GOP to 60fps ${scenario.transition} avoids repeated badge, audio and decoder restarts`, async ({ page, request }, info) => {
  test.setTimeout(180_000);
  const source = await fixture(request, info, scenario.transition), errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const frames = [149, 150, 151, 153, 156, 159, 161, 162, 164], { runId } = await rpc<{ runId: string }>(request, 'render.export', { projectId: source.project.id, destination: info.outputPath('actual-1080p60-export.mp4') });
  await expect.poll(async () => (await rpc<{ status: string }>(request, 'run.get', { runId })).status, { timeout: 90_000 }).toBe('succeeded');
  const output = await rpc<{ videoPath: string }>(request, 'node.result', { runId, nodeId: 'export' }); await probeVideo(output.videoPath, info, 'actual-export'); const reference = await decodeTransitionFrames(output.videoPath, frames, 1920, 1080);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  if (scenario.cold) await page.route(url => url.pathname === '/__desktop_asset' && url.searchParams.get('path') === source.assets[1].path, async route => { await gate; await route.continue(); });
  await instrument(page); await page.addInitScript(() => localStorage.setItem('vq-preview-scale', '1')); await page.goto('/'); await openProjectFromList(page, source.project.title);
  const canvas = page.locator('.preview-frame canvas[role="img"]'); await expect(canvas).toBeVisible(); await expect(page.locator('.preview-panel .prepared-mix-preview')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await seek(page, 126); if (!scenario.cold) await page.waitForTimeout(800);
  const capture = await canvas.evaluateHandle((element: HTMLCanvasElement, points) => {
    const state = { active: true, raf: 0, samples: [] as Sample[] };
    function tick() {
      if (!state.active) return;
      const bounds = element.getBoundingClientRect(), style = getComputedStyle(element), parent = element.closest('.scene-preview'), badge = parent?.querySelector<HTMLElement>('.timeline-preview__buffering'), badgeStyle = badge && getComputedStyle(badge), audio = document.querySelector<HTMLAudioElement>('audio[data-audio-role="处理后混音"]');
      const status = parent?.querySelector<HTMLElement>('[role="status"]'), statusBounds = status?.getBoundingClientRect(), statusStyle = status && getComputedStyle(status), alpha = statusStyle?.backgroundColor.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/)?.[1];
      const occluded = Boolean(statusBounds && statusBounds.width >= bounds.width * .95 && statusBounds.height >= bounds.height * .95 && statusStyle?.backgroundColor !== 'transparent' && Number(alpha ?? 1) * Number(statusStyle?.opacity ?? 1) >= .95);
      state.samples.push({ wallMs: performance.now(), uiMs: Number(document.querySelector('[role="slider"][aria-label="预览播放位置"]')?.getAttribute('aria-valuenow')), frame: Number(element.dataset.renderedFrame ?? -1), width: element.width, height: element.height, visible: style.visibility !== 'hidden' && style.display !== 'none' && bounds.width > 0 && !occluded, badge: Boolean(badge && badge.getBoundingClientRect().width && badgeStyle?.display !== 'none' && badgeStyle?.visibility !== 'hidden' && Number(badgeStyle?.opacity ?? 1) > 0), audioPaused: audio?.paused ?? true, audioMs: (audio?.currentTime ?? 0) * 1000, buffered: element.dataset.transitionBuffered === 'true', cachePixels: Number(element.dataset.transitionCachePixels ?? 0), pixels: points.map(({ x, y }) => [...element.getContext('2d')!.getImageData(Math.floor(x * element.width / 1920), Math.floor(y * element.height / 1080), 1, 1).data].slice(0, 3) as Rgb) });
      state.raf = requestAnimationFrame(tick);
    }
    state.raf = requestAnimationFrame(tick); return state;
  }, points);
  try {
    await page.getByRole('button', { name: '播放预览', exact: true }).click();
    if (scenario.cold) { await page.waitForTimeout(1300); const wait = await capture.evaluate(state => state.samples.at(-1)!); await info.attach('cold-before-release', { body: JSON.stringify(wait), contentType: 'application/json' }); expect(wait.visible).toBe(true); expect(wait.uiMs).toBeLessThanOrEqual(2517); expect(wait.audioPaused).toBe(true); release(); }
    await expect.poll(() => capture.evaluate(state => state.samples.some(sample => sample.visible && sample.frame >= 174)), { timeout: 30_000 }).toBe(true);
    await page.getByRole('button', { name: '暂停预览', exact: true }).click();
    const samples = await capture.evaluate(state => { state.active = false; cancelAnimationFrame(state.raf); return state.samples; }), events = await page.evaluate(() => (window as unknown as { transitionAudit: AuditEvent[] }).transitionAudit);
    let shown = 0, hidden = 0, before = false;
    for (const sample of samples) { if (sample.badge !== before) { if (sample.badge) shown++; else hidden++; before = sample.badge; } }
    const setters = events.filter(event => event.kind === 'set-currentTime' && event.path === source.assets[1].path && event.uiMs >= 2500 && event.uiMs < 2700 && event.frame >= 150);
    const pauseEvents = events.filter(event => event.kind === 'audio-pause' && event.uiMs >= 2500 && event.uiMs < 2700 && event.frame >= 150), playEvents = events.filter(event => event.kind === 'audio-play' && event.uiMs >= 2500 && event.uiMs < 2700 && event.frame >= 150);
    const paints = samples.filter((sample, index) => !index || sample.frame !== samples[index - 1].frame), paintIntervals = paints.slice(1).map((sample, index) => sample.wallMs - paints[index].wallMs);
    const comparisons = samples.filter(sample => sample.visible && reference.has(sample.frame) && sample.frame >= 150 && sample.frame <= 162).map(sample => ({ frame: sample.frame, buffered: sample.buffered, difference: Math.max(...sample.pixels.flatMap((pixel, index) => pixel.map((value, channel) => Math.abs(value - transitionPixels(reference.get(sample.frame)!, 1920, points)[index][channel])))) }));
    await info.attach('badge-audio-decoder-and-presented-pixels', { body: JSON.stringify({ shown, hidden, setters, pauseEvents, playEvents, paintIntervals, comparisons, samples, events }), contentType: 'application/json' }); await page.screenshot({ path: info.outputPath(`1080p60-${scenario.transition}-${scenario.cold ? 'cold' : 'warm'}.png`) });
    expect(new Set(comparisons.map(sample => sample.frame)).size).toBeGreaterThanOrEqual(3); for (const sample of comparisons) expect(sample.difference, `Presented frame ${sample.frame}`).toBeLessThanOrEqual(12);
    expect(shown, 'Preparing-frame feedback must not flash repeatedly.').toBeLessThanOrEqual(1); expect(hidden).toBeLessThanOrEqual(1);
    if (scenario.cold && setters.length === 1) expect(setters[0]).toMatchObject({ value: .2, uiMs: 2500, frame: 150 });
    else expect(setters, 'An already presented transition must read its prepared frames without repeatedly seeking the incoming decoder.').toHaveLength(0);
    expect(pauseEvents).toHaveLength(0); expect(playEvents.length).toBeLessThanOrEqual(1);
    const transition = samples.filter(sample => sample.frame >= 150 && sample.frame < 162); expect(transition.every(sample => sample.buffered)).toBe(true); expect(Math.max(...samples.map(sample => sample.cachePixels))).toBeLessThanOrEqual(12_582_912);
    expect(samples.every(sample => sample.visible)).toBe(true); expect(errors).toEqual([]);
  } finally { release(); await capture.evaluate(state => { state.active = false; cancelAnimationFrame(state.raf); }); await capture.dispose(); }
  expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: source.project.id })).project).toEqual(source.project);
});
