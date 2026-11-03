import { productionStep } from './production-settings';
import { expect, type Locator, type Page } from '@playwright/test';

export async function addModelConnection(page: Page, type = '文本模型') {
  await page.locator('.page-heading').getByRole('button', { name: '添加模型', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const picker = page.getByRole('dialog', { name: '选择模型类型', exact: true });
  if (await picker.isVisible()) await picker.getByRole('button', { name: new RegExp(`^${type}`) }).click();
  const dialog = page.getByRole('dialog', { name: `添加${type}`, exact: true }); await expect(dialog).toBeVisible(); return dialog;
}

async function revealSetting(dialog: Locator, field: Locator) {
  if (await field.count() !== 1) return field;
  const step = await field.evaluate(element => element.closest<HTMLElement>('[data-production-step]')?.dataset.productionStep);
  const wizardStep = ([{ id: 'planning', label: '创作要求' }, { id: 'materials', label: '模型与素材' }, { id: 'delivery', label: '声音与成片' }] as const).find(item => item.id === step);
  if (wizardStep) await productionStep(dialog, wizardStep.label);
  const tab = await field.evaluate(element => element.closest('[role="tabpanel"]')?.getAttribute('aria-labelledby'));
  if (tab) await dialog.locator(`[role="tab"][id="${tab}"]`).click();
  const disclosures = field.locator('xpath=ancestor::details');
  for (let index = 0; index < await disclosures.count(); index++) {
    const disclosure = disclosures.nth(index);
    if (await disclosure.getAttribute('open') === null) await disclosure.locator(':scope > summary').click();
  }
  return field;
}

export function settingField(dialog: Locator, name: string) {
  return revealSetting(dialog, dialog.getByLabel(name, { exact: true }));
}

export async function selectModel(dialog: Locator, value: string, label = '模型 ID') {
  const input = await settingField(dialog, label);
  await input.fill(value);
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await dialog.getByRole('option', { name: new RegExp(`(?:^| · )${escaped}$`) }).click();
  await expect(input).toHaveValue(value);
}

export async function settingControl(dialog: Locator, role: Parameters<Locator['getByRole']>[0], options: Parameters<Locator['getByRole']>[1]) {
  const field = dialog.getByRole(role, { ...options, includeHidden: true });
  return await field.count() > 1 ? dialog.getByRole(role, options) : revealSetting(dialog, field);
}

export async function showSettingsPreview(dialog: Locator) {
  await expect(dialog).toBeVisible();
  const toggle = dialog.getByRole('button', { name: '实时预览', exact: true });
  if (await dialog.page().evaluate(() => matchMedia('(max-width: 800px)').matches)) {
    await expect(toggle).toBeVisible();
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
  await expect(dialog.locator('.settings-sections__preview-body')).toBeVisible();
}

export async function projectSettingField(page: Page, name: string, options?: Parameters<Locator['getByLabel']>[1]) {
  const dialog = await openProjectSettings(page);
  const label = name === '主题与核心问题' ? '创作要求' : name === '系列风格' ? '视觉风格' : name;
  return revealSetting(dialog, dialog.getByLabel(label, options));
}

export async function projectSettingAction(page: Page, name: string, options?: Parameters<Locator['getByRole']>[1]) {
  const projectActions = ['背景音乐', '项目字幕样式', '应用系列模板', '保存当前系列为模板'];
  if (!projectActions.includes(name)) return page.getByRole('button', { ...options, name });
  const dialog = await openProjectSettings(page);
  return revealSetting(dialog, dialog.getByRole('button', { ...options, name, includeHidden: true }));
}

export async function openProjectSettings(page: Page) {
  const dialog = page.getByRole('dialog', { name: '制作设置', exact: true });
  if (!await dialog.count()) await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
  await expect(dialog).toBeVisible(); return dialog;
}

export async function closeProjectSettings(page: Page) {
  const dialog = page.getByRole('dialog', { name: '制作设置', exact: true });
  if (await dialog.count()) {
    await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
}
