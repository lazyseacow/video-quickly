import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { cpus, platform, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { expect, test, type APIRequestContext, type CDPSession } from '@playwright/test';
import type { AssetRecord, ProjectDocument } from '@video-quickly/contracts';

const execute = promisify(execFile), requested = process.env.VIDEO_QUICKLY_SOAK_SECONDS;
const sourceColors = ['d12a36', '2ac950', '2f4bd1', 'd1bd2a', '2ac7c7', 'c72ac7', 'd16a2a', '6ac72a', '2a72c7', '902ac7', 'c72a72', '2ac794'];
interface VideoSample { source: string; width: number; height: number; ready: number; playing: boolean; currentTime: number; decodedFrames: number; droppedFrames: number }
interface PresentationSample { source: string; stable: boolean; frames: number; mediaTimes: number[]; pixel: number[]; sourcePixel: number[]; pattern: string }

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  expect(response.ok()).toBe(true); const value = await response.json(); expect(value.error).toBeUndefined(); return value.result;
}

async function decodedVideos(session: CDPSession) {
  const group = 'independent-media-soak';
  const prototype = await session.send('Runtime.evaluate', { expression: 'HTMLVideoElement.prototype', objectGroup: group });
  const objects = await session.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: group });
  try {
    const result = await session.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId, returnByValue: true, awaitPromise: true, functionDeclaration: `async function () {
      const live = this.filter(video => video.getAttribute('src'));
      const videos = live.map(video => { const quality = video.getVideoPlaybackQuality(); return { source: video.currentSrc, width: video.videoWidth, height: video.videoHeight, ready: video.readyState, playing: !video.paused, currentTime: video.currentTime, decodedFrames: quality.totalVideoFrames, droppedFrames: quality.droppedVideoFrames }; });
      const video = live.find(video => !video.paused && video.readyState >= 2);
      if (!video) return { videos };
      const source = video.currentSrc, times = []; let callback;
      const record = (_, metadata) => { times.push(metadata.mediaTime); callback = video.requestVideoFrameCallback(record); };
      if (typeof video.requestVideoFrameCallback === 'function') callback = video.requestVideoFrameCallback(record);
      await new Promise(resolve => setTimeout(resolve, 300));
      if (callback !== undefined) video.cancelVideoFrameCallback(callback);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const canvas = document.querySelector('.preview-panel .scene-preview canvas'), preview = canvas?.parentElement;
      const stable = !!canvas && video.currentSrc === source && !!video.getAttribute('src') && !video.paused && preview.getAttribute('aria-busy') === 'false';
      if (!stable) return { videos, presentation: { source, stable: false, frames: times.length, mediaTimes: times, pixel: [], sourcePixel: [], pattern: '' } };
      const context = canvas.getContext('2d'), pixel = Array.from(context.getImageData(Math.floor(canvas.width * .75), Math.floor(canvas.height * .5), 1, 1).data), pattern = [];
      const reference = new OffscreenCanvas(1, 1), referenceContext = reference.getContext('2d');
      referenceContext.drawImage(video, Math.floor(video.videoWidth * .75), Math.floor(video.videoHeight * .5), 1, 1, 0, 0, 1, 1);
      const sourcePixel = Array.from(referenceContext.getImageData(0, 0, 1, 1).data);
      for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) pattern.push(...Array.from(context.getImageData(Math.floor(canvas.width * (100 + x * 35) / 1920), Math.floor(canvas.height * (95 + y * 28) / 1080), 1, 1).data).slice(0, 3));
      return { videos, presentation: { source, stable, frames: times.length, mediaTimes: times, pixel, sourcePixel, pattern: pattern.join(',') } };
    }` });
    return result.result.value as { videos: VideoSample[]; presentation?: PresentationSample };
  } finally { await session.send('Runtime.releaseObjectGroup', { objectGroup: group }); }
}

