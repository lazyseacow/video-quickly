import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';

const execute = promisify(execFile);
const width = 1280, height = 720, prefixFrames = 12;
// Relative points avoid both the moving source strip and H.264 4:2:0 wipe edges.
const points = [.2, .8].flatMap(y => [.12, .36, .64, .88].map(x => ({ x: Math.floor(width * x), y: Math.floor(height * y) })));
const joins = [{ kind: 'fade', first: 90 }, { kind: 'wipe', first: 180 }];

async function probeMedia(ffmpegPath, environment, path) {
  const ffprobePath = join(dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const result = await execute(ffprobePath, ['-v', 'error', '-show_entries', 'stream=index,codec_type,width,height,pix_fmt,r_frame_rate,avg_frame_rate,color_range,color_space,color_transfer,color_primaries:format=duration', '-of', 'json', path], { windowsHide: true, env: environment });
  return JSON.parse(result.stdout);
}

async function observePlayback(page, canvas) {
  const key = `__vqNativeTransitionCache_${randomUUID().replaceAll('-', '')}`;
  const handle = await canvas.evaluateHandle((element, { key, points }) => {
    const state = { active: true, request: 0, start: performance.now(), samples: [], badgeEvents: [], audioEvents: [], videoEvents: [], cleanup: [], watched: new WeakSet(), lastFrame: -1, badge: undefined, audio: undefined };
    const pixels = document.createElement('canvas'); pixels.width = points.length; pixels.height = 1;
    const pixelsContext = pixels.getContext('2d', { willReadFrequently: true });
    const position = () => ({ wallMs: performance.now() - state.start, frame: Number(element.dataset.renderedFrame ?? -1), uiMs: Number(document.querySelector('[role="slider"][aria-label="预览播放位置"]')?.getAttribute('aria-valuenow')), buffered: element.dataset.transitionBuffered === 'true', cachePixels: Number(element.dataset.transitionCachePixels ?? 0) });
    state.position = position;
    const tick = () => {
      if (!state.active) return;
      const parent = element.closest('.timeline-preview'), audio = document.querySelector('.preview-panel audio[data-audio-role="处理后混音"]');
      if (audio && audio !== state.audio) {
        state.audio = audio;
        for (const type of ['play', 'playing', 'pause', 'waiting', 'ended']) {
          const listener = () => state.audioEvents.push({ ...position(), type, timeMs: audio.currentTime * 1000, paused: audio.paused });
          audio.addEventListener(type, listener); state.cleanup.push(() => audio.removeEventListener(type, listener));
        }
      }
      const status = parent?.querySelector('.timeline-preview__buffering'), badge = Boolean(status && getComputedStyle(status).display !== 'none');
      if (badge !== state.badge) { state.badgeEvents.push({ ...position(), type: badge ? 'show' : 'hide', initial: state.badge === undefined }); state.badge = badge; }
      const style = getComputedStyle(element), bounds = element.getBoundingClientRect(), current = position();
      const sample = { ...current, kind: element.dataset.transition, visible: style.visibility !== 'hidden' && style.display !== 'none' && bounds.width > 0, busy: parent?.getAttribute('aria-busy') === 'true', badge, audioMs: (audio?.currentTime ?? 0) * 1000, audioPaused: audio?.paused ?? true };
      if (current.frame !== state.lastFrame && current.buffered) {
        const started = performance.now();
        for (const [index, { x, y }] of points.entries()) pixelsContext.drawImage(element, x, y, 1, 1, index, 0, 1, 1);
        const data = pixelsContext.getImageData(0, 0, points.length, 1).data;
        sample.pixels = points.map((_, index) => [...data.slice(index * 4, index * 4 + 3)]); sample.pixelReadMs = performance.now() - started;
      }
      state.samples.push(sample); state.lastFrame = current.frame;
      state.request = requestAnimationFrame(tick);
    };
    globalThis[key] = state; state.request = requestAnimationFrame(tick); return state;
  }, { key, points });
  const session = await page.context().newCDPSession(page), group = key, decoderSnapshots = [];
  let watching = true, observerError;
  async function refresh(paths) {
    try {
      const prototype = await session.send('Runtime.evaluate', { expression: 'HTMLVideoElement.prototype', objectGroup: group });
      const objects = await session.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: group });
      const result = await session.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId, arguments: [{ value: key }, { value: paths }], returnByValue: true, functionDeclaration: `function(key, paths) {
        const state = globalThis[key];
        const videos = this.filter(video => { if (!video.getAttribute('src')) return false; try { return paths.includes(new URL(video.src).searchParams.get('path')); } catch { return false; } });
        for (const video of videos) if (state?.active && !state.watched.has(video)) {
          state.watched.add(video);
          const path = new URL(video.src).searchParams.get('path');
          for (const type of ['seeking', 'seeked', 'play', 'playing', 'pause', 'waiting', 'stalled', 'emptied']) {
            const listener = () => state.videoEvents.push({ ...state.position(), type, path, timeMs: video.currentTime * 1000, ready: video.readyState, paused: video.paused });
            video.addEventListener(type, listener); state.cleanup.push(() => video.removeEventListener(type, listener));
          }
        }
        return { ...(state?.position() ?? {}), videos: videos.map(video => ({ path: new URL(video.src).searchParams.get('path'), timeMs: video.currentTime * 1000, paused: video.paused, seeking: video.seeking, ready: video.readyState, width: video.videoWidth, height: video.videoHeight })) };
      }` });
      decoderSnapshots.push(result.result.value); return result.result.value?.videos ?? [];
    } finally { await session.send('Runtime.releaseObjectGroup', { objectGroup: group }); }
  }
  let observation;
  return {
    handle,
    refresh,
    // queryObjects performs a heap walk. Never run it inside either transition:
    // attach once before play and once in the long ordinary middle clip.
    start(paths) { observation = (async () => { while (watching) { const frame = await handle.evaluate(state => state.samples.at(-1)?.frame ?? 0); if (frame >= 120) { await refresh(paths); return; } await new Promise(resolve => setTimeout(resolve, 100)); } })().catch(error => { observerError = error; }); },
    async stop() {
      watching = false; await observation;
      const result = await handle.evaluate((state, key) => { state.active = false; cancelAnimationFrame(state.request); for (const cleanup of state.cleanup) cleanup(); state.cleanup.length = 0; delete globalThis[key]; return { samples: state.samples, badgeEvents: state.badgeEvents, audioEvents: state.audioEvents, videoEvents: state.videoEvents }; }, key);
      await handle.dispose(); await session.detach();
      return { ...result, decoderSnapshots, ...(observerError ? { observerError: String(observerError) } : {}) };
    },
  };
}

