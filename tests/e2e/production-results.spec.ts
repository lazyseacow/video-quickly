import { expect, test, type Page, type APIRequestContext, type TestInfo } from '@playwright/test';
import type { RunSummary } from '@video-quickly/contracts';
import { fixture, open, rpc, saved } from './native-video-fixture';

const brief = {
  topic: '职场人如何用 AI 提效',
  audience: '20–35 岁的职场白领',
  coreMessage: '通过三个实用方法，让职场人用 AI 改善日常工作，缓解工作焦虑。',
  narrativeOrder: [
    '1. **黄金 3 秒开场（Hook）**：直接提出痛点，建立悬念。',
    '2. **痛点与共鸣（Problem）**：还原日常办公场景。',
    '3. **解决方案（Value）**：用写稿、邮件和会议三个例子说明方法。',
    '4. **互动与结尾（CTA）**：引导观众收藏和分享。',
  ].join('\n'),
  targetDuration: '约 45 秒',
  expression: `保持角色外观一致。${'语气真诚自然，使用短句；先说明操作，再展示具体效果。'.repeat(12)}成片规格为{"width":1920,"height":1080,"frameRate":{"numerator":60000,"denominator":1001},"fitMode":"contain","previewScale":0.5}；保留最后一条表达要求。`,
};
const style = {
  artStyle: '采用**柔和蓝色**的漫画画面。',
  palette: '',
  composition: '- 保持人物服装一致\n- 突出办公桌和屏幕',
  lighting: '',
  characterAppearance: '',
  sceneContinuity: '```html\n<img src="https://invalid.example/never-load.png" onerror="alert(1)">\n```\n最后一段仍然可读。',
};
const shotVisual = '背景#F7F5F0，阴影（#AbC）、透明区域 #0000 和强调色（#E0A030FF）。\n镜头编号 #123456789 和标识 #FEEDfaceZ 保持原样。';

async function produced(page: Page, request: APIRequestContext, info: TestInfo) {
  const firstScriptResponse = JSON.stringify({ shots: [{ number: 1, title: '生成的蓝色镜头', narration: '天空是蓝色的。', visualPrompt: shotVisual, soundPrompt: '自然讲述', durationUs: 1_000_000 }] });
  const source = await fixture(request, info, false, 1, { brief, style, firstScriptResponse });
  try {
    await rpc(request, 'project.update', { projectId: source.project.id, patch: { workflow: { ...source.project.workflow, production: { ...source.project.workflow.production!, textModelId: source.models[0].id, videoModelId: source.video.id } } } });
    const run = await rpc<{ id: string }>(request, 'run.start', { projectId: source.project.id });
    await expect.poll(async () => (await rpc<RunSummary>(request, 'run.get', { runId: run.id })).status, { timeout: 60_000 }).toBe('succeeded');
    await open(page, source.project).then(dialog => dialog.getByRole('button', { name: '关闭对话框', exact: true }).click());
    const trigger = page.getByRole('button', { name: '打开阶段：策划与分镜', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '本次制作', exact: true });
    await dialog.getByRole('navigation', { name: '本次制作步骤' }).getByRole('button', { name: /简报生成/ }).click();
    await expect(dialog.getByRole('heading', { name: '职场人如何用 AI 提效', exact: true })).toBeVisible();
    return { source, dialog, trigger };
  } catch (error) { await source.close(); throw error; }
}

