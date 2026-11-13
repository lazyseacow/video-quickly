import { expect, test } from '@playwright/test';
import { openProduction, openStoryboardProfile, pickProductionModel, productionFixture, productionStep, saveProduction } from './production-settings';

const stageLabels = ['策划与分镜', '素材与配音', '剪辑与动画', '审阅与导出'];
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
    for (const label of ['简报内容', '风格内容']) {
      const input = dialog.getByRole('textbox', { name: label, exact: true });
      await expect(input).toBeVisible();
      await expect(input).toHaveAttribute('placeholder', '未填写时由 AI 生成');
    }
    await expect(dialog.getByRole('textbox', { name: '分镜内容', exact: true })).toHaveCount(0);
    const storyboardEntry = dialog.getByRole('button', { name: '添加分镜', exact: true });
    await expect(storyboardEntry).toBeVisible();
    await expect(storyboardEntry).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(storyboardEntry).toHaveAccessibleDescription('未填写时由 AI 生成');
    await expect(dialog.getByRole('button', { name: /^AI 填写(?:简报|风格|分镜)$/ })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '保存并开始制作', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '本次制作', exact: true })).toHaveCount(0);
    const footer = dialog.locator('.production-settings__footer');
    await expect(footer.getByRole('button')).toHaveText(['下一步']);
    await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
    const content = dialog.locator('.production-settings__content');
    await expect(dialog.getByText('分镜全局参数', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('textbox', { name: '项目原文', exact: true })).toBeVisible();
    await expect(dialog.getByText('项目原文（可选）', { exact: true })).toHaveCount(0);
    await expect(footer.getByRole('button', { name: '下一步', exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('configuration-first-' + viewport.width + '.png') });
    const storyboard = await openStoryboardProfile(dialog);
    for (const label of ['画面比例', '分辨率', '视频帧率', '素材适配']) await expect(storyboard.getByLabel(label, { exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath('storyboard-global-profile-' + viewport.width + '.png') });
    await dialog.getByRole('button', { name: '下一步', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: '文本模型', exact: true })).toBeVisible();
    await expect(dialog.getByRole('listbox')).toHaveCount(0);
    await pickProductionModel(dialog, '文本模型', source.text); await pickProductionModel(dialog, '视频模型', source.video);
    await expect(dialog.getByRole('combobox', { name: '图片模型', exact: true })).toHaveCount(0);
    const modelBounds = await Promise.all(['文本模型', '视频模型'].map(label => dialog.getByRole('combobox', { name: label, exact: true }).boundingBox()));
    for (const [index, bounds] of modelBounds.entries()) {
      expect(bounds!.x).toBeCloseTo(modelBounds[0]!.x);
      expect(bounds!.width).toBeCloseTo(modelBounds[0]!.width);
      if (index > 0) expect(bounds!.y).toBeGreaterThanOrEqual(modelBounds[index - 1]!.y + modelBounds[index - 1]!.height);
    }
    await expect(dialog.getByRole('button', { name: '添加参考音频', exact: true })).toHaveText('');
    await expect(dialog.getByText('生成并发', { exact: true })).toHaveCount(0);
    if (viewport.width >= 1024) {
      expect(await content.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    }
    await expect(dialog.getByRole('button', { name: '下一步', exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath('configuration-models-' + viewport.width + '.png') });
    await productionStep(dialog, '声音与成片');
    await expect(dialog.getByLabel('声音要求', { exact: true })).toBeVisible();
    await dialog.getByLabel('字幕', { exact: true }).selectOption('script');
    if (viewport.width >= 1024) expect(await content.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath('configuration-delivery-' + viewport.width + '.png') });
    await productionStep(dialog, '确认保存');
    await expect(footer.getByRole('button')).toHaveText(['上一步', '保存设置']);
    await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeInViewport({ ratio: 1 });
    if (viewport.width >= 1024) expect(await content.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath('configuration-review-' + viewport.width + '.png') });
    const close = dialog.getByRole('button', { name: '关闭对话框', exact: true });
    await close.focus(); await close.press('Enter'); await expect(dialog).toHaveCount(0);
    const entry = page.getByRole('button', { name: '制作设置', exact: true });
    await expect(entry).toHaveCount(1); await expect(entry).toBeFocused();
    await expect(page.getByRole('button', { name: '打开制作设置', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '填写创意简报', exact: true })).toHaveCount(0);
    const progress = page.getByRole('list', { name: '制作阶段进度', exact: true });
    await expect(progress.locator('.workbench-guide__step-copy > strong')).toHaveText(stageLabels);
    for (const label of stageLabels) {
      const trigger = progress.getByRole('button', { name: `打开阶段：${label}`, exact: true });
      await trigger.focus(); await trigger.press('Enter');
      const records = page.getByRole('dialog', { name: '本次制作', exact: true });
      await expect(records).toBeVisible(); await expect(records.getByRole('tablist', { name: '制作阶段记录', exact: true })).toHaveCount(0);
      await expect(records.getByRole('heading', { name: '尚未开始制作', exact: true })).toBeVisible();
      if (label === stageLabels[0]) {
        await expect(records.locator('.dialog__surface')).toHaveCSS('opacity', '1');
        const empty = records.locator('.empty-state');
        await expect(empty).toBeInViewport({ ratio: 1 });
        const { horizontal, vertical } = await empty.evaluate(element => {
          const body = element.closest('.dialog__body')!.getBoundingClientRect();
          const heading = element.querySelector('h3')!.getBoundingClientRect();
          const group = element.getBoundingClientRect();
          return {
            horizontal: Math.abs(heading.left + heading.width / 2 - (body.left + body.width / 2)),
            vertical: Math.abs(group.top + group.height / 2 - (body.top + body.height / 2)),
          };
        });
        expect(horizontal).toBeLessThanOrEqual(1);
        expect(vertical).toBeLessThanOrEqual(1);
        await records.screenshot({ path: info.outputPath(`production-empty-${viewport.width}.png`) });
      }
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

test('checks required models and saves once from review', async ({ page, request }, info) => {
  const source = await productionFixture(request), dialog = await openProduction(page, source.project);
  let writes = 0, starts = 0;
  page.on('request', request => { if (!request.url().endsWith('/__desktop_rpc') || request.method() !== 'POST') return; const method = request.postDataJSON().method; if (method === 'project.update') writes++; if (method === 'run.start') starts++; });
  await dialog.getByLabel('简报内容', { exact: true }).fill('给初学者解释潮汐，控制在一分钟以内。');
  await dialog.getByLabel('风格内容', { exact: true }).fill('清爽的水彩插画');
  const next = dialog.getByRole('button', { name: '下一步', exact: true });
  await next.click();
  const text = dialog.getByRole('combobox', { name: '文本模型', exact: true });
  const video = dialog.getByRole('combobox', { name: '视频模型', exact: true });
  for (const field of [text, video]) {
    await expect(field).toHaveAttribute('aria-required', 'true');
    const mark = field.locator('xpath=ancestor::label[1]').locator('.field__required');
    await expect(mark).toHaveText('*');
    await expect(mark).toHaveCSS('color', 'rgb(244, 154, 145)');
  }
  await text.fill(source.text.name);
  await next.click();
  await expect(dialog.getByRole('alert')).toContainText('请选择可用的文本模型');
  await expect(text).toBeFocused();
  await pickProductionModel(dialog, '文本模型', source.text);
  await next.click();
  await expect(dialog.getByRole('alert')).toContainText('请选择可用的视频模型');
  await expect(video).toBeFocused();
  await pickProductionModel(dialog, '视频模型', source.video);
  await expect(dialog.getByLabel('参考素材', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('combobox', { name: '图片模型', exact: true })).toHaveCount(0);
  await dialog.screenshot({ path: info.outputPath('production-required-models.png') });
  await next.click();
  await dialog.getByLabel('声音要求', { exact: true }).fill('自然中文解说，轻柔海浪声');
  await dialog.getByLabel('字幕', { exact: true }).selectOption('script');
  await productionStep(dialog, '创作要求');
  await openStoryboardProfile(dialog);
  await dialog.getByLabel('画面比例', { exact: true }).selectOption('9:16'); await dialog.getByLabel('分辨率', { exact: true }).selectOption('720');
  await dialog.getByLabel('素材适配', { exact: true }).selectOption('cover');
  await productionStep(dialog, '确认保存');
  await expect(dialog.getByRole('region', { name: '确认保存', exact: true })).toContainText(source.text.name);
  await expect(dialog.getByRole('region', { name: '确认保存', exact: true })).toContainText('9:16 · 720 × 1280');
  await expect(dialog.getByRole('region', { name: '确认保存', exact: true })).toContainText('裁剪填满');
  expect(writes).toBe(0); expect(starts).toBe(0); expect((await source.saved()).revision).toBe(source.project.revision);
  const edit = dialog.getByRole('button', { name: '修改创作要求', exact: true });
  await expect(edit).toHaveText('');
  await expect(edit.locator('svg')).toHaveCount(1);
  await edit.click();
  await expect(dialog.getByLabel('风格内容', { exact: true })).toHaveValue('清爽的水彩插画');
  await dialog.getByLabel('简报内容', { exact: true }).fill('给初学者解释潮汐，三十秒以内。');
  await productionStep(dialog, '模型与素材'); await expect(dialog.getByRole('combobox', { name: '文本模型', exact: true })).toHaveValue(source.text.name);
  await productionStep(dialog, '声音与成片'); await expect(dialog.getByLabel('声音要求', { exact: true })).toHaveValue('自然中文解说，轻柔海浪声');
  await saveProduction(dialog); await expect(dialog).toHaveCount(0);
  expect(writes).toBe(1); expect(starts).toBe(0);
  const saved = await source.saved();
  expect(saved.brief).toBe('给初学者解释潮汐，三十秒以内。'); expect(saved.style).toBe('清爽的水彩插画');
  expect(saved.profile).toMatchObject({ width: 720, height: 1280, fitMode: 'cover' });
  expect(saved.workflow.production).toMatchObject({ textModelId: source.text.id, videoModelId: source.video.id, referenceMode: 'existing', subtitleMode: 'script', soundPrompt: '自然中文解说，轻柔海浪声', manualPlanningSteps: ['brief', 'style'] });
  expect(saved.workflow.production.imageModelId).toBeUndefined();
  expect(saved.workflow.nodes.filter(node => ['brief', 'style', 'script'].includes(node.id)).map(node => node.modelId)).toEqual([source.text.id, source.text.id, source.text.id]);
  await page.getByRole('button', { name: '制作设置', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '确认保存', exact: true })).toHaveAttribute('aria-current', 'step');
});

test('keeps model search focused across the first frame after changing configuration steps', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const source = await productionFixture(request), dialog = await openProduction(page, source.project);
  const brief = dialog.getByLabel('简报内容', { exact: true }), model = dialog.getByRole('combobox', { name: '文本模型', exact: true });
  const next = dialog.getByRole('button', { name: '下一步', exact: true });
  await expect(brief).toBeFocused();
  await page.clock.install({ time: new Date('2026-06-15T12:00:00Z') }); await page.clock.pauseAt(new Date('2026-06-15T12:00:01Z'));
  await next.focus(); await next.press('Enter'); await page.clock.runFor(32); await expect(model).toBeFocused();
  const previous = dialog.getByRole('button', { name: '上一步', exact: true });
  await previous.focus(); await previous.press('Enter'); await page.clock.runFor(32); await expect(brief).toBeFocused();
  await next.focus(); await next.press('Enter');
  await model.fill(source.text.name); await expect(dialog.getByRole('option', { name: source.text.name, exact: true })).toBeVisible();
  // Hold the first RAF until typing has begun, reproducing a delayed step focus
  // without delaying the renderer or changing the Combobox's own behavior.
  await page.clock.runFor(32); await expect(model).toBeFocused(); await expect(model).toHaveAttribute('aria-expanded', 'true');
  await page.clock.resume(); await dialog.getByRole('option', { name: source.text.name, exact: true }).click();
  await expect(model).toHaveValue(source.text.name); await expect(model).toBeFocused();
  expect((await source.saved()).revision).toBe(source.project.revision);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(page.getByRole('button', { name: '制作设置', exact: true })).toBeFocused();
});

test('retains every step after a failed save and retries only through the final review', async ({ page, request }) => {
  const source = await productionFixture(request), dialog = await openProduction(page, source.project);
  await dialog.getByLabel('简报内容', { exact: true }).fill('保存失败也要保留的创作要求');
  await productionStep(dialog, '声音与成片'); await dialog.getByLabel('声音要求', { exact: true }).fill('保留声音要求');
  let failed = false;
  await page.route('**/__desktop_rpc', route => {
    if (!failed && route.request().postDataJSON().method === 'project.update') { failed = true; return route.fulfill({ status: 200, json: { error: { code: -32000, message: '测试保存失败' } } }); }
    return route.continue();
  });
  await saveProduction(dialog); await expect(dialog).toContainText('当前输入已保留');
  await productionStep(dialog, '创作要求'); await expect(dialog.getByLabel('简报内容', { exact: true })).toHaveValue('保存失败也要保留的创作要求');
  await productionStep(dialog, '声音与成片'); await expect(dialog.getByLabel('声音要求', { exact: true })).toHaveValue('保留声音要求');
  expect((await source.saved()).brief).toBe(source.project.brief);
  await saveProduction(dialog); await expect(dialog).toHaveCount(0); expect((await source.saved()).brief).toBe('保存失败也要保留的创作要求');
});

test('saves the selected storyboard profile using presets', async ({ page, request }) => {
  const source = await productionFixture(request), dialog = await openProduction(page, source.project);
  const profile = await openStoryboardProfile(dialog);
  await expect(profile.getByText('自定义分镜尺寸', { exact: true })).toHaveCount(0);
  await expect(profile.getByLabel('视频宽度', { exact: true })).toHaveCount(0);
  await expect(profile.locator('option[value="custom"]')).toHaveCount(0);
  await profile.getByLabel('画面比例', { exact: true }).selectOption('9:16');
  await profile.getByLabel('分辨率', { exact: true }).selectOption('1080');
  await profile.getByLabel('视频帧率', { exact: true }).selectOption('60');
  await saveProduction(dialog);
  await expect(dialog).toHaveCount(0);
  expect((await source.saved()).profile).toMatchObject({ width: 1080, height: 1920, frameRate: { numerator: 60, denominator: 1 } });
});

test('confirms saving before opening an auxiliary editor', async ({ page, request }) => {
  const source = await productionFixture(request), dialog = await openProduction(page, source.project);
  await dialog.getByLabel('简报内容', { exact: true }).fill('在最后一步确认之前不保存');
  await expect(dialog.getByRole('button', { name: '应用系列模板', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '保存当前系列为模板', exact: true })).toHaveCount(0);
  await productionStep(dialog, '声音与成片');
  await dialog.getByRole('button', { name: '项目字幕样式', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '确认保存', exact: true })).toHaveAttribute('aria-current', 'step');
  await expect(dialog).toContainText('保存设置后将打开字幕样式'); expect((await source.saved()).revision).toBe(source.project.revision);
  await dialog.getByRole('button', { name: '保存并打开', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '项目字幕样式', exact: true })).toBeVisible();
  expect((await source.saved()).brief).toBe('在最后一步确认之前不保存');
});
