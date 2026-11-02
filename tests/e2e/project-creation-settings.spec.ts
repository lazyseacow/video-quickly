import { closeProjectSettings } from './settings';
import { openProjectFromList } from './workspace-navigation';
import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createSceneTemplate, DEFAULT_CAPTION_STYLE, DEFAULT_VIDEO_PROFILE, type ProjectDocument, type SeriesTemplate } from '@video-quickly/contracts';
import { test } from './isolated-workspace';
import { settingField } from './settings';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function saved(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
function observe(page: Page) {
  const writes: string[] = [], errors: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) { const method = request.postDataJSON()?.method; if (['project.create', 'project.update', 'workflow.save', 'run.start', 'render.export'].includes(method)) writes.push(method); } });
  page.on('pageerror', error => errors.push(error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); }); return { writes, errors };
}
async function openCreation(page: Page, title: string) {
  await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.getByRole('complementary', { name: '工作空间导航', exact: true }).getByRole('button', { name: '新建项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建视频项目', exact: true }); await expect(dialog).toBeVisible(); await dialog.getByLabel('项目名称', { exact: true }).fill(title); return dialog;
}
async function creationControls(dialog: Locator) {
  const ratio = dialog.getByLabel('画面比例', { exact: true });
  const disclosure = dialog.locator('details.creation-settings');
  await expect(disclosure.locator('summary')).toHaveText('更多设置');
  if (!await ratio.isVisible()) await disclosure.getByText('更多设置', { exact: true }).click();
  await expect(ratio).toBeVisible();
  expect(await ratio.locator('option').evaluateAll(options => options.map(option => option.value))).toEqual(['16:9', '9:16', '1:1', '4:3', '3:4']);
  const resolution = dialog.getByLabel('分辨率', { exact: true }), fit = dialog.getByLabel('素材适配', { exact: true });
  expect(await resolution.locator('option').evaluateAll(options => options.map(option => option.value))).toEqual(['720', '1080', '1440', '2160']);
  expect(await fit.locator('option').evaluateAll(options => options.map(option => option.value))).toEqual(['contain', 'cover', 'blur']);
  await expect(dialog.locator('.video-settings').getByRole('combobox')).toHaveCount(3);
  for (const label of ['视频宽度', '视频高度', '视频帧率', '预览质量']) await expect(dialog.getByLabel(label, { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^(锁定宽高比例|解锁宽高比例|交换宽高)$/ })).toHaveCount(0);
  await expect(dialog.locator('.dimension-row, .spec-summary')).toHaveCount(0); return { ratio, resolution, fit };
}
async function submit(page: Page, dialog: Locator) {
  const response = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'project.create');
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click(); const creation = await response, payload = await creation.json(); expect(creation.ok()).toBe(true); expect(payload.error).toBeUndefined();
  await expect(dialog).toHaveCount(0); return { project: payload.result as ProjectDocument, params: creation.request().postDataJSON().params };
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 600, height: 900, theme: 'light' }] as const) {
  test.describe(`creation settings at ${viewport.width}px in ${viewport.theme}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce', storageState: async ({ isolatedWorkspace }, use) => {
      await use({ cookies: [], origins: [{ origin: isolatedWorkspace.origin, localStorage: [{ name: 'vq-theme', value: viewport.theme }, { name: 'vq-onboarding-v1', value: 'done' }] }] });
    } });
    test('offers only common presets and creates the selected dimensions and fit at a fixed 60fps', async ({ page, request, isolatedWorkspace }, info) => {
      const observed = observe(page), title = `简化创建规格 ${randomUUID().slice(0, 8)}`, dialog = await openCreation(page, title), controls = await creationControls(dialog);
      await expect(page.locator('html')).toHaveAttribute('data-theme', viewport.theme); await expect(controls.ratio).toHaveValue('16:9'); await expect(controls.resolution).toHaveValue('1080');
      for (const [ratio, resolution] of [['16:9', '720'], ['9:16', '1080'], ['1:1', '1440'], ['4:3', '2160'], ['3:4', '720']]) {
        await controls.ratio.selectOption(ratio); await controls.resolution.selectOption(resolution); await expect(controls.ratio).toHaveValue(ratio); await expect(controls.resolution).toHaveValue(resolution);
      }
      for (const fit of ['contain', 'cover', 'blur']) { await controls.fit.selectOption(fit); await expect(controls.fit).toHaveValue(fit); }
      const create = dialog.getByRole('button', { name: '创建项目', exact: true }); await expect(create).toBeInViewport({ ratio: 1 }); await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
      await page.screenshot({ path: info.outputPath(`creation-${viewport.theme}-${viewport.width}.png`) });
      const { project, params } = await submit(page, dialog), profile = { width: 720, height: 960, frameRate: { numerator: 60, denominator: 1 }, fitMode: 'blur', previewScale: DEFAULT_VIDEO_PROFILE.previewScale };
      expect(params.profile).toEqual(profile); expect(project.profile).toEqual(profile); expect((await saved(request, project.id)).profile).toEqual(profile); expect(project.shots).toEqual([]);
      expect(new URL(page.url()).origin).toBe(isolatedWorkspace.origin); expect(observed.writes).toEqual(['project.create']); expect(observed.errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
    });
  });
}

test('keeps 60fps when choosing series settings from an existing 30fps project without changing the source', async ({ page, request }) => {
  const source = await rpc<ProjectDocument>(request, 'project.create', { title: '已有30帧系列项目', profile: { width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'cover', previewScale: 1 } });
  const original = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.id, revision: source.revision, patch: { style: '保留系列的明亮口吻', captionStyle: { ...DEFAULT_CAPTION_STYLE, textColor: '#225588' }, scenePreset: { kind: 'comparison', palette: 'amber', motion: 'none' } } });
  const template = await rpc<SeriesTemplate>(request, 'seriesTemplate.save', { template: { name: '已有项目的系列设置', description: '仅复用合法的系列样式', settings: { style: original.style, captionStyle: original.captionStyle, scenePreset: original.scenePreset } } });
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); const dialog = await openCreation(page, '选择系列后仍使用60帧'), controls = await creationControls(dialog);
  await controls.ratio.selectOption('9:16'); await controls.resolution.selectOption('1440'); await controls.fit.selectOption('blur');
  const selector = dialog.getByLabel('系列模板（可选）', { exact: true }); await expect(selector.locator(`option[value="${template.id}"]`)).toHaveCount(1); await selector.selectOption(template.id);
  await expect(controls.ratio).toHaveValue('9:16'); await expect(controls.resolution).toHaveValue('1440'); await expect(controls.fit).toHaveValue('blur');
  const { project, params } = await submit(page, dialog); expect(params).toMatchObject({ seriesTemplateId: template.id, seriesTemplateRevision: template.revision, profile: { frameRate: { numerator: 60, denominator: 1 } } });
  expect(project).toMatchObject(template.settings); expect(project.profile).toEqual({ width: 1440, height: 2560, frameRate: { numerator: 60, denominator: 1 }, fitMode: 'blur', previewScale: DEFAULT_VIDEO_PROFILE.previewScale });
  expect(await saved(request, project.id)).toEqual(project); expect(await saved(request, original.id)).toEqual(original); expect(await rpc(request, 'seriesTemplate.get', { templateId: template.id })).toEqual(template);
  expect(observed.writes).toEqual(['project.create']); expect(observed.errors).toEqual([]);
});

test('preserves existing 30fps data and keeps complete frame-rate and dimension controls in editing and export', async ({ page, request }, info) => {
  const source = await rpc<ProjectDocument>(request, 'project.create', { title: '已有4比5三十帧项目', profile: { width: 800, height: 1000, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: 1 } });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.id, revision: source.revision, patch: { shots: [{ id: 'existing-profile-shot', title: '保持现有素材与时长', narration: '', visualPrompt: '', durationUs: 1_000_000, sceneTemplate: createSceneTemplate('process') }] } });
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await openProjectFromList(page, project.title);
  expect(await saved(request, project.id)).toEqual(project); await page.getByRole('button', { name: '项目设置', exact: true }).click();
  const panel = page.locator('.project-settings-panel'); await panel.getByRole('tab', { name: '画面', exact: true }).click();
  await expect(panel.getByLabel('视频宽度', { exact: true })).toHaveValue('800'); await expect(panel.getByLabel('视频高度', { exact: true })).toHaveValue('1000');
  const rate = panel.getByLabel('视频帧率', { exact: true }); await expect(rate).toHaveValue('30');
  for (const value of ['custom', '4:5', '21:9']) await expect(panel.getByLabel('画面比例', { exact: true }).locator(`option[value="${value}"]`)).toHaveCount(1);
  for (const value of ['60', '30']) {
    await rate.selectOption(value); const save = panel.getByRole('button', { name: '保存项目设置', exact: true }); await expect(save).toBeEnabled(); await save.click();
    await expect.poll(async () => (await saved(request, project.id)).profile.frameRate).toEqual({ numerator: Number(value), denominator: 1 }); await expect(save).toBeDisabled();
  }
  const edited = await saved(request, project.id); expect(edited.profile).toEqual(project.profile); expect(edited.shots).toEqual(project.shots);
  await closeProjectSettings(page); await page.getByRole('button', { name: '导出', exact: true }).click(); const exporter = page.getByRole('dialog', { name: '导出视频', exact: true });
  await expect(await settingField(exporter, '视频帧率')).toHaveValue('30'); await expect(await settingField(exporter, '视频宽度')).toHaveValue('800'); await expect(await settingField(exporter, '视频高度')).toHaveValue('1000');
  for (const value of ['custom', '4:5', '21:9']) await expect(exporter.getByLabel('画面比例', { exact: true }).locator(`option[value="${value}"]`)).toHaveCount(1);
  await expect(exporter.locator('.spec-summary')).toBeVisible(); await page.screenshot({ path: info.outputPath('existing-profile-export-controls.png') });
  await exporter.getByRole('button', { name: '关闭', exact: true }).click(); expect(await saved(request, project.id)).toEqual(edited); expect(observed.writes).toEqual(['project.update', 'project.update']); expect(observed.errors).toEqual([]);
});
