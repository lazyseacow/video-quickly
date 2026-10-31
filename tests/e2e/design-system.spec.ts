import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { addModelConnection } from './settings';

test.use({ storageState: { cookies: [], origins: [] } });

async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
  await expect(page.getByLabel('项目名称', { exact: true })).toBeVisible();
}

test('starts in light mode and preserves an explicit dark preference after reload', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: '深色外观', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: '浅色外观', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '浅色外观', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('shares typography and spacing roles across the workspace, navigation and dialogs', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page);
  await page.evaluate(() => {
    for (const [role, value] of Object.entries({ '--text-size-body': '15px', '--text-size-label': '14px', '--text-size-caption': '13px', '--text-size-project': '26px', '--text-size-title': '22px', '--space-2': '10px' })) document.documentElement.style.setProperty(role, value);
  });
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: '深色外观', exact: true }).click();
    await expect(page.getByRole('button', { name: '我的项目', exact: true })).toHaveCSS('font-size', '15px');
    await expect(page.getByLabel('项目名称', { exact: true })).toHaveCSS('font-size', '26px');
    const create = page.getByRole('button', { name: '新建项目', exact: true });
    await expect(create).toHaveCSS('font-size', '14px');
    await create.click();
    const dialog = page.getByRole('dialog', { name: '新建视频项目', exact: true });
    await expect(dialog.getByRole('heading')).toHaveCSS('font-size', '22px');
    await expect(dialog.locator('.field__label').first()).toHaveCSS('font-size', '13px');
    await expect(dialog.getByLabel('项目名称', { exact: true })).toHaveCSS('font-size', '15px');
    await expect(dialog.locator('.dialog__footer')).toHaveCSS('gap', '10px');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(create).toBeFocused();
  }
});

test('reads dialog timing from shared CSS roles and responds to reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // GSAP captures Date.now and its frame scheduler when the app loads.
  // Install the clock first so pausing and advancing time drive that same ticker.
  await page.clock.install();
  await openApp(page);
  // Ten percent speed makes the actual production entrance observable, without
  // exporting a second GSAP instance or replacing its animation implementation.
  await page.evaluate(() => document.documentElement.style.setProperty('--motion-enter', '2400ms'));
  const create = page.getByRole('button', { name: '新建项目', exact: true });
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 100));
  await create.click();
  const dialog = page.getByRole('dialog', { name: '新建视频项目', exact: true });
  await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '0');
  await page.clock.runFor(240);
  const opacity = await dialog.locator('.dialog__surface').evaluate(element => Number(getComputedStyle(element).opacity));
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(.9);
  await page.clock.runFor(2500);
  await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
  // Repeated dismissal has one completion, even when the preference changes
  // during its exit. A late completion must not close a newly opened dialog.
  await page.evaluate(() => document.documentElement.style.setProperty('--motion-exit', '2400ms'));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // Exit content leaves the accessibility tree; a repeated Escape may also
  // close the native modal before React's exit has finished. Observe unmount.
  const mountedDialog = page.locator('dialog');
  await expect(mountedDialog.locator('.dialog__surface')).toHaveAttribute('inert', '');
  await expect(mountedDialog).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(mountedDialog).toHaveCount(0);
  await create.click();
  await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
  await page.clock.runFor(2500);
  await expect(dialog).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(create).toBeFocused();
  await page.clock.resume();
});

