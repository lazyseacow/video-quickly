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
    const original = dialog.getByRole('textbox', { name: '项目原文', exact: true });
    const planning = dialog.getByRole('group', { name: '策划内容', exact: true });
    const profile = await openStoryboardProfile(dialog);
    const presets = profile.locator('.field-row');
    await expect(dialog.locator('summary').filter({ hasText: /分镜全局参数|自定义分镜尺寸|项目原文/ })).toHaveCount(0);
    await expect(profile.getByRole('spinbutton')).toHaveCount(0);
    await expectGap(presets, original, 12);
    await expectGap(original, planning, 12);
    const brief = planning.getByRole('textbox', { name: '简报内容', exact: true });
    const style = planning.getByRole('textbox', { name: '风格内容', exact: true });
    const storyboard = planning.getByRole('group', { name: '分镜内容', exact: true });
    const addStoryboard = storyboard.getByRole('button', { name: '添加分镜', exact: true });
    for (const input of [brief, style]) await expect(input).toHaveAttribute('placeholder', '未填写时由 AI 生成');
    await expect(addStoryboard).toHaveAccessibleDescription('未填写时由 AI 生成');
    const [briefBox, styleBox, storyboardBox, addBox] = await Promise.all([brief, style, storyboard, addStoryboard].map(bounds));
    expect(addBox.height).toBeGreaterThanOrEqual(40);
    expect(addBox.width).toBeLessThan(storyboardBox.width / 2);
    expect(addBox.height).toBeLessThan(briefBox.height);
    expect(styleBox.width).toBeCloseTo(briefBox.width, 0);
    expect(storyboardBox.width).toBeCloseTo(styleBox.width, 0);
    expect(styleBox.x).toBeCloseTo(briefBox.x, 0);
    expect(storyboardBox.x).toBeCloseTo(styleBox.x, 0);
    expect(styleBox.y).toBeGreaterThan(briefBox.bottom);
    expect(storyboardBox.y).toBeGreaterThan(styleBox.bottom);

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
    const scroll = await content.evaluate(element => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    if (width === 390) expect(scroll).toBeGreaterThan(0);
    expect((await bounds(next)).y).toBeCloseTo(action.y, 0);

    await content.evaluate(element => { element.scrollTop = 0; });
    await dialog.screenshot({ path: info.outputPath(`production-spacing-${width}-${theme}.png`) });

    const source = await original.inputValue();
    const initial = await bounds(original);
    await original.fill('这是一行项目原文。\n'.repeat(6));
    const expanded = await bounds(original);
    expect(expanded.height).toBeGreaterThan(initial.height);
    expect(expanded.width).toBeCloseTo(initial.width, 0);
    await original.fill('这是一行项目原文。\n'.repeat(40));
    const capped = await original.evaluate(element => ({ height: element.getBoundingClientRect().height, overflow: element.scrollHeight - element.clientHeight }));
    expect(capped.height).toBeLessThanOrEqual(height / 4 + 1);
    expect(capped.overflow).toBeGreaterThan(0);
    await expect(next).toBeInViewport({ ratio: 1 });
    if (width === 1024) await dialog.screenshot({ path: info.outputPath('production-original-text.png') });
    await original.fill(source);
    expect((await bounds(original)).height).toBeCloseTo(initial.height, 0);

    await productionStep(dialog, '模型与素材');
    const models = await Promise.all(['文本模型', '视频模型'].map(name => bounds(dialog.getByRole('combobox', { name, exact: true }))));
    for (const model of models) expect(model.width).toBeCloseTo(body.width, 0);
    expect(models[1].y).toBeGreaterThan(models[0].bottom);
    await dialog.screenshot({ path: info.outputPath(`production-models-${width}-${theme}.png`) });

    await productionStep(dialog, '声音与成片');
    const delivery = await bounds(dialog.getByLabel('声音要求', { exact: true }));
    expect(await content.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    expect.soft(delivery.x, 'field start after leaving a scrolling step').toBeCloseTo(body.x, 0);
    expect.soft(delivery.right, 'field end after leaving a scrolling step').toBeCloseTo(body.right, 0);
  });
}
