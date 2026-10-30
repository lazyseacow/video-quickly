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
  const tab = await field.evaluate(element => element.closest('[role="tabpanel"]')?.getAttribute('aria-labelledby'));
  if (tab) await dialog.locator(`[role="tab"][id="${tab}"]`).click();
  return field;
}

export function settingField(dialog: Locator, name: string) {
  return revealSetting(dialog, dialog.getByLabel(name, { exact: true }));
}

export async function settingControl(dialog: Locator, role: Parameters<Locator['getByRole']>[0], options: Parameters<Locator['getByRole']>[1]) {
  const field = dialog.getByRole(role, { ...options, includeHidden: true });
  return await field.count() > 1 ? dialog.getByRole(role, options) : revealSetting(dialog, field);
}

export async function showSettingsPreview(dialog: Locator) {
  const toggle = dialog.getByRole('button', { name: '实时预览', exact: true });
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
}

export async function projectSettingField(page: Page, name: string, options?: Parameters<Locator['getByLabel']>[1]) {
  const panel = page.locator('.project-settings-panel');
  if (await panel.count() && !await page.getByRole('dialog').count()) {
    const field = panel.getByLabel(name, options);
    if (await field.count()) return revealSetting(panel, field);
  }
  return page.getByLabel(name, options);
}

export async function projectSettingAction(page: Page, name: string, options?: Parameters<Locator['getByRole']>[1]) {
  const panel = page.locator('.project-settings-panel');
  if (await panel.count() && !await page.getByRole('dialog').count()) {
    const button = panel.getByRole('button', { ...options, name, includeHidden: true });
    if (await button.count()) return revealSetting(panel, button);
  }
  return page.getByRole('button', { ...options, name });
}
