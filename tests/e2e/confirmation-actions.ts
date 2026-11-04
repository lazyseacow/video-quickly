import { expect, type Page } from '@playwright/test';

export async function confirmAction(page: Page, name: string) {
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
