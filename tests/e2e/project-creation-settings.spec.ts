import { productionStep, saveProduction } from './production-settings';
import { closeProjectSettings, settingField } from './settings';
import { openProjectFromList } from './workspace-navigation';
import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createSceneTemplate, DEFAULT_CAPTION_STYLE, DEFAULT_VIDEO_PROFILE, dramaStylePresets, type DramaWork, type ProjectDocument, type SeriesTemplate } from '@video-quickly/contracts';
import { test } from './isolated-workspace';

const newProjectProfile = { ...DEFAULT_VIDEO_PROFILE, width: 1080, height: 1920 };
const screenplay = '清晨，林夏在书房发现一封旧信。她到城门寻找失散的朋友，两人读完信后决定一起回家。';
async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function saved(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
function observe(page: Page) {
  const writes: string[] = [], errors: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) { const method = request.postDataJSON()?.method; if (['dramaStudio.create', 'project.update', 'run.start', 'render.export'].includes(method)) writes.push(method); } });
  page.on('pageerror', error => errors.push(error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); }); return { writes, errors };
}
function composer(page: Page) { return page.getByRole('region', { name: '新建短剧', exact: true }); }
async function openCreation(page: Page, title: string) {
  await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/);
  await page.getByRole('complementary', { name: '工作空间导航', exact: true }).getByRole('button', { name: '新建短剧', exact: true }).click();
  const form = composer(page); await expect(form.getByRole('textbox', { name: '短剧名称', exact: true })).toBeFocused(); await form.getByRole('textbox', { name: '短剧名称', exact: true }).fill(title);
  await form.getByRole('textbox', { name: '剧本正文', exact: true }).fill(screenplay); return form;
}
async function submit(page: Page, form: Locator) {
  const response = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'dramaStudio.create');
  await form.getByRole('button', { name: '创建短剧', exact: true }).click(); const creation = await response, payload = await creation.json(); expect(creation.ok()).toBe(true); expect(payload.error).toBeUndefined();
  await expect(form).toBeHidden(); return { project: payload.result.project as ProjectDocument, work: payload.result.work as DramaWork, params: creation.request().postDataJSON().params };
}
async function chooseTemplate(page: Page, template: SeriesTemplate) {
  await page.getByRole('button', { name: '系列模板', exact: true }).click();
  const card = page.locator('.series-template-card').filter({ has: page.getByRole('heading', { name: template.name, exact: true }) });
  const more = page.getByRole('button', { name: '加载更多系列模板', exact: true });
  await expect.poll(async () => { if (await card.count()) return true; if (await more.count() && await more.isEnabled()) await more.click(); return false; }).toBe(true);
  await card.getByRole('button', { name: '用此模板新建', exact: true }).press('Enter');
  await expect(composer(page).getByRole('textbox', { name: '短剧名称', exact: true })).toBeFocused();
  await expect(composer(page).getByText(`系列模板：${template.name}`, { exact: true })).toBeVisible();
  await composer(page).getByRole('tab', { name: '上传剧本', exact: true }).click();
  await composer(page).getByRole('textbox', { name: '剧本正文', exact: true }).fill(screenplay);
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 600, height: 900, theme: 'light' }] as const) {
  test.describe(`short drama creation at ${viewport.width}px in ${viewport.theme}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce', storageState: async ({ isolatedWorkspace }, use) => {
      await use({ cookies: [], origins: [{ origin: isolatedWorkspace.origin, localStorage: [{ name: 'vq-theme', value: viewport.theme }, { name: 'vq-onboarding-v1', value: 'done' }] }] });
    } });
    test('creates a work and first portrait episode and centers its empty inspector', async ({ page, request, isolatedWorkspace }, info) => {
      const observed = observe(page), title = `短剧创建 ${randomUUID().slice(0, 8)}`, form = await openCreation(page, title);
      await expect(page.locator('html')).toHaveAttribute('data-theme', viewport.theme);
      for (const label of ['画面比例', '分辨率', '素材适配']) await expect(form.getByLabel(label, { exact: true })).toHaveCount(0);
      await expect(form.getByLabel('画风', { exact: true })).toBeVisible(); await expect(form.getByRole('button', { name: '创作 Skill', exact: true })).toBeVisible();
      const create = form.getByRole('button', { name: '创建短剧', exact: true }); await create.scrollIntoViewIfNeeded(); await expect(create).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: info.outputPath(`creation-${viewport.theme}-${viewport.width}.png`) });
      const { project, work, params } = await submit(page, form);
      expect(params.work).toMatchObject({ title, stylePresetId: 'natural-live-action' }); expect(project.profile).toEqual(newProjectProfile); expect((await saved(request, project.id)).profile).toEqual(newProjectProfile); expect(project.shots).toEqual([]);
      expect(project.drama).toMatchObject({ workId: work.id, number: 1 }); expect(project.originalText).toBe(screenplay);
      await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(`${title} · 第 1 集`);
      const inspector = page.locator('#project-inspector'), empty = inspector.getByRole('heading', { name: '添加镜头开始编辑', exact: true }); await empty.scrollIntoViewIfNeeded(); await expect(empty).toBeInViewport({ ratio: 1 });
      const { horizontal, vertical } = await empty.evaluate(heading => { const body = heading.closest('.inspector-body')!.getBoundingClientRect(), group = heading.closest('.empty-state')!.getBoundingClientRect(), title = heading.getBoundingClientRect(); return { horizontal: Math.abs(title.left + title.width / 2 - (body.left + body.width / 2)), vertical: Math.abs(group.top + group.height / 2 - (body.top + body.height / 2)) }; });
      expect(horizontal).toBeLessThanOrEqual(1); expect(vertical).toBeLessThanOrEqual(1); await inspector.screenshot({ path: info.outputPath(`inspector-empty-${viewport.theme}-${viewport.width}.png`) });
      expect(new URL(page.url()).origin).toBe(isolatedWorkspace.origin); expect(observed.writes).toEqual(['dramaStudio.create']); expect(observed.errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
      await page.locator('#project-outline').getByRole('button', { name: '添加镜头', exact: true }).click(); await expect(inspector.getByLabel('镜头标题', { exact: true })).toHaveValue('镜头 1'); await expect(empty).toHaveCount(0); await expect.poll(async () => (await saved(request, project.id)).shots).toHaveLength(1);
    });
  });
}

test('applies an existing series template to the first episode without changing the source', async ({ page, request }) => {
  const source = await rpc<ProjectDocument>(request, 'project.create', { title: '已有系列分集', originalText: screenplay, profile: { width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'cover', previewScale: 1 } });
  const original = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.id, revision: source.revision, patch: { style: '保留系列的明亮口吻', captionStyle: { ...DEFAULT_CAPTION_STYLE, textColor: '#225588' }, scenePreset: { kind: 'comparison', palette: 'amber', motion: 'none' } } });
  const template = await rpc<SeriesTemplate>(request, 'seriesTemplate.save', { template: { name: '已有分集的系列设置', description: '复用已保存的系列样式', settings: { style: original.style, captionStyle: original.captionStyle, scenePreset: original.scenePreset } } });
  const observed = observe(page); await page.goto('/'); await chooseTemplate(page, template);
  await composer(page).getByRole('textbox', { name: '短剧名称', exact: true }).fill('系列短剧新作'); const { project, params } = await submit(page, composer(page));
  expect(params).toMatchObject({ seriesTemplateId: template.id, seriesTemplateRevision: template.revision }); expect(project).toMatchObject(template.settings); expect(project.profile).toEqual(newProjectProfile);
  expect(await saved(request, project.id)).toEqual(project); expect(await saved(request, original.id)).toEqual(original); expect(await rpc(request, 'seriesTemplate.get', { templateId: template.id })).toEqual(template); expect(observed.writes).toEqual(['dramaStudio.create']); expect(observed.errors).toEqual([]);
});

test('offers all built-in styles and transfers a series template with its selected Skills', async ({ page, request }, info) => {
  const templates = await rpc<{ items: SeriesTemplate[] }>(request, 'seriesTemplate.list', { limit: 100 }); const template = templates.items.find(item => item.name === 'AI 短剧 · 竖屏真人')!; expect(template).toBeDefined();
  const title = '竖屏真人短剧验收';
  const observed = observe(page); const form = await openCreation(page, title);
  for (const style of dramaStylePresets) await expect(form.getByLabel('画风', { exact: true }).locator(`option[value="${style.id}"]`)).toHaveText(style.name);
  const choose = form.getByRole('button', { name: '选择系列模板', exact: true });
  await choose.press('Enter');
  const picker = page.getByRole('dialog', { name: '选择系列模板', exact: true });
  const templateField = picker.getByRole('combobox', { name: '系列模板', exact: true });
  await templateField.selectOption(template.id);
  await picker.getByRole('button', { name: '取消', exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(choose).toBeFocused();
  await choose.press('Enter');
  await templateField.selectOption(template.id);
  await picker.getByRole('button', { name: '应用选择', exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(form.getByRole('button', { name: `系列模板：${template.name}`, exact: true })).toBeFocused();
  await expect(form.getByRole('textbox', { name: '短剧名称', exact: true })).toHaveValue(title);
  await expect(form.getByRole('textbox', { name: '剧本正文', exact: true })).toHaveValue(screenplay);
  await expect(form.getByRole('button', { name: '创作 Skill', exact: true })).toContainText(`已选 ${template.creationDefaults!.skillIds.length} 个`);
  await page.screenshot({ path: info.outputPath('builtin-drama-template-composer.png') });
  const { project, params } = await submit(page, form);
  expect(params).toMatchObject({ seriesTemplateId: template.id, seriesTemplateRevision: template.revision });
  expect(project).toMatchObject({ ...template.settings, shots: [], profile: { width: 1080, height: 1920 } });
  expect(project.workflow.production.agentSkillIds).toEqual([]);
  for (const id of ['screenplay', 'brief', 'style', 'script']) expect(project.workflow.nodes.find(node => node.id === id)?.skillIds).toEqual(template.creationDefaults!.skillIds);
  await page.getByRole('button', { name: '素材库', exact: true }).click(); await page.getByRole('button', { name: '图片', exact: true }).click();
  for (const name of ['巴黎石板巷', '大桥骤雨', '云山隐居图']) { const preview = page.getByRole('button', { name: `预览“内置参考 · ${name}”`, exact: true }); await preview.scrollIntoViewIfNeeded(); await expect.poll(() => preview.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0); }
  expect(observed.writes).toEqual(['dramaStudio.create']); expect(observed.errors).toEqual([]);
});

test('uses a template from a later library page through the same creation composer', async ({ page, request }, info) => {
  const settings = { style: '暖色手绘短剧', captionStyle: { ...DEFAULT_CAPTION_STYLE, textColor: '#225588' }, scenePreset: { kind: 'comparison', palette: 'amber', motion: 'none' } };
  const template = await rpc<SeriesTemplate>(request, 'seriesTemplate.save', { template: { name: '手绘故事系列', description: '旧城与信的故事', settings } });
  for (let index = 0; index < 20; index++) await rpc(request, 'seriesTemplate.save', { template: { name: `新模板 ${index + 1}`, description: '', settings } });
  const observed = observe(page); await page.setViewportSize({ width: 600, height: 900 }); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await page.getByRole('button', { name: '系列模板', exact: true }).click();
  const card = page.locator('.series-template-card').filter({ has: page.getByRole('heading', { name: template.name, exact: true }) }); await expect(card).toHaveCount(0); await expect(page.getByRole('button', { name: '加载更多系列模板', exact: true })).toBeEnabled();
  await chooseTemplate(page, template); const form = composer(page); await expect(form.getByRole('textbox', { name: '短剧名称', exact: true })).toHaveValue(template.name);
  await form.getByRole('textbox', { name: '短剧名称', exact: true }).fill('手绘故事新作'); await page.getByRole('button', { name: '模型连接', exact: true }).click(); await page.getByRole('button', { name: '新建短剧', exact: true }).click();
  await expect(form.getByRole('textbox', { name: '短剧名称', exact: true })).toHaveValue('手绘故事新作'); await expect(form.getByText(`系列模板：${template.name}`, { exact: true })).toBeVisible(); expect(observed.writes).toEqual([]);
  await form.screenshot({ path: info.outputPath('create-from-series-composer.png') }); const { project, params } = await submit(page, form); expect(params).toMatchObject({ seriesTemplateId: template.id, seriesTemplateRevision: template.revision }); expect(await saved(request, project.id)).toMatchObject({ ...template.settings, shots: [] }); expect(observed.writes).toEqual(['dramaStudio.create']); expect(observed.errors).toEqual([]);
});

test('preserves an existing nonstandard production size and keeps complete dimension controls in export', async ({ page, request }, info) => {
  const source = await rpc<ProjectDocument>(request, 'project.create', { originalText: '清晨，林夏在书房发现一封未寄出的信。她来到旧城寻找信的主人，与朋友在雨中的城门重逢。两人读完信后决定一起回家。', title: '已有4比5三十帧项目', profile: { width: 800, height: 1000, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: 1 } });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.id, revision: source.revision, patch: { shots: [{ id: 'existing-profile-shot', title: '保持现有素材与时长', narration: '', visualPrompt: '', durationUs: 1_000_000, sceneTemplate: createSceneTemplate('process') }] } });
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await openProjectFromList(page, project.title);
  expect(await saved(request, project.id)).toEqual(project); await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '制作设置', exact: true }); await productionStep(panel, '创作要求');
  await expect(panel.getByLabel('分辨率', { exact: true }).locator('option:checked')).toHaveText('800 × 1000 · 当前');
  await expect(panel.getByLabel('视频宽度', { exact: true })).toHaveCount(0);
  await expect(panel.getByLabel('视频高度', { exact: true })).toHaveCount(0);
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