async function decodeReference(ffmpegPath, environment, videoPath) {
  const frames = joins.flatMap(join => Array.from({ length: prefixFrames }, (_, index) => join.first + index));
  const labels = points.map((_, index) => `[p${index}]`).join('');
  const crops = points.map(({ x, y }, index) => `[p${index}]crop=1:1:${x}:${y}[c${index}]`).join(';');
  const filter = `[0:v]select='${frames.map(frame => `eq(n,${frame})`).join('+')}',format=rgb24,split=${points.length}${labels};${crops};${points.map((_, index) => `[c${index}]`).join('')}hstack=inputs=${points.length}[pixels]`;
  const decoded = await execute(ffmpegPath, ['-v', 'error', '-i', videoPath, '-filter_complex', filter, '-map', '[pixels]', '-frames:v', String(frames.length), '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, env: environment, encoding: 'buffer', maxBuffer: 1_000_000 });
  const bytes = Buffer.from(decoded.stdout); assert.equal(bytes.length, frames.length * points.length * 3);
  return new Map(frames.map((frame, index) => [frame, points.map((_, point) => [...bytes.subarray((index * points.length + point) * 3, (index * points.length + point + 1) * 3)])]));
}

/** Native 1080p/24 fps decoding into a 60 fps original-quality project, without ready/seek mocks. */
export async function verifyNativeTransitionCache({ page, rpc, openProject, fixture, artifacts, ffmpegPath, environment, checks }) {
  const originalTitle = await page.getByRole('textbox', { name: '项目名称', exact: true }).inputValue(), directory = join(fixture, 'transition-cache');
  await mkdir(directory, { recursive: true });
  const record = { sourceProfile: { width: 1920, height: 1080, fps: 24, gop: 96 }, projectProfile: { width, height, fps: 60, previewScale: 1 }, points, noSyntheticReadyCallbacks: true, noMediaMethodOverrides: true, sourceProbes: [], colorOracle: 'Sources are actually color-converted from BT.601 to BT.709 and tagged. Output metadata is recorded as produced; pixel comparisons use default FFmpeg RGB decoding without a forced input matrix.', scenarios: [] };
  const sourcePaths = [join(directory, 'first-1080p24.mp4'), join(directory, 'next-1080p24.mp4')];
  let probe, completed = false;
  try {
    for (const [index, path] of sourcePaths.entries()) {
      await execute(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${index ? '1050d0' : 'd05010'}:s=1920x1080:r=24:d=2.5`, '-f', 'lavfi', '-i', 'testsrc2=s=1920x240:r=24:d=2.5', '-f', 'lavfi', '-i', `sine=frequency=${index ? 660 : 330}:sample_rate=48000:duration=2.5`, '-filter_complex', `[0:v][1:v]overlay=x=0:y=420,colorspace=iall=bt601-6-625:all=bt709,format=yuv420p[v]`, '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-g', '96', '-keyint_min', '96', '-sc_threshold', '0', '-bf', '2', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', path], { windowsHide: true, env: environment });
      const metadata = await probeMedia(ffmpegPath, environment, path), video = metadata.streams.find(stream => stream.codec_type === 'video');
      record.sourceProbes.push(metadata);
      assert.equal(video.width, 1920); assert.equal(video.height, 1080); assert.equal(video.avg_frame_rate, '24/1');
      for (const key of ['color_space', 'color_primaries', 'color_transfer']) assert.equal(video[key], 'bt709');
    }
    let project = await rpc('project.create', { title: `原生原画缓存 1080p24→60 ${randomUUID().slice(0, 6)}`, profile: { width, height, frameRate: { numerator: 60, denominator: 1 }, previewScale: 1 } });
    const assets = []; for (const path of sourcePaths) assets.push(await rpc('asset.import', { projectId: project.id, path, kind: 'video' }));
    assert.notEqual(assets[0].sha256, assets[1].sha256);
    project = (await rpc('project.get', { projectId: project.id })).project;
    project = await rpc('project.update', { projectId: project.id, revision: project.revision, patch: { audioMix: { version: 1, loudness: { enabled: false, targetLufs: -16, truePeakDb: -1.5 }, ducking: { enabled: false, thresholdDb: -30, ratio: 8, attackMs: 20, releaseMs: 250 } }, shots: [assets[0], assets[1], assets[0]].map((asset, index) => ({ id: `native-cached-${index}`, title: `原画长GOP ${index + 1}`, narration: '', visualPrompt: '', durationUs: 1_500_000, videoAssetId: asset.id, videoInUs: 0, animation: { zoom: 1, panX: 0, panY: 0, transition: ['cut', 'fade', 'wipe'][index] }, audioProcessing: { version: 2, gainDb: 0, denoise: false, noiseReductionDb: 12, videoAudio: { enabled: true, gainDb: 0 } } })) } });
    record.projectId = project.id;
    const { runId } = await rpc('render.export', { projectId: project.id, destination: join(directory, 'reference-60fps.mp4') }); let run;
    await expect.poll(async () => { run = await rpc('run.get', { runId }); return ['succeeded', 'failed', 'canceled'].includes(run.status); }, { timeout: 120_000 }).toBe(true); assert.equal(run.status, 'succeeded', run.error);
    const output = await rpc('node.result', { runId, nodeId: 'export' }), reference = await decodeReference(ffmpegPath, environment, output.videoPath);
    record.outputProbe = await probeMedia(ffmpegPath, environment, output.videoPath);
    await openProject(project.title);
    const player = page.getByRole('region', { name: '视频预览播放器', exact: true }), canvas = player.locator('.preview-frame canvas[role="img"]');
    await player.getByRole('combobox', { name: '预览质量', exact: true }).selectOption('1');
    await expect(canvas).toHaveAttribute('width', String(width)); await expect(canvas).toHaveAttribute('height', String(height)); await expect(canvas).toHaveAttribute('data-rendered-frame', '0'); await expect(canvas).toBeVisible();
    probe = await observePlayback(page, canvas);
    const paths = assets.map(asset => asset.path); await probe.refresh(paths); probe.start(paths);
    await expect(page.locator('.preview-panel .prepared-mix-preview')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    // A real full-prefix witness precedes playback. Later prefixes must prepare while the preceding shot plays.
    await expect(canvas).toHaveAttribute('data-transition-cache-pixels', String(prefixFrames * width * height), { timeout: 30_000 });
    await page.getByRole('button', { name: '播放预览', exact: true }).click();
    await expect.poll(() => probe.handle.evaluate(state => state.samples.some(sample => sample.frame >= 198)), { timeout: 30_000 }).toBe(true);
    await page.getByRole('button', { name: '暂停预览', exact: true }).click();
    Object.assign(record, await probe.stop()); probe = undefined;
    assert.equal(record.observerError, undefined);
    assert.ok(record.decoderSnapshots.some(snapshot => snapshot.videos.length === 2 && snapshot.videos.every(video => video.width === 1920 && video.height === 1080)), 'Observe the real full-resolution native video decoders');
    assert.ok(record.samples.some(sample => !sample.audioPaused), 'The prepared mixed audio must actually play');
    for (const join of joins) {
      const transition = record.samples.filter(sample => sample.frame >= join.first && sample.frame < join.first + prefixFrames), visible = transition.filter(sample => sample.pixels), frames = [...new Set(visible.map(sample => sample.frame))];
      // A retained picture can lag the requested UI at a handoff. Classify the
      // event by requested timeline time so a post-transition seek is not called
      // a seek inside the old still-visible cached frame.
      const interior = event => event.uiMs > Math.round(join.first * 1000 / 60) && event.uiMs < Math.round((join.first + prefixFrames - 1) * 1000 / 60);
      const summary = { kind: join.kind, frames, audioPauses: record.audioEvents.filter(event => event.type === 'pause' && interior(event)), videoSeeks: record.videoEvents.filter(event => event.type === 'seeking' && interior(event)), badges: record.badgeEvents.filter(event => event.type === 'show' && interior(event)) };
      record.scenarios.push(summary);
      assert.ok(frames.includes(join.first) && frames.length >= 8, `Native ${join.kind} must present its entrance and at least eight cached frames: ${frames}`);
      assert.ok(transition.every(sample => sample.visible && sample.buffered), `Native ${join.kind} must use the visible immutable prefix throughout`);
      assert.equal(summary.audioPauses.length, 0, `Native ${join.kind} must not pause mixed audio for individual cached frames`);
      assert.equal(summary.videoSeeks.length, 0, `Native ${join.kind} must not seek a decoder for individual cached frames`);
      assert.equal(summary.badges.length, 0, `Native ${join.kind} must not flash a buffering badge between cached frames`);
      assert.ok(record.samples.some(sample => sample.frame >= (join.first === 90 ? 0 : 110) && sample.frame <= join.first && sample.cachePixels === prefixFrames * width * height), `Native ${join.kind} must have prepared the entire prefix by its entrance`);
      for (const sample of visible) for (const [point, expected] of reference.get(sample.frame).entries()) assert.ok(sample.pixels[point].every((value, channel) => Math.abs(value - expected[channel]) <= 12), `Native cached ${join.kind} frame ${sample.frame}, point ${point}: ${sample.pixels[point]} vs ${expected}`);
    }
    assert.ok(record.samples.every(sample => sample.cachePixels * 4 <= 48 * 1024 * 1024), 'Native transition cache must stay within 48 MiB');
    assert.deepEqual((await rpc('project.get', { projectId: project.id })).project, project);
    await page.screenshot({ path: join(artifacts, 'desktop-transition-cache-1080p24-60fps.png') });
    const control = await rpc('project.create', { title: `原画缓存释放 ${randomUUID().slice(0, 6)}` }); await openProject(control.title);
    // Detached decoder inspection includes only our paths and has no native-protocol or onReady substitution.
    const session = await page.context().newCDPSession(page);
    try {
      await expect.poll(async () => {
        const prototype = await session.send('Runtime.evaluate', { expression: 'HTMLVideoElement.prototype', objectGroup: 'cache-release' });
        const objects = await session.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: 'cache-release' });
        const result = await session.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId, arguments: [{ value: paths }], returnByValue: true, functionDeclaration: `function(paths) { return this.filter(video => { if (!video.getAttribute('src')) return false; try { return paths.includes(new URL(video.src).searchParams.get('path')); } catch { return false; } }).length; }` });
        await session.send('Runtime.releaseObjectGroup', { objectGroup: 'cache-release' }); return result.result.value;
      }).toBe(0);
    } finally { await session.detach(); }
    record.resourcesReleased = true;
    checks.nativeOriginalQualityCachedTransitions = true; checks.nativeTransitionCacheNoRepeatedSeeks = true; checks.nativeTransitionCacheContinuousAudio = true; checks.nativeTransitionCacheResourcesReleased = true;
    completed = true;
  } catch (error) { record.error = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    if (probe) Object.assign(record, await probe.stop());
    await writeFile(join(artifacts, 'native-transition-cache.json'), JSON.stringify(record, null, 2));
    if (completed) await openProject(originalTitle);
  }
}
