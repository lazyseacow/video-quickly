import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';

const execute = promisify(execFile);
const points = [36, 144].flatMap(y => [38, 115, 204, 281].map(x => ({ x, y })));
const terminal = ['succeeded', 'failed', 'canceled'];

async function capture(canvas) {
  return canvas.evaluateHandle((element, points) => {
    const state = { active: true, request: 0, samples: [], start: performance.now() };
    const sample = () => {
      if (!state.active) return;
      const style = getComputedStyle(element), bounds = element.getBoundingClientRect(), parent = element.closest('.scene-preview');
      const audio = document.querySelector('.preview-panel audio[data-audio-role="处理后混音"]'), status = parent?.querySelector('[role="status"]'), statusBounds = status?.getBoundingClientRect(), statusStyle = status && getComputedStyle(status);
      const alpha = statusStyle?.backgroundColor.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/)?.[1];
      const occluded = Boolean(statusBounds && statusBounds.width >= bounds.width * .95 && statusBounds.height >= bounds.height * .95 && statusStyle?.backgroundColor !== 'transparent' && Number(alpha ?? 1) * Number(statusStyle?.opacity ?? 1) >= .95);
      state.samples.push({ wallMs: performance.now() - state.start, frame: Number(element.dataset.renderedFrame ?? -1), uiMs: Number(document.querySelector('[role="slider"][aria-label="预览播放位置"]')?.getAttribute('aria-valuenow')), audioMs: (audio?.currentTime ?? 0) * 1000, audioPaused: audio?.paused ?? true, visible: style.visibility !== 'hidden' && style.display !== 'none' && bounds.width > 0 && !occluded, busy: parent?.getAttribute('aria-busy') === 'true', status: status?.textContent ?? '', pixels: points.map(({ x, y }) => [...element.getContext('2d').getImageData(x, y, 1, 1).data].slice(0, 3)) });
      state.request = requestAnimationFrame(sample);
    };
    state.request = requestAnimationFrame(sample); return state;
  }, points);
}
async function stopCapture(handle) {
  if (!handle) return [];
  const samples = await handle.evaluate(state => { state.active = false; cancelAnimationFrame(state.request); return state.samples; }); await handle.dispose(); return samples;
}
async function videos(page, paths) {
  const session = await page.context().newCDPSession(page), group = `native-cold-${randomUUID()}`;
  try {
    const prototype = await session.send('Runtime.evaluate', { expression: 'HTMLVideoElement.prototype', objectGroup: group });
    const objects = await session.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: group });
    const result = await session.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId, arguments: [{ value: paths }], returnByValue: true, functionDeclaration: `function(paths) { return this.filter(video => { if (!video.getAttribute('src')) return false; try { return paths.includes(new URL(video.src).searchParams.get('path')); } catch { return false; } }).map(video => ({ path: new URL(video.src).searchParams.get('path'), time: video.currentTime, paused: video.paused, ready: video.readyState, bufferedEnd: video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0 })); }` });
    return result.result.value ?? [];
  } finally { await session.send('Runtime.releaseObjectGroup', { objectGroup: group }); await session.detach(); }
}
async function gateAsset(page, path) {
  let blocked = true, release; const pending = new Promise(resolve => { release = () => { blocked = false; resolve(); }; });
  const attempts = [], observed = [], errors = [];
  const matches = url => url.protocol === 'video-quickly:' && url.pathname === '/__asset' && url.searchParams.get('path') === path;
  const listener = request => { if (matches(new URL(request.url()))) observed.push({ url: request.url(), range: request.headers().range }); };
  const handler = async route => { attempts.push({ url: route.request().url(), range: route.request().headers().range }); if (blocked) await pending; await route.continue(); };
  page.on('request', listener);
  try { await page.route(matches, handler); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); release(); }
  return { attempts, observed, errors, release, async close() { release(); page.off('request', listener); await page.unroute(matches, handler); } };
}

