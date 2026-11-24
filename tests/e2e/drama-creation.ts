import { expect, type Locator, type Page } from '@playwright/test';

export function creationInput(composer: Locator) {
  return composer.getByRole('textbox', { name: '创作输入', exact: true });
}

export function creationModes(composer: Locator) {
  return composer.getByRole('radiogroup', { name: '创作方式', exact: true });
}

export function creationMode(composer: Locator, name: '自动判断' | '改编小说' | '上传剧本' | '制作剧本' | '创作分镜') {
  return creationModes(composer).getByRole('radio', { name, exact: true });
}

export async function setCreationTitle(composer: Locator, title: string) {
  await composer.getByRole('textbox', { name: '短剧名称', exact: true }).fill(title);
  await expect(composer.getByRole('button', { name: '创建短剧', exact: true })).toBeEnabled();
}

export async function sendCreationSource(composer: Locator, source: string) {
  await creationInput(composer).fill(source);
  await composer.getByRole('button', { name: '发送', exact: true }).click();
  await expect(composer.getByRole('textbox', { name: '短剧名称', exact: true })).toBeFocused();
}

export async function draftDrama(composer: Locator, mode: '改编小说' | '上传剧本' | '制作剧本', source: string, title: string) {
  await creationMode(composer, mode).check();
  await sendCreationSource(composer, source);
  await setCreationTitle(composer, title);
}

export async function openCreationSettings(page: Page, composer: Locator) {
  await composer.getByRole('button', { name: '创作设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创作设置', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function closeCreationSettings(dialog: Locator) {
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
