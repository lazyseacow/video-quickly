import { expect, test, type Locator } from '@playwright/test';
import { openProduction, productionFixture, productionStep } from './production-settings';

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
    const content = dialog.locator('.production-settings__content');
    const sources = dialog.getByRole('group', { name: '策划内容来源', exact: true });
    const prompts = dialog.locator('.production-settings__prompts');
    await expectGap(sources, prompts, 12);
    await dialog.getByLabel('创作要求', { exact: true }).fill('核对长内容滚动时的表单边缘和底栏。\n'.repeat(60).trimEnd());

    await productionStep(dialog, '声音与成片');
    const options = dialog.locator('.production-settings__delivery-options');
    const fit = options.getByLabel('素材适配', { exact: true });
    const subtitle = options.getByLabel('字幕', { exact: true }).locator('..');
    const custom = options.locator('.video-settings__advanced > summary');
    const dimensions = options.locator('.dimension-row');
    await expect(dimensions).not.toBeVisible();
    await expectGap(fit, custom, 8);
    await expectGap(custom, subtitle, 8);
    const customHeight = (await bounds(custom)).height;
    expect(customHeight).toBeGreaterThanOrEqual(40);
    await custom.press('Enter');
    await expect(custom).toBeFocused();
    await expect(custom).toHaveCSS('outline-style', 'solid');
    await expect(dimensions).toBeVisible();
    await expectGap(fit, custom, 8);
    await expectGap(custom, dimensions, 8);
    await expectGap(dimensions, options.getByLabel('视频帧率', { exact: true }).locator('..'), 8);
    expect((await bounds(custom)).height).toBe(customHeight);

    const [widthInput, lock, heightInput, swap] = await Promise.all([
      options.getByLabel('视频宽度', { exact: true }), options.getByRole('button', { name: '解锁宽高比例' }),
      options.getByLabel('视频高度', { exact: true }), options.getByRole('button', { name: '交换宽高' }),
    ].map(bounds));
    expect.soft(lock.y + lock.height / 2, 'lock centered on the width control').toBeCloseTo(widthInput.y + widthInput.height / 2, 0);
    expect.soft(swap.y + swap.height / 2, 'swap centered on the height control').toBeCloseTo(heightInput.y + heightInput.height / 2, 0);

    const steps = dialog.getByRole('navigation', { name: '制作设置步骤', exact: true }).locator('ol');
    const next = dialog.getByRole('button', { name: '下一步', exact: true });
    const [frame, navigation, title, body, action] = await Promise.all([
      bounds(dialog.locator('.dialog__surface')), bounds(steps), bounds(dialog.getByRole('heading', { name: '制作设置', exact: true })),
      bounds(options), bounds(next),
    ]);
    expect.soft(body.x - frame.x, 'symmetric body gutters').toBeCloseTo(frame.right - body.right, 0);
    expect.soft(title.x, 'heading and form start').toBeCloseTo(body.x, 0);
    expect.soft(navigation.x, 'steps and form start').toBeCloseTo(body.x, 0);
    expect.soft(navigation.right, 'steps and form end').toBeCloseTo(body.right, 0);
    expect.soft(action.right, 'primary action and form end').toBeCloseTo(body.right, 0);
    expect(await content.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await expect(next).toBeInViewport({ ratio: 1 });

    await custom.blur();
    await custom.hover();
    await dialog.screenshot({ path: info.outputPath(`production-spacing-${width}-${theme}.png`) });
    await custom.press('Enter');
    await expect(dimensions).not.toBeVisible();
    await expectGap(fit, custom, 8);
    await expectGap(custom, subtitle, 8);

    await productionStep(dialog, '确认保存');
    const review = await bounds(dialog.getByRole('region', { name: '确认保存', exact: true }));
    const save = dialog.getByRole('button', { name: '保存设置', exact: true });
    expect.soft(review.x, 'form start on a scrolling step').toBeCloseTo(body.x, 0);
    expect.soft(review.right, 'form end on a scrolling step').toBeCloseTo(body.right, 0);
    expect(await content.evaluate(element => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    })).toBeGreaterThan(0);
    await expect(save).toBeInViewport({ ratio: 1 });
    const savedAction = await bounds(save);
    expect(savedAction.right).toBeCloseTo(action.right, 0);
    expect(savedAction.y).toBeCloseTo(action.y, 0);
  });
}