/** Real installed-app decode, resource and audio checks. No media-ready callbacks or native protocol results are mocked. */
export async function verifyNativeTransitionLoading({ page, rpc, openProject, fixture, artifacts, ffmpegPath, environment, checks }) {
  const originalTitle = await page.getByRole('textbox', { name: '项目名称', exact: true }).inputValue(), directory = join(fixture, 'cold-transitions');
  await mkdir(directory, { recursive: true });
  const sourcePaths = [join(directory, 'independent-first.mp4'), join(directory, 'independent-next.mp4')], results = [];
  for (const [index, path] of sourcePaths.entries()) {
    const palette = index ? ['10c0b0', '1020e0', '10b030'] : ['e02010', 'e08010', 'd0c010'];
    const changes = palette.map((color, phase) => `drawbox=x=0:y=0:w=iw:h=ih:color=0x${color}:t=fill:enable='eq(mod(floor(n/3),3),${phase})'`).join(',');
    await execute(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=320x180:r=30:d=2.5', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=30:d=2.5', '-f', 'lavfi', '-i', `sine=frequency=${index ? 660 : 330}:sample_rate=48000:duration=2.5`, '-filter_complex', `[0:v]${changes}[base];[base][1:v]overlay=x='mod(t*80,256)':y=58[v]`, '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-bf', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', path], { windowsHide: true, env: environment });
  }
  let completed = false;
  const seek = async frame => { const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true }); await ruler.press('Home'); for (let i = 0; i < Math.floor(frame / 10); i++) await ruler.press('Shift+ArrowRight'); for (let i = 0; i < frame % 10; i++) await ruler.press('ArrowRight'); await expect(ruler).toHaveAttribute('aria-valuenow', String(Math.round(frame * 1000 / 30))); };
  try {
    for (const scenario of ['fade', 'wipe', 'pause']) {
      let project = await rpc('project.create', { title: `原生冷加载 ${scenario} ${randomUUID().slice(0, 6)}`, profile: { width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 }, previewScale: 1 } });
      const assets = []; for (const path of sourcePaths) assets.push(await rpc('asset.import', { projectId: project.id, path, kind: 'video' }));
      assert.notEqual(assets[0].sha256, assets[1].sha256);
      project = (await rpc('project.get', { projectId: project.id })).project;
      project = await rpc('project.update', { projectId: project.id, revision: project.revision, patch: { audioMix: { version: 1, loudness: { enabled: false, targetLufs: -16, truePeakDb: -1.5 }, ducking: { enabled: false, thresholdDb: -30, ratio: 8, attackMs: 20, releaseMs: 250 } }, shots: assets.map((asset, index) => ({ id: `cold-native-${index}`, title: `独立长GOP ${index + 1}`, narration: '', visualPrompt: '', durationUs: 1_500_000, videoAssetId: asset.id, videoInUs: 0, animation: { zoom: 1, panX: 0, panY: 0, transition: index ? scenario === 'wipe' ? 'wipe' : 'fade' : 'cut' }, audioProcessing: { version: 2, gainDb: 0, denoise: false, noiseReductionDb: 12, videoAudio: { enabled: true, gainDb: 0 } } })) } });
      const paths = assets.map(asset => asset.path), record = { scenario, projectId: project.id, routes: [], requestEvents: [], samples: [], protocolGateSupported: false };
      let reference;
      if (scenario !== 'pause') {
        const { runId } = await rpc('render.export', { projectId: project.id, destination: join(directory, `reference-${scenario}.mp4`) }); let run;
        await expect.poll(async () => { run = await rpc('run.get', { runId }); return terminal.includes(run.status); }, { timeout: 90_000 }).toBe(true); assert.equal(run.status, 'succeeded', run.error);
        const output = await rpc('node.result', { runId, nodeId: 'export' });
        const decoded = await execute(ffmpegPath, ['-v', 'error', '-i', output.videoPath, '-vf', 'select=between(n\\,45\\,51)', '-frames:v', '7', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, env: environment, encoding: 'buffer', maxBuffer: 2_000_000 }); reference = Buffer.from(decoded.stdout); assert.equal(reference.length, 7 * 320 * 180 * 3);
      }
      const gate = await gateAsset(page, assets[1].path); let handle;
      try {
        await openProject(project.title);
        const player = page.getByRole('region', { name: '视频预览播放器', exact: true }), canvas = player.locator('.preview-frame canvas[role="img"]');
        await player.getByRole('combobox', { name: '预览质量', exact: true }).selectOption('1');
        await expect(page.locator('.preview-panel .prepared-mix-preview')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 }); await expect(canvas).toHaveAttribute('data-rendered-frame', '0'); await expect(canvas).toBeVisible(); await expect(canvas).toHaveAttribute('width', '320');
        await expect.poll(async () => gate.attempts.length > 0 || (await videos(page, paths)).some(video => video.path === assets[1].path), { timeout: 10_000 }).toBe(true);
        record.protocolGateSupported = gate.attempts.length > 0;
        record.preloadedVideos = await videos(page, paths); assert.ok(record.preloadedVideos.length <= 4);
        if (!record.protocolGateSupported) { record.protocolLimitation = 'The real custom-scheme video decoder was observed, but page.route did not intercept its fresh unique source path. No delayed-ready behaviour is claimed for this native run.'; gate.release(); await gate.close(); }
        await seek(record.protocolGateSupported ? 30 : 0); await expect(canvas).toHaveAttribute('data-rendered-frame', record.protocolGateSupported ? '30' : '0'); handle = await capture(canvas);
        await page.getByRole('button', { name: '播放预览', exact: true }).click();
        if (record.protocolGateSupported) {
          await page.waitForTimeout(1300); record.waiting = await handle.evaluate(state => state.samples.at(-1));
          assert.ok(record.waiting.visible, 'Cold decoding must preserve the previous picture'); assert.ok(record.waiting.uiMs <= 1534, 'Blocked source must not consume the transition'); assert.equal(record.waiting.audioPaused, true); assert.ok(Math.abs(record.waiting.audioMs - record.waiting.uiMs) < 80);
          await page.screenshot({ path: join(artifacts, `desktop-cold-${scenario}-waiting.png`) });
        }
        if (scenario === 'pause') {
          if (!record.protocolGateSupported) await expect.poll(() => handle.evaluate(state => state.samples.at(-1)?.uiMs ?? 0)).toBeGreaterThanOrEqual(300);
          await page.getByRole('button', { name: '暂停预览', exact: true }).click(); const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true }), pausedMs = await ruler.getAttribute('aria-valuenow'); gate.release();
          await page.waitForTimeout(800); await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeVisible(); await expect(ruler).toHaveAttribute('aria-valuenow', pausedMs); assert.equal((await handle.evaluate(state => state.samples.at(-1))).audioPaused, true);
          record.pausePreserved = true; if (record.protocolGateSupported) checks.nativeBufferedPause = true; else checks.nativeColdPauseNoResume = true;
        } else {
          gate.release(); await expect.poll(() => handle.evaluate(state => state.samples.some(sample => sample.visible && sample.frame >= 52)), { timeout: 20_000 }).toBe(true);
          const pause = page.getByRole('button', { name: '暂停预览', exact: true }); if (await pause.isVisible()) await pause.click();
          const samples = await handle.evaluate(state => state.samples), transition = samples.filter(sample => sample.visible && sample.frame >= 45 && sample.frame <= 51), frames = new Set(transition.map(sample => sample.frame));
          assert.ok(frames.has(45) && frames.has(51) && frames.size >= 3, `A complete native ${scenario} must be presented: ${[...frames]}`);
          for (const sample of transition) for (const [point, { x, y }] of points.entries()) {
            const offset = (sample.frame - 45) * 320 * 180 * 3 + (y * 320 + x) * 3;
            assert.ok(sample.pixels[point].every((value, channel) => Math.abs(value - reference[offset + channel]) <= 12), `Native cold ${scenario} frame ${sample.frame}, point ${point}: ${sample.pixels[point]} vs ${[...reference.subarray(offset, offset + 3)]}`);
          }
          assert.ok(samples.filter(sample => sample.uiMs > 0).every(sample => sample.visible), 'The visible picture must survive real continuous playback'); record.transitionFrames = [...frames].sort((a, b) => a - b);
          await page.screenshot({ path: join(artifacts, `desktop-cold-${scenario}-recovered.png`) });
        }
        record.samples = await stopCapture(handle); handle = undefined; record.routes = gate.attempts; record.requestEvents = gate.observed; record.routeSetupErrors = gate.errors;
        assert.deepEqual((await rpc('project.get', { projectId: project.id })).project, project);
        const control = await rpc('project.create', { title: `原生解码释放 ${randomUUID().slice(0, 6)}` }); await openProject(control.title); await expect.poll(async () => (await videos(page, paths)).length).toBe(0); record.resourcesReleased = true;
        checks.nativeColdTransitionResources = true;
      } finally {
        gate.release(); if (handle) record.samples = await stopCapture(handle); await gate.close(); results.push(record); await writeFile(join(artifacts, 'native-transition-loading.json'), JSON.stringify({ scenarios: results, noSyntheticReadyCallbacks: true }, null, 2));
      }
    }
    checks.nativeColdTransitionPlayback = true; checks.nativeNextSourcePrefetch = results.every(record => record.preloadedVideos?.some(video => video.path !== record.preloadedVideos[0]?.path) || record.routes.length > 0);
    assert.equal(checks.nativeNextSourcePrefetch, true); completed = true;
  } finally { if (completed) await openProject(originalTitle); }
}
