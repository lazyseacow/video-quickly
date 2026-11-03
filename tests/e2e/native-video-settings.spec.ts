import { productionStep, saveProduction, saveAndStartProduction } from './production-settings';
import { expect, test } from '@playwright/test';
import { rpc, fixture, saved, latest, open, pick } from './native-video-fixture';
import { openProjectFromList } from './workspace-navigation';

test('saves all four stages once, preserves subtitles off and completes video with original sound', async ({ page, request }, info) => {
  const source = await fixture(request, info), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    let dialog = await open(page, source.project); await pick(dialog, '文本模型', source.models[0]); await pick(dialog, '视频模型', source.video);
    await productionStep(dialog, '创作要求'); await dialog.getByLabel('创作要求', { exact: true }).fill('用一个镜头介绍蓝色天空，声音自然。');
    await productionStep(dialog, '模型与素材'); await expect(dialog.getByLabel('参考素材', { exact: true })).toHaveValue('none'); await productionStep(dialog, '声音与成片'); await dialog.getByLabel('声音要求', { exact: true }).fill('轻声讲述，环境音克制。');
    await productionStep(dialog, '声音与成片'); await expect(dialog.getByLabel('字幕', { exact: true })).toHaveValue('off');
    await page.screenshot({ path: info.outputPath('native-settings-dark.png') });
    let writes = 0; page.on('request', value => { if (value.url().endsWith('/__desktop_rpc') && value.postDataJSON()?.method === 'project.update') writes++; });
    await saveProduction(dialog); await expect(dialog).toHaveCount(0); expect(writes).toBe(1);
    const configured = await saved(request, source.project.id); expect(configured.workflow.production).toMatchObject({ textModelId: source.models[0].id, videoModelId: source.video.id, soundPrompt: '轻声讲述，环境音克制。', subtitleMode: 'off' });
    expect(configured.workflow.nodes.filter(node => ['brief', 'style', 'script'].includes(node.id)).every(node => node.modelId === source.models[0].id)).toBe(true);
    await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
    await saveAndStartProduction(dialog); await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30_000 }).toBe('succeeded');
    await expect(page.locator('.preview-panel .prepared-mix-preview')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
    expect((await saved(request, source.project.id)).shots[0].audioProcessing).toMatchObject({ version: 2, videoAudio: { enabled: true } });
    expect(source.requests.filter(value => value.generate_audio === true)).toHaveLength(1); expect(errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('native-production-complete.png') });
    await page.getByRole('button', { name: '打开阶段：剪辑与动画', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '本次制作', exact: true }); await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab', { name: '剪辑与动画', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('navigation', { name: '本阶段制作步骤', exact: true })).toContainText('剪辑与运镜准备');
    await page.screenshot({ path: info.outputPath('automatic-editing-record.png') });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await rpc(request, 'run.start', { projectId: source.project.id, nodeId: 'script' });
    await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30_000 }).toBe('succeeded');
    await page.reload(); await openProjectFromList(page, source.project.title);
    await page.getByRole('button', { name: '打开阶段：剪辑与动画', exact: true }).click();
    await expect(dialog).toContainText('这次制作未包含本阶段');
    await expect(dialog.getByRole('button', { name: '查看制作设置', exact: true })).toHaveCount(0);
  } finally { await source.close(); }
});

test('keeps runtime settings frozen while saving the next production configuration', async ({ page, request }, info) => {
  const source = await fixture(request, info, true);
  try {
    let dialog = await open(page, source.project); await pick(dialog, '文本模型', source.models[0]); await pick(dialog, '视频模型', source.video);
    await saveAndStartProduction(dialog); await source.pending;
    await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click(); dialog = page.getByRole('dialog', { name: '制作设置', exact: true });
    await pick(dialog, '文本模型', source.models[1]); await saveProduction(dialog); await expect(dialog).toHaveCount(0);
    expect((await saved(request, source.project.id)).workflow.production?.textModelId).toBe(source.models[0].id);
    source.release(); await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30_000 }).toBe('succeeded');
    expect(source.requests.filter(value => value.messages).every(value => value.model === source.models[0].model)).toBe(true);
    await page.reload(); await openProjectFromList(page, source.project.title); await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
    await expect(dialog).toContainText('已保存待用配置'); await productionStep(dialog, '模型与素材'); await expect(dialog.getByRole('combobox', { name: '文本模型', exact: true })).toHaveValue(source.models[1].name);
  } finally { await source.close(); }
});

test('retains failed saves and keeps the unified form usable in a narrow light window', async ({ page, request }, info) => {
  const source = await fixture(request, info); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(() => localStorage.setItem('vq-theme', 'light')); await page.setViewportSize({ width: 760, height: 800 });
    let dialog = await open(page, source.project); await pick(dialog, '文本模型', source.models[0]); await pick(dialog, '视频模型', source.video);
    await productionStep(dialog, '创作要求'); await dialog.getByLabel('创作要求', { exact: true }).fill('保存失败后仍保留的创作要求');
    let fail = true;
    await page.route('**/__desktop_rpc', async route => { if (route.request().postDataJSON()?.method === 'project.update' && fail) { fail = false; await route.fulfill({ status: 400, json: { error: '隔离的保存失败' } }); } else await route.continue(); });
    await saveProduction(dialog); await expect(dialog).toContainText('操作尚未完成'); await expect(dialog.getByLabel('创作要求', { exact: true })).toHaveValue('保存失败后仍保留的创作要求');
    await productionStep(dialog, '声音与成片'); await expect(dialog.getByLabel('字幕', { exact: true })).toHaveValue('off');
    const bounds = await dialog.locator('.dialog__surface').boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.width).toBeLessThanOrEqual(760);
    await productionStep(dialog, '确认保存'); await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeInViewport(); await page.screenshot({ path: info.outputPath('native-settings-light-narrow.png') });
    await saveProduction(dialog); await expect(dialog).toHaveCount(0); expect((await saved(request, source.project.id)).brief).toBe('保存失败后仍保留的创作要求'); expect(errors).toEqual([]);
  } finally { await source.close(); }
});
