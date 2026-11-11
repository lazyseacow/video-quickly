import { expect, type Page } from '@playwright/test';

export const sampleProjectTitle = '一纸登科，改变了什么？';

export async function openAssetLibrary(page: Page, view: '媒体' | '角色') {
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  const tab = page.getByRole('tablist', { name: '素材库视图', exact: true }).getByRole('tab', { name: view, exact: true });
  if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

export async function openProjectFromList(page: Page, title?: string, { waitForReady = true }: { waitForReady?: boolean } = {}) {
  const name = title ?? await page.locator('.project-title-input').inputValue();
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.getByLabel('搜索项目', { exact: true }).fill('');
  await page.getByRole('button', { name: '全部项目', exact: true }).click();
  const card = page.locator('.project-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '继续创作', exact: true }).click();
  if (waitForReady) {
    const workbench = page.locator('.workbench');
    await expect(workbench).toBeVisible();
    await expect(workbench.getByLabel('项目名称', { exact: true })).toHaveValue(name);
  }
}
