import { closeProjectSettings } from './settings';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ModelProfile, ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }); const payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function fixture(request: APIRequestContext) {
  const suffix = randomUUID().slice(0, 8), models: ModelProfile[] = [];
  for (const capability of ['text', 'image', 'video', 'tts', 'asr']) models.push(await rpc<ModelProfile>(request, 'model.save', { model: { name: `引导 ${capability} ${suffix}`, provider: 'openai-compatible', model: `fixture-${capability}`, baseUrl: 'http://127.0.0.1:1/v1', capabilities: [capability] } }));
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `制作指引 ${suffix}` });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
    shots: [], brief: '', workflow: { id: 'guide', version: 1, name: '入门流程', nodes: [
      { id: 'brief', kind: 'brief', label: '确定主题' }, { id: 'script', kind: 'script', label: '生成分镜', requiresReview: true },
      { id: 'assets', kind: 'assets', label: '制作画面' }, { id: 'review', kind: 'review', label: '检查成片', requiresReview: true },
    ].map((node, index) => ({ ...node, position: { x: index * 300, y: 0 } })), edges: [{ id: 'a', source: 'brief', target: 'script' }, { id: 'b', source: 'script', target: 'assets' }, { id: 'c', source: 'assets', target: 'review' }] },
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
    await expect(guide).toContainText('先写下视频主题'); await expect(guide).toContainText('2 处人工审阅');
    await guide.getByRole('button', { name: '填写创意简报', exact: true }).click();
    const brief = page.getByLabel('主题与核心问题', { exact: true }); await expect(brief).toBeFocused();
    await brief.fill('为新观众介绍城市的变化，保持写实、简洁。');
    await closeProjectSettings(page);
    await guide.getByRole('button', { name: '配置生成步骤', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '生成分镜', exact: true });
    await expect(dialog.getByRole('region', { name: '步骤指引', exact: true })).toHaveCount(0); await expect(dialog.getByLabel('完成后等待人工审阅', { exact: true })).toHaveCount(0);
    const selector = dialog.getByLabel('使用模型', { exact: true });
    const text = models.find(model => model.capabilities.includes('text'))!;
    await expect(selector.locator(`option[value="${text.id}"]`)).toHaveCount(1);
    for (const other of models.filter(model => model.id !== text.id)) await expect(selector.locator(`option[value="${other.id}"]`)).toHaveCount(0);
    await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: info.outputPath('workbench-step-guide.png') });
    await selector.selectOption(text.id); await dialog.getByRole('button', { name: '保存', exact: true }).click(); await expect(dialog).toHaveCount(0);
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
    brief: '说明城市的变化。', workflow: { ...source.project.workflow, nodes: source.project.workflow.nodes.map(node => node.id === 'script' ? { ...node, modelId: 'removed-model' } : node) },
  } });
  await open(page, project);
  await page.getByRole('region', { name: '制作指引', exact: true }).getByRole('button', { name: '配置生成步骤', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '生成分镜', exact: true }), selector = dialog.getByLabel('使用模型', { exact: true });
  await expect(selector).toHaveValue('removed-model'); await expect(selector.locator('option:checked')).toHaveText('当前：模型已移除');
  await expect(dialog).toContainText('当前模型不可用于此步骤');
  await expect(dialog.getByRole('button', { name: '执行', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '预览这步及后续', exact: true })).toBeDisabled();
  const text = source.models.find(model => model.capabilities.includes('text'))!;
  await selector.selectOption(text.id); await expect(dialog.getByRole('button', { name: '执行', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '保存', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '流程', exact: true }).click();
  await page.locator('.react-flow__node[data-id="script"]').click();
  const graphSelector = page.getByLabel('使用模型', { exact: true }); await expect(graphSelector).toHaveValue(text.id);
  for (const other of source.models.filter(model => model.id !== text.id)) await expect(graphSelector.locator(`option[value="${other.id}"]`)).toHaveCount(0);
  await expect(page.getByRole('region', { name: '步骤指引', exact: true })).toHaveCount(0);
  expect((await rpc<{ items: unknown[] }>(request, 'run.list', { projectId: project.id })).items).toEqual([]);
});

test('explains required agent models and saves step input without a model-connection shortcut', async ({ page, request }) => {
  const source = await fixture(request);
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: {
    brief: '说明城市的变化。', workflow: { ...source.project.workflow, nodes: source.project.workflow.nodes.map(node => node.id === 'script' ? { ...node, kind: 'agent', label: '自定义创作' } : node) },
  } });
  await open(page, project);
  await page.getByRole('region', { name: '制作指引', exact: true }).getByRole('button', { name: '配置生成步骤', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '自定义创作', exact: true });
  await expect(dialog).toContainText('此步骤需要选择匹配的模型才能执行');
  await expect(dialog.getByRole('button', { name: '执行', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '预览这步及后续', exact: true })).toBeDisabled();
  await dialog.getByLabel('提示词与补充要求', { exact: true }).fill('先核对资料，再准备视频提纲。');
  await expect(dialog.getByRole('button', { name: '添加模型连接', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '保存', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '模型连接', exact: true }).click(); await expect(page.getByRole('heading', { name: '模型连接', exact: true })).toBeVisible();
  const saved = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
  expect(saved.workflow.nodes.find(node => node.id === 'script')?.prompt).toBe('先核对资料，再准备视频提纲。');
  expect((await rpc<{ items: unknown[] }>(request, 'run.list', { projectId: project.id })).items).toEqual([]);
});
