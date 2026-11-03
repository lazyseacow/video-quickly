import { expect, test } from '@playwright/test';
import { fixture, open, pick, latest, rpc } from './native-video-fixture';

for (const { width, theme } of [{ width: 1536, theme: 'dark' }, { width: 600, theme: 'light' }]) test('shows concise storyboard, media and delivery outputs at ' + width + 'px', async ({ page, request }, info) => {
  const source = await fixture(request, info, false, 3), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  try {
    await page.setViewportSize({ width, height: 960 }); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), theme);
    const settings = await open(page, source.project);
    await pick(settings, '文本模型', source.models[0]); await pick(settings, '视频模型', source.video);
    await settings.getByRole('tab', { name: '素材与配音', exact: true }).click();
    await expect(settings.getByRole('button', { name: '项目混音设置', exact: true })).toHaveCount(0);
    await expect(settings.getByText('参考音频', { exact: true })).toBeVisible();
    await expect(settings.getByRole('button', { name: '背景音乐', exact: true })).toBeVisible();
    await settings.getByRole('button', { name: '保存并开始制作', exact: true }).click();
    await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30000 }).toBe('succeeded');
    await expect(page.getByLabel('旁白音频', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '镜头声音处理', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('轨道信息', { exact: true })).not.toContainText('旁白');
    await expect(page.getByRole('checkbox', { name: '启用视频原声', exact: true })).toBeChecked();
    await page.locator('.workbench-guide__step').filter({ hasText: '策划与分镜' }).click();
    const dialog = page.getByRole('dialog', { name: '制作设置', exact: true }); await dialog.getByRole('button', { name: '本次制作', exact: true }).click();
    const stages = dialog.getByRole('tablist', { name: '制作阶段记录', exact: true }), steps = dialog.getByRole('navigation', { name: '本阶段制作步骤', exact: true });
    await steps.getByRole('button', { name: /旁白与分镜/ }).click();
    const output = dialog.getByRole('region', { name: '本次产物', exact: true });
    const storyboard = output.getByRole('region', { name: '分镜预览', exact: true });
    await expect(storyboard.locator('ol > li')).toHaveCount(3); await expect(storyboard).toContainText('3 个镜头');
    await expect(storyboard.getByRole('heading', { name: '生成的蓝色镜头 1', exact: true })).toBeVisible();
    await expect(storyboard).toContainText('蓝色天空'); await expect(storyboard).toContainText('自然讲述');
    await expect(storyboard.locator('.step-result__visual')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('step-storyboard-' + width + '.png') });
    await stages.getByRole('tab', { name: '素材与配音', exact: true }).click();
    await steps.getByRole('button', { name: /参考素材准备/ }).click(); await expect(output).toContainText('本步骤未添加参考素材');
    await expect(output).not.toContainText('referenceAssetIds');
    await steps.getByRole('button', { name: /镜头视频生成/ }).click();
    const media = output.getByRole('combobox', { name: '预览媒体', exact: true }); await expect(media.getByRole('option')).toHaveCount(3);
    const first = await media.inputValue(); await media.focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await expect(media).not.toHaveValue(first); await expect(output.locator('video')).toHaveCount(1);
    await expect.poll(() => output.locator('video').evaluate(video => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await expect(media).toBeFocused(); await expect(media).not.toHaveCSS('box-shadow', 'none');
    await page.screenshot({ path: info.outputPath('step-video-' + width + '.png') });
    await stages.getByRole('tab', { name: '剪辑与动画', exact: true }).click(); await expect(output).toContainText('3 个镜头已就绪');
    await expect(output.locator('.step-result__fields')).toHaveCount(0);
    await stages.getByRole('tab', { name: '审阅与导出', exact: true }).click();
    await expect(output.getByRole('link', { name: '下载成片', exact: true })).toBeVisible();
    await expect(output.locator('video')).toHaveCount(1);
    await expect(page.locator('.workbench-guide__step')).toHaveCount(4);
    await expect(page).toHaveTitle(/Video Quickly/); expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  } finally { await source.close(); }
});

test('expands a long storyboard without losing the remaining shots', async ({ page, request }, info) => {
  const source = await fixture(request, info, false, 21);
  try {
    await rpc(request, 'workflow.save', { projectId: source.project.id, workflow: { ...source.project.workflow, production: { ...source.project.workflow.production!, textModelId: source.models[0].id, videoModelId: source.video.id } } });
    const script = source.project.workflow.nodes.find(node => node.kind === 'script')!;
    await rpc(request, 'run.start', { projectId: source.project.id, nodeId: script.id });
    await expect.poll(async () => (await latest(request, source.project.id))?.status).toBe('succeeded');
    const settings = await open(page, source.project); await settings.getByRole('button', { name: '本次制作', exact: true }).click();
    const storyboard = settings.getByRole('region', { name: '分镜预览', exact: true });
    await expect(storyboard.locator('ol > li')).toHaveCount(20);
    await expect(storyboard).toContainText('21 个镜头');
    await storyboard.getByRole('button', { name: '显示更多镜头', exact: true }).click();
    await expect(storyboard.locator('ol > li')).toHaveCount(21);
    await expect(storyboard.getByRole('heading', { name: '生成的蓝色镜头 21', exact: true })).toBeVisible();
    await expect(storyboard.getByRole('button', { name: '显示更多镜头', exact: true })).toHaveCount(0);
  } finally { await source.close(); }
});
