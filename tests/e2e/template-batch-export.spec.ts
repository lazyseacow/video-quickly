import { settingField, settingControl } from './settings';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createSceneTemplate, type AssetRecord, type ExportBatch, type ProjectDocument } from '@video-quickly/contracts';
import { batchTargetDirectory } from '../../packages/runtime/src/export-batches';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }); const payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function savedProject(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
async function createProject(request: APIRequestContext, title: string, template = false) {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title, profile: { width: 320, height: 180, frameRate: { numerator: 24, denominator: 1 }, fitMode: 'contain', previewScale: 1 } });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'template-shot', title: '模板镜头', narration: '', visualPrompt: '', durationUs: 1_000_000, ...(template ? { sceneTemplate: { ...createSceneTemplate('bar-chart'), motion: 'none' } } : {}) }] } });
}
async function openProject(page: Page, title: string) {
  await page.goto('/'); await page.getByRole('button', { name: '我的项目', exact: true }).click(); await page.locator('.project-card').filter({ hasText: title }).getByRole('button', { name: /继续创作/ }).click(); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('模板镜头');
}
async function save(page: Page) { const button = page.getByRole('button', { name: '保存镜头', exact: true }); await expect(button).not.toHaveAttribute('aria-busy', 'true'); if (await button.isEnabled()) await button.click(); await expect(button).toBeDisabled(); await expect(button).not.toHaveAttribute('aria-busy', 'true'); }
function observe(page: Page) { const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); return errors; }
async function canvasPixel(page: Page) { return page.locator('.preview-frame canvas').evaluate((element: HTMLCanvasElement) => [...element.getContext('2d')!.getImageData(Math.floor(element.width * .5), Math.floor(element.height * .6), 1, 1).data]); }
async function openBatch(page: Page) {
  await page.getByRole('button', { name: '导出', exact: true }).click(); const single = page.getByRole('dialog', { name: '导出视频', exact: true }); await single.getByRole('tab', { name: '其他导出', exact: true }).click(); await single.getByRole('button', { name: '多比例批量导出', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '多比例批量导出', exact: true }); await expect(dialog).toBeVisible(); await expect(single).toHaveCount(0); return dialog;
}
async function startBatch(page: Page, dialog: Locator) {
  const response = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'render.batch.start');
  await dialog.getByRole('button', { name: '开始导出', exact: true }).click(); const payload = await (await response).json(); expect(payload.error).toBeUndefined(); return payload.result as ExportBatch;
}
async function completed(request: APIRequestContext, batchId: string, status: ExportBatch['status'] = 'succeeded') {
  await expect.poll(async () => (await rpc<ExportBatch>(request, 'render.batch.get', { batchId })).status, { timeout: 90_000 }).toBe(status); return rpc<ExportBatch>(request, 'render.batch.get', { batchId });
}
function probe(path: string) {
  return JSON.parse(execFileSync(process.env.VIDEO_QUICKLY_FFPROBE ?? 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-show_entries', 'format=duration', '-of', 'json', path], { encoding: 'utf8' })) as { streams: Array<{ width: number; height: number; r_frame_rate: string }>; format: { duration: string } };
}
async function assertMedia(batch: ExportBatch) {
  for (const target of batch.targets) {
    expect(target.status).toBe('succeeded'); expect(target.videoPath).toBeTruthy(); const result = probe(target.videoPath!);
    expect(result.streams[0]).toMatchObject({ width: target.profile.width, height: target.profile.height, r_frame_rate: `${target.profile.frameRate.numerator}/${target.profile.frameRate.denominator}` });
    expect(Number(result.format.duration)).toBeGreaterThanOrEqual(.95); expect(Number(result.format.duration)).toBeLessThan(1.2);
    const frame = execFileSync(process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', target.videoPath!, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-']); expect(frame.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    for (const path of [target.coverPath, target.subtitlePath, target.timelinePath]) { expect(path).toBeTruthy(); expect((await stat(path!)).isFile()).toBe(true); }
  }
}

test('edits real process, comparison and chart templates, preserving media through undo and reload', async ({ page, request }, info) => {
  const errors = observe(page); let project = await createProject(request, '科普模板编辑与恢复验收');
  const path = info.outputPath('original-magenta.svg'); await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#ff00ff"/></svg>'); const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, shotId: project.shots[0].id, path }); project = await savedProject(request, project.id);
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map(shot => ({ ...shot, sceneInUs: 400_000, sceneDurationUs: 2_000_000, captionTrack: { timeBase: 'scene', alignment: 'manual', cues: [{ id: 'existing-caption', startUs: 400_000, endUs: 1_400_000, text: '保留原字幕时间' }] } })) } });
  await openProject(page, project.title); await expect.poll(() => canvasPixel(page)).toEqual([255, 0, 255, 255]);
  const selector = page.getByLabel('科普画面模板', { exact: true }); await selector.selectOption('process'); await expect(page.getByText('示例内容请自行替换，并核对事实与数据。', { exact: true })).toBeVisible();
  await page.getByLabel('模板动效', { exact: true }).selectOption('none'); await page.getByLabel('模板标题', { exact: true }).fill('研究问题如何得到解释'); await page.getByLabel('流程步骤 1 标题', { exact: true }).fill('观察现象'); await page.getByLabel('流程步骤 1 说明', { exact: true }).fill('记录可以核对的观察。'); await save(page);
  let saved = await savedProject(request, project.id); expect(saved.shots[0]).toMatchObject({ sceneInUs: 400_000, sceneDurationUs: 2_000_000, captionTrack: project.shots[0].captionTrack }); expect(saved.shots[0]).toMatchObject({ assetId: asset.id, sceneTemplate: { kind: 'process', heading: '研究问题如何得到解释', steps: expect.arrayContaining([{ title: '观察现象', detail: '记录可以核对的观察。' }]) } }); await expect(page.getByLabel('画面素材', { exact: true })).toBeDisabled(); await expect(page.getByLabel('镜头视频', { exact: true })).toBeDisabled(); await expect.poll(() => canvasPixel(page)).not.toEqual([255, 0, 255, 255]);
  await page.getByLabel('模板标题', { exact: true }).fill('流程标题的下一次修订'); await page.getByLabel('模板标题', { exact: true }).press('Tab'); await save(page); await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(page.getByLabel('模板标题', { exact: true })).toHaveValue('研究问题如何得到解释'); await expect(page.getByRole('button', { name: '重做', exact: true })).toBeEnabled(); await page.getByRole('button', { name: '重做', exact: true }).click(); await expect(page.getByLabel('模板标题', { exact: true })).toHaveValue('流程标题的下一次修订');
  await selector.selectOption('comparison'); await page.getByLabel('模板动效', { exact: true }).selectOption('none'); await page.getByLabel('对照左栏标题', { exact: true }).fill('观察'); await page.getByLabel('对照右栏标题', { exact: true }).fill('解释'); await page.getByLabel('对照左栏要点 1', { exact: true }).fill('保留证据来源'); await page.getByRole('button', { name: '增加右栏要点', exact: true }).click(); await save(page); saved = await savedProject(request, project.id); expect(saved.shots[0].sceneTemplate).toMatchObject({ kind: 'comparison', left: { title: '观察', points: ['保留证据来源', expect.any(String), expect.any(String)] }, right: { title: '解释', points: expect.any(Array) } });
  await selector.selectOption('bar-chart'); await page.getByLabel('模板动效', { exact: true }).selectOption('none'); await page.getByLabel('模板标题', { exact: true }).fill('三次实验的计数'); await page.getByLabel('数据单位', { exact: true }).fill('次'); await page.getByLabel('数据 1 名称', { exact: true }).fill('实验甲'); await page.getByLabel('数据 1 数值', { exact: true }).fill('12'); await page.getByLabel('数据 2 数值', { exact: true }).fill('34'); await page.getByLabel('模板配色', { exact: true }).selectOption('blue'); await save(page); saved = await savedProject(request, project.id); expect(saved.shots[0]).toMatchObject({ assetId: asset.id, sceneTemplate: { kind: 'bar-chart', heading: '三次实验的计数', unit: '次', palette: 'blue', bars: [{ label: '实验甲', value: 12 }, { value: 34 }, { value: 36 }] } });
  await page.getByLabel('模板标题', { exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('scene-template-chart-dark.png') });
  await page.reload(); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click(); await expect(selector).toHaveValue('bar-chart'); await expect(page.getByLabel('数据 1 数值', { exact: true })).toHaveValue('12'); expect((await savedProject(request, project.id)).shots[0].sceneTemplate).toEqual(saved.shots[0].sceneTemplate);
  await page.getByRole('button', { name: '清除画面模板', exact: true }).click(); await save(page); expect((await savedProject(request, project.id)).shots[0].sceneTemplate).toBeUndefined(); expect((await savedProject(request, project.id)).shots[0].assetId).toBe(asset.id); await expect.poll(() => canvasPixel(page)).toEqual([255, 0, 255, 255]);
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(selector).toHaveValue('bar-chart'); await expect.poll(async () => (await savedProject(request, project.id)).shots[0].sceneTemplate).toEqual(saved.shots[0].sceneTemplate); expect(errors).toEqual([]);
});

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 1024, height: 768, theme: 'light' }, { width: 600, height: 900, theme: 'light' }, { width: 390, height: 844, theme: 'dark' }]) {
  test(`gives expanded batch settings the full content width and retains frame rate choices at ${viewport.width}px`, async ({ page, request }, info) => {
    const errors = observe(page); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const project = await createProject(request, `批量规格宽度验收 ${viewport.width}`);
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    await openProject(page, project.title); await page.setViewportSize(viewport); const dialog = await openBatch(page);
    await expect(page).toHaveTitle(/Video Quickly/);
    const landscape = dialog.getByRole('region', { name: '导出规格 横屏 16:9', exact: true });
    const portrait = dialog.getByRole('region', { name: '导出规格 竖屏 9:16', exact: true });
    const square = dialog.getByRole('region', { name: '导出规格 方形 1:1', exact: true });
    const landscapeToggle = landscape.locator('summary'), portraitToggle = portrait.locator('summary');
    await landscapeToggle.click();
    const frameRate = landscape.getByLabel('视频帧率', { exact: true });
    expect(await frameRate.locator('option:not([disabled])').allTextContents()).toEqual(['30 fps', '60 fps']);
    await frameRate.selectOption('30'); await portraitToggle.click(); await portrait.getByLabel('视频帧率', { exact: true }).selectOption('60');
    for (const card of [landscape, portrait]) {
      const layout = await card.evaluate(element => {
        const bounds = element.getBoundingClientRect(), grid = element.parentElement!.getBoundingClientRect();
        const controls = [...element.querySelectorAll<HTMLElement>('.video-settings input, .video-settings select')].map(control => ({ width: control.getBoundingClientRect().width, left: control.getBoundingClientRect().left, right: control.getBoundingClientRect().right }));
        return { width: bounds.width, gridWidth: grid.width, left: bounds.left, right: bounds.right, controls, scroll: element.scrollWidth - element.clientWidth };
      });
      expect(layout.width).toBeCloseTo(layout.gridWidth, 0); expect(layout.scroll).toBeLessThanOrEqual(1);
      for (const control of layout.controls) { expect(control.width).toBeGreaterThanOrEqual(80); expect(control.left).toBeGreaterThanOrEqual(layout.left); expect(control.right).toBeLessThanOrEqual(layout.right); }
      const ratio = await card.getByLabel('画面比例', { exact: true }).boundingBox(); expect(ratio!.width).toBeGreaterThanOrEqual(180);
    }
    expect((await square.boundingBox())!.height).toBeLessThan(300);
    await portraitToggle.focus(); await page.keyboard.press('Space'); await expect(portrait.locator('details')).not.toHaveAttribute('open');
    await dialog.getByRole('tab', { name: '输出设置', exact: true }).click(); await dialog.getByRole('tab', { name: '导出规格', exact: true }).click();
    await expect(frameRate).toHaveValue('30'); await portraitToggle.click(); await expect(portrait.getByLabel('视频帧率', { exact: true })).toHaveValue('60'); await portraitToggle.click();
    await expect(dialog.locator('.dialog__footer')).toBeInViewport({ ratio: 1 });
    await dialog.locator('.settings-sections__content').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath('batch-expanded-settings.png') });
    await landscapeToggle.click(); await landscapeToggle.click(); await expect(frameRate).toHaveValue('30');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]); expect(await savedProject(request, project.id)).toEqual(project);
  });
}

