import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { DramaWork, ProjectDocument, RecordPage, RunSummary } from '@video-quickly/contracts';
import { probeMedia } from '../../src/packages/video/src/media-process';
import { openProjectFromList, openStudio } from './workspace-navigation';
import { settingField } from './settings';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) test('changes preview quality locally without editing production settings at ' + viewport.width + 'px', async ({ page, request }, info) => {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: '预览质量 ' + randomUUID().slice(0, 8), originalText: '第一场：清晨，人物来到窗前，抬头看向窗外的街道。', profile: { width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, previewScale: 1 } });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [{ id: 'preview-shot', title: '预览镜头', narration: '', visualPrompt: '', durationUs: 1_000_000 }] } });
  const writes: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) { const method = request.postDataJSON()?.method; if (['project.update', 'run.start', 'render.export'].includes(method)) writes.push(method); } });
  await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
  await page.goto('/'); await openProjectFromList(page, project.title);
  const controls = page.locator('.preview-controls'), quality = controls.getByRole('combobox', { name: '预览质量', exact: true }), canvas = page.locator('.preview-frame canvas');
  const qualityControl = controls.locator('.preview-quality-control');
  const fullscreen = controls.getByRole('button', { name: '全屏预览', exact: true });
  await expect(quality).toHaveValue('1'); await expect(quality).toBeInViewport();
  await expect(page.locator('.preview-toolbar .preview-quality')).toHaveCount(0);
  await quality.click(); await expect(quality).toHaveJSProperty('value', '1');
  await expect(qualityControl).toHaveCSS('outline-style', 'none');
  const picker = await quality.getByRole('option', { name: '原画', exact: true }).boundingBox(), control = await quality.boundingBox(), fullscreenBounds = await fullscreen.boundingBox();
  expect(picker).not.toBeNull(); expect(control).not.toBeNull(); expect(fullscreenBounds).not.toBeNull();
  expect(picker!.y + picker!.height).toBeLessThan(control!.y);
  expect(picker!.x).toBeGreaterThan(control!.x - 132);
  expect(picker!.x + picker!.width).toBeLessThanOrEqual(control!.x + control!.width);
  expect(control!.x + control!.width).toBeLessThanOrEqual(fullscreenBounds!.x);
  await page.screenshot({ path: info.outputPath('preview-quality-menu-' + viewport.width + '.png') });
  await quality.press('Escape');

  await page.keyboard.press('Tab'); await expect(fullscreen).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(quality).toBeFocused();
  await expect(qualityControl).toHaveCSS('outline-style', 'solid');
  await expect(qualityControl).toHaveCSS('outline-offset', '-2px');
  await expect(quality).toHaveCSS('box-shadow', 'none');
  await page.mouse.move(0, 0);
  await controls.screenshot({ path: info.outputPath(`preview-quality-focus-${viewport.width}.png`) });
  await quality.press('Space');
  await expect(quality.getByRole('option', { name: '原画', exact: true })).toBeVisible();
  await quality.press('Escape'); await expect(quality).toBeFocused();

  if (viewport.width === 1536) {
    const volume = controls.getByRole('slider', { name: '预览音量', exact: true });
    const volumeControl = controls.locator('.preview-volume__slider');
    await page.keyboard.press('Shift+Tab'); await expect(volume).toBeFocused();
    await expect(volumeControl).toHaveCSS('outline-style', 'solid');
    await expect(volumeControl).toHaveCSS('outline-offset', '-2px');
    await expect(volume).toHaveCSS('box-shadow', 'none');
    await expect(qualityControl).toHaveCSS('outline-style', 'none');
    const slider = (await volume.boundingBox())!, volumeBounds = (await volumeControl.boundingBox())!, qualityBounds = (await qualityControl.boundingBox())!;
    expect(slider.x).toBeGreaterThan(volumeBounds.x);
    expect(slider.x + slider.width).toBeLessThan(volumeBounds.x + volumeBounds.width);
    expect(volumeBounds.x + volumeBounds.width).toBeLessThan(qualityBounds.x);
    await controls.screenshot({ path: info.outputPath('preview-volume-focus.png') });
    await page.keyboard.press('Tab'); await expect(quality).toBeFocused();
    await volume.click(); await expect(volume).toBeFocused();
    await expect(volumeControl).toHaveCSS('outline-style', 'none');
    await expect(volume).toHaveCSS('box-shadow', 'none');
  }
  await quality.selectOption('0.25'); await expect(canvas).toHaveJSProperty('width', 160); await expect(canvas).toHaveJSProperty('height', 90);
  await expect(page.locator('.unsaved-dot')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('preview-quality-' + viewport.width + '.png') });
  await page.reload(); await openProjectFromList(page, project.title);
  await expect(quality).toHaveValue('0.25'); await expect(canvas).toHaveJSProperty('width', 160);
  await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '制作设置', exact: true });
  await expect(dialog.getByRole('navigation', { name: '制作设置步骤', exact: true }).getByRole('button')).toHaveText(['1创作要求', '2模型与素材', '3声音与成片', '4确认保存']);
  await expect(dialog.getByLabel('预览质量', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '备份项目与素材', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('production-sections-' + viewport.width + '.png') });
  expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project).toEqual(project);
  expect(writes).toEqual([]); expect(errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

test('exports a saved episode from its workbench and retains the MP4 after permanent deletion', async ({ page, request }, info) => {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: '完整视频 ' + randomUUID().slice(0, 8), originalText: '第一场：人物推门。第二场：人物回望。', profile: { width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 }, previewScale: 1 } });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
    shots: [1, 2].map(index => ({ id: `download-shot-${index}`, title: `成片镜头 ${index}`, narration: '', visualPrompt: '', durationUs: 1_000_000 })),
  } });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/'); await openProjectFromList(page, project.title);
  await page.locator('.project-heading-actions').getByRole('button', { name: '导出', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导出视频', exact: true });
  await (await settingField(dialog, '输出文件路径')).fill(info.outputPath('episode-full.mp4'));
  const exportButton = dialog.getByRole('button', { name: '导出 MP4', exact: true });
  let attempts = 0, enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/__desktop_rpc', async route => {
    if (route.request().postDataJSON()?.method !== 'render.export') { await route.continue(); return; }
    attempts++;
    if (attempts === 1) { await route.fulfill({ status: 400, json: { error: '隔离的导出失败' } }); return; }
    enter(); await pending; await route.continue();
  });
  try {
    await exportButton.click(); await expect(page.getByRole('alert')).toContainText('隔离的导出失败'); await expect(exportButton).toBeEnabled();
    const response = page.waitForResponse(value => value.url().endsWith('/__desktop_rpc') && value.request().postDataJSON()?.method === 'render.export');
    await exportButton.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); }); await entered;
    await expect(exportButton).toBeDisabled(); expect(attempts).toBe(2); release();
    const { runId } = (await (await response).json()).result as { runId: string };
    await expect(dialog.getByText(/文件已保存/)).toBeVisible({ timeout: 30_000 });
    const { videoPath } = await rpc<{ videoPath: string }>(request, 'node.result', { runId, nodeId: 'export' });
    expect(videoPath).toBe(info.outputPath('episode-full.mp4'));
    const media = await probeMedia(videoPath, process.env.VIDEO_QUICKLY_FFPROBE);
    expect(media).toMatchObject({ width: 320, height: 180, frameRate: '30/1' }); expect(media.videoDuration).toBeCloseTo(2, 2);
    expect((await stat(videoPath)).size).toBeGreaterThan(500);
    await expect(exportButton).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('episode-workbench-export.png') });
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project).toEqual(project);
    const bytes = await readFile(videoPath);
    await rpc(request, 'project.archive', { projectId: project.id }); await rpc(request, 'project.deleteMany', { projectIds: [project.id] });
    expect(await readFile(videoPath)).toEqual(bytes);
    expect((await rpc<RecordPage<RunSummary>>(request, 'run.list', { projectId: project.id })).items).toMatchObject([{ id: runId, status: 'succeeded' }]);
  } finally { release(); }
});

