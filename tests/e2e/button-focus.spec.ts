import { expect, test, type Locator, type Page } from '@playwright/test';
import { productionFixture, openProduction } from './production-settings';

async function keyboardFocus(page: Page, button: Locator) {
  await button.focus(); await button.press('Tab'); await page.keyboard.press('Shift+Tab');
  await expect(button).toBeFocused(); await expect(button).toHaveCSS('outline-style', 'solid');
}

for (const viewport of [{ width: 1536, height: 960, theme: 'light' }, { width: 600, height: 900, theme: 'dark' }]) test.describe(`button focus at ${viewport.width}px in ${viewport.theme}`, () => {
  test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.width === 600, storageState: async ({ baseURL }, use) => {
    if (!baseURL) throw new Error('Button focus tests require a local application origin');
    await use({ cookies: [], origins: [{ origin: baseURL, localStorage: [{ name: 'vq-theme', value: viewport.theme }, { name: 'vq-onboarding-v1', value: 'done' }] }] });
  } });

  test('clears pointer rings across dialogs, toolbar controls, navigation and floating settings', async ({ page, request }, info) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', entry => { if (['error', 'warning'].includes(entry.type())) errors.push(entry.text()); });
    const source = await productionFixture(request), initial = await openProduction(page, source.project);
    await initial.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await expect(initial).toHaveCount(0);
    for (const [name, title] of [['新建项目', '新建视频项目'], ['制作设置', '制作设置'], ['制作前检查', '制作前检查'], ['导出', '导出视频']]) {
      const inMore = name === '制作前检查';
      const button = page.getByRole('button', { name: inMore ? '更多' : name, exact: true }), dialog = page.getByRole('dialog', { name: title, exact: true });
      async function activate(key?: string) {
        if (key) await button.press(key);
        else if (viewport.width === 600) await button.tap();
        else await button.click();
        if (!inMore) return;
        const item = page.getByRole('button', { name, exact: true });
        if (key) {
          await page.keyboard.press('Tab'); await expect(item).toBeFocused(); await item.press(key);
        } else if (viewport.width === 600) await item.tap();
        else await item.click();
      }
      await keyboardFocus(page, button);
      await activate();
      await expect(dialog).toBeVisible();
      if (name === '新建项目') await dialog.getByLabel('项目名称', { exact: true }).press('Tab');
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
      await expect(button).toBeFocused();
      if (name === '新建项目') await page.screenshot({ path: info.outputPath('pointer-dialog-return.png') });
      await expect(button).toHaveCSS('outline-style', 'none');
      await keyboardFocus(page, button);
      for (const key of ['Enter', 'Space']) {
        await activate(key); await expect(dialog).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
        await expect(button).toBeFocused(); await expect(button).toHaveCSS('outline-style', 'solid');
      }
      await activate('Enter'); await expect(dialog).toBeVisible(); await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(dialog).toHaveCount(0);
      await expect(button).toBeFocused(); await expect(button).toHaveCSS('outline-style', 'none');
      if (name === '新建项目') {
        await keyboardFocus(page, button); await button.press('Enter'); await expect(dialog).toBeVisible();
        await page.mouse.click(8, 8); await expect(dialog).toHaveCount(0); await expect(button).toBeFocused(); await expect(button).toHaveCSS('outline-style', 'none');
      }
    }
    const inspector = page.getByRole('button', { name: '切换属性面板', exact: true });
    await keyboardFocus(page, inspector);
    const expanded = await inspector.getAttribute('aria-pressed');
    await inspector.click(); await expect(inspector).toHaveAttribute('aria-pressed', expanded === 'true' ? 'false' : 'true');
    await expect(inspector).toBeFocused(); await expect(inspector).toHaveCSS('outline-style', 'none');
    await inspector.press('Space'); await expect(inspector).toHaveAttribute('aria-pressed', expanded!); await expect(inspector).toHaveCSS('outline-style', 'solid');
    const models = page.getByRole('button', { name: '模型连接', exact: true });
    await keyboardFocus(page, models); await models.click(); await expect(page.getByRole('heading', { name: '模型连接', exact: true })).toBeVisible();
    await expect(models).toBeFocused(); await expect(models).toHaveCSS('outline-style', 'none');
    await models.press('Space'); await expect(models).toHaveCSS('outline-style', 'solid');
    const settings = page.getByRole('button', { name: '设置', exact: true }), popup = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.click(); await expect(popup).toBeVisible(); await page.keyboard.press('Escape'); await expect(popup).toHaveCount(0);
    await expect(settings).toBeFocused(); await expect(settings).toHaveCSS('outline-style', 'none');
    await keyboardFocus(page, settings); await settings.press('Enter'); await expect(popup).toBeVisible(); await page.keyboard.press('Escape'); await expect(popup).toHaveCount(0);
    await expect(settings).toBeFocused(); await expect(settings).toHaveCSS('outline-style', 'solid');
    await settings.click(); await popup.getByRole('button', { name: '使用指南', exact: true }).click();
    const guide = page.locator('[data-guide-popover]'); await expect(guide).toBeVisible(); await page.keyboard.press('Escape'); await expect(guide).toHaveCount(0);
    await expect(settings).toBeFocused(); await expect(settings).toHaveCSS('outline-style', 'none');
    await keyboardFocus(page, settings); await settings.press('Enter'); await expect(popup).toBeVisible();
    const help = popup.getByRole('button', { name: '使用指南', exact: true }); await help.focus(); await help.press('Enter'); await expect(guide).toBeVisible();
    await page.keyboard.press('Escape'); await expect(guide).toHaveCount(0); await expect(settings).toBeFocused(); await expect(settings).toHaveCSS('outline-style', 'solid');
    await expect(page).toHaveTitle(/Video Quickly/); expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
    expect((await source.saved()).revision).toBe(source.project.revision);
    await page.screenshot({ path: info.outputPath('keyboard-settings-return.png') });
  });

  test('preserves step navigation, combobox editing, sliders and help while switching input methods', async ({ page, request }, info) => {
    const source = await productionFixture(request), dialog = await openProduction(page, source.project);
    const navigation = dialog.getByRole('navigation', { name: '制作设置步骤', exact: true });
    const materials = navigation.getByRole('button', { name: '模型与素材', exact: true }), delivery = navigation.getByRole('button', { name: '声音与成片', exact: true });
    await materials.click(); await expect(materials).toBeFocused(); await expect(materials).toHaveCSS('outline-style', 'none');
    await materials.press('Tab'); await expect(delivery).toBeFocused(); await delivery.press('Enter'); await expect(delivery).toHaveAttribute('aria-current', 'step'); await expect(delivery).toHaveCSS('outline-style', 'solid');
    await delivery.click(); await expect(delivery).toBeFocused(); await expect(delivery).toHaveCSS('outline-style', 'none');
    await delivery.press('Shift+Tab'); await expect(materials).toBeFocused(); await materials.press('Enter'); await expect(materials).toHaveAttribute('aria-current', 'step'); await expect(materials).toHaveCSS('outline-style', 'solid');
    const video = dialog.getByRole('combobox', { name: '视频模型', exact: true });
    await video.fill(source.video.name); await video.press('ArrowDown'); await video.press('Enter'); await expect(video).toHaveValue(source.video.name);
    await dialog.getByRole('button', { name: '展开视频模型列表', exact: true }).click();
    await expect(video).toBeFocused(); await expect(dialog.getByRole('listbox')).toBeVisible();
    expect(await video.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
    await video.press('Escape'); await expect(dialog.getByRole('listbox')).toHaveCount(0); await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const zoom = page.getByRole('slider', { name: '时间轴缩放', exact: true });
    await zoom.focus(); await zoom.press('Home'); await zoom.press('ArrowRight'); await expect(zoom).toHaveValue('1.1'); await expect(zoom).toBeFocused();
    const help = page.getByRole('button', { name: '素材与配音说明', exact: true });
    await keyboardFocus(page, help); await help.click(); await expect(page.getByRole('tooltip')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).toHaveCount(0); await expect(help).toBeFocused(); await expect(help).toHaveCSS('outline-style', 'none');
    await keyboardFocus(page, help); await expect(page.getByRole('tooltip')).toBeVisible();
    await page.screenshot({ path: info.outputPath('keyboard-help-focus.png') });
    expect((await source.saved()).revision).toBe(source.project.revision);
  });
});
