import { expect, test } from '@playwright/test';
import { fixture, open, pick, latest } from './native-video-fixture';

for (const width of [1536, 600]) test('previews native video output inside the completed material stage at ' + width + 'px', async ({ page, request }, info) => {
  const source = await fixture(request, info), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width, height: 960 }); const settings = await open(page, source.project);
    await pick(settings, '文本模型', source.models[0]); await pick(settings, '视频模型', source.video);
    await settings.getByRole('button', { name: '保存并开始制作', exact: true }).click();
    await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30000 }).toBe('succeeded');
    await page.locator('.workbench-guide__step').filter({ hasText: '素材与配音' }).click();
    const dialog = page.getByRole('dialog', { name: '制作设置', exact: true }); await dialog.getByRole('button', { name: '本次制作', exact: true }).click();
    await dialog.getByRole('navigation', { name: '本阶段制作步骤', exact: true }).getByRole('button', { name: /镜头视频生成/ }).click();
    const output = dialog.getByRole('region', { name: '本次产物', exact: true }); await expect(output).toBeVisible();
    await expect.poll(() => output.locator('video').evaluate(video => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
    await expect(page.locator('.workbench-guide__step')).toHaveCount(4); expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath('native-step-output-' + width + '.png') });
  } finally { await source.close(); }
});
