import { productionStep, saveProduction } from './production-settings';
import { closeProjectSettings } from './settings';
import { openProjectFromList } from './workspace-navigation';
import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createSceneTemplate, DEFAULT_CAPTION_STYLE, DEFAULT_VIDEO_PROFILE, type ProjectDocument, type SeriesTemplate } from '@video-quickly/contracts';
import { test } from './isolated-workspace';
import { settingField } from './settings';

const newProjectProfile = { ...DEFAULT_VIDEO_PROFILE, frameRate: { numerator: 60, denominator: 1 } };

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function saved(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
function observe(page: Page) {
  const writes: string[] = [], errors: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) { const method = request.postDataJSON()?.method; if (['project.create', 'project.update', 'run.start', 'render.export'].includes(method)) writes.push(method); } });
  page.on('pageerror', error => errors.push(error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); }); return { writes, errors };
}
async function openCreation(page: Page, title: string) {
  await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.getByRole('complementary', { name: '工作空间导航', exact: true }).getByRole('button', { name: '新建项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建视频项目', exact: true }); await expect(dialog).toBeVisible(); await dialog.getByLabel('项目名称', { exact: true }).fill(title); return dialog;
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
    test('creates with default video settings and centers the empty shot inspector', async ({ page, request, isolatedWorkspace }, info) => {
      const observed = observe(page), title = `新建视频项目 ${randomUUID().slice(0, 8)}`, dialog = await openCreation(page, title);
      await expect(page.locator('html')).toHaveAttribute('data-theme', viewport.theme);
      await expect(dialog.getByText('更多设置', { exact: true })).toHaveCount(0);
      for (const label of ['画面比例', '分辨率', '素材适配']) await expect(dialog.getByLabel(label, { exact: true })).toHaveCount(0);
      await expect(dialog.getByLabel('创意简报', { exact: true })).toBeVisible();
      await expect(dialog.getByLabel('系列模板（可选）', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: '创作 Skill（可选）', exact: true })).toBeVisible();
      const create = dialog.getByRole('button', { name: '创建项目', exact: true }); await expect(create).toBeInViewport({ ratio: 1 }); await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
      await page.screenshot({ path: info.outputPath(`creation-${viewport.theme}-${viewport.width}.png`) });
      const { project, params } = await submit(page, dialog);
      expect(params.profile).toEqual(newProjectProfile); expect(project.profile).toEqual(newProjectProfile); expect((await saved(request, project.id)).profile).toEqual(newProjectProfile); expect(project.shots).toEqual([]);
      await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(title);
      const inspector = page.locator('#project-inspector');
      const empty = inspector.getByRole('heading', { name: '暂无镜头属性', exact: true });
      await empty.scrollIntoViewIfNeeded();
      await expect(empty).toBeInViewport({ ratio: 1 });
      const { horizontal, vertical } = await empty.evaluate(heading => {
        const body = heading.closest('.inspector-body')!.getBoundingClientRect();
        const group = heading.closest('.empty-state')!.getBoundingClientRect();
        const title = heading.getBoundingClientRect();
        return {
          horizontal: Math.abs(title.left + title.width / 2 - (body.left + body.width / 2)),
          vertical: Math.abs(group.top + group.height / 2 - (body.top + body.height / 2)),
        };
      });
      expect(horizontal).toBeLessThanOrEqual(1);
      expect(vertical).toBeLessThanOrEqual(1);
      await inspector.screenshot({ path: info.outputPath(`inspector-empty-${viewport.theme}-${viewport.width}.png`) });
      expect(new URL(page.url()).origin).toBe(isolatedWorkspace.origin); expect(observed.writes).toEqual(['project.create']); expect(observed.errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);

      await page.locator('#project-outline').getByRole('button', { name: '添加镜头', exact: true }).click();
      await expect(inspector.getByLabel('镜头标题', { exact: true })).toHaveValue('镜头 1');
      await expect(empty).toHaveCount(0);
      await expect.poll(async () => (await saved(request, project.id)).shots).toHaveLength(1);
    });
  });
}

