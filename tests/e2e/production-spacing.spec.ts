import { expect, test, type Locator } from '@playwright/test';
import { openProduction, openStoryboardProfile, productionFixture, productionStep } from './production-settings';

test.use({ reducedMotion: 'reduce', launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Expected a visible box for ${locator}`);
  return { ...box, right: box.x + box.width, bottom: box.y + box.height };
}

async function expectGap(before: Locator, after: Locator, pixels: number) {
  const [first, second] = await Promise.all([bounds(before), bounds(after)]);
  expect.soft(second.y - first.bottom, `Gap between ${before} and ${after}`).toBeCloseTo(pixels, 0);
}

for (const { width, height, theme } of [
  { width: 1464, height: 895, theme: 'dark' },
  { width: 1024, height: 720, theme: 'light' },
  { width: 750, height: 720, theme: 'dark' },
  { width: 390, height: 844, theme: 'light' },
]) {
  test(`keeps production form spacing stable at ${width}px`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(value => localStorage.setItem('vq-theme', value), theme);
    const { project } = await productionFixture(request);
    const dialog = await openProduction(page, project);
    const surface = dialog.locator('.dialog__surface');
    const content = dialog.locator('.production-settings__content');
    const steps = dialog.getByRole('navigation', { name: '制作设置步骤' }).locator('ol');
    const next = dialog.getByRole('button', { name: '下一步', exact: true });
    const storyboard = dialog.locator('.production-settings__storyboard');
    const globalSummary = storyboard.locator(':scope > summary');
    const sources = dialog.getByRole('group', { name: '策划内容来源' });

    await expectGap(globalSummary, sources, 12);
    const profile = await openStoryboardProfile(dialog);
    const presets = profile.locator('.field-row');
    const custom = profile.getByText('自定义分镜尺寸', { exact: true });
    await expectGap(globalSummary, presets, 8);
    await expectGap(presets, custom, 8);
    const customHeight = (await bounds(custom)).height;
    expect(customHeight).toBeGreaterThanOrEqual(40);
    await custom.press('Enter');
    await expect(custom).toBeFocused();
    await expect(custom).toHaveCSS('outline-style', 'solid');
    const dimensions = profile.locator('.dimension-row');
    await expect(dimensions).toBeVisible();
    await expectGap(custom, dimensions, 8);
    await expectGap(dimensions, sources, 12);
    expect((await bounds(custom)).height).toBe(customHeight);
    const [widthInput, lock, heightInput, swap] = await Promise.all([
      profile.getByLabel('视频宽度', { exact: true }), profile.getByRole('button', { name: '解锁宽高比例' }),
      profile.getByLabel('视频高度', { exact: true }), profile.getByRole('button', { name: '交换宽高' }),
    ].map(bounds));
    expect.soft(lock.y + lock.height / 2, 'lock centered on the width control').toBeCloseTo(widthInput.y + widthInput.height / 2, 0);
    expect.soft(swap.y + swap.height / 2, 'swap centered on the height control').toBeCloseTo(heightInput.y + heightInput.height / 2, 0);

    const [frame, navigation, title, body, action] = await Promise.all([
      bounds(surface), bounds(steps), bounds(dialog.getByRole('heading', { name: '制作设置' })),
      bounds(presets), bounds(next),
    ]);
    expect.soft(body.x - frame.x, 'symmetric body gutters').toBeCloseTo(frame.right - body.right, 0);
    expect.soft(title.x, 'heading and form start').toBeCloseTo(body.x, 0);
    expect.soft(navigation.x, 'steps and form start').toBeCloseTo(body.x, 0);
    expect.soft(navigation.right, 'steps and form end').toBeCloseTo(body.right, 0);
    expect.soft(action.right, 'primary action and form end').toBeCloseTo(body.right, 0);
    expect(await content.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await expect(next).toBeInViewport({ ratio: 1 });
    expect(await content.evaluate(element => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    })).toBeGreaterThan(0);
    expect((await bounds(next)).y).toBeCloseTo(action.y, 0);

    await content.evaluate(element => { element.scrollTop = 0; });
    await custom.blur();
    await custom.hover();
    await dialog.screenshot({ path: info.outputPath(`production-spacing-${width}-${theme}.png`) });
    await custom.press('Enter');
    await expect(dimensions).not.toBeVisible();
    await expectGap(presets, custom, 8);
    await expectGap(custom, sources, 12);

    await productionStep(dialog, '声音与成片');
    const delivery = await bounds(dialog.getByLabel('声音要求', { exact: true }));
    expect(await content.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    expect.soft(delivery.x, 'field start after leaving a scrolling step').toBeCloseTo(body.x, 0);
    expect.soft(delivery.right, 'field end after leaving a scrolling step').toBeCloseTo(body.right, 0);
  });
}
