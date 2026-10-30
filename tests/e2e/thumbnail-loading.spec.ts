import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { AssetRecord, ProjectDocument } from '@video-quickly/contracts';

const execute = promisify(execFile);
async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const value = await response.json(); expect(response.ok()).toBe(true); expect(value.error).toBeUndefined(); return value.result;
}
async function fixture(request: APIRequestContext, info: TestInfo, count = 3) {
  const path = info.outputPath('green-red-blue.mp4');
  await execute(process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x180:r=30:d=3', '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=0xff0000:t=fill:enable='gte(t,1)',drawbox=x=0:y=0:w=iw:h=ih:color=0x0000ff:t=fill:enable='gte(t,2)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-g', '1', '-bf', '0', '-pix_fmt', 'yuv420p', '-an', path]);
  const project = await rpc<ProjectDocument>(request, 'project.create', { title: `真实缩略图验收 ${randomUUID().slice(0, 8)}` });
  const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path, kind: 'video' });
  const current = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
  const updated = await rpc<ProjectDocument>(request, 'project.update', { projectId: current.id, revision: current.revision, patch: { profile: { ...current.profile, width: 640, height: 360 }, shots: Array.from({ length: count }, (_, index) => ({ id: `color-${index}`, title: `彩色镜头 ${index + 1}`, narration: '', visualPrompt: '', durationUs: 500_000, sourceInUs: 0, videoInUs: Math.round((index % 3 + .5) * 1_000_000), videoAssetId: asset.id, animation: { zoom: 1, panX: 0, panY: 0, transition: 'cut' } })) } });
  return { project: updated, asset };
}
async function open(page: Page, title: string) {
  await page.goto('/'); await expect(page.getByLabel('项目名称', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `打开项目：${title}`, exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('彩色镜头 1');
}
async function color(canvas: Locator, expected: 'green' | 'red' | 'blue') {
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    if (element.width < 64) return 'waiting';
    const rgb = element.getContext('2d')!.getImageData(Math.floor(element.width * .5), Math.floor(element.height * .38), 1, 1).data;
    return rgb[1] > 160 && rgb[0] < 80 && rgb[2] < 80 ? 'green' : rgb[0] > 160 && rgb[1] < 80 && rgb[2] < 80 ? 'red' : rgb[2] > 160 && rgb[0] < 80 && rgb[1] < 80 ? 'blue' : 'other';
  })).toBe(expected);
}

test('paints the actual source sample in both thumbnail surfaces and invalidates a changed source offset', async ({ page, request }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { project } = await fixture(request, info); await open(page, project.title);
  const colors = ['green', 'red', 'blue'] as const;
  for (const [index, expected] of colors.entries()) {
    await color(page.locator('.outline-shot').nth(index).locator('canvas'), expected);
    await color(page.locator('.timeline-clip--video').nth(index).locator('canvas'), expected);
  }
  const revised = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map(shot => shot.id === 'color-0' ? { ...shot, videoInUs: 2_500_000 } : shot) } });
  await expect(page.getByText(`修订 ${revised.revision}`, { exact: true })).toBeVisible();
  await color(page.locator('.outline-shot').first().locator('canvas'), 'blue');
  await color(page.locator('.timeline-clip--video').first().locator('canvas'), 'blue');
  await color(page.locator('.preview-panel .scene-preview canvas'), 'blue');
  expect(errors).toEqual([]);
});

test('releases offscreen canvas buffers and restores real thumbnails without changing selection or focus', async ({ page, request }, info) => {
  const { project } = await fixture(request, info, 24); await open(page, project.title);
  const first = page.locator('.outline-shot').first(), last = page.locator('.outline-shot').last();
  await color(first.locator('canvas'), 'green');
  await expect.poll(() => last.locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBe(1);
  await last.scrollIntoViewIfNeeded(); await color(last.locator('canvas'), 'blue'); await last.click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('彩色镜头 24'); await expect(last).toBeFocused();
  await color(page.locator('.preview-panel .scene-preview canvas'), 'blue');
  await first.scrollIntoViewIfNeeded(); await color(first.locator('canvas'), 'green');
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('彩色镜头 24');
  await expect.poll(() => last.locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBe(1);
});

test('cancels real frame reads without retaining thumbnail video elements or poisoning later requests', async ({ page, request }, info) => {
  const { project, asset } = await fixture(request, info); await open(page, project.title);
  await color(page.locator('.outline-shot').last().locator('canvas'), 'blue');
  const result = await page.evaluate(async asset => {
    const modulePath: string = '/src/components/preview-thumbnails.ts';
    const { videoThumbnails } = await import(modulePath);
    const controllers = Array.from({ length: 80 }, () => new AbortController());
    const pending = controllers.map((controller, index) => videoThumbnails.read({ asset, timeUs: index * 30_000, width: 123, height: 69 }, controller.signal));
    const settled = Promise.allSettled(pending);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); controllers.forEach(controller => controller.abort());
    const results = await settled;
    const retry = await videoThumbnails.read({ asset, timeUs: 2_500_000, width: 123, height: 69 }, new AbortController().signal);
    const rgb = retry.image.getContext('2d')!.getImageData(60, 30, 1, 1).data;
    return { canceled: results.filter(result => result.status === 'rejected' && result.reason instanceof DOMException && result.reason.name === 'AbortError').length, blue: rgb[2] > 160 && rgb[0] < 80 };
  }, asset);
  expect(result.canceled).toBeGreaterThan(0); expect(result.blue).toBe(true);
  const session = await page.context().newCDPSession(page);
  try {
    await expect.poll(async () => {
      const prototype = await session.send('Runtime.evaluate', { expression: 'HTMLVideoElement.prototype', objectGroup: 'thumbnail-cleanup' });
      const objects = await session.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: 'thumbnail-cleanup' });
      const result = await session.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId, returnByValue: true, functionDeclaration: "function () { return this.filter(video => video.getAttribute('src')).length; }" });
      await session.send('Runtime.releaseObjectGroup', { objectGroup: 'thumbnail-cleanup' }); return result.result.value;
    }).toBe(1);
  } finally { await session.detach(); }
});
