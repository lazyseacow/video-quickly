import { openCosts, setWorkspaceTheme } from './workspace-settings';
import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { addModelConnection } from './settings';
import { chooseStudioEntry, openProjectFromList, openStudio, sampleProjectTitle } from './workspace-navigation';
import { closeCreationSettings, creationInput, creationMode, creationModes, draftDrama, openCreationSettings } from './drama-creation';

test.use({ storageState: async ({ baseURL }, use) => {
  if (!baseURL) throw new Error('Design-system tests require a local application origin');
  await use({ cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'vq-onboarding-v1', value: 'done' }] }] });
} });

async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
  await openProjectFromList(page, sampleProjectTitle);
}

test('starts in light mode and preserves an explicit dark preference after reload', async ({ page }) => {
  await openApp(page);
  const colorScheme = page.locator('meta[name="color-scheme"]');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await setWorkspaceTheme(page, 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(colorScheme).toHaveAttribute('content', 'dark');
  await page.reload();
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible();
  await setWorkspaceTheme(page, 'light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(colorScheme).toHaveAttribute('content', 'light');
});

test('applies the default and saved color schemes before the renderer loads', async ({ page }) => {
  await page.route('**/assets/*.js', route => route.abort());
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const root = page.locator('html');
  const colorScheme = page.locator('meta[name="color-scheme"]');
  await expect(page.locator('#root')).toBeEmpty();
  await expect(root).toHaveCSS('color-scheme', 'light');
  await expect(colorScheme).toHaveAttribute('content', 'light');

  await page.evaluate(() => localStorage.setItem('vq-theme', 'dark'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await expect(page.locator('#root')).toBeEmpty();
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(root).toHaveCSS('color-scheme', 'dark');
  await expect(colorScheme).toHaveAttribute('content', 'dark');
});

test('keeps a modal open when selecting text across its backdrop', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page);
  await chooseStudioEntry(page, '对话');
  const composer = page.getByRole('region', { name: '新建短剧', exact: true });
  const creation = await openCreationSettings(page, composer);
  const trigger = creation.getByRole('button', { name: '打开选题库', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '选题库', exact: true });
  const name = dialog.getByRole('searchbox', { name: '搜索选题', exact: true });
  await name.fill('拖选时保留正在编辑的选题搜索');
  const [field, modal] = await Promise.all([name.boundingBox(), dialog.locator('.dialog__surface').boundingBox()]);
  if (!field || !modal) throw new Error('Expected a visible topic library and search field');
  const y = field.y + field.height / 2;
  const backdrop = modal.x / 2;
  await page.mouse.move(field.x + field.width / 4, y);
  await page.mouse.down();
  await page.mouse.move(backdrop, y, { steps: 5 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await expect(name).toHaveValue('拖选时保留正在编辑的选题搜索');

  await page.mouse.click(backdrop, y);
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('shares typography and spacing roles across the workspace, navigation and dialogs', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page);
  await page.evaluate(() => {
    for (const [role, value] of Object.entries({ '--text-size-body': '15px', '--text-size-label': '14px', '--text-size-caption': '13px', '--text-size-project': '26px', '--text-size-title': '22px', '--space-2': '10px' })) document.documentElement.style.setProperty(role, value);
  });
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await setWorkspaceTheme(page, 'dark');
    await expect(page.getByRole('button', { name: '素材库', exact: true })).toHaveCSS('font-size', '15px');
    await expect(page.getByLabel('项目名称', { exact: true })).toHaveCSS('font-size', '26px');
    const create = page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true });
    await expect(create).toHaveCSS('font-size', '14px');
    await create.click();
    const dialog = page.getByRole('dialog', { name: '制作设置', exact: true });
    await expect(dialog.getByRole('heading', { name: '制作设置', exact: true })).toHaveCSS('font-size', '22px');
    await expect(dialog.locator('.field__label').first()).toHaveCSS('font-size', '13px');
    await expect(dialog.getByLabel('项目原文', { exact: true })).toHaveCSS('font-size', '15px');
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
  const clockOrigin = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time: clockOrigin });
  await openApp(page);
  const create = page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true });
  const dialog = page.getByRole('dialog', { name: '制作设置', exact: true });
  // Load the actual production settings chunk before freezing its animation clock.
  await create.click(); await expect(dialog).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  // Ten percent speed makes the actual production entrance observable, without
  // exporting a second GSAP instance or replacing its animation implementation.
  await page.evaluate(() => document.documentElement.style.setProperty('--motion-enter', '2400ms'));
  // This target exceeds the entire test deadline. A delayed protocol command
  // cannot arrive after it while this test is still allowed to run.
  const pauseTime = new Date(clockOrigin.getTime() + 2 * test.info().timeout);
  // Reproduce a slow protocol delivery without sleeping inside the fake clock.
  await new Promise(resolve => setTimeout(resolve, 180));
  await page.clock.pauseAt(pauseTime);
  await create.click();
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
    await expect(page.getByRole('button', { name: '制作记录', exact: true })).toHaveCount(0);
    for (const name of ['短剧工作室', '素材库', '系列模板', '模型连接', 'Skill 工作室', 'Token 消耗']) {
      if (name === 'Token 消耗') await openCosts(page); else if (name === '短剧工作室') await openStudio(page); else await page.getByRole('button', { name, exact: true }).click();
      const routeHeading = page.getByRole('heading', { level: 1, name, exact: true });
      await expect(routeHeading).toBeVisible();
      if (name === '短剧工作室') await chooseStudioEntry(page, '对话');
      const visibleHeading = name === '短剧工作室' ? page.getByRole('heading', { name: '把故事拍成短剧', exact: true }) : routeHeading;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name).toBe(true);
      await expect(visibleHeading).toHaveCSS('font-weight', '650');
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
  const image = card.getByRole('button', { name: `预览“${asset.name}”`, exact: true }).locator('img');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  await expect(card.locator('p')).toHaveCount(0);
  const imageTab = page.getByRole('button', { name: '图片', exact: true });
  const tabWeight = await imageTab.evaluate(element => getComputedStyle(element).fontWeight);
  await imageTab.click();
  await expect(imageTab).toHaveCSS('font-weight', tabWeight);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(320);
  await setWorkspaceTheme(page, 'dark');
  expect(await typography()).toEqual(unselected);
  await expect(image).toBeVisible();
  const calls: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) calls.push(request.postDataJSON().method); });
  await openCosts(page);
  await expect(page.locator('.cost-totals')).toBeVisible();
  await expect(page.locator('.cost-metric > p')).toHaveCount(0);
  expect(calls).not.toContain('run.list');
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
  await openCosts(page);
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
  await setWorkspaceTheme(page, 'dark');
  await filter.selectOption(project.id);
  await expect(label).toHaveText(title);
});

