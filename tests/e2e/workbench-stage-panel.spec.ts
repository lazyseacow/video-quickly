import { expect, test } from '@playwright/test';
import { productionFixture, openProduction, pickProductionModel } from './production-settings';

const stages = ['策划与分镜', '素材与配音', '剪辑与动画', '审阅与导出'];
const configurationSections = ['策划与分镜', '素材与配音', '审阅与导出'];
for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 600, height: 900, theme: 'light' }]) test.describe(`stage focus at ${viewport.width}px in ${viewport.theme}`, () => {
  test.use({ viewport: { width: viewport.width, height: viewport.height }, storageState: async ({ baseURL }, use) => {
    if (!baseURL) throw new Error('Stage focus tests require a local application origin');
    await use({ cookies: [], origins: [{ origin: baseURL, localStorage: [{ name: 'vq-theme', value: viewport.theme }, { name: 'vq-onboarding-v1', value: 'done' }] }] });
  } });
  test('clears pointer focus rings after closing stage settings and preserves keyboard navigation', async ({ page, request }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    const source = await productionFixture(request), dialog = await openProduction(page, source.project);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    for (const stage of [stages[1], stages[0], stages[2], stages[3]]) {
      const trigger = page.locator('.workbench-guide__step').filter({ hasText: stage }), card = trigger.locator('..');
      const current = await trigger.getAttribute('aria-current');
      await trigger.click(); await expect(dialog).toBeVisible();
      if (stage === stages[1]) await page.keyboard.press('Escape');
      else await dialog.getByRole('button', { name: stage === stages[3] ? '取消' : '关闭对话框', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      if (stage === stages[1]) await page.screenshot({ path: info.outputPath('stage-pointer-focus-cleared.png') });
      await expect(card).toHaveCSS('outline-style', 'none');
      await expect(trigger).toBeFocused();
      expect(await trigger.getAttribute('aria-current')).toBe(current);
      const help = page.getByRole('button', { name: `${stage}说明`, exact: true });
      await trigger.press('Tab'); await expect(help).toBeFocused();
      await help.press('Shift+Tab'); await expect(trigger).toBeFocused(); await expect(card).toHaveCSS('outline-style', 'solid');
      for (const key of ['Enter', 'Space']) {
        await trigger.press(key); await expect(dialog).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused(); await expect(card).toHaveCSS('outline-style', 'solid');
      }
      await trigger.click(); await expect(dialog).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused(); await expect(card).toHaveCSS('outline-style', 'none');
    }
    await expect(page).toHaveTitle(/Video Quickly/); expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
    expect((await source.saved()).revision).toBe(source.project.revision);
    await page.getByRole('button', { name: `${stages[3]}说明`, exact: true }).press('Shift+Tab');
    await expect(page.locator('.workbench-guide__step').filter({ hasText: stages[3] })).toBeFocused();
    await page.screenshot({ path: info.outputPath('stage-keyboard-focus.png') });
  });
});

test('opens configuration for configurable stages and records for automatic stages using the keyboard', async ({ page, request }, info) => {
  const errors: string[] = [], consoleIssues: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) consoleIssues.push(message.text()); });
  const source = await productionFixture(request), dialog = await openProduction(page, source.project);
  await expect(page).toHaveTitle(/Video Quickly/); expect(new URL(page.url()).pathname).toBe('/');
  await expect(dialog.getByRole('tablist', { name: '制作配置分区', exact: true }).getByRole('tab')).toHaveText(configurationSections);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  for (const stage of stages) {
    const trigger = page.locator('.workbench-guide__step').filter({ hasText: stage }); await expect(trigger).toBeVisible(); await trigger.focus(); await trigger.press('Enter');
    await expect(dialog).toBeVisible(); await expect(dialog.getByRole('tab', { name: stage, exact: true })).toHaveAttribute('aria-selected', 'true');
    if (stage === '剪辑与动画') {
      await expect(dialog.getByRole('button', { name: '本次制作', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(dialog.getByRole('tablist', { name: '制作阶段记录', exact: true }).getByRole('tab')).toHaveText(stages);
      await expect(dialog).toContainText('本阶段尚未开始制作');
      await expect(dialog.getByRole('combobox', { name: '文本模型', exact: true })).toHaveCount(0);
      await dialog.getByRole('button', { name: '制作设置', exact: true }).click();
      await expect(dialog.getByRole('tablist', { name: '制作配置分区', exact: true }).getByRole('tab')).toHaveText(configurationSections);
      await dialog.getByRole('button', { name: '本次制作', exact: true }).click();
      await expect(dialog.getByRole('tab', { name: stage, exact: true })).toHaveAttribute('aria-selected', 'true');
    } else {
      await expect(dialog.getByRole('button', { name: '制作设置', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(dialog.getByRole('combobox', { name: '文本模型', exact: true })).toBeVisible();
      await expect(dialog.locator('summary:visible').filter({ hasText: '高级设置' })).toHaveCount(stage === '审阅与导出' ? 0 : 1);
    }
    await expect(dialog.getByRole('listbox')).toHaveCount(0);
    await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await expect(trigger).toBeFocused();
  }
  await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]); expect(consoleIssues).toEqual([]);
  await page.screenshot({ path: info.outputPath('four-native-stages.png') });
});

test('preserves form values and each view selection when switching between settings and records', async ({ page, request }) => {
  const source = await productionFixture(request), dialog = await openProduction(page, source.project);
  await dialog.getByLabel('创作要求', { exact: true }).fill('保留切换前的创作要求');
  await dialog.getByRole('tab', { name: '素材与配音', exact: true }).click();
  await dialog.getByLabel('声音要求', { exact: true }).fill('保留切换前的声音要求');
  await dialog.getByRole('button', { name: '本次制作', exact: true }).click();
  await dialog.getByRole('tab', { name: '剪辑与动画', exact: true }).click();
  await dialog.getByRole('button', { name: '制作设置', exact: true }).click();
  await expect(dialog.getByRole('tab', { name: '素材与配音', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByLabel('声音要求', { exact: true })).toHaveValue('保留切换前的声音要求');
  await dialog.getByRole('tab', { name: '策划与分镜', exact: true }).click();
  await expect(dialog.getByLabel('创作要求', { exact: true })).toHaveValue('保留切换前的创作要求');
  await dialog.getByRole('button', { name: '本次制作', exact: true }).click();
  await expect(dialog.getByRole('tab', { name: '剪辑与动画', exact: true })).toHaveAttribute('aria-selected', 'true');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  expect((await source.saved()).brief).toBe(source.project.brief);
});

test('shows reference generation requirements only when reference images will be generated', async ({ page, request }) => {
  const source = await productionFixture(request), dialog = await openProduction(page, source.project);
  await dialog.getByRole('tab', { name: '素材与配音', exact: true }).click();
  await dialog.locator('summary:visible').click();
  await expect(dialog.getByLabel('镜头视频生成补充要求', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('参考素材准备补充要求', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('参考素材', { exact: true }).selectOption('generate');
  await dialog.getByRole('combobox', { name: '任务', exact: true }).selectOption('assets');
  await dialog.getByLabel('参考素材准备补充要求', { exact: true }).fill('保持参考图主体一致');
  await dialog.getByLabel('参考素材', { exact: true }).selectOption('existing');
  await expect(dialog.getByLabel('参考素材准备补充要求', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('参考素材', { exact: true }).selectOption('generate');
  await expect(dialog.getByLabel('参考素材准备补充要求', { exact: true })).toHaveValue('保持参考图主体一致');
});

for (const width of [1536, 390]) test('keeps model lists closed on dialog focus and opens them through user input at ' + width + 'px', async ({ page, request }, info) => {
  const source = await productionFixture(request), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
  const response = await request.post('/__desktop_rpc', { data: { method: 'project.update', params: { projectId: source.project.id, revision: source.project.revision, patch: { workflow: { ...source.project.workflow, production: { ...source.project.workflow.production, textModelId: source.text.id, videoModelId: source.video.id } } } } } });
  expect(response.ok()).toBe(true);
  const project = (await response.json()).result, dialog = await openProduction(page, project);
  const text = dialog.getByRole('combobox', { name: '文本模型', exact: true }), video = dialog.getByRole('combobox', { name: '视频模型', exact: true });
  await expect(text).toBeFocused(); await expect(text).toHaveValue(source.text.name);
  await expect(text).toHaveAttribute('aria-expanded', 'false'); await expect(dialog.getByRole('listbox')).toHaveCount(0);
  await text.click(); await expect(dialog.getByRole('option', { name: source.text.name, exact: true })).toBeVisible();
  await text.press('Escape'); await expect(text).toHaveAttribute('aria-expanded', 'false'); await expect(dialog).toBeVisible();
  await text.press('Tab'); await expect(video).toBeFocused(); await expect(video).toHaveAttribute('aria-expanded', 'false');
  await video.press('ArrowDown'); await expect(dialog.getByRole('option', { name: source.video.name, exact: true })).toBeVisible();
  await expect(video).toHaveAttribute('aria-activedescendant', /\S+/);
  const activeId = await video.getAttribute('aria-activedescendant'), selectedLabel = await dialog.locator(`[id="${activeId}"]`).innerText();
  await video.press('Enter'); await expect(video).toHaveValue(selectedLabel); await expect(dialog.getByRole('listbox')).toHaveCount(0);
  await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('model-lists-collapsed-' + width + '.png') });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await source.saved()).workflow.production).toEqual(project.workflow.production);
});

test('edits one task at a time, retains its inputs and restores unified model inheritance', async ({ page, request }, info) => {
  const source = await productionFixture(request), dialog = await openProduction(page, source.project);
  await pickProductionModel(dialog, '文本模型', source.text); await pickProductionModel(dialog, '视频模型', source.video);
  await dialog.locator('summary:visible').click();
  await dialog.getByRole('combobox', { name: '任务', exact: true }).selectOption('style'); await pickProductionModel(dialog, '风格与角色模型', source.override);
  await dialog.getByLabel('风格与角色补充要求', { exact: true }).fill('统一的水彩风格');
  await dialog.getByRole('combobox', { name: '任务', exact: true }).selectOption('brief');
  await dialog.getByLabel('创意简报补充要求', { exact: true }).fill('向普通观众说明主题');
  await dialog.getByRole('combobox', { name: '任务', exact: true }).selectOption('style');
  await expect(dialog.getByLabel('风格与角色补充要求', { exact: true })).toHaveValue('统一的水彩风格');
  await expect(dialog.getByRole('combobox', { name: '风格与角色模型', exact: true })).toHaveValue(source.override.name);
  await expect(dialog.locator('.production-settings__task:visible')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('single-task-settings.png') });
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(dialog).toHaveCount(0);
  let saved = await source.saved(); expect(saved.workflow.nodes.find(node => node.id === 'style')).toMatchObject({ modelId: source.override.id, config: { modelOverride: true }, prompt: '统一的水彩风格' });
  expect(saved.workflow.nodes.find(node => node.id === 'brief')?.prompt).toBe('向普通观众说明主题');
  await page.getByRole('button', { name: '制作设置', exact: true }).click(); await dialog.locator('summary:visible').click();
  await dialog.getByRole('combobox', { name: '任务', exact: true }).selectOption('style');
  await dialog.getByRole('combobox', { name: '风格与角色模型', exact: true }).fill('跟随统一模型'); await dialog.getByRole('option', { name: '跟随统一模型', exact: true }).click();
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(dialog).toHaveCount(0);
  saved = await source.saved(); expect(saved.workflow.nodes.find(node => node.id === 'style')).toMatchObject({ modelId: source.text.id, config: { modelOverride: false } });
});

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) test('keeps common output choices concise and saves optional settings at ' + viewport.width + 'px', async ({ page, request }, info) => {
  const source = await productionFixture(request), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
  const dialog = await openProduction(page, source.project);
  await pickProductionModel(dialog, '文本模型', source.text); await pickProductionModel(dialog, '视频模型', source.video);
  await dialog.getByRole('tab', { name: '审阅与导出', exact: true }).click();
  await expect(dialog.getByLabel('字幕', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('画面比例', { exact: true })).toBeVisible(); await expect(dialog.getByLabel('分辨率', { exact: true })).toBeVisible();
  for (const label of ['视频宽度', '视频高度', '视频帧率', '素材适配']) await expect(dialog.getByLabel(label, { exact: true })).toBeHidden();
  await expect(dialog.getByLabel('预览质量', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('画面比例', { exact: true }).selectOption('9:16'); await dialog.getByLabel('分辨率', { exact: true }).selectOption('720');
  await page.screenshot({ path: info.outputPath('concise-output-' + viewport.width + '.png') });
  const more = dialog.locator('.video-settings__advanced'); await more.locator('summary').click();
  await expect(dialog.getByLabel('视频宽度', { exact: true })).toHaveValue('720'); await expect(dialog.getByLabel('视频高度', { exact: true })).toHaveValue('1280');
  await dialog.getByLabel('视频帧率', { exact: true }).selectOption('60'); await dialog.getByLabel('素材适配', { exact: true }).selectOption('cover');
  await more.locator('summary').click(); await expect(more).not.toHaveAttribute('open');
  await expect(more.locator('summary')).toContainText('60 fps · 裁剪填满');
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect((await source.saved()).profile).toEqual({ ...source.project.profile, width: 720, height: 1280, frameRate: { numerator: 60, denominator: 1 }, fitMode: 'cover' });
  await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
});

test('preserves custom output values and reveals collapsed invalid dimensions before saving', async ({ page, request }) => {
  const source = await productionFixture(request);
  const profile = { ...source.project.profile, width: 962, height: 674, frameRate: { numerator: 30000, denominator: 1001 }, fitMode: 'blur', previewScale: .25 };
  const response = await request.post('/__desktop_rpc', { data: { method: 'project.update', params: { projectId: source.project.id, revision: source.project.revision, patch: { profile } } } });
  expect(response.ok()).toBe(true);
  const dialog = await openProduction(page, source.project);
  await pickProductionModel(dialog, '文本模型', source.text); await pickProductionModel(dialog, '视频模型', source.video);
  await dialog.getByRole('tab', { name: '审阅与导出', exact: true }).click();
  await expect(dialog.getByLabel('分辨率', { exact: true }).locator('option:checked')).toHaveText('962 × 674 · 当前');
  const more = dialog.locator('.video-settings__advanced'); await more.locator('summary').click();
  await expect(dialog.getByLabel('视频帧率', { exact: true })).toHaveValue('current');
  await expect(dialog.getByLabel('素材适配', { exact: true })).toHaveValue('blur');
  await dialog.getByRole('button', { name: '解锁宽高比例', exact: true }).click(); await dialog.getByLabel('视频宽度', { exact: true }).fill('32');
  await more.locator('summary').click(); await dialog.getByRole('tab', { name: '策划与分镜', exact: true }).click();
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(dialog.getByRole('tab', { name: '审阅与导出', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(more).toHaveAttribute('open', ''); await expect(dialog.getByLabel('视频宽度', { exact: true })).toBeFocused();
  await dialog.getByLabel('视频宽度', { exact: true }).fill('962'); await more.locator('summary').click();
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect((await source.saved()).profile).toEqual(profile);
});

test('opens the exact task when its model override needs repair', async ({ page, request }) => {
  const source = await productionFixture(request);
  const workflow = { ...source.project.workflow, nodes: source.project.workflow.nodes.map(node => node.id === 'style' ? { ...node, modelId: 'removed-model', config: { ...node.config, modelOverride: true } } : node) };
  const response = await request.post('/__desktop_rpc', { data: { method: 'project.update', params: { projectId: source.project.id, revision: source.project.revision, patch: { workflow } } } });
  expect(response.ok()).toBe(true);
  const dialog = await openProduction(page, source.project);
  await pickProductionModel(dialog, '文本模型', source.text); await pickProductionModel(dialog, '视频模型', source.video);
  await dialog.getByRole('button', { name: '保存并开始制作', exact: true }).click();
  await expect(dialog).toContainText('请为「风格与角色」选择可用的模型');
  await expect(dialog.getByRole('combobox', { name: '任务', exact: true })).toHaveValue('style');
  await expect(dialog.getByLabel('风格与角色补充要求', { exact: true })).toBeVisible();
  await pickProductionModel(dialog, '风格与角色模型', source.override);
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect((await source.saved()).workflow.nodes.find(node => node.id === 'style')?.modelId).toBe(source.override.id);
});
