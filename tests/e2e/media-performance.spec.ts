import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { cpus, platform, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { expect, test, type APIRequestContext, type Browser, type CDPSession, type Page, type TestInfo } from '@playwright/test';
import type { AssetRecord, ProjectDocument } from '@video-quickly/contracts';

const execute = promisify(execFile);

// Recording every canvas update changes the cadence being measured. Functional
// thumbnail/clip tests retain the normal failure traces and pixel assertions.
test.use({ trace: 'off' });

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

async function fixture(request: APIRequestContext, info: TestInfo, count: number) {
  const source = info.outputPath('1080p-30fps.mp4');
  await execute(process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=5', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-threads', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', source]);
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `真实视频 ${count} 镜头 ${randomUUID().slice(0, 8)}` });
  const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: created.id, path: source, kind: 'video' });
  const current = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: created.id })).project;
  return rpc<ProjectDocument>(request, 'project.update', { projectId: current.id, revision: current.revision, patch: {
    profile: { ...current.profile, width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, previewScale: .5 },
    shots: Array.from({ length: count }, (_, index) => ({ id: `real-${index}`, title: `真实镜头 ${index + 1}`, narration: '', visualPrompt: '', durationUs: 1_000_000, sourceInUs: 0, videoInUs: index * 20_000, videoAssetId: asset.id, animation: { zoom: 1, panX: 0, panY: 0, transition: 'cut' } })),
  } });
}

async function videoElements(session: CDPSession) {
  const group = 'real-media-measurement';
  const prototype = await session.send('Runtime.evaluate', { expression: 'HTMLVideoElement.prototype', objectGroup: group });
  const objects = await session.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: group });
  try {
    const result = await session.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId, returnByValue: true, functionDeclaration: `function () {
      const live = this.filter(element => element.getAttribute('src'));
      return { live: live.length, ready: live.filter(element => element.readyState >= 2).length, playing: live.filter(element => !element.paused).length, sourcePixels: live.reduce((sum, element) => sum + element.videoWidth * element.videoHeight, 0) };
    }` });
    const value: unknown = result.result.value;
    if (!value || typeof value !== 'object' || !('live' in value) || typeof value.live !== 'number') throw new Error('无法测量真实视频元素');
    return value;
  } finally { await session.send('Runtime.releaseObjectGroup', { objectGroup: group }); }
}

async function processMemory(browser: Browser) {
  if (platform() !== 'win32') return { available: false, reason: 'working-set measurement is Windows-specific' };
  const session = await browser.newBrowserCDPSession();
  try {
    const processes = await session.send('SystemInfo.getProcessInfo');
    const ids: number[] = processes.processInfo.map((entry: { id: number }) => entry.id).filter((id: number) => Number.isInteger(id) && id > 0);
    const result = await execute('powershell.exe', ['-NoProfile', '-Command', `@(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = $_.Id; workingSetBytes = $_.WorkingSet64 } }) | ConvertTo-Json -Compress`], { windowsHide: true });
    const measured: unknown = JSON.parse(result.stdout);
    return { available: true, processes: measured, note: 'Sum of process working sets includes shared pages; it is not private memory.' };
  } finally { await session.detach(); }
}

async function firstFrame(page: Page) {
  await expect(page.locator('.preview-panel .scene-preview')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.preview-panel .scene-preview__state')).toHaveCount(0);
  await expect.poll(() => page.locator('.preview-panel .scene-preview canvas').evaluate((canvas: HTMLCanvasElement) => {
    if (canvas.width < 64) return false;
    return canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 3), Math.floor(canvas.height / 3), 1, 1).data[3] === 255;
  })).toBe(true);
}

function summarize(samples: number[]) {
  const ordered = samples.toSorted((left, right) => left - right);
  return { samples, p50Ms: ordered[Math.floor(ordered.length * .5)], p95Ms: ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * .95))] };
}