for (const viewport of [{ width: 1536, height: 960 }, { width: 1024, height: 720 }, { width: 390, height: 844 }]) {
  test(`keeps studio creation fields and actions reachable and restores topic library focus at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page);
    await chooseStudioEntry(page, '对话');
    const composer = page.getByRole('region', { name: '新建短剧', exact: true });
    await expect(creationInput(composer)).toBeFocused();
    const modes = creationModes(composer);
    await expect(modes.getByRole('radio')).toHaveCount(5);
    const attachment = composer.getByRole('button', { name: '添加文件', exact: true });
    await expect(attachment).toBeVisible();
    const modeNames = ['自动判断', '改编小说', '上传剧本', '制作剧本', '创作分镜'] as const;
    const [modeBounds, fileBounds, sourceBounds, labels] = await Promise.all([
      modes.boundingBox(),
      attachment.boundingBox(),
      creationInput(composer).boundingBox(),
      Promise.all(modeNames.map(name => modes.getByText(name, { exact: true }).boundingBox())),
    ]);
    expect(modeBounds).toBeTruthy();
    expect(fileBounds).toBeTruthy();
    expect(sourceBounds).toBeTruthy();
    expect(modeBounds!.y + modeBounds!.height).toBeLessThanOrEqual(Math.min(fileBounds!.y, sourceBounds!.y));
    expect(labels.every(Boolean)).toBe(true);
    if (viewport.width >= 1024) {
      expect(fileBounds!.x + fileBounds!.width).toBeLessThanOrEqual(sourceBounds!.x);
      expect(fileBounds!.y + fileBounds!.height).toBeGreaterThan(sourceBounds!.y);
      expect(sourceBounds!.y + sourceBounds!.height).toBeGreaterThan(fileBounds!.y);
      expect(new Set(labels.map(box => Math.round(box!.y))).size).toBe(1);
      for (let index = 1; index < labels.length; index++) expect(labels[index]!.x).toBeGreaterThan(labels[index - 1]!.x);
    } else {
      expect(fileBounds!.y + fileBounds!.height).toBeLessThanOrEqual(sourceBounds!.y);
    }
    await page.screenshot({ path: info.outputPath(`studio-creation-${viewport.width}.png`) });
    await expect(page.getByRole('dialog', { name: '新建视频项目', exact: true })).toHaveCount(0);
    const menuButton = page.getByRole('button', { name: '工作室菜单', exact: true });
    const navigation = page.getByRole('navigation', { name: '工作室菜单', exact: true });
    if (viewport.width <= 980) await menuButton.press('Enter');
    await expect(navigation).toBeVisible();
    if (viewport.width <= 980) await expect(navigation).toBeInViewport({ ratio: 1 });
    for (const name of ['对话', '新建对话', '我的作品']) {
      await expect(navigation.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await expect(navigation.getByRole('button', { name: '创作分镜', exact: true })).toHaveCount(0);
    if (viewport.width <= 980) {
      await page.keyboard.press('Escape');
      await expect(navigation).toBeHidden();
      await expect(menuButton).toBeFocused();
    } else await expect(menuButton).toBeHidden();
    await expect(composer.getByRole('tablist', { name: '剧本来源', exact: true })).toHaveCount(0);
    await expect(composer.getByRole('combobox', { name: '创作方式', exact: true })).toHaveCount(0);
    const automatic = creationMode(composer, '自动判断');
    const novel = creationMode(composer, '改编小说');
    await expect(automatic).toBeChecked();
    await automatic.press('ArrowRight');
    await expect(novel).toBeChecked();
    await expect(novel).toBeFocused();
    await creationMode(composer, '上传剧本').check();
    await expect(composer.getByRole('button', { name: '添加文件', exact: true })).toBeVisible();
    const write = creationMode(composer, '制作剧本');
    await write.check();
    await expect(write).toBeChecked();
    await expect(composer.getByRole('button', { name: '添加文件', exact: true })).toHaveCount(0);
    await automatic.check();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const styleTrigger = composer.getByRole('button', { name: '快速选择画风', exact: true });
    await styleTrigger.click();
    const stylePicker = page.getByRole('dialog', { name: '选择画风', exact: true });
    const styleSearch = stylePicker.getByRole('searchbox', { name: '搜索画风', exact: true });
    await expect(styleSearch).toBeFocused();
    await expect(stylePicker).toHaveCSS('transition-property', 'opacity, translate, display, overlay');
    await styleSearch.fill('水墨');
    await expect(stylePicker.getByRole('button', { name: '自然写实', exact: true })).toHaveCount(0);
    await stylePicker.getByRole('button', { name: '国风水墨', exact: true }).click();
    await expect(stylePicker).toBeHidden();
    await expect(styleTrigger).toHaveText('国风水墨');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await styleTrigger.press('Enter');
    await expect(stylePicker).toHaveCSS('transition-duration', '0s');
    await expect(stylePicker.getByRole('button', { name: '国风水墨', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(styleTrigger).toBeFocused();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const starters = composer.getByRole('list', { name: '创作起点', exact: true });
    await starters.getByRole('button', { name: /^规划一组分镜/ }).click();
    await expect(creationMode(composer, '创作分镜')).toBeChecked();
    await expect(creationInput(composer)).toBeFocused();
    await expect(composer.getByRole('button', { name: '添加文件', exact: true })).toHaveCount(0);
    await draftDrama(composer, '制作剧本', '车站管理员捡到了一封写给自己的旧信。', '窄窗口创作验收');
    const create = composer.getByRole('button', { name: '创建短剧', exact: true });
    await create.scrollIntoViewIfNeeded();
    await expect(create).toBeInViewport({ ratio: 1 });
    const creation = await openCreationSettings(page, composer);
    await expect(creation.getByRole('combobox', { name: '画风', exact: true })).toHaveValue('ink-wash');
    const skills = creation.getByRole('button', { name: '创作 Skill', exact: true });
    await skills.scrollIntoViewIfNeeded();
    await expect(skills).toBeInViewport({ ratio: .95 });
    const topics = creation.getByRole('button', { name: '打开选题库', exact: true });
    await topics.scrollIntoViewIfNeeded(); await topics.click();
    const dialog = page.getByRole('dialog', { name: '选题库', exact: true });
    const layout = await dialog.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.top).toBeGreaterThanOrEqual(0);
    expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight);
    await page.screenshot({ path: info.outputPath(`studio-topic-library-${viewport.width}.png`) });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(topics).toBeFocused();
    await closeCreationSettings(creation);
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
