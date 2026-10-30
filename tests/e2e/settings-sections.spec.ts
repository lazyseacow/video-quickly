import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ModelProfile, SeriesTemplate } from '@video-quickly/contracts';
import { addModelConnection, settingField, showSettingsPreview } from './settings';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }); const payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 1024, height: 720, theme: 'light' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`keeps series settings, preview and save accessible across sections at ${viewport.width}px`, async ({ page, request }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    await page.setViewportSize(viewport); await page.goto('/');
    await page.getByRole('button', { name: '系列模板', exact: true }).click();
    const trigger = page.getByRole('button', { name: '新建系列模板', exact: true }); await trigger.click();
    const dialog = page.getByRole('dialog', { name: '保存系列模板', exact: true });
    const name = `分区模板验收 ${viewport.width}`, style = '纸张质感，简洁构图，保持字幕与配色一致。';
    await expect(dialog.getByLabel('系列模板名称', { exact: true })).toBeFocused();
    await dialog.getByLabel('系列模板名称', { exact: true }).fill(name);
    await dialog.getByLabel('系列风格文字', { exact: true }).fill(style);
    const preview = await dialog.locator('.settings-sections__preview').elementHandle();
    const basic = dialog.getByRole('tab', { name: '基本信息', exact: true }); await basic.focus(); await page.keyboard.press('ArrowDown');
    await expect(dialog.getByRole('tab', { name: '字幕样式', exact: true })).toHaveAttribute('aria-selected', 'true');
    await dialog.getByRole('checkbox', { name: '自定义字幕样式', exact: true }).check();
    await dialog.getByLabel('字幕字体', { exact: true }).selectOption('serif');
    await dialog.getByLabel('文字颜色', { exact: true }).fill('#b23a24');
    await dialog.getByRole('tab', { name: '画面预设', exact: true }).click();
    await dialog.getByLabel('新镜头模板', { exact: true }).selectOption('bar-chart');
    await dialog.getByLabel('预设配色', { exact: true }).selectOption('sage');
    await basic.click(); await expect(dialog.getByLabel('系列风格文字', { exact: true })).toHaveValue(style);
    await dialog.getByRole('tab', { name: '字幕样式', exact: true }).click();
    await expect(dialog.getByLabel('文字颜色', { exact: true })).toHaveValue('#b23a24');
    await expect(dialog.getByLabel('字幕字体', { exact: true })).toHaveValue('serif');
    expect(await preview!.evaluate(element => element.isConnected)).toBe(true);
    await expect(dialog.locator('[role="tabpanel"]:visible')).toHaveCount(1);
    await showSettingsPreview(dialog);
    await expect(dialog.locator('.series-settings-preview')).toBeVisible();
    await expect(dialog.locator('.dialog__footer')).toBeInViewport({ ratio: 1 });
    const layout = await dialog.evaluate(element => { const body = element.querySelector('.dialog__body')!; const bounds = element.getBoundingClientRect(); return { scroll: body.scrollHeight - body.clientHeight, right: bounds.right, width: innerWidth, bottom: bounds.bottom, height: innerHeight }; });
    expect(layout.scroll).toBeLessThanOrEqual(1); expect(layout.right).toBeLessThanOrEqual(layout.width); expect(layout.bottom).toBeLessThanOrEqual(layout.height);
    await page.screenshot({ path: info.outputPath('series-template-sections.png') });
    await dialog.getByRole('button', { name: '保存系列模板', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const library = await rpc<{ items: SeriesTemplate[] }>(request, 'seriesTemplate.list', { limit: 100 });
    const saved = library.items.find(template => template.name === name);
    expect(saved?.settings.style).toBe(style); expect(saved?.settings.captionStyle).toMatchObject({ fontId: 'serif', textColor: '#b23a24' }); expect(saved?.settings.scenePreset?.kind).toBe('bar-chart'); expect(errors).toEqual([]);
  });
}

test('opens the required model section on submit and retains parameter changes', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.getByRole('button', { name: '模型连接', exact: true }).click(); const dialog = await addModelConnection(page);
  await dialog.getByRole('tab', { name: '文本参数', exact: true }).click(); await dialog.getByLabel('文本温度', { exact: true }).fill('0.55');
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(dialog.getByRole('tab', { name: '基本连接', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByLabel('连接名称', { exact: true })).toBeFocused();
  const name = '分区表单原生校验验收'; await dialog.getByLabel('连接名称', { exact: true }).fill(name);
  await dialog.getByRole('tab', { name: '文本参数', exact: true }).click(); await dialog.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(dialog.getByLabel('模型 ID', { exact: true })).toBeFocused();
  await dialog.getByLabel('模型 ID', { exact: true }).fill('fixture-model');
  await expect(await settingField(dialog, '文本温度')).toHaveValue('0.55');
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const workspace = await rpc<{ models: ModelProfile[] }>(request, 'workspace.summary');
  expect(workspace.models.find(model => model.name === name)?.parameters.temperature).toBe(.55); expect(errors).toEqual([]);
});
