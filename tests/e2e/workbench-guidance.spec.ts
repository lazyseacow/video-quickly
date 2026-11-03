import { pickProductionModel } from './production-settings';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ModelProfile, ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }); const payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function fixture(request: APIRequestContext) {
  const suffix = randomUUID().slice(0, 8), models: ModelProfile[] = [];
  for (const capability of ['text', 'image', 'video']) models.push(await rpc<ModelProfile>(request, 'model.save', { model: { name: `引导 ${capability} ${suffix}`, provider: 'openai-compatible', model: `fixture-${capability}`, baseUrl: 'http://127.0.0.1:1/v1', connectionType: (([capability]) as readonly string[]).includes('text') ? 'text' : (([capability]) as readonly string[]).includes('video') ? 'video' : 'image', capabilities: capability === 'text' ? ['text', 'tools'] : [capability], parameters: {} } }));
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `制作指引 ${suffix}` });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
    shots: [], brief: '', workflow: { id: 'guide', version: 1, name: '入门流程', production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [
      { id: 'brief', kind: 'brief', label: '确定主题' }, { id: 'script', kind: 'script', label: '生成分镜', config: { modelBinding: 'default', requiresModel: true } },
      { id: 'assets', kind: 'assets', label: '制作画面' }, { id: 'review', kind: 'review', label: '检查成片', requiresReview: true },
    ].map((node, index) => ({ ...node, position: { x: index * 300, y: 0 } })), stages: [{ id: 'planning', label: '策划', nodeIds: ['brief', 'script'] }, { id: 'materials', label: '参考素材', nodeIds: ['assets'] }, { id: 'delivery', label: '检查', nodeIds: ['review'] }], edges: [{ id: 'a', source: 'brief', target: 'script' }, { id: 'b', source: 'script', target: 'assets' }, { id: 'c', source: 'assets', target: 'review' }] },
  } });
  return { project, models };
}
async function open(page: Page, project: ProjectDocument) {
  await page.goto('/'); await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.getByLabel('搜索项目', { exact: true }).fill(project.title);
  await page.locator('.project-card').filter({ hasText: project.title }).getByRole('button', { name: '继续创作', exact: true }).click();
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`guides a new project from brief to a compatible step model without starting generation at ${viewport.width}px`, async ({ page, request }, info) => {
    const { project, models } = await fixture(request), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    await open(page, project); const guide = page.getByRole('region', { name: '制作指引', exact: true });
    await expect(guide).toContainText('统一设置模型与制作要求'); await expect(guide).not.toContainText('人工审阅'); await expect(guide).toContainText('根据上游结果自动继续');
    await guide.getByRole('button', { name: '填写创意简报', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '制作设置', exact: true });
    await dialog.getByLabel('创作要求', { exact: true }).fill('为新观众介绍城市的变化，保持写实、简洁。');
    await expect(dialog.getByRole('region', { name: '步骤指引', exact: true })).toHaveCount(0);
    const text = models.find(model => model.capabilities.includes('text'))!;
    const selector = dialog.getByRole('combobox', { name: '文本模型', exact: true }); await selector.click();
    await expect(dialog.getByRole('option', { name: text.name, exact: true })).toHaveCount(1);
    for (const other of models.filter(model => model.id !== text.id)) await expect(dialog.getByRole('option', { name: other.name, exact: true })).toHaveCount(0);
    await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: info.outputPath('workbench-step-guide.png') });
    await pickProductionModel(dialog, '文本模型', text); await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const saved = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
    expect(saved.brief).toContain('城市的变化'); expect(saved.workflow.nodes.find(node => node.id === 'script')?.modelId).toBe(text.id);
    await guide.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('workbench-guidance.png') });
    expect((await rpc<{ items: unknown[] }>(request, 'run.list', { projectId: project.id })).items).toEqual([]);
    expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('retains an unavailable saved model until the user chooses a compatible replacement', async ({ page, request }) => {
  const source = await fixture(request);
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: {
    brief: '说明城市的变化。', workflow: { ...source.project.workflow, nodes: source.project.workflow.nodes.map(node => node.id === 'script' ? { ...node, modelId: 'removed-model', config: { ...node.config, modelOverride: true } } : node) },
  } });
  await open(page, project);
  await page.getByRole('region', { name: '制作指引', exact: true }).getByRole('button', { name: '打开制作设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '制作设置', exact: true }); await dialog.locator('summary:visible').click();
  const selector = dialog.getByRole('combobox', { name: '生成分镜模型', exact: true }); await expect(selector).toHaveValue('removed-model');
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(dialog).toContainText('请为「生成分镜」选择可用的模型');
  const text = source.models.find(model => model.capabilities.includes('text'))!; await pickProductionModel(dialog, '生成分镜模型', text);
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '流程', exact: true }).click();
  await page.locator('.react-flow__node[data-id="script"]').click();
  const graphSelector = page.getByLabel('使用模型', { exact: true }); await expect(graphSelector).toHaveValue(text.id);
  for (const other of source.models.filter(model => model.id !== text.id)) await expect(graphSelector.locator(`option[value="${other.id}"]`)).toHaveCount(0);
  await expect(page.getByRole('region', { name: '步骤指引', exact: true })).toHaveCount(0);
  expect((await rpc<{ items: unknown[] }>(request, 'run.list', { projectId: project.id })).items).toEqual([]);
});

test('requires a compatible agent model and retains step input without a model-connection shortcut', async ({ page, request }) => {
  const source = await fixture(request);
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: {
    brief: '说明城市的变化。', workflow: { ...source.project.workflow, nodes: source.project.workflow.nodes.map(node => node.id === 'script' ? { ...node, kind: 'agent', label: '自定义创作' } : node) },
  } });
  await open(page, project);
  await page.getByRole('region', { name: '制作指引', exact: true }).getByRole('button', { name: '打开制作设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '制作设置', exact: true });
  await dialog.locator('summary:visible').click();
  await dialog.getByLabel('自定义创作补充要求', { exact: true }).fill('先核对资料，再准备视频提纲。');
  await expect(dialog.getByRole('button', { name: '添加模型连接', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(dialog).toContainText('请为「自定义创作」选择可用的模型');
  await expect(dialog.getByLabel('自定义创作补充要求', { exact: true })).toHaveValue('先核对资料，再准备视频提纲。');
  await pickProductionModel(dialog, '自定义创作模型', source.models.find(model => model.capabilities.includes('text'))!);
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '模型连接', exact: true }).click(); await expect(page.getByRole('heading', { name: '模型连接', exact: true })).toBeVisible();
  const saved = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
  expect(saved.workflow.nodes.find(node => node.id === 'script')?.prompt).toBe('先核对资料，再准备视频提纲。');
  expect((await rpc<{ items: unknown[] }>(request, 'run.list', { projectId: project.id })).items).toEqual([]);
});
