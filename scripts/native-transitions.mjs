import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';

const execute = promisify(execFile);

/** Compare the installed player's actual pixels with its own sidecar's MP4. */
export async function verifyNativeTransitions({ page, rpc, openProject, fixture, artifacts, ffmpegPath, environment, checks }) {
  const originalTitle = await page.getByRole('textbox', { name: '项目名称', exact: true }).inputValue();
  const directory = join(fixture, 'transitions');
  await mkdir(directory, { recursive: true });
  const red = join(directory, 'red.png'), green = join(directory, 'green.mp4'), blue = join(directory, 'blue.png');
  for (const [path, color] of [[red, 'red'], [blue, 'blue']]) await execute(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180`, '-frames:v', '1', path], { windowsHide: true, env: environment });
  await execute(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x180:r=60:d=0.5', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', green], { windowsHide: true, env: environment });
  let project = await rpc('project.create', { title: `原生转场验收 ${randomUUID().slice(0, 6)}`, profile: { width: 320, height: 180, frameRate: { numerator: 60, denominator: 1 }, previewScale: 1 } });
  const assets = [];
  for (const [path, kind] of [[red, 'image'], [green, 'video'], [blue, 'image']]) assets.push(await rpc('asset.import', { projectId: project.id, path, kind }));
  project = (await rpc('project.get', { projectId: project.id })).project;
  project = await rpc('project.update', { projectId: project.id, revision: project.revision, patch: { shots: assets.map((asset, index) => ({ id: `native-transition-${index}`, title: `转场画面 ${index + 1}`, narration: '', visualPrompt: '', durationUs: 500_000, ...(index === 1 ? { videoAssetId: asset.id } : { assetId: asset.id }), animation: { zoom: 1, panX: 0, panY: 0, transition: ['cut', 'fade', 'wipe'][index] } })) } });
  const { runId } = await rpc('render.export', { projectId: project.id, destination: join(directory, 'result.mp4') });
  let run;
  await expect.poll(async () => { run = await rpc('run.get', { runId }); return ['succeeded', 'failed', 'cancelled'].includes(run.status); }, { timeout: 90_000 }).toBe(true);
  assert.equal(run.status, 'succeeded', run.error);
  const result = await rpc('node.result', { runId, nodeId: 'export' });
  const sampleFrames = [29, 30, 36, 42, 59, 60, 66, 72];
  const decoded = await execute(ffmpegPath, ['-v', 'error', '-i', result.videoPath, '-vf', `select='${sampleFrames.map(frame => `eq(n,${frame})`).join('+')}'`, '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, env: environment, encoding: 'buffer', maxBuffer: 4_000_000 });
  const reference = Buffer.from(decoded.stdout), frameBytes = 320 * 180 * 3;
  assert.equal(reference.length, sampleFrames.length * frameBytes);
  await openProject(project.title);
  const player = page.getByRole('region', { name: '视频预览播放器', exact: true });
  const seek = player.getByRole('slider', { name: '播放器播放位置', exact: true }), canvas = player.locator('.preview-frame canvas');
  await expect(canvas).toHaveCount(1);
  await player.getByRole('combobox', { name: '预览质量', exact: true }).selectOption('1');
  await expect(player.locator('.scene-preview')).toHaveAttribute('aria-busy', 'false');
  await expect(canvas).toHaveAttribute('width', '320');
  // Sample away from the 4:2:0 chroma edge; the exact wipe boundary is tested in lossless RGB.
  const points = [[32, 90], [112, 90], [288, 90]];
  await seek.focus(); await seek.press('Home');
  let cursor = 0;
  for (const [sampleIndex, frame] of sampleFrames.entries()) {
    for (; cursor < frame; cursor++) await seek.press('ArrowRight');
    await expect(canvas).toHaveAttribute('data-rendered-frame', String(frame));
    const pixels = await canvas.evaluate((element, points) => {
      const ctx = element.getContext('2d');
      return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3));
    }, points);
    points.forEach(([x, y], pointIndex) => {
      const offset = sampleIndex * frameBytes + (y * 320 + x) * 3;
      const expected = [...reference.subarray(offset, offset + 3)];
      assert.ok(pixels[pointIndex].every((value, channel) => Math.abs(value - expected[channel]) <= 12), `Native frame ${frame}, point ${pointIndex}: ${pixels[pointIndex]} vs MP4 ${expected}`);
    });
    if (frame === 36 || frame === 66) {
      const name = `desktop-transition-${frame === 36 ? 'fade' : 'wipe'}`;
      await page.screenshot({ path: join(artifacts, `${name}.png`) });
      await player.screenshot({ path: join(artifacts, `${name}-player.png`) });
    }
  }
  assert.deepEqual((await rpc('project.get', { projectId: project.id })).project, project);
  checks.nativeTransitionExportPixels = true;
  await openProject(originalTitle);
}
