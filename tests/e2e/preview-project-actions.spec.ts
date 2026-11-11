import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { AssetRecord, ProjectDocument, RecordPage, RunSummary } from '@video-quickly/contracts';
import { probeMedia } from '../../packages/video/src/media-process';
import { openProjectFromList } from './workspace-navigation';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) test('changes preview quality locally without editing production settings at ' + viewport.width + 'px', async ({ page, request }, info) => {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: '预览质量 ' + randomUUID().slice(0, 8), profile: { width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, previewScale: 1 } });
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

test('downloads the whole saved project from its card and retains the exported MP4 after permanent deletion', async ({ page, request }, info) => {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: '完整视频 ' + randomUUID().slice(0, 8), profile: { width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 }, previewScale: 1 } });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
    workflow: { ...created.workflow, id: 'custom-download-test', stages: undefined, nodes: created.workflow.nodes.filter(node => node.kind === 'script'), edges: [] },
    shots: [1, 2].map(index => ({ id: `download-shot-${index}`, title: `成片镜头 ${index}`, narration: '', visualPrompt: '', durationUs: 1_000_000 })),
  } });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  const card = page.locator('.project-card').filter({ has: page.getByRole('heading', { name: project.title, exact: true }) });
  const download = card.getByRole('button', { name: `下载“${project.title}”的完整视频`, exact: true });
  await expect(card.locator('.project-card-footer').getByRole('button')).toHaveText(['', '', '']);
  let attempts = 0, enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/__desktop_rpc', async route => {
    if (route.request().postDataJSON()?.method !== 'render.export') { await route.continue(); return; }
    attempts++;
    if (attempts === 1) { await route.fulfill({ status: 400, json: { error: '隔离的导出失败' } }); return; }
    enter(); await pending; await route.continue();
  });
  try {
    await download.click(); await expect(page.getByRole('alert')).toContainText('隔离的导出失败'); await expect(download).toBeEnabled();
    const response = page.waitForResponse(value => value.url().endsWith('/__desktop_rpc') && value.request().postDataJSON()?.method === 'render.export');
    const downloaded = page.waitForEvent('download');
    await download.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); }); await entered;
    await expect(download).toBeDisabled(); expect(attempts).toBe(2); release();
    const { runId } = (await (await response).json()).result as { runId: string };
    const file = await downloaded;
    expect(file.suggestedFilename()).toBe(`${project.title}-成片.mp4`);
    const media = await probeMedia(await file.path(), process.env.VIDEO_QUICKLY_FFPROBE);
    expect(media).toMatchObject({ width: 320, height: 180, frameRate: '30/1' });
    expect(media.videoDuration).toBeCloseTo(2, 2);
    await expect(page.locator('.notice--success')).toContainText('完整视频已生成');
    await expect(download).toBeEnabled();
    expect(await page.locator('.page-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.locator('.notice--success').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('project-card-download.png') });
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project).toEqual(project);
    const { videoPath } = await rpc<{ videoPath: string }>(request, 'node.result', { runId, nodeId: 'export' });
    expect((await stat(videoPath)).size).toBe((await stat(await file.path())).size);
    await rpc(request, 'project.archive', { projectId: project.id });
    await rpc(request, 'project.deleteMany', { projectIds: [project.id] });
    expect(await readFile(videoPath)).toEqual(await readFile(await file.path()));
    expect((await rpc<RecordPage<RunSummary>>(request, 'run.list', { projectId: project.id })).items).toMatchObject([{ id: runId, status: 'succeeded' }]);
  } finally { release(); }
});

