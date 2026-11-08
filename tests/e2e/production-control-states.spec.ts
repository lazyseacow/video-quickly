import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './isolated-workspace';
import { openProduction, productionFixture, productionStep } from './production-settings';

// Browser plugin not available: inspect real controls in the isolated Playwright preview.
async function fieldStates(page: Page, dialog: Locator, control: Locator, radius: string) {
  await dialog.locator('.dialog__header h2').click();
  await expect(control).toHaveCSS('border-top-left-radius', radius);
  await expect(control).toHaveCSS('border-bottom-right-radius', radius);
  await control.hover();
  await expect(control).toHaveCSS('border-radius', radius);
  await control.focus(); await control.press('Tab'); await control.focus();
  await expect(control).toBeFocused(); await expect(control).toHaveCSS('border-radius', radius);
  await expect(control).not.toHaveCSS('box-shadow', 'none');
}

async function disclosureStates(page: Page, dialog: Locator, summary: Locator, top: string, bottom = top) {
  await dialog.locator('.dialog__header h2').click();
  await expect(summary).toHaveCSS('border-top-left-radius', top);
  await expect(summary).toHaveCSS('border-bottom-right-radius', bottom);
  await summary.hover();
  await expect(summary).toHaveCSS('border-top-left-radius', top);
  await expect(summary).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await summary.focus(); await summary.press('Tab'); await summary.focus();
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
  await fieldStates(page, dialog, dialog.getByLabel('创作要求', { exact: true }), radius);
  await fieldStates(page, dialog, dialog.getByLabel('视觉风格', { exact: true }), radius);
  const roles = dialog.locator('.creative-context-editor__roles > summary');
  await disclosureStates(page, dialog, roles, `${scenario.radius - 1}px`);
  await roles.click(); await fieldStates(page, dialog, dialog.getByLabel('连续性要求', { exact: true }), radius); await roles.click();
  const entities = dialog.locator('.creative-context-editor__entities > summary');
  await disclosureStates(page, dialog, entities, `${scenario.radius - 1}px`); await entities.click();
  await dialog.getByRole('button', { name: '添加场景设定', exact: true }).click();
  const scene = dialog.getByRole('region', { name: '场景设定 1', exact: true });
  await scene.getByLabel('设定名称', { exact: true }).fill('庭院');
  await fieldStates(page, dialog, scene.getByLabel('设定名称', { exact: true }), radius);
  await fieldStates(page, dialog, scene.getByLabel('固定特征', { exact: true }), radius);
  await disclosureStates(page, dialog, scene.locator(':scope > details > summary'), '7px', '0px');
  const references = scene.locator('.creative-reference-picker__disclosure > summary');
  await disclosureStates(page, dialog, references, radius); await references.click();
  await fieldStates(page, dialog, scene.getByLabel('场景参考图路径', { exact: true }), radius);
  await references.click(); await entities.click();
  const planningAdvanced = dialog.locator('[data-production-step="planning"] > .production-settings__advanced > summary');
  await disclosureStates(page, dialog, planningAdvanced, radius); await planningAdvanced.click();
  await fieldStates(page, dialog, dialog.getByRole('combobox', { name: '任务', exact: true }), radius);
  await fieldStates(page, dialog, dialog.getByRole('combobox', { name: '创意简报模型', exact: true }), radius);
  await fieldStates(page, dialog, dialog.getByLabel('创意简报补充要求', { exact: true }), radius);
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
  const referenceMode = dialog.getByLabel('参考素材', { exact: true });
  await fieldStates(page, dialog, referenceMode, radius); await referenceMode.press('Space');
  await expect(referenceMode.getByRole('option', { name: '先生成参考图', exact: true })).toBeVisible();
  expect(await referenceMode.evaluate(element => getComputedStyle(element, '::picker(select)').borderRadius)).toBe(radius);
  const nativeOption = referenceMode.getByRole('option', { name: '先生成参考图', exact: true });
  await nativeOption.hover(); await expect(nativeOption).toHaveCSS('border-radius', optionRadius);
  await page.screenshot({ path: info.outputPath('native-picker-states.png') });
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); await expect(referenceMode).toHaveValue('generate');
  await fieldStates(page, dialog, dialog.getByRole('combobox', { name: '图片模型', exact: true }), radius);
  await fieldStates(page, dialog, dialog.getByLabel('参考音频文件路径', { exact: true }), radius);
  await fieldStates(page, dialog, dialog.getByLabel('镜头同时处理数', { exact: true }), radius);
  const materialSummaries = dialog.locator('[data-production-step="materials"] > .production-settings__advanced > summary');
  for (const summary of await materialSummaries.all()) await disclosureStates(page, dialog, summary, radius);
  await productionStep(dialog, '声音与成片');
  for (const label of ['声音要求', '字幕', '画面比例', '分辨率']) await fieldStates(page, dialog, dialog.getByLabel(label, { exact: true }), radius);
  const outputDetails = dialog.locator('.video-settings__advanced > summary');
  await disclosureStates(page, dialog, outputDetails, radius); await outputDetails.click();
  for (const label of ['视频宽度', '视频高度', '视频帧率', '素材适配']) await fieldStates(page, dialog, dialog.getByLabel(label, { exact: true }), radius);
  await page.screenshot({ path: info.outputPath('output-control-states.png') });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect((await source.saved()).revision).toBe(source.project.revision);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
});
