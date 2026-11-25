import { expect, test, type Locator, type Page } from '@playwright/test';
import { openProjectFromList, sampleProjectTitle } from './workspace-navigation';
import { openShotInspectorSection } from './storyboard-actions';

async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
  await openProjectFromList(page, sampleProjectTitle);
}

async function dragText(page: Page, target: Locator) {
  const bounds = await target.boundingBox();
  if (!bounds) throw new Error('Text target is not visible');
  await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2, { steps: 12 });
  await page.mouse.up();
}

for (const viewport of [{ width: 1536, height: 960 }, { width: 1024, height: 720 }]) {
  test(`macOS desktop prevents page drag selection while preserving editing and scrolling at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await openApp(page);
    // Emulate only the native surface marker, keeping the real browser runtime
    // and isolated workspace instead of replacing Electron's IPC transport.
    await page.locator('html').evaluate(element => { element.dataset.nativePlatform = 'macos'; });
    await dragText(page, page.locator('.preview-toolbar > span').first());
    expect(await page.evaluate(() => getSelection()?.toString())).toBe('');
    await expect(page.locator('html')).toHaveCSS('overscroll-behavior-x', 'none');
    await expect(page.locator('.page-body')).toHaveCSS('overscroll-behavior-x', 'none');

    for (const field of [page.getByLabel('项目名称', { exact: true }), page.getByLabel('旁白', { exact: true })]) {
      await expect(field).toHaveCSS('user-select', 'text');
      await field.focus();
      await field.press('ControlOrMeta+a');
      expect(await field.evaluate((element: HTMLInputElement | HTMLTextAreaElement) => element.selectionEnd! - element.selectionStart!)).toBe((await field.inputValue()).length);
      await field.press('ArrowRight');
    }

    const seek = page.getByRole('slider', { name: '播放器播放位置', exact: true });
    await seek.scrollIntoViewIfNeeded();
    await expect(seek).toBeInViewport({ ratio: 1 });
    await seek.press('End');
    await expect(seek).toHaveValue((await seek.getAttribute('max'))!);
    await expect(seek).toBeFocused();
    await expect(page.locator('.outline-shot')).toHaveCount(4);
    const shots = page.locator('.outline-list');
    expect(await shots.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => window.scrollX)).toBe(0);

    await openShotInspectorSection(page, '画面与素材');
    const inspector = page.locator('#project-inspector .inspector-body');
    const scroller = await inspector.evaluate(element => element.scrollHeight > element.clientHeight + 1)
      ? inspector
      : page.locator('.page-body');
    await expect.poll(() => scroller.evaluate(element => element.scrollHeight > element.clientHeight + 1)).toBe(true);
    await scroller.hover();
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await page.mouse.wheel(0, 400);
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await page.locator('vite-error-overlay').count()).toBe(0);
    expect(errors).toEqual([]);
    await expect(page).toHaveTitle('Video Quickly · 视频创作工作台');
    await page.screenshot({ path: info.outputPath('macos-desktop-interactions.png') });
  });
}

test('browser preview keeps ordinary page text selectable', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('html')).not.toHaveAttribute('data-native-platform', 'macos');
  await dragText(page, page.locator('.preview-toolbar > span').first());
  expect(await page.evaluate(() => getSelection()?.toString())).not.toBe('');
});
