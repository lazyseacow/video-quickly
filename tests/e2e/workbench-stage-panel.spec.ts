import { expect, test } from '@playwright/test';
import { openProduction, pickProductionModel, productionFixture, productionStep, saveProduction } from './production-settings';

const generationLabels = ['简报生成', '风格与角色生成', '分镜生成', '镜头视频生成'];
const configurationSteps = ['创作要求', '模型与素材', '声音与成片', '确认保存'];

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 1024, height: 720, theme: 'light' }, { width: 390, height: 844, theme: 'light' }]) {
  test('keeps one configuration entry and separate stage records at ' + viewport.width + 'px', async ({ page, request }, info) => {
    const errors: string[] = [], consoleIssues: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) consoleIssues.push(message.text()); });
    await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    const source = await productionFixture(request), dialog = await openProduction(page, source.project);
    await expect(page).toHaveTitle(/Video Quickly/); expect(new URL(page.url()).pathname).toBe('/');
    const navigation = dialog.getByRole('navigation', { name: '制作设置步骤', exact: true });
    await expect(navigation.getByRole('button')).toHaveText(['1创作要求', '2模型与素材', '3声音与成片', '4确认保存']);
    for (const label of configurationSteps) await expect(navigation.getByRole('button', { name: label, exact: true })).toBeInViewport();
    await expect(dialog.getByLabel('创作要求', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '保存并开始制作', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '本次制作', exact: true })).toHaveCount(0);
    await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
    const content = dialog.locator('.production-settings__content');
    if (viewport.width >= 1024) expect(await content.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath('configuration-first-' + viewport.width + '.png') });
    await dialog.getByRole('button', { name: '下一步', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: '文本模型', exact: true })).toBeVisible();
    await expect(dialog.getByRole('listbox')).toHaveCount(0);
    await pickProductionModel(dialog, '文本模型', source.text); await pickProductionModel(dialog, '视频模型', source.video);
    await dialog.getByLabel('参考素材', { exact: true }).selectOption('generate'); await pickProductionModel(dialog, '图片模型', source.image);
    if (viewport.width >= 1024) {
      expect(await content.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
      await expect(dialog.locator('.production-settings__advanced > summary').filter({ hasText: /^高级编排$/ })).toBeInViewport({ ratio: 1 });
    }
    await expect(dialog.getByRole('button', { name: '下一步', exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath('configuration-models-' + viewport.width + '.png') });
    await productionStep(dialog, '声音与成片');
    await expect(dialog.getByLabel('声音要求', { exact: true })).toBeVisible();
    await dialog.getByLabel('字幕', { exact: true }).selectOption('script');
    if (viewport.width >= 1024) expect(await content.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath('configuration-delivery-' + viewport.width + '.png') });
    await productionStep(dialog, '确认保存');
    await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeInViewport({ ratio: 1 });
    if (viewport.width >= 1024) expect(await content.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath('configuration-review-' + viewport.width + '.png') });
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    const entry = page.getByRole('button', { name: '制作设置', exact: true });
    await expect(entry).toHaveCount(1); await expect(entry).toBeFocused();
    await expect(page.getByRole('button', { name: '打开制作设置', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '填写创意简报', exact: true })).toHaveCount(0);
    const progress = page.getByRole('list', { name: '模型生成进度', exact: true });
    await expect(progress.locator('.workbench-guide__step-copy > strong')).toHaveText(generationLabels);
    for (const label of generationLabels) {
      const trigger = progress.getByRole('button', { name: `打开步骤：${label}`, exact: true });
      await trigger.focus(); await trigger.press('Enter');
      const records = page.getByRole('dialog', { name: '本次制作', exact: true });
      await expect(records).toBeVisible(); await expect(records.getByRole('tablist', { name: '制作阶段记录', exact: true })).toHaveCount(0);
      await expect(records).toContainText('尚未开始制作');
      await expect(records.getByRole('combobox', { name: '文本模型', exact: true })).toHaveCount(0);
      await expect(records.getByRole('button', { name: '制作设置', exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape'); await expect(records).toHaveCount(0); await expect(trigger).toBeFocused();
    }
    await entry.focus();
    await page.screenshot({ path: info.outputPath('single-entry-workbench-' + viewport.width + '.png') });
    expect((await source.saved()).revision).toBe(source.project.revision);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]); expect(consoleIssues).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('fills steps without saving and commits all configuration once from the final review', async ({ page, request }) => {
  const source = await productionFixture(request), dialog = await openProduction(page, source.project);
  let writes = 0, starts = 0;
  page.on('request', request => { if (!request.url().endsWith('/__desktop_rpc') || request.method() !== 'POST') return; const method = request.postDataJSON().method; if (method === 'project.update') writes++; if (method === 'run.start') starts++; });
  await dialog.getByLabel('创作要求', { exact: true }).fill('给初学者解释潮汐，控制在一分钟以内。');
  await dialog.getByLabel('视觉风格', { exact: true }).fill('清爽的水彩插画');
  await dialog.locator('summary:visible').filter({ hasText: '高级设置' }).click();
  await dialog.getByRole('combobox', { name: '任务', exact: true }).selectOption('style');
  await pickProductionModel(dialog, '风格与角色模型', source.override);
  await dialog.getByLabel('风格与角色补充要求', { exact: true }).fill('保持人物外观一致');
  await dialog.getByRole('button', { name: '下一步', exact: true }).click();
  await pickProductionModel(dialog, '文本模型', source.text); await pickProductionModel(dialog, '视频模型', source.video);
  await dialog.getByLabel('参考素材', { exact: true }).selectOption('generate'); await pickProductionModel(dialog, '图片模型', source.image);
  await dialog.getByRole('button', { name: '下一步', exact: true }).click();
  await dialog.getByLabel('声音要求', { exact: true }).fill('自然中文解说，轻柔海浪声');
  await dialog.getByLabel('字幕', { exact: true }).selectOption('script');
  await dialog.getByLabel('画面比例', { exact: true }).selectOption('9:16'); await dialog.getByLabel('分辨率', { exact: true }).selectOption('720');
  await dialog.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '确认保存', exact: true })).toContainText(source.text.name);
  await expect(dialog.getByRole('region', { name: '确认保存', exact: true })).toContainText('720 × 1280');
  expect(writes).toBe(0); expect(starts).toBe(0); expect((await source.saved()).revision).toBe(source.project.revision);
  await dialog.getByRole('button', { name: '修改创作要求', exact: true }).click();
  await expect(dialog.getByLabel('视觉风格', { exact: true })).toHaveValue('清爽的水彩插画');
  await dialog.getByLabel('创作要求', { exact: true }).fill('给初学者解释潮汐，三十秒以内。');
  await productionStep(dialog, '模型与素材'); await expect(dialog.getByRole('combobox', { name: '文本模型', exact: true })).toHaveValue(source.text.name);
  await productionStep(dialog, '声音与成片'); await expect(dialog.getByLabel('声音要求', { exact: true })).toHaveValue('自然中文解说，轻柔海浪声');
  await saveProduction(dialog); await expect(dialog).toHaveCount(0);
  expect(writes).toBe(1); expect(starts).toBe(0);
  const saved = await source.saved();
  expect(saved.brief).toBe('给初学者解释潮汐，三十秒以内。'); expect(saved.style).toBe('清爽的水彩插画');
  expect(saved.profile).toMatchObject({ width: 720, height: 1280 });
  expect(saved.workflow.production).toMatchObject({ textModelId: source.text.id, videoModelId: source.video.id, imageModelId: source.image.id, referenceMode: 'generate', subtitleMode: 'script', soundPrompt: '自然中文解说，轻柔海浪声' });
  expect(saved.workflow.nodes.find(node => node.id === 'style')).toMatchObject({ modelId: source.override.id, config: { modelOverride: true }, prompt: '保持人物外观一致' });
  await page.getByRole('button', { name: '制作设置', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '确认保存', exact: true })).toHaveAttribute('aria-current', 'step');
});