test('exports three actual MP4 aspect ratios, restores the exact batch and leaves project specifications unchanged', async ({ page, request }, info) => {
  test.setTimeout(120_000); const errors = observe(page), project = await createProject(request, '三比例真实批量导出验收', true); await openProject(page, project.title); let dialog = await openBatch(page);
  for (const label of ['横屏 16:9', '竖屏 9:16', '方形 1:1']) await (await settingField(dialog, `${label} 短边（像素）`)).fill('144');
  await expect(dialog.getByRole('tab', { name: '导出规格', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.locator('[role="tabpanel"]:visible')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('batch-export-target-sections.png') });
  const portrait = dialog.getByRole('region', { name: '导出规格 竖屏 9:16', exact: true }); await portrait.getByText('调整竖屏 9:16规格', { exact: true }).click(); await portrait.getByLabel('视频帧率', { exact: true }).selectOption('60'); await portrait.getByLabel('素材适配', { exact: true }).selectOption('cover');
  const destination = info.outputPath('three-ratios'); await (await settingField(dialog, '批量输出目录')).fill(destination);
  await dialog.getByRole('tab', { name: '导出规格', exact: true }).click(); await expect(dialog.getByLabel('横屏 16:9 短边（像素）', { exact: true })).toHaveValue('144');
  await dialog.getByRole('tab', { name: '输出设置', exact: true }).click(); await expect(dialog.getByLabel('批量输出目录', { exact: true })).toHaveValue(destination);
  const batch = await startBatch(page, dialog); expect(batch.projectRevision).toBe(project.revision);
  await expect(dialog.getByRole('tab', { name: '导出记录', exact: true })).toHaveAttribute('aria-selected', 'true');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await expect(dialog).toHaveCount(0); dialog = await openBatch(page); await expect((await settingField(dialog, '批量导出记录'))).toHaveValue(batch.id);
  await expect(dialog.getByRole('tab', { name: '导出记录', exact: true })).toHaveAttribute('aria-selected', 'true');
  const done = await completed(request, batch.id); await expect(dialog.locator('.batch-export__summary')).toContainText('全部完成'); expect(done.targets.map(target => [target.profile.width, target.profile.height])).toEqual([[256, 144], [144, 256], [144, 144]]); await assertMedia(done); expect(await savedProject(request, project.id)).toEqual(project);
  await dialog.locator('.batch-export__summary').scrollIntoViewIfNeeded(); await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1'); await expect(dialog.getByRole('button', { name: '校验并恢复导出', exact: true })).toBeInViewport({ ratio: 1 }); await page.screenshot({ path: info.outputPath('batch-export-results-dark.png') });
  const first = done.targets[0].videoPath!, before = await stat(first), hash = createHash('sha256').update(await readFile(first)).digest('hex'); await dialog.getByRole('button', { name: '校验并恢复导出', exact: true }).click(); await completed(request, batch.id); expect((await stat(first)).mtimeMs).toBe(before.mtimeMs); expect(createHash('sha256').update(await readFile(first)).digest('hex')).toBe(hash);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await page.getByRole('button', { name: '浅色外观', exact: true }).click(); await page.setViewportSize({ width: 600, height: 900 }); dialog = await openBatch(page); await expect((await settingField(dialog, '批量导出记录'))).toHaveValue(batch.id); await dialog.locator('.batch-export__summary').scrollIntoViewIfNeeded(); await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1'); await expect(dialog.getByRole('button', { name: '校验并恢复导出', exact: true })).toBeInViewport({ ratio: 1 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await page.screenshot({ path: info.outputPath('batch-export-results-light-600.png') }); expect(errors).toEqual([]);
});

test('keeps an open batch configuration on an external project revision conflict', async ({ page, request }) => {
  const errors = observe(page), project = await createProject(request, '批量导出固定修订验收', true); await openProject(page, project.title); let dialog = await openBatch(page);
  await (await settingControl(dialog, 'checkbox', { name: '竖屏 9:16', exact: true })).uncheck(); await (await settingControl(dialog, 'checkbox', { name: '方形 1:1', exact: true })).uncheck(); await (await settingField(dialog, '横屏 16:9 短边（像素）')).fill('144');
  const remote = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { title: `${project.title}外部修订` } });
  const response = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'render.batch.start'); await dialog.getByRole('button', { name: '开始导出', exact: true }).click(); expect((await response).status()).toBe(400); await expect(dialog.getByRole('alert')).toBeVisible(); await expect((await settingField(dialog, '横屏 16:9 短边（像素）'))).toHaveValue('144');
  expect((await rpc<{ items: ExportBatch[] }>(request, 'render.batch.list', { projectId: project.id })).items).toEqual([]); expect(await savedProject(request, project.id)).toEqual(remote);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); dialog = await openBatch(page); await expect(dialog.locator('.batch-export__intro')).toContainText(`修订 ${remote.revision}`); expect(errors).toEqual([]);
});