async function playbackCadence(page: Page, session: CDPSession, playerCount: () => number) {
  const before = playerCount();
  await page.getByRole('button', { name: '播放预览', exact: true }).click();
  const group = 'real-media-playback';
  try {
    const prototype = await session.send('Runtime.evaluate', { expression: 'HTMLVideoElement.prototype', objectGroup: group });
    const objects = await session.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: group });
    const measured = await session.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId, awaitPromise: true, returnByValue: true, functionDeclaration: `async function () {
      const video = this.find(element => element.getAttribute('src') && !element.paused);
      if (!video) return { observed: false };
      const frames = [], display = [], before = video.getVideoPlaybackQuality();
      let frame, raf;
      const recordFrame = time => { frames.push(time); frame = video.requestVideoFrameCallback(recordFrame); };
      const recordDisplay = time => { display.push(time); raf = requestAnimationFrame(recordDisplay); };
      if (typeof video.requestVideoFrameCallback === 'function') frame = video.requestVideoFrameCallback(recordFrame);
      raf = requestAnimationFrame(recordDisplay);
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (frame !== undefined) video.cancelVideoFrameCallback(frame);
      cancelAnimationFrame(raf);
      const after = video.getVideoPlaybackQuality(), fps = values => values.length < 2 ? null : (values.length - 1) * 1000 / (values.at(-1) - values[0]);
      return { observed: true, videoFrameCallbacks: frames.length, videoFps: fps(frames), displayRafHz: fps(display), decodedFrames: after.totalVideoFrames - before.totalVideoFrames, droppedFrames: after.droppedVideoFrames - before.droppedVideoFrames };
    }` });
    return { sample: measured.result.value, newMediaPlayersDuringPlayback: playerCount() - before };
  } finally {
    await session.send('Runtime.releaseObjectGroup', { objectGroup: group });
    await page.getByRole('button', { name: '暂停预览', exact: true }).click();
  }
}

for (const count of [50, 200]) test(`bounds real 1080p video resources and measures ${count} shots`, async ({ page, request, browser, headless, trace }, info) => {
  test.setTimeout(60_000);
  const errors: string[] = [], mediaErrors: unknown[] = [], players = new Map<string, Record<string, string>>();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await expect(page.getByLabel('项目名称', { exact: true })).toBeVisible();
  const session = await page.context().newCDPSession(page);
  session.on('Media.playerCreated', ({ player }) => { if (!players.has(player.playerId)) players.set(player.playerId, {}); });
  session.on('Media.playerPropertiesChanged', ({ playerId, properties }) => { const current = players.get(playerId) ?? {}; for (const property of properties) current[property.name] = property.value; players.set(playerId, current); });
  session.on('Media.playerErrorsRaised', event => mediaErrors.push(event));
  await session.send('Media.enable');
  const project = await fixture(request, info, count);
  const timing: Record<string, unknown> = {};
  try {
    const trigger = page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }); await expect(trigger).toBeVisible();
    const begin = performance.now(); await trigger.click(); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('真实镜头 1'); await firstFrame(page);
    timing.openToPreviewReadyMs = performance.now() - begin;
    const selections = [], seeks = [];
    for (const index of [Math.floor(count / 2), count - 1, 0]) {
      const started = performance.now(); await page.locator('.outline-shot').nth(index).click(); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue(`真实镜头 ${index + 1}`); await firstFrame(page); selections.push(performance.now() - started);
      const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true }), previous = await ruler.getAttribute('aria-valuenow');
      const seeking = performance.now(); await ruler.press('Shift+ArrowRight'); await expect(ruler).not.toHaveAttribute('aria-valuenow', previous ?? ''); seeks.push(performance.now() - seeking);
    }
    // Selection acknowledges the field and preview state; it is not a measurement
    // of the exact new source frame reaching the display. Pixel tests cover that.
    timing.selectionUiFeedback = summarize(selections); timing.seekUiFeedback = summarize(seeks);
    timing.playback = await playbackCadence(page, session, () => players.size);
  } finally {
    const elements = await videoElements(session), heap = await session.send('Runtime.getHeapUsage');
    const metrics = { fixture: { shots: count, source: '5s H.264 1920x1080 30fps, one real asset, distinct 20ms source offsets', preview: '1920x1080, previewScale=0.5', viewport: page.viewportSize() }, machine: { platform: platform(), cpu: cpus()[0]?.model, memoryGiB: totalmem() / 1024 ** 3, node: process.version, browser: { version: browser.version(), headless, trace } }, timing, videoElements: elements, createdMediaPlayers: players.size, reportedDecoders: [...players.values()].flatMap(properties => Object.entries(properties).filter(([key]) => key.includes('DecoderName')).map(([key, value]) => ({ key, value }))), heap, browserMemory: await processMemory(browser), errors, mediaErrors };
    await writeFile(info.outputPath('real-media-metrics.json'), JSON.stringify(metrics, null, 2));
    await info.attach('real-media-metrics', { path: info.outputPath('real-media-metrics.json'), contentType: 'application/json' });
    console.log(JSON.stringify({ shots: count, liveVideos: elements.live, createdPlayers: players.size, timing, errors: errors.length, mediaErrors: mediaErrors.length }));
    expect(elements.live).toBeLessThanOrEqual(3);
    expect(errors).toEqual([]); expect(mediaErrors).toEqual([]);
    await session.detach();
  }
});