test('keeps 60fps when choosing series settings from an existing 30fps project without changing the source', async ({ page, request }) => {
  const source = await rpc<ProjectDocument>(request, 'project.create', { title: '已有30帧系列项目', profile: { width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'cover', previewScale: 1 } });
  const original = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.id, revision: source.revision, patch: { style: '保留系列的明亮口吻', captionStyle: { ...DEFAULT_CAPTION_STYLE, textColor: '#225588' }, scenePreset: { kind: 'comparison', palette: 'amber', motion: 'none' } } });
  const template = await rpc<SeriesTemplate>(request, 'seriesTemplate.save', { template: { name: '已有项目的系列设置', description: '仅复用合法的系列样式', settings: { style: original.style, captionStyle: original.captionStyle, scenePreset: original.scenePreset } } });
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); const dialog = await openCreation(page, '选择系列后仍使用60帧');
  const selector = dialog.getByLabel('系列模板（可选）', { exact: true }); await expect(selector.locator(`option[value="${template.id}"]`)).toHaveCount(1); await selector.selectOption(template.id);
  const { project, params } = await submit(page, dialog); expect(params).toMatchObject({ seriesTemplateId: template.id, seriesTemplateRevision: template.revision, profile: newProjectProfile });
  expect(project).toMatchObject(template.settings); expect(project.profile).toEqual(newProjectProfile);
  expect(await saved(request, project.id)).toEqual(project); expect(await saved(request, original.id)).toEqual(original); expect(await rpc(request, 'seriesTemplate.get', { templateId: template.id })).toEqual(template);
  expect(observed.writes).toEqual(['project.create']); expect(observed.errors).toEqual([]);
});

test('lists built-in templates by name and creates a portrait project with the matching Skill', async ({ page, request }, info) => {
  const custom = await rpc<SeriesTemplate>(request, 'seriesTemplate.save', { template: { name: '自定义系列模板', description: '', settings: { style: '', captionStyle: null, scenePreset: null } } });
  const observed = observe(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const dialog = await openCreation(page, '竖屏真人短剧验收');
  const selector = dialog.getByLabel('系列模板（可选）', { exact: true });
  const builtIn = selector.locator('optgroup[label="系统内置"] option');
  await expect(builtIn).toHaveText(['AI 漫剧 · 国风水墨', 'AI 漫剧 · 动态条漫', 'AI 短剧 · 竖屏真人']);
  await expect(selector.locator(`option[value="${custom.id}"]`)).toHaveText(custom.name);

  await selector.click();
  await expect.poll(() => selector.evaluate(element => element.matches(':open'))).toBe(true);
  await page.screenshot({ path: info.outputPath('builtin-drama-template-picker.png') });
  await selector.press('Escape');
  const picker = dialog.getByRole('button', { name: '创作 Skill（可选）', exact: true });
  await selector.selectOption({ label: 'AI 漫剧 · 动态条漫' });
  await expect(picker).toContainText('已选 1 个');
  await selector.selectOption('');
  await expect(picker).toContainText('已选 0 个');
  await selector.selectOption({ label: 'AI 短剧 · 竖屏真人' });
  await expect(picker).toContainText('已选 1 个');
  const template = await rpc<SeriesTemplate>(request, 'seriesTemplate.get', { templateId: await selector.inputValue() });
  const { project } = await submit(page, dialog);
  expect(project).toMatchObject({ ...template.settings, shots: [], profile: { width: 1080, height: 1920 } });
  expect(project.workflow.production.agentSkillIds).toEqual(template.creationDefaults!.skillIds);
  expect(project.workflow.nodes.find(node => node.kind === 'script')!.skillIds).toEqual(template.creationDefaults!.skillIds);

  await page.getByRole('button', { name: '素材库', exact: true }).click();
  await page.getByRole('button', { name: '图片', exact: true }).click();
  for (const name of ['巴黎石板巷', '大桥骤雨', '云山隐居图']) {
    const image = page.getByRole('img', { name: `内置参考 · ${name}`, exact: true });
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
  expect(observed.writes).toEqual(['project.create']);
  expect(observed.errors).toEqual([]);
});

test('starts project creation with a selected template from a later library page', async ({ page, request }, info) => {
  const settings = { style: '暖色手绘科普', captionStyle: { ...DEFAULT_CAPTION_STYLE, textColor: '#225588' }, scenePreset: { kind: 'comparison', palette: 'amber', motion: 'none' } };
  const template = await rpc<SeriesTemplate>(request, 'seriesTemplate.save', { template: { name: '手绘科普系列', description: '', settings } });
  for (let index = 0; index < 20; index++) {
    await rpc(request, 'seriesTemplate.save', { template: { name: `新模板 ${index + 1}`, description: '', settings } });
  }

  const observed = observe(page);
  await page.setViewportSize({ width: 600, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: '系列模板', exact: true }).click();
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: template.name, exact: true }) });
  const loadMore = page.getByRole('button', { name: '加载更多系列模板', exact: true });
  await expect(loadMore).toBeEnabled();
  await expect(card).toHaveCount(0);
  await loadMore.click();
  const open = card.getByRole('button', { name: '用此模板新建', exact: true });
  await expect(open).toBeVisible();
  await card.screenshot({ path: info.outputPath('create-from-series-card.png') });

  await open.press('Enter');
  const dialog = page.getByRole('dialog', { name: '新建视频项目', exact: true });
  const selector = dialog.getByLabel('系列模板（可选）', { exact: true });
  await expect(selector).toBeEnabled();
  await expect(selector).toHaveValue(template.id);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(open).toBeFocused();
  expect(observed.writes).toEqual([]);

  await open.click();
  await dialog.getByLabel('项目名称', { exact: true }).fill('手绘科普新项目');
  await expect(selector).toBeEnabled();
  await expect(selector).toHaveValue(template.id);
  await dialog.screenshot({ path: info.outputPath('create-from-series-dialog.png') });
  const { project, params } = await submit(page, dialog);
  expect(params).toMatchObject({ seriesTemplateId: template.id, seriesTemplateRevision: template.revision });
  expect(await saved(request, project.id)).toMatchObject({ ...template.settings, shots: [] });
  expect(observed.writes).toEqual(['project.create']);
  expect(observed.errors).toEqual([]);
});