test('keeps the successful MP4 when another target fails, then restores only the unfinished target', async ({ page, request }, info) => {
  test.setTimeout(150_000); const errors = observe(page), project = await createProject(request, '批量部分失败与恢复验收', true); await openProject(page, project.title); let dialog = await openBatch(page);
  await (await settingControl(dialog, 'checkbox', { name: '方形 1:1', exact: true })).uncheck(); await (await settingField(dialog, '横屏 16:9 短边（像素）')).fill('720'); await (await settingField(dialog, '竖屏 9:16 短边（像素）')).fill('144'); await (await settingField(dialog, '批量输出目录')).fill(info.outputPath('partial-output'));
  let blocker = '';
  await page.route('**/__desktop_rpc', async route => {
    if (route.request().postDataJSON()?.method !== 'render.batch.start') { await route.continue(); return; }
    const response = await route.fetch(), payload = await response.json();
    if (!payload.error) {
      const batch = payload.result as ExportBatch; if (!batch.destinationDirectory) throw new Error('批量导出未返回实际输出目录');
      const directory = batchTargetDirectory(batch.destinationDirectory, batch.targets[1].id); await mkdir(directory, { recursive: true }); blocker = join(directory, 'video.mp4'); await writeFile(blocker, 'existing file owned by the test fixture', { flag: 'wx' });
    }
    // Preserve the actual API response. The failure is a real filesystem collision.
    await route.fulfill({ response });
  });
  const batch = await startBatch(page, dialog), partial = await completed(request, batch.id, 'partial'); expect(partial.targets.map(target => target.status)).toEqual(['succeeded', 'failed']); expect(await readFile(blocker, 'utf8')).toBe('existing file owned by the test fixture');
  await expect(dialog.locator('.batch-export__summary')).toContainText('部分完成'); const failed = dialog.getByRole('article', { name: '导出结果 竖屏 9:16', exact: true }); await expect(failed.getByRole('alert')).toBeVisible();
  const successfulPath = partial.targets[0].videoPath!, successfulStat = await stat(successfulPath), successfulHash = createHash('sha256').update(await readFile(successfulPath)).digest('hex');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await expect(dialog).toHaveCount(0); dialog = await openBatch(page); await expect((await settingField(dialog, '批量导出记录'))).toHaveValue(batch.id); await expect(dialog.locator('.batch-export__summary')).toContainText('部分完成');
  await rm(blocker); await dialog.getByRole('button', { name: '继续未完成导出', exact: true }).click(); const resumed = await completed(request, batch.id); expect(resumed.id).toBe(batch.id); expect((await stat(successfulPath)).mtimeMs).toBe(successfulStat.mtimeMs); expect(createHash('sha256').update(await readFile(successfulPath)).digest('hex')).toBe(successfulHash); await assertMedia(resumed);
  expect(await savedProject(request, project.id)).toEqual(project); await expect(dialog.locator('.batch-export__summary')).toContainText('全部完成'); expect(errors).toEqual([]);
});