for (const width of [1536, 600]) for (const theme of ['light', 'dark']) {
  test(`keeps every page and shared dialog readable without overflow at ${width}px in ${theme} mode`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize({ width, height: 960 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(value => localStorage.setItem('vq-theme', value), theme);
    await openApp(page);
    await page.screenshot({ path: info.outputPath(`unified-workspace-${theme}-${width}.png`) });
    for (const name of ['我的项目', '素材库', '角色参考库', '系列模板', '模型连接', 'Skill 工作室', 'Token 消耗', '制作记录']) {
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name).toBe(true);
      await expect(page.getByRole('heading', { level: 1, name, exact: true })).toHaveCSS('font-weight', '650');
    }
    await page.getByRole('button', { name: '模型连接', exact: true }).click();
    const model = await addModelConnection(page);
    await expect(model.getByRole('button', { name: '取消', exact: true })).toBeInViewport();
    await expect(model.getByRole('button', { name: '保存连接', exact: true })).toBeInViewport();
    const bounds = await model.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`unified-model-${theme}-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(model).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('previews imported images automatically and keeps navigation typography stable', async ({ page, request }, info) => {
  const path = info.outputPath('library-preview.svg');
  await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#b6c5b9"/><circle cx="240" cy="50" r="24" fill="#edd3a5"/></svg>');
  const imported = await request.post('/__desktop_rpc', { data: { method: 'asset.import', params: { path } } });
  expect(imported.ok()).toBe(true);
  const asset = (await imported.json()).result;
  await openApp(page);
  const library = page.getByRole('button', { name: '素材库', exact: true });
  const typography = () => library.evaluate(element => {
    const style = getComputedStyle(element);
    return { family: style.fontFamily, weight: style.fontWeight, size: style.fontSize, spacing: style.letterSpacing, lineHeight: style.lineHeight };
  });
  const unselected = await typography();
  await library.click();
  expect(await typography()).toEqual(unselected);
  const card = page.locator('.asset-card').filter({ has: page.getByRole('heading', { name: asset.name, exact: true }) });
  const image = card.getByRole('img', { name: asset.name, exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  await expect(card.locator('p')).toHaveCount(0);
  const imageTab = page.getByRole('button', { name: '图片', exact: true });
  const tabWeight = await imageTab.evaluate(element => getComputedStyle(element).fontWeight);
  await imageTab.click();
  await expect(imageTab).toHaveCSS('font-weight', tabWeight);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(320);
  await page.getByRole('button', { name: '深色外观', exact: true }).click();
  expect(await typography()).toEqual(unselected);
  await expect(image).toBeVisible();
  await page.getByRole('button', { name: 'Token 消耗', exact: true }).click();
  await expect(page.locator('.cost-totals')).toBeVisible();
  await expect(page.locator('.cost-metric > p')).toHaveCount(0);
  const calls: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) calls.push(request.postDataJSON().method); });
  await page.getByRole('button', { name: '制作记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '制作记录', exact: true })).toBeVisible();
  await expect(page.locator('.run-card').first().or(page.getByText('还没有制作记录', { exact: true }))).toBeVisible();
  await expect(page.locator('.run-card details')).toHaveCount(0);
  expect(calls).toContain('run.list');
  expect(calls).not.toContain('run.events');
  expect(calls).not.toContain('run.activities');
});

test('keeps long project filter labels synchronized with keyboard and native selection', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const title = '长名称制作项目：资料整理、旁白配音、分镜审阅与多平台视频输出。'.repeat(3);
  const response = await request.post('/__desktop_rpc', { data: { method: 'project.create', params: { title } } });
  expect(response.ok()).toBe(true);
  const project = (await response.json()).result;
  await openApp(page);
  await page.getByRole('button', { name: 'Token 消耗', exact: true }).click();
  const filter = page.getByRole('combobox', { name: '用量项目', exact: true });
  await filter.selectOption(project.id);
  await expect(filter).toHaveValue(project.id);
  const label = filter.locator('selectedcontent');
  await expect(label).toHaveText(title);
  const clipped = await label.evaluate(element => ({ visibleWidth: element.clientWidth, fullWidth: element.scrollWidth }));
  expect(clipped.fullWidth).toBeGreaterThan(clipped.visibleWidth);
  await filter.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('option', { name: title, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(filter).toHaveValue(project.id);
  await page.keyboard.press('Space');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(filter).toHaveValue('');
  await expect(label).toHaveText('所有项目');
  await page.getByRole('button', { name: '深色外观', exact: true }).click();
  await filter.selectOption(project.id);
  await expect(label).toHaveText(title);
});

for (const viewport of [{ width: 1536, height: 960 }, { width: 1024, height: 720 }, { width: 390, height: 844 }]) {
  test(`keeps a long dialog's actions visible and restores keyboard focus at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page);
    const trigger = page.getByRole('button', { name: '新建项目', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '新建视频项目', exact: true });
    await expect(dialog.getByLabel('项目名称', { exact: true })).toBeFocused();
    await dialog.getByText(/^视频规格 ·/).click();
    const footer = dialog.locator('.dialog__footer');
    await expect(footer).toBeInViewport({ ratio: 1 });
    for (const button of await footer.getByRole('button').all()) await expect(button).toBeInViewport({ ratio: 1 });
    const layout = await dialog.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const body = element.querySelector('.dialog__body')!;
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, scrollable: body.scrollHeight > body.clientHeight };
    });
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.top).toBeGreaterThanOrEqual(0);
    expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight);
    if (viewport.height <= 844) expect(layout.scrollable).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    const misplacedIcons = await page.locator('.icon-button').evaluateAll(buttons => buttons.flatMap(button => {
      const target = button.getBoundingClientRect();
      if (!target.width || !target.height) return [];
      const icon = button.querySelector('svg')?.getBoundingClientRect();
      const centered = icon && Math.abs(icon.x + icon.width / 2 - target.x - target.width / 2) <= 1 && Math.abs(icon.y + icon.height / 2 - target.y - target.height / 2) <= 1;
      return target.width >= 40 && target.height >= 40 && centered && button.getAttribute('aria-label') ? [] : [button.getAttribute('aria-label')];
    }));
    expect(misplacedIcons).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