test('retains every step after a failed save and retries only through the final review', async ({ page, request }) => {
  const source = await productionFixture(request), dialog = await openProduction(page, source.project);
  await dialog.getByLabel('创作要求', { exact: true }).fill('保存失败也要保留的创作要求');
  await productionStep(dialog, '声音与成片'); await dialog.getByLabel('声音要求', { exact: true }).fill('保留声音要求');
  let failed = false;
  await page.route('**/__desktop_rpc', route => {
    if (!failed && route.request().postDataJSON().method === 'project.update') { failed = true; return route.fulfill({ status: 200, json: { error: { code: -32000, message: '测试保存失败' } } }); }
    return route.continue();
  });
  await saveProduction(dialog); await expect(dialog).toContainText('当前输入已保留');
  await productionStep(dialog, '创作要求'); await expect(dialog.getByLabel('创作要求', { exact: true })).toHaveValue('保存失败也要保留的创作要求');
  await productionStep(dialog, '声音与成片'); await expect(dialog.getByLabel('声音要求', { exact: true })).toHaveValue('保留声音要求');
  expect((await source.saved()).brief).toBe(source.project.brief);
  await saveProduction(dialog); await expect(dialog).toHaveCount(0); expect((await source.saved()).brief).toBe('保存失败也要保留的创作要求');
});

test('returns final validation errors to the relevant step and reveals the invalid field', async ({ page, request }) => {
  const source = await productionFixture(request), dialog = await openProduction(page, source.project);
  await productionStep(dialog, '声音与成片');
  await dialog.locator('.video-settings__advanced > summary').click();
  await dialog.getByLabel('视频宽度', { exact: true }).fill('63');
  await productionStep(dialog, '确认保存'); await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '声音与成片', exact: true })).toHaveAttribute('aria-current', 'step');
  await expect(dialog.getByLabel('视频宽度', { exact: true })).toBeVisible(); await expect(dialog.getByLabel('视频宽度', { exact: true })).toBeFocused();
  expect((await source.saved()).revision).toBe(source.project.revision);
  await dialog.getByLabel('视频宽度', { exact: true }).fill('1280'); await saveProduction(dialog); await expect(dialog).toHaveCount(0);
});

test('confirms saving before opening an auxiliary editor', async ({ page, request }) => {
  const source = await productionFixture(request), dialog = await openProduction(page, source.project);
  await dialog.getByLabel('创作要求', { exact: true }).fill('在最后一步确认之前不保存');
  await dialog.getByRole('button', { name: '应用系列模板', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '确认保存', exact: true })).toHaveAttribute('aria-current', 'step');
  await expect(dialog).toContainText('保存设置后将打开系列模板'); expect((await source.saved()).revision).toBe(source.project.revision);
  await dialog.getByRole('button', { name: '保存并打开', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '应用系列模板', exact: true })).toBeVisible();
  expect((await source.saved()).brief).toBe('在最后一步确认之前不保存');
});