test('starts on the project list and moves only checked projects into and out of the recycle bin', async ({ page, request }, info) => {
  const group = `批量项目 ${randomUUID().slice(0, 8)}`;
  const projects = [];
  for (const suffix of ['甲', '乙', '丙', '丁']) projects.push(await rpc<ProjectDocument>(request, 'project.create', { title: `${group} ${suffix}` }));
  const [first, second, third, fourth] = projects;
  await rpc(request, 'project.archive', { projectId: fourth.id });
  const card = (project: ProjectDocument) => page.locator('.project-card').filter({ has: page.getByRole('heading', { name: project.title, exact: true }) });
  const calls: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) calls.push(request.postDataJSON().method); });
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.goto('/');
  const heading = page.getByRole('heading', { name: '我的项目', exact: true });
  await expect(heading).toBeVisible(); await expect(card(first)).toBeVisible();
  expect(calls).not.toContain('project.get');
  await openProjectFromList(page, first.title); await page.reload();
  await expect(heading).toBeVisible(); await expect(page.locator('.workbench')).toHaveCount(0);

  const invalidBatch = await request.post('/__desktop_rpc', { data: { method: 'project.archiveMany', params: { projectIds: [first.id, 'missing-project'] } } });
  expect((await invalidBatch.json()).error).toContain('项目不存在');
  expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: first.id })).project).toEqual(first);

  await page.getByLabel('搜索项目', { exact: true }).fill(group);
  await page.getByRole('button', { name: '多选', exact: true }).click();
  const selectAll = page.getByRole('checkbox', { name: '全选', exact: true });
  await selectAll.check();
  await card(third).getByRole('checkbox').uncheck();
  await expect(selectAll).toHaveJSProperty('indeterminate', true);
  await expect(page.getByText('已选 2 项', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('project-card-selection.png') });
  const remove = page.getByRole('button', { name: '删除', exact: true });
  const confirmation = page.getByRole('alertdialog', { name: '批量删除项目？' });
  await remove.click(); await expect(confirmation).toContainText('将 2 个项目移入回收站');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(remove).toBeFocused();
  expect(calls).not.toContain('project.archiveMany');
  await remove.click(); await confirmation.getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(card(first)).toHaveCount(0); await expect(card(second)).toHaveCount(0); await expect(card(third)).toBeVisible();
  expect(calls.filter(method => method === 'project.archiveMany')).toHaveLength(1);
  await page.getByRole('button', { name: '回收站', exact: true }).click();
  await expect(card(first)).toBeVisible(); await expect(card(second)).toBeVisible(); await expect(card(third)).toHaveCount(0);

  const invalidRestore = await request.post('/__desktop_rpc', { data: { method: 'project.restoreMany', params: { projectIds: [first.id, 'missing-project'] } } });
  expect((await invalidRestore.json()).error).toContain('项目不存在');
  expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: first.id })).project.archived).toBe(true);

  const multiSelect = page.getByRole('button', { name: '多选', exact: true });
  await multiSelect.click();
  const restore = page.getByRole('button', { name: '批量恢复', exact: true });
  await expect(restore).toBeDisabled();
  await expect(card(fourth).getByRole('button', { name: '恢复项目', exact: true })).toHaveCount(0);
  await selectAll.check();
  await card(fourth).getByRole('checkbox').uncheck();
  await expect(selectAll).toHaveJSProperty('indeterminate', true);
  await expect(page.getByText('已选 2 项', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('project-trash-selection.png') });
  await restore.click();
  await expect(card(first)).toHaveCount(0); await expect(card(second)).toHaveCount(0); await expect(card(fourth)).toBeVisible();
  await expect(restore).toBeDisabled();
  expect(calls.filter(method => method === 'project.restoreMany')).toHaveLength(1);
  expect(await rpc(request, 'project.restoreMany', { projectIds: [first.id, first.id] })).toEqual({ restored: 0 });

  const allProjects = page.getByRole('button', { name: '全部项目', exact: true });
  const recycleBin = page.getByRole('button', { name: '回收站', exact: true });
  await selectAll.check();
  await allProjects.click();
  await expect(multiSelect).toBeVisible();
  await expect(card(first)).toBeVisible(); await expect(card(second)).toBeVisible(); await expect(card(third)).toBeVisible();
  await expect(card(fourth)).toHaveCount(0);
  await recycleBin.click();
  await card(fourth).getByRole('button', { name: '恢复项目', exact: true }).click();
  await expect(card(fourth)).toHaveCount(0);
  await allProjects.click();
  await expect(card(fourth)).toBeVisible();
});

