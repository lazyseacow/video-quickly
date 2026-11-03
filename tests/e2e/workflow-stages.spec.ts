import { expect, test } from '@playwright/test';
import { productionFixture, openProduction, pickProductionModel } from './production-settings';

for (const width of [1536, 390]) test('saves four native stages once at ' + width + 'px', async ({ page, request }, info) => {
  const source = await productionFixture(request), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
  const dialog = await openProduction(page, source.project);
  await pickProductionModel(dialog, '文本模型', source.text); await pickProductionModel(dialog, '视频模型', source.video);
  await dialog.getByRole('tab', { name: '素材与配音', exact: true }).click();
  await dialog.getByLabel('参考素材', { exact: true }).selectOption('generate'); await pickProductionModel(dialog, '图片模型', source.image);
  await dialog.getByLabel('声音要求', { exact: true }).fill('自然中文旁白，轻微环境音。');
  await dialog.getByRole('tab', { name: '审阅与导出', exact: true }).click(); await expect(dialog.getByLabel('字幕', { exact: true })).toHaveValue('off');
  let writes = 0; page.on('request', outgoing => { if (outgoing.url().endsWith('/__desktop_rpc') && outgoing.postDataJSON()?.method === 'project.update') writes++; });
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(dialog).toHaveCount(0); expect(writes).toBe(1);
  const saved = await source.saved(); expect(saved.workflow.production).toMatchObject({ textModelId: source.text.id, imageModelId: source.image.id, videoModelId: source.video.id, referenceMode: 'generate', subtitleMode: 'off' });
  expect(saved.workflow.stages).toHaveLength(4); expect(saved.workflow.nodes.map(node => node.id)).toEqual(['brief', 'style', 'script', 'assets', 'video', 'animation', 'export']);
  await page.reload(); await page.getByRole('button', { name: '我的项目', exact: true }).click();
  const reopened = await openProduction(page, saved); await expect(reopened.getByRole('combobox', { name: '文本模型', exact: true })).toHaveValue(source.text.name);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
  await expect(reopened.getByRole('combobox', { name: '文本模型', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(reopened.locator('.dialog__surface')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: info.outputPath('unified-stages-' + width + '.png') });
});