for (const { width, height, theme } of [{ width: 1024, height: 720, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`searches works, archives only the selected work and restores its episode navigation at ${width}px`, async ({ page, request }, info) => {
    const group = `作品归档 ${randomUUID().slice(0, 8)}`;
    const values: Array<{ work: DramaWork; project: ProjectDocument }> = [];
    for (const suffix of ['甲', '乙']) values.push(await rpc(request, 'dramaStudio.create', { mode: 'upload', originalText: `第一场：人物寻找${suffix}号维修单。`,
      work: { title: `${group} ${suffix}`, visualStyle: 'live-action', narrativeMode: 'mixed', description: `${suffix}号人物的独立故事` } }));
    const [first, keep] = values;
    await page.setViewportSize({ width, height }); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), theme); await page.goto('/');
    const writes: string[] = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) { const method = request.postDataJSON().method; if (['dramaWork.archive', 'dramaWork.restore', 'project.archive', 'project.deleteMany'].includes(method)) writes.push(method); } });
    await openStudio(page); await page.getByLabel('搜索作品', { exact: true }).fill(group);
    const card = (work: DramaWork) => page.locator(`.drama-work-card[data-work-id="${work.id}"]`);
    const filters = page.getByRole('group', { name: '作品筛选', exact: true });
    await expect(card(first.work)).toBeVisible(); await expect(card(keep.work)).toBeVisible();
    await card(first.work).getByRole('button', { name: '查看分集', exact: true }).click();
    const episode = page.locator(`.drama-episode-row[data-project-id="${first.project.id}"]`);
    await expect(episode.getByRole('heading', { name: first.project.title, exact: true })).toBeVisible();
    await page.getByRole('button', { name: '归档作品', exact: true }).click(); await expect(page.getByRole('button', { name: '恢复作品', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '新建分集', exact: true })).toBeDisabled();
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: first.project.id })).project).toEqual(first.project);
    expect(await rpc<DramaWork>(request, 'dramaWork.get', { workId: keep.work.id })).toEqual(keep.work);
    await openStudio(page); await page.getByLabel('搜索作品', { exact: true }).fill(group);
    await expect(card(first.work)).toHaveCount(0); await expect(card(keep.work)).toBeVisible();
    await filters.getByRole('button', { name: '已归档', exact: true }).click();
    await expect(card(first.work)).toBeVisible(); await expect(card(keep.work)).toHaveCount(0);
    await card(first.work).getByRole('button', { name: '查看分集', exact: true }).click();
    await page.getByRole('button', { name: '恢复作品', exact: true }).click(); await expect(page.getByRole('button', { name: '新建分集', exact: true })).toBeEnabled();
    await page.screenshot({ path: info.outputPath(`work-archive-restored-${width}.png`) });
    await openProjectFromList(page, first.project.title); await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(first.project.title);
    await page.reload(); await expect(page.getByRole('heading', { name: '短剧工作室', level: 1, exact: true })).toBeVisible();
    await expect(page.locator('.workbench')).toHaveCount(0);
    expect(writes).toEqual(['dramaWork.archive', 'dramaWork.restore']); expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