// This is an explicit measurement job, not a skipped functional assertion in the
// default suite. Request 300 seconds for the long-playback acceptance run.
if (requested !== undefined) {
  const seconds = Number(requested);
  if (!Number.isInteger(seconds) || seconds < 15 || seconds > 300) throw new Error('VIDEO_QUICKLY_SOAK_SECONDS 必须是 15–300 的整数。');
  test.use({ trace: 'off' });
  test('plays 200 shots from twelve independently encoded sources and records sustained resource usage', async ({ page, request, browser, headless, trace }, info) => {
    test.setTimeout(180_000 + seconds * 1_000);
    const errors: string[] = [], mediaErrors: unknown[] = [], samples: unknown[] = [], mixJobs: unknown[] = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', async response => {
      if (!response.url().endsWith('/__desktop_rpc')) return;
      const method = response.request().postDataJSON()?.method;
      if (method !== 'audio.mix.prepare' && method !== 'audio.mix.get') return;
      try { const payload = await response.json(); const job = payload.result; mixJobs.push({ time: new Date().toISOString(), method, httpStatus: response.status(), id: job?.id, key: job?.key, status: job?.status, error: payload.error ?? job?.error }); }
      catch { mixJobs.push({ time: new Date().toISOString(), method, httpStatus: response.status(), unreadableResponse: true }); }
    });
    await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `多独立素材长时验收 ${randomUUID().slice(0, 8)}` });
    const assets: AssetRecord[] = [];
    for (let index = 0; index < 12; index++) {
      const path = info.outputPath(`independent-source-${index}.mp4`);
      await execute(process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${sourceColors[index]}:size=1920x1080:rate=30:duration=3[background];testsrc2=size=320x180:rate=30:duration=3[pattern];[background][pattern]overlay=80:80`, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-threads', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path]);
      assets.push(await rpc<AssetRecord>(request, 'asset.import', { projectId: created.id, path, kind: 'video' }));
    }
    expect(new Set(assets.map(asset => asset.sha256)).size).toBe(12);
    const latest = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: created.id })).project;
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: latest.id, revision: latest.revision, patch: {
      profile: { ...latest.profile, width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, previewScale: .5 },
      shots: Array.from({ length: 200 }, (_, index) => ({ id: `independent-shot-${index}`, title: `独立镜头 ${index + 1}`, narration: '', visualPrompt: '', durationUs: 2_000_000, videoInUs: 200_000, videoAssetId: assets[index % assets.length].id, animation: { panX: 0, panY: 0, zoom: 1, transition: 'cut' } })),
    } });
    const session = await page.context().newCDPSession(page), players = new Set<string>();
    session.on('Media.playerCreated', ({ player }) => players.add(player.playerId)); session.on('Media.playerErrorsRaised', event => mediaErrors.push(event)); await session.send('Media.enable');
    const observed = new Map<string, Set<string>>(); let maxLiveVideos = 0, presentedFrames = 0, openToPreviewMs: number | undefined;
    try {
      const started = performance.now();
      await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
      await expect(page.locator('.preview-panel .scene-preview')).toHaveAttribute('aria-busy', 'false'); openToPreviewMs = performance.now() - started;
      const play = page.getByRole('button', { name: '播放预览', exact: true }); await expect(play).toBeEnabled({ timeout: 90_000 }); await play.click();
      const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true }), beginning = Number(await ruler.getAttribute('aria-valuenow')), clockStart = performance.now();
      while (performance.now() - clockStart < seconds * 1_000) {
        await page.waitForTimeout(Math.max(0, Math.min(650, seconds * 1_000 - (performance.now() - clockStart))));
        const { videos, presentation } = await decodedVideos(session); maxLiveVideos = Math.max(maxLiveVideos, videos.length);
        const heap = await session.send('Runtime.getHeapUsage');
        samples.push({ elapsedMs: performance.now() - clockStart, programTimeMs: Number(await ruler.getAttribute('aria-valuenow')), heap, videos, presentation });
        if (presentation?.stable && presentation.frames > 0) {
          const path = new URL(presentation.source).searchParams.get('path'), index = assets.findIndex(asset => asset.path === path);
          expect(index).toBeGreaterThanOrEqual(0);
          // Compare the preview against the browser's actual decoded source.
          // Nominal lavfi RGB values change during YUV conversion and are not
          // an authoritative reference for the encoded H.264 frame.
          for (let channel = 0; channel < 3; channel++) expect(Math.abs(presentation.pixel[channel] - presentation.sourcePixel[channel])).toBeLessThanOrEqual(3);
          expect(presentation.pixel[3]).toBe(255);
          const patterns = observed.get(assets[index].id) ?? new Set<string>(); patterns.add(presentation.pattern); observed.set(assets[index].id, patterns); presentedFrames += presentation.frames;
          if (presentation.mediaTimes.length > 1) expect(presentation.mediaTimes.at(-1)!).toBeGreaterThan(presentation.mediaTimes[0]);
        }
        expect(videos.length).toBeLessThanOrEqual(3); await expect(page.getByRole('button', { name: '暂停预览', exact: true })).toBeVisible();
        await expect(page.locator('.preview-panel .scene-preview__state[role="alert"]')).toHaveCount(0);
      }
      const advanced = Number(await ruler.getAttribute('aria-valuenow')) - beginning;
      expect(advanced).toBeGreaterThan(seconds * 1_000 * .8); expect(advanced).toBeLessThan(seconds * 1_000 + 5_000);
      expect(observed.size).toBeGreaterThanOrEqual(seconds >= 60 ? 12 : 3);
      expect(presentedFrames).toBeGreaterThan(seconds * 2);
      expect([...observed.values()].filter(patterns => patterns.size > 1).length).toBeGreaterThanOrEqual(seconds >= 60 ? 12 : 1);
      await page.getByRole('button', { name: '暂停预览', exact: true }).click();
      // Retain actual source/decoder counters; element lifetime changes at every
      // asset transition, so these are samples, not a fabricated aggregate FPS.
      await page.locator('.outline-shot').last().scrollIntoViewIfNeeded(); await page.locator('.outline-shot').last().click();
      await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('独立镜头 200');
      await expect(page.locator('.preview-panel .scene-preview')).toHaveAttribute('aria-busy', 'false');
      expect(errors).toEqual([]); expect(mediaErrors).toEqual([]);
      await page.screenshot({ path: info.outputPath('independent-media-after-soak.png') });
    } finally {
      const evidence = { fixture: { shots: 200, independentSourceFiles: assets.length, uniqueSourceHashes: new Set(assets.map(asset => asset.sha256)).size, source: '3s H.264 1920x1080 30fps; unique background and moving test pattern for every file', playbackSecondsRequested: seconds }, machine: { platform: platform(), cpu: cpus()[0]?.model, memoryGiB: totalmem() / 1024 ** 3, node: process.version, browser: browser.version(), headless, trace }, measurements: { openToPreviewMs, maxLiveVideos, playersCreated: players.size, observedSourceIds: [...observed.keys()], canvasPatternsPerSource: Object.fromEntries([...observed].map(([id, patterns]) => [id, patterns.size])), presentedFramesInObservationWindows: presentedFrames, samples, mixJobs }, errors, mediaErrors, nativeGpuMeasured: false };
      const path = info.outputPath('independent-media-soak.json'); await writeFile(path, JSON.stringify(evidence, null, 2)); await info.attach('independent-media-soak', { path, contentType: 'application/json' }); await session.detach();
    }
  });
}
