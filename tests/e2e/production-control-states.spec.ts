import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './isolated-workspace';
import { openProduction, openStoryboardProfile, productionFixture, productionStep } from './production-settings';

// Browser plugin not available: inspect real controls in the isolated Playwright preview.
async function resetControlFocus(dialog: Locator) {
  const popover = dialog.locator(':is(.creative-context-editor__popover, .creative-context-editor__workspace):popover-open');
  if (await popover.isVisible()) await popover.click({ position: { x: 8, y: 16 } });
  else await dialog.locator('.dialog__header h2').click();
}

async function fieldStates(page: Page, dialog: Locator, control: Locator, radius: string, focusStep: 'Tab' | 'Shift+Tab' = 'Tab') {
  await resetControlFocus(dialog);
  await expect(control).toHaveCSS('border-top-left-radius', radius);
  await expect(control).toHaveCSS('border-bottom-right-radius', radius);
  await control.hover();
  await expect(control).toHaveCSS('border-radius', radius);
  await control.focus(); await control.press(focusStep); await control.focus();
  await expect(control).toBeFocused(); await expect(control).toHaveCSS('border-radius', radius);
  await expect(control).not.toHaveCSS('box-shadow', 'none');
}

async function disclosureStates(page: Page, dialog: Locator, summary: Locator, top: string, bottom = top, focusStep: 'Tab' | 'Shift+Tab' = 'Tab') {
  await resetControlFocus(dialog);
  await expect(summary).toHaveCSS('border-top-left-radius', top);
  await expect(summary).toHaveCSS('border-bottom-right-radius', bottom);
  await summary.hover();
  await expect(summary).toHaveCSS('border-top-left-radius', top);
  await expect(summary).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await summary.focus(); await summary.press(focusStep); await summary.focus();
  await expect(summary).toBeFocused(); await expect(summary).toHaveCSS('outline-style', 'solid');
  await expect(summary).toHaveCSS('border-top-left-radius', top);
  await expect(summary).toHaveCSS('border-bottom-right-radius', bottom);
}

const scenarios = [
  { width: 1024, height: 720, theme: 'light', radius: 16 },
  { width: 1024, height: 720, theme: 'dark', radius: 16 },
  { width: 390, height: 844, theme: 'light', radius: 16 },
  { width: 390, height: 844, theme: 'dark', radius: 16 },
  { width: 1024, height: 720, theme: 'light', radius: 20 },
] as const;

for (const scenario of scenarios) test(`keeps control corners consistent across interaction states at ${scenario.width}px in ${scenario.theme} with ${scenario.radius}px corners`, async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await page.setViewportSize(scenario); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), scenario.theme);
  const source = await productionFixture(request), dialog = await openProduction(page, source.project), radius = `${scenario.radius}px`;
  if (scenario.radius !== 16) await page.evaluate(value => document.documentElement.style.setProperty('--radius-small', `${value}px`), scenario.radius);
  await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('html')).toHaveAttribute('data-theme', scenario.theme);
  await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
  await fieldStates(page, dialog, dialog.getByLabel('简报内容', { exact: true }), radius);
  await fieldStates(page, dialog, dialog.getByLabel('风格内容', { exact: true }), radius);
  const roles = dialog.getByRole('button', { name: /^角色与连续性/ });
  await disclosureStates(page, dialog, roles, radius);
  await roles.click(); await fieldStates(page, dialog, dialog.getByLabel('连续性要求', { exact: true }), radius); await roles.click();
  const entities = dialog.getByRole('button', { name: /^人物、场景与道具/ });
  await disclosureStates(page, dialog, entities, radius); await entities.click();
  await dialog.getByRole('button', { name: '添加场景设定', exact: true }).click();
  const scene = dialog.getByRole('region', { name: '场景设定 1', exact: true });
  await scene.getByLabel('设定名称', { exact: true }).fill('庭院');
  await fieldStates(page, dialog, scene.getByLabel('设定名称', { exact: true }), radius);
  await fieldStates(page, dialog, scene.getByLabel('固定特征', { exact: true }), radius);
  await disclosureStates(page, dialog, dialog.getByRole('tab', { name: '场景 · 庭院', exact: true }), radius);
  const references = scene.locator('.creative-reference-picker__disclosure > summary');
  await disclosureStates(page, dialog, references, radius, radius, 'Shift+Tab');
  const referenceBox = (await references.locator('..').boundingBox())!, featureBox = (await scene.getByLabel('固定特征', { exact: true }).boundingBox())!;
  expect(referenceBox.y - featureBox.y - featureBox.height).toBeCloseTo(8, 0);
  await references.click();
  await fieldStates(page, dialog, scene.getByLabel('场景参考图路径', { exact: true }), radius, 'Shift+Tab');
  await references.click(); await dialog.getByRole('button', { name: '返回创作要求', exact: true }).click();
  await disclosureStates(page, dialog, dialog.getByText('剪辑 Agent 设置', { exact: true }), radius);
  await disclosureStates(page, dialog, dialog.getByRole('button', { name: '添加分镜', exact: true }), radius);
  await page.screenshot({ path: info.outputPath('planning-control-states.png') });
  await productionStep(dialog, '模型与素材');
  const textModel = dialog.getByRole('combobox', { name: '文本模型', exact: true });
  await fieldStates(page, dialog, textModel, radius);
  await fieldStates(page, dialog, dialog.getByRole('combobox', { name: '视频模型', exact: true }), radius);
  await textModel.fill(source.text.name);
  const modelMenu = dialog.locator('.combobox__list'); await expect(modelMenu).toBeVisible(); await expect(modelMenu).toHaveCSS('border-radius', radius);
  const modelOption = modelMenu.getByRole('option', { name: source.text.name, exact: true });
  await modelOption.hover(); const optionRadius = await modelOption.evaluate(element => getComputedStyle(element).borderRadius);
  await textModel.press('ArrowDown'); await expect(modelMenu.locator('.combobox__option--active')).toHaveCSS('border-radius', optionRadius);
  await page.screenshot({ path: info.outputPath('model-picker-states.png') }); await textModel.press('Enter');
  await expect(dialog.getByLabel('参考素材', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('combobox', { name: '图片模型', exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('镜头同时处理数', { exact: true })).toHaveCount(0);
  await fieldStates(page, dialog, dialog.getByLabel('参考音频文件路径', { exact: true }), radius);
  await productionStep(dialog, '声音与成片');
  for (const label of ['声音要求', '字幕']) await fieldStates(page, dialog, dialog.getByLabel(label, { exact: true }), radius);
  await productionStep(dialog, '创作要求');
  const storyboard = await openStoryboardProfile(dialog);
  for (const label of ['画面比例', '分辨率', '视频帧率', '素材适配']) await fieldStates(page, dialog, storyboard.getByLabel(label, { exact: true }), radius);
  await expect(storyboard.locator('details')).toHaveCount(0);
  const resolution = storyboard.getByLabel('分辨率', { exact: true });
  await resolution.press('Space');
  const nativeOption = resolution.getByRole('option', { name: '720p', exact: true });
  await expect(nativeOption).toBeVisible();
  expect(await resolution.evaluate(element => getComputedStyle(element, '::picker(select)').borderRadius)).toBe(radius);
  await nativeOption.hover(); await expect(nativeOption).toHaveCSS('border-radius', optionRadius);
  await page.screenshot({ path: info.outputPath('native-picker-states.png') });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: info.outputPath('storyboard-profile-controls.png') });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect((await source.saved()).revision).toBe(source.project.revision);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
});
