import { expect, type Page } from '@playwright/test';

export async function openWorkspaceSettings(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function setWorkspaceTheme(page: Page, theme: 'light' | 'dark') {
  const dialog = await openWorkspaceSettings(page);
  await dialog.getByRole('button', { name: theme === 'dark' ? '深色外观' : '浅色外观', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
}

export async function openCosts(page: Page) {
  const dialog = await openWorkspaceSettings(page);
  await dialog.getByRole('button', { name: 'Token 消耗', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Token 消耗', exact: true })).toBeVisible();
}

export async function openGuide(page: Page) {
  const dialog = await openWorkspaceSettings(page);
  await dialog.getByRole('button', { name: '使用指南', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-guide-popover]')).toBeVisible();
}
