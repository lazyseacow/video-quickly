import { expect, type Page } from '@playwright/test';

export async function openProjectFromList(page: Page, title?: string) {
  const name = title ?? await page.locator('.project-title-input').inputValue();
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.getByLabel('搜索项目', { exact: true }).fill('');
  await page.getByRole('button', { name: '全部项目', exact: true }).click();
  const card = page.locator('.project-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '继续创作', exact: true }).click();
}