for (const { width, theme } of [{ width: 1536, theme: 'dark' }, { width: 1024, theme: 'light' }, { width: 390, theme: 'dark' }]) {
  test(`makes production results readable and preserves navigation at ${width}px in ${theme}`, async ({ page, request }, info) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    const detailReads: string[] = [];
    page.on('request', request => {
      if (!request.url().endsWith('/__desktop_rpc')) return;
      const { method, params } = request.postDataJSON();
      if (method === 'run.inspect' && params.nodeId || method === 'run.step.payload' && params.kind === 'input' || ['run.events', 'run.activities'].includes(method)) detailReads.push(method);
    });
    await page.setViewportSize({ width, height: 960 });
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), theme);
    if (width === 390) await page.emulateMedia({ reducedMotion: 'reduce' });
    const { source, dialog, trigger } = await produced(page, request, info);
    try {
      const baseline = await saved(request, source.project.id), requests = source.requests.length;
      const document = dialog.getByRole('article', { name: '创作简报', exact: true });
      const overview = document.getByRole('definition').filter({ hasText: '20–35 岁' });
      await expect(overview).toBeVisible(); await expect(document.getByText('约 45 秒', { exact: true })).toBeVisible();
      await expect(document.getByRole('region', { name: '核心信息', exact: true })).toContainText('三个实用方法');
      const sequence = document.getByRole('region', { name: '叙事顺序', exact: true });
      await expect(sequence.locator('ol > li')).toHaveCount(4); await expect(sequence.locator('strong').first()).toHaveText('黄金 3 秒开场（Hook）');
      await expect(dialog.locator('.stage-run-view__completion')).toHaveText('7/ 7 项任务完成');
      await expect(document.locator('details').filter({ has: page.locator('summary', { hasText: '表达要求' }) })).not.toHaveAttribute('open');
      await page.screenshot({ path: info.outputPath(`production-brief-${width}-${theme}.png`) });

      const navigation = dialog.getByRole('navigation', { name: '本次制作步骤', exact: true });
      const before = await navigation.boundingBox();
      const panel = dialog.locator('.run-inspector__panel');
      await document.locator('summary').filter({ hasText: '表达要求' }).click();
      const specs = document.getByRole('definition').filter({ hasText: '1920 × 1080' });
      await expect(specs).toBeVisible(); await expect(document).toContainText('59.94 fps');
      await expect(document).toContainText('完整显示');
      await expect(document).toContainText('保留最后一条表达要求。');
      await expect(dialog.getByText(/^(查看完整原文|查看模型原始返回)$/)).toHaveCount(0);
      await panel.hover(); await page.mouse.wheel(0, 5000);
      await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      const after = await navigation.boundingBox();
      expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
      await expect(dialog.getByRole('tablist', { name: '制作阶段记录', exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('tablist', { name: '步骤详情视图', exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: '编辑创意简报', exact: true })).toBeInViewport();
      await expect(dialog.getByRole('button', { name: '关闭对话框', exact: true })).toBeVisible();
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

      await navigation.getByRole('button', { name: /风格与角色/ }).click();
      const visual = dialog.getByRole('article', { name: '视觉风格', exact: true });
      await expect(visual.getByRole('heading', { name: '构图', exact: true })).toBeVisible();
      await expect(visual.locator('ul > li')).toHaveCount(2);
      await expect(visual.locator('pre').first()).toContainText('<img src=');
      await expect(visual.locator('img, script, iframe')).toHaveCount(0);
      await expect(visual).toContainText('最后一段仍然可读。');
      await expect(dialog.getByText(/^(查看完整原文|查看模型原始返回)$/)).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`production-style-${width}-${theme}.png`) });
      await expect(navigation.getByRole('button').locator('strong')).toHaveText(['简报生成', '风格与角色生成', '分镜生成', '参考图生成', '镜头视频生成', '剪辑与运镜准备', '导出成片']);
      await expect(dialog.getByRole('button', { name: '编辑风格与角色', exact: true })).toBeInViewport();

      await navigation.getByRole('button', { name: /分镜生成/ }).click();
      const visualPrompt = dialog.getByRole('region', { name: '分镜预览' }).getByText(shotVisual, { exact: true });
      await expect(visualPrompt).toBeVisible();
      expect(await visualPrompt.textContent()).toBe(shotVisual);
      const swatches = visualPrompt.locator('.step-result__color-swatch');
      await expect(swatches).toHaveCount(4);
      for (const [index, color] of ['rgb(247, 245, 240)', 'rgb(170, 187, 204)', 'rgba(0, 0, 0, 0)', 'rgb(224, 160, 48)'].entries()) {
        await expect(swatches.nth(index)).toHaveCSS('background-color', color);
      }
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`production-storyboard-${width}-${theme}.png`) });
      expect(detailReads).toEqual([]);
      expect(await saved(request, source.project.id)).toEqual(baseline); expect(source.requests.length).toBe(requests);
      await expect(page).toHaveTitle(/Video Quickly/); expect(new URL(page.url()).pathname).toBe('/');
      await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
    } finally { await source.close(); }
  });
}
