import { expect, type Page } from '@playwright/test';

export async function openShotActions(page: Page) {
  const actions = page.getByRole('group', { name: '所选镜头操作', exact: true });
  if (!await actions.isVisible()) await page.getByRole('button', { name: '镜头操作', exact: true }).click();
  await expect(actions).toBeVisible();
  return actions;
}

export async function clickShotAction(page: Page, name: string) {
  const actions = await openShotActions(page);
  await actions.getByRole('button', { name, exact: true }).click();
}

export async function openShotInspectorSection(page: Page, name: '画面与素材' | '运镜' | '字幕与文稿') {
  const section = page.locator('#project-inspector .shot-inspector__disclosure').filter({
    has: page.locator('summary').filter({ hasText: name }),
  });
  const summary = section.locator(':scope > summary');
  await expect(summary).toBeVisible();
  if (!await section.evaluate((details: HTMLDetailsElement) => details.open)) await summary.click();
  await expect(section).toHaveJSProperty('open', true);
  return section;
}