for (const { width, height, theme } of [{ width: 1024, height: 720, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`requires confirmation to permanently delete only checked recycle-bin projects at ${width}px`, async ({ page, request }, info) => {
    const group = `彻底删除 ${randomUUID().slice(0, 8)}`;
    const projects = [];
    for (const suffix of ['甲', '乙', '丙', '丁']) projects.push(await rpc<ProjectDocument>(request, 'project.create', { title: `${group} ${suffix}` }));
    const [first, second, keep, live] = projects;
    await mkdir(info.outputDir, { recursive: true });
    const source = info.outputPath('project-owned.txt');
    await writeFile(source, '项目素材夹具');
    const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: first.id, path: source });
    await rpc(request, 'project.archiveMany', { projectIds: [first.id, second.id, keep.id] });
    const calls: string[][] = [];
    page.on('request', request => {
      if (!request.url().endsWith('/__desktop_rpc')) return;
      const { method, params } = request.postDataJSON();
      if (method === 'project.deleteMany') calls.push(params.projectIds);
    });
    await page.setViewportSize({ width, height });
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), theme);
    await page.goto('/');

    const search = page.getByLabel('搜索项目', { exact: true });
    const recycleBin = page.getByRole('button', { name: '回收站', exact: true });
    const multiSelect = page.getByRole('button', { name: '多选', exact: true });
    const purge = page.getByRole('button', { name: '批量彻底删除', exact: true });
    const card = (project: ProjectDocument) => page.locator('.project-card').filter({ has: page.getByRole('heading', { name: project.title, exact: true }) });
    await search.fill(group);
    await multiSelect.click();
    await expect(purge).toHaveCount(0);
    await recycleBin.click();
    await multiSelect.click();
    await expect(purge).toBeDisabled();
    await page.getByRole('checkbox', { name: '全选', exact: true }).check();
    await card(keep).getByRole('checkbox').uncheck();
    await expect(page.getByText('已选 2 项', { exact: true })).toBeVisible();
    expect(await page.locator('.page-body').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

    const dialog = page.getByRole('alertdialog', { name: '批量彻底删除项目？', exact: true });
    const cancel = dialog.getByRole('button', { name: '取消', exact: true });
    await purge.click();
    await expect(dialog).toHaveAccessibleDescription('将彻底删除 2 个项目，并清理项目独占的本地素材和缓存。此操作无法撤销。');
    await expect(cancel).toBeFocused();
    await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: info.outputPath(`project-trash-delete-confirm-${width}.png`) });
    await cancel.click();
    await expect(dialog).toHaveCount(0);
    await expect(purge).toBeFocused();
    await expect(card(first).getByRole('checkbox')).toBeChecked();
    expect(calls).toEqual([]);
    expect(await readFile(asset.path, 'utf8')).toBe('项目素材夹具');

    await purge.click();
    await dialog.getByRole('button', { name: '彻底删除', exact: true }).click();
    await expect(card(first)).toHaveCount(0);
    await expect(card(second)).toHaveCount(0);
    await expect(card(keep)).toBeVisible();
    await expect(purge).toBeDisabled();
    expect(calls).toEqual([[first.id, second.id]]);
    await expect(stat(asset.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(source, 'utf8')).toBe('项目素材夹具');
    await page.reload();
    await search.fill(group);
    await expect(card(live)).toBeVisible();
    await recycleBin.click();
    await expect(card(keep)).toBeVisible();
    await expect(page.locator('.project-card')).toHaveCount(1);
    await expect(card(keep).getByRole('button')).toHaveCount(2);
    await expect(card(keep).getByRole('button', { name: '恢复项目', exact: true })).toBeVisible();
    const deleteProject = card(keep).getByRole('button', { name: `彻底删除“${keep.title}”`, exact: true });
    await deleteProject.click();
    const singleDialog = page.getByRole('alertdialog', { name: '彻底删除项目？', exact: true });
    await expect(singleDialog).toHaveAccessibleDescription(`将彻底删除“${keep.title}”，并清理项目独占的本地素材和缓存。此操作无法撤销。`);
    await singleDialog.getByRole('button', { name: '彻底删除', exact: true }).click();
    await expect(card(keep)).toHaveCount(0);
    expect(calls).toEqual([[first.id, second.id], [keep.id]]);
  });
}