test('preserves existing 30fps data and keeps complete frame-rate and dimension controls in editing and export', async ({ page, request }, info) => {
  const source = await rpc<ProjectDocument>(request, 'project.create', { title: '已有4比5三十帧项目', profile: { width: 800, height: 1000, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: 1 } });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.id, revision: source.revision, patch: { shots: [{ id: 'existing-profile-shot', title: '保持现有素材与时长', narration: '', visualPrompt: '', durationUs: 1_000_000, sceneTemplate: createSceneTemplate('process') }] } });
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await openProjectFromList(page, project.title);
  expect(await saved(request, project.id)).toEqual(project); await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '制作设置', exact: true }); await productionStep(panel, '创作要求');
  await expect(panel.getByLabel('视频宽度', { exact: true })).toHaveValue('800'); await expect(panel.getByLabel('视频高度', { exact: true })).toHaveValue('1000');
  const rate = await settingField(panel, '视频帧率'); await expect(rate).toHaveValue('30');
  for (const value of ['4:5', '21:9']) await expect(panel.getByLabel('画面比例', { exact: true }).locator(`option[value="${value}"]`)).toHaveCount(1);
  for (const value of ['60', '30']) {
    if (!await panel.count()) await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
    await settingField(panel, '视频帧率');
    await rate.selectOption(value); await saveProduction(panel);
    await expect.poll(async () => (await saved(request, project.id)).profile.frameRate).toEqual({ numerator: Number(value), denominator: 1 }); await expect(panel).toHaveCount(0);
  }
  const edited = await saved(request, project.id); expect(edited.profile).toEqual(project.profile); expect(edited.shots).toEqual(project.shots);
  await closeProjectSettings(page); await page.getByRole('button', { name: '导出', exact: true }).click(); const exporter = page.getByRole('dialog', { name: '导出视频', exact: true });
  await expect(await settingField(exporter, '视频帧率')).toHaveValue('30'); await expect(await settingField(exporter, '视频宽度')).toHaveValue('800'); await expect(await settingField(exporter, '视频高度')).toHaveValue('1000');
  for (const value of ['4:5', '21:9']) await expect(exporter.getByLabel('画面比例', { exact: true }).locator(`option[value="${value}"]`)).toHaveCount(1);
  await expect(exporter.getByLabel('分辨率', { exact: true }).locator('option:checked')).toHaveText('800 × 1000 · 当前');
  await expect(exporter.locator('.export-dialog__preview figcaption')).toContainText('800 × 1000 · 30 fps'); await page.screenshot({ path: info.outputPath('existing-profile-export-controls.png') });
  await exporter.getByLabel('画面比例', { exact: true }).selectOption('9:16');
  await exporter.getByLabel('分辨率', { exact: true }).selectOption('720');
  await (await settingField(exporter, '素材适配')).selectOption('cover');
  await expect(exporter.locator('.export-dialog__preview figcaption')).toContainText('720 × 1280 · 30 fps');
  await expect(exporter.locator('.video-settings__advanced > summary')).toContainText('裁剪填满');
  await exporter.getByRole('button', { name: '关闭对话框', exact: true }).click(); expect(await saved(request, project.id)).toEqual(edited); expect(observed.writes).toEqual(['project.update', 'project.update']); expect(observed.errors).toEqual([]);
});
