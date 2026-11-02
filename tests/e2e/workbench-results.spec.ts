import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import type { AssetRecord, ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function saved(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
function wav() {
  const rate = 8000, samples = rate * 2, data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) data.writeInt16LE(Math.round(Math.sin(index / rate * Math.PI * 440) * 3000), 44 + index * 2);
  return data;
}
async function fixture(request: APIRequestContext, info: TestInfo) {
  const server = createServer((incoming, response) => {
    incoming.resume(); incoming.on('end', () => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ segments: [{ start: .1, end: .7, text: '城市正在变化。' }, { start: .9, end: 1.6, text: '故事从这里开始。' }] })); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('字幕夹具未启动');
  try {
    const model = await rpc<{ id: string }>(request, 'model.save', { model: { name: '字幕预览夹具', provider: 'openai-compatible', model: 'timestamp-fixture', capabilities: ['asr'], baseUrl: `http://127.0.0.1:${address.port}/v1` } });
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `可视化制作 ${randomUUID().slice(0, 8)}`, brief: '用两个镜头介绍城市的变化。' });
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
      profile: { ...created.profile, width: 320, height: 180 }, shots: [
        { id: 'first', title: '城市清晨', narration: '城市正在变化。', visualPrompt: '暖色晨光下的城市全景。', durationUs: 2_000_000 },
        { id: 'second', title: '街道故事', narration: '故事从这里开始。', visualPrompt: '街道与行人，保持统一的写实风格。', durationUs: 2_000_000 },
      ], workflow: { id: 'visual-production', name: '可视化制作', version: 1, nodes: [
        { id: 'script', kind: 'script', label: '准备分镜' }, { id: 'assets', kind: 'assets', label: '准备画面' },
        { id: 'voice', kind: 'voice', label: '准备配音' }, { id: 'captions', kind: 'voice', label: '识别字幕', modelId: model.id, config: { operation: 'transcribe', shotId: 'first' } },
        { id: 'animation', kind: 'animation', label: '设置运镜' }, { id: 'review', kind: 'review', label: '审阅小样', requiresReview: true }, { id: 'export', kind: 'export', label: '导出成片' },
      ].map((node, index) => ({ ...node, position: { x: index * 260, y: 0 } })), edges: ['script', 'assets', 'voice', 'captions', 'animation', 'review'].map((source, index, ids) => ({ id: `edge-${index}`, source, target: ids[index + 1] ?? 'export' })) },
    } });
    const images: AssetRecord[] = [];
    for (const shot of project.shots) {
      const imagePath = info.outputPath(`${shot.title}.png`), audioPath = info.outputPath(`${shot.title}.wav`);
      await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
      await writeFile(audioPath, wav());
      images.push(await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, shotId: shot.id, path: imagePath }));
      await rpc(request, 'asset.import', { projectId: project.id, shotId: shot.id, path: audioPath });
    }
    return { project: await saved(request, project.id), images, server };
  } catch (error) { await close(server); throw error; }
}
async function open(page: Page, project: ProjectDocument) {
  await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/);
  await page.getByRole('button', { name: '我的项目', exact: true }).click(); await page.getByLabel('搜索项目', { exact: true }).fill(project.title);
  await page.locator('.project-card').filter({ hasText: project.title }).getByRole('button', { name: '继续创作', exact: true }).click();
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(project.title);
}
for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`previews real storyboard, image, audio, captions and exported video while retaining all production steps at ${viewport.width}px`, async ({ page, request }, info) => {
    // Two bounded production waits plus media inspection and downloads share this case.
    test.setTimeout(90_000);
    const source = await fixture(request, info), errors: string[] = [], consoleErrors: string[] = [], payloadKinds: string[] = [];
    let imageFailed = false;
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) { const input = request.postDataJSON(); if (input.method === 'run.step.payload') payloadKinds.push(input.params.kind); } });
    try {
      await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme); await open(page, source.project);
      await page.getByRole('button', { name: '开始制作', exact: true }).click();
      const panel = page.getByRole('region', { name: '当前制作', exact: true }); await expect(panel.getByRole('button', { name: '通过审阅并继续', exact: true })).toBeEnabled({ timeout: 30_000 });
      await panel.locator('.workbench-guide__step[aria-current="step"]').click();
      const detail = page.getByRole('dialog', { name: '制作步骤详情', exact: true }), steps = detail.getByRole('navigation', { name: '冻结流程步骤' });
      await expect(steps.getByRole('button')).toHaveCount(7); await expect(detail.getByRole('tab', { name: '执行输入', exact: true })).toHaveCount(0);
      await steps.getByRole('button', { name: /准备分镜/ }).click(); const storyboard = detail.getByRole('region', { name: '分镜预览', exact: true });
      await expect(storyboard.locator('li')).toHaveCount(2); await expect(storyboard).toContainText('4.0 秒'); await expect(storyboard).toContainText('暖色晨光'); await expect(storyboard).not.toContainText('动画与运镜'); await expect(detail.locator('pre')).toHaveCount(0);
      await detail.getByRole('button', { name: '在项目中查看与应用', exact: true }).click();
      const output = page.getByRole('dialog', { name: '步骤产物', exact: true }); await expect(output.getByRole('region', { name: '分镜预览', exact: true })).toContainText('城市清晨'); await expect(output.locator('pre')).toHaveCount(0);
      await expect(output.locator('.dialog__surface')).toHaveCSS('opacity', '1'); await page.screenshot({ path: info.outputPath('storyboard-results.png') });
      await output.getByRole('button', { name: '关闭', exact: true }).click(); await panel.locator('.workbench-guide__step[aria-current="step"]').click();
      if (viewport.width === 1536) await page.route('**/__desktop_asset**', async route => {
        if (!imageFailed && new URL(route.request().url()).searchParams.get('path') === source.images[0].path) { imageFailed = true; await route.fulfill({ status: 404, body: 'unavailable fixture' }); } else await route.continue();
      });
      await steps.getByRole('button', { name: /准备画面/ }).click();
      if (viewport.width === 1536) { await expect(detail.getByRole('alert')).toContainText('媒体暂时无法预览'); await detail.getByRole('button', { name: '重试预览', exact: true }).click(); }
      const image = detail.getByRole('img', { name: source.images[0].name, exact: true }); await expect.poll(() => image.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      await detail.getByLabel('选择媒体', { exact: true }).getByRole('button', { name: source.images[1].name, exact: true }).click();
      await expect(detail.getByRole('img', { name: source.images[1].name, exact: true })).toBeVisible();
      await steps.getByRole('button', { name: /准备配音/ }).click(); const audio = detail.locator('audio'); await expect.poll(() => audio.evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThanOrEqual(1);
      await audio.evaluate(async (audio: HTMLAudioElement) => { audio.muted = true; await audio.play(); }); await expect.poll(() => audio.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0);
      const playingAudio = await audio.elementHandle(); if (!playingAudio) throw new Error('配音预览未挂载');
      await steps.getByRole('button', { name: /识别字幕/ }).click(); const captions = detail.getByRole('region', { name: '字幕预览', exact: true });
      await expect.poll(() => playingAudio.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true); await playingAudio.dispose();
      await expect(captions.locator('li')).toHaveCount(2); await expect(captions).toContainText('城市正在变化'); await expect(captions).toContainText('语音对齐'); await expect(detail.locator('pre')).toHaveCount(0);
      await expect(detail.locator('.dialog__surface')).toHaveCSS('opacity', '1'); await page.screenshot({ path: info.outputPath('caption-results.png') });
      await detail.getByRole('button', { name: '关闭', exact: true }).click();
      await panel.getByRole('button', { name: '通过审阅并继续', exact: true }).click();
      await expect(panel.locator('.workbench-guide__step[data-state="succeeded"]')).toHaveCount(7, { timeout: 30_000 }); await expect(panel.getByRole('list', { name: '制作步骤进度', exact: true }).locator('li')).toHaveCount(7);
      await panel.getByRole('button', { name: '查看产物', exact: true }).click(); const video = output.locator('video');
      await expect.poll(() => video.evaluate((video: HTMLVideoElement) => video.videoWidth)).toBe(320);
      await expect(video).toHaveAttribute('controls', ''); await expect(output.getByRole('button', { name: '应用到项目', exact: true })).toHaveCount(0);
      const download = page.waitForEvent('download'); await output.getByRole('link', { name: '下载成片', exact: true }).click();
      const path = info.outputPath('downloaded.mp4'); await (await download).saveAs(path); expect((await readFile(path)).subarray(4, 8).toString()).toBe('ftyp');
      expect(await saved(request, source.project.id)).toEqual(source.project); expect(payloadKinds).not.toContain('input'); expect(errors).toEqual([]);
      expect(consoleErrors.filter(error => !imageFailed || !error.includes('404'))).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      expect(await output.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await close(source.server); }
  });
}
