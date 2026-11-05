import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import type { ProjectDocument, PromptLibraryItem, RunSummary } from '@video-quickly/contracts';
import { openProduction, saveProduction } from './production-settings';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok(), JSON.stringify(payload.error)).toBe(true); return payload.result;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
async function fixture(request: APIRequestContext, hold = false) {
  const prompts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = createServer((incoming, response) => { void (async () => {
    let body = ''; for await (const bytes of incoming) body += String(bytes);
    const input = JSON.parse(body); prompts.push(input.messages[0].content); if (hold) await gate;
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: '实验生成的创意简报正文' } }], usage: { prompt_tokens: 17, completion_tokens: 9 } }));
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture');
  const model = await rpc<{ id: string }>(request, 'model.save', { model: { name: `实验文本 ${randomUUID().slice(0, 6)}`, provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, connectionType: 'text', capabilities: ['text'], model: 'fixture' } });
  let project = await rpc<ProjectDocument>(request, 'project.create', { title: `提示词花园 ${randomUUID().slice(0, 6)}`, brief: '原始创作简报' });
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, production: { ...project.workflow.production, textModelId: model.id } } } });
  return { project, prompts, release, async close() { release(); await close(server); }, current: () => rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id }).then(value => value.project) };
}
async function openExperiment(settings: Locator) {
  await settings.locator('summary:visible').filter({ hasText: '高级设置' }).click();
  await settings.getByRole('button', { name: '预览与实验提示词', exact: true }).click();
  return settings.page().getByRole('dialog', { name: '提示词实验', exact: true });
}
for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) test(`previews offline, versions templates and applies configuration explicitly at ${viewport.width}px`, async ({ page, request }, info) => {
  const source = await fixture(request), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    const settings = await openProduction(page, source.project), dialog = await openExperiment(settings);
    await dialog.getByRole('textbox', { name: '实验提示词', exact: true }).fill('用 {{theme}} 写一个温柔的故事');
    await dialog.locator('summary').filter({ hasText: '变量与 Skill' }).click();
    await dialog.getByRole('button', { name: '添加变量', exact: true }).click();
    await dialog.getByRole('textbox', { name: '变量 1 名称', exact: true }).fill('theme');
    await dialog.getByRole('combobox', { name: '变量 1 来源', exact: true }).selectOption('project');
    await dialog.getByRole('textbox', { name: '变量 1 字段路径', exact: true }).fill('title');
    await dialog.getByRole('button', { name: '离线预览', exact: true }).click();
    await expect(dialog.getByLabel('最终提示词', { exact: true })).toContainText(`用 ${source.project.title} 写一个温柔的故事`);
    expect(source.prompts).toEqual([]); expect(await source.current()).toEqual(source.project);
    await dialog.locator('.prompt-workbench__body').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath(`prompt-workbench-${viewport.theme}.png`) });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await dialog.getByRole('button', { name: '保存实验草稿', exact: true }).click(); await expect(dialog.getByText('实验草稿已保存。', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '模板与片段', exact: true }).click();
    const name = `温柔故事 ${randomUUID().slice(0, 6)}`;
    await dialog.getByRole('textbox', { name: '提示词名称', exact: true }).fill(name);
    await dialog.getByRole('button', { name: '另存为新提示词', exact: true }).click(); await expect(dialog.getByText('已保存模板 v1。', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '收藏', exact: true }).click(); await expect(dialog.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '编辑与预览', exact: true }).click();
    await dialog.getByRole('textbox', { name: '实验提示词', exact: true }).fill('第二版 {{theme}}');
    await dialog.getByRole('button', { name: '模板与片段', exact: true }).click();
    const library = await rpc<{ items: PromptLibraryItem[] }>(request, 'promptLibrary.list', { nodeKind: 'brief', limit: 100 }), item = library.items.find(item => item.name === name)!;
    await dialog.getByRole('combobox', { name: '模板或快捷片段', exact: true }).selectOption(item.id);
    await dialog.getByRole('button', { name: '保存新版本', exact: true }).click(); await expect(dialog.getByText('已保存模板 v2。', { exact: true })).toBeVisible();
    await dialog.getByRole('combobox', { name: '固定版本', exact: true }).selectOption('1');
    await expect(dialog.locator('.prompt-library__content')).toHaveText('用 {{theme}} 写一个温柔的故事');
    await dialog.getByRole('button', { name: '替换草稿', exact: true }).click();
    await dialog.getByRole('button', { name: '应用提示词到设置', exact: true }).click();
    expect(await source.current()).toEqual(source.project);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(settings.getByRole('textbox', { name: '创意简报补充要求', exact: true })).toHaveValue('用 {{theme}} 写一个温柔的故事');
    await saveProduction(settings); await expect(settings).toHaveCount(0);
    const saved = await source.current(), node = saved.workflow.nodes.find(node => node.kind === 'brief')!;
    expect(node.promptBindings).toEqual({ theme: { projectPath: ['title'] } }); expect(node.promptTemplate).toEqual({ id: item.id, version: 1 }); expect(source.prompts).toHaveLength(0); expect(errors).toEqual([]);
  } finally { await source.close(); }
});

test('runs a frozen experiment, restores its output, and uses the existing explicit apply flow', async ({ page, request }) => {
  const source = await fixture(request);
  try {
    const settings = await openProduction(page, source.project), dialog = await openExperiment(settings);
    await dialog.getByRole('textbox', { name: '实验提示词', exact: true }).fill('只围绕花园里的蓝色木盒');
    await dialog.getByRole('button', { name: '离线预览', exact: true }).click();
    const prompt = await dialog.getByLabel('最终提示词', { exact: true }).locator('pre').textContent();
    await dialog.getByRole('button', { name: '保存实验草稿', exact: true }).click();
    await expect(dialog.getByText('实验草稿已保存。', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '查看试运行', exact: true }).click();
    await dialog.getByRole('button', { name: '试运行（产生用量）', exact: true }).click();
    await expect(dialog.getByRole('article', { name: '创作简报', exact: true }).getByRole('paragraph').filter({ hasText: '实验生成的创意简报正文' })).toBeVisible();
    expect(source.prompts).toEqual([prompt]); expect(await source.current()).toEqual(source.project);
    await expect(dialog.getByLabel('实验费用', { exact: true })).toContainText('1 条用量记录');
    await expect(dialog.getByLabel('实验费用', { exact: true })).toContainText('输入 Token 17 · 输出 Token 9');
    await dialog.getByRole('button', { name: '查看与核对费用', exact: true }).click();
    const usage = page.getByRole('dialog', { name: '实验费用', exact: true });
    await expect(usage).toContainText('提示词实验'); await usage.getByRole('button', { name: '返回提示词实验', exact: true }).click();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await settings.getByRole('button', { name: '预览与实验提示词', exact: true }).click();
    const reopened = page.getByRole('dialog', { name: '提示词实验', exact: true });
    const saved = await rpc<{ items: { id: string }[] }>(request, 'promptSession.list', { projectId: source.project.id });
    await reopened.getByRole('combobox', { name: '继续实验', exact: true }).selectOption(saved.items[0].id);
    await reopened.getByRole('button', { name: '查看试运行', exact: true }).click();
    await expect(reopened.getByRole('article', { name: '创作简报', exact: true }).getByRole('paragraph').filter({ hasText: '实验生成的创意简报正文' })).toBeVisible();
    await reopened.getByRole('button', { name: '查看并应用产物', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '步骤产物', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '应用到项目', exact: true }).click();
    await page.getByRole('button', { name: '确认应用', exact: true }).click();
    await expect.poll(async () => (await source.current()).brief).toBe('实验生成的创意简报正文');
    const runs = await rpc<{ items: RunSummary[] }>(request, 'run.list', { projectId: source.project.id, purpose: 'prompt-trial' });
    expect(runs.items).toHaveLength(1); expect(runs.items[0].stepCount).toBe(1); expect(source.prompts).toHaveLength(1);
  } finally { await source.close(); }
});

test('opens the shared workbench from the existing Skill studio and saves prompt configuration explicitly', async ({ page, request }) => {
  const source = await fixture(request);
  try {
    await page.goto('/'); await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
    await page.getByRole('button', { name: '提示词实验与模板', exact: true }).click();
    const launcher = page.getByRole('dialog', { name: '选择提示词实验任务', exact: true });
    await launcher.getByRole('combobox', { name: '实验项目', exact: true }).selectOption(source.project.id);
    await launcher.getByRole('button', { name: '打开提示词实验', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '提示词实验', exact: true });
    await dialog.getByRole('textbox', { name: '实验提示词', exact: true }).fill('工作室保存的提示词');
    expect(await source.current()).toEqual(source.project);
    await dialog.getByRole('button', { name: '应用提示词到设置', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await source.current()).workflow.nodes.find(node => node.kind === 'brief')?.prompt).toBe('工作室保存的提示词');
    expect(source.prompts).toHaveLength(0);
  } finally { await source.close(); }
});

test('preserves the project when a trial is canceled and exposes experiment history separately', async ({ page, request }) => {
  const source = await fixture(request, true);
  try {
    const settings = await openProduction(page, source.project), dialog = await openExperiment(settings);
    await dialog.getByRole('button', { name: '离线预览', exact: true }).click(); await dialog.getByRole('button', { name: '保存实验草稿', exact: true }).click();
    await expect(dialog.getByText('实验草稿已保存。', { exact: true })).toBeVisible(); await dialog.getByRole('button', { name: '查看试运行', exact: true }).click();
    await dialog.getByRole('button', { name: '试运行（产生用量）', exact: true }).click(); await expect.poll(() => source.prompts.length).toBe(1);
    await dialog.getByRole('button', { name: '停止试运行', exact: true }).click(); await expect(dialog.getByText('已停止', { exact: true })).toBeVisible();
    expect(await source.current()).toEqual(source.project); source.release();
    await page.goto('/'); await page.getByRole('button', { name: '制作记录', exact: true }).click();
    await page.getByRole('combobox', { name: '记录来源', exact: true }).selectOption('prompt-trial');
    await expect(page.locator('.run-card').filter({ hasText: source.project.title })).toContainText('提示词实验');
    await page.getByRole('combobox', { name: '记录来源', exact: true }).selectOption('production');
    await expect(page.locator('.run-card').filter({ hasText: source.project.title })).toHaveCount(0);
  } finally { await source.close(); }
});

test('appends a compatible quick snippet, rejects an expression offline and restores keyboard focus on dismissal', async ({ page, request }) => {
  const source = await fixture(request);
  try {
    const snippet = await rpc<PromptLibraryItem>(request, 'promptLibrary.save', { kind: 'snippet', name: `快捷节奏 ${randomUUID().slice(0, 6)}`, prompt: '镜头节奏舒缓', nodeKinds: ['brief'] });
    const settings = await openProduction(page, source.project), dialog = await openExperiment(settings);
    await dialog.getByRole('textbox', { name: '实验提示词', exact: true }).fill('草稿前文');
    await dialog.getByRole('button', { name: '模板与片段', exact: true }).click();
    await dialog.getByRole('combobox', { name: '模板或快捷片段', exact: true }).selectOption(snippet.id);
    await dialog.getByRole('button', { name: '追加到草稿', exact: true }).click();
    await dialog.getByRole('button', { name: '编辑与预览', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: '实验提示词', exact: true })).toHaveValue('草稿前文\n\n镜头节奏舒缓');
    await dialog.getByRole('textbox', { name: '实验提示词', exact: true }).fill('{{theme.toUpperCase()}}');
    await dialog.locator('summary').filter({ hasText: '变量与 Skill' }).click(); await dialog.getByRole('button', { name: '添加变量', exact: true }).click();
    await dialog.getByRole('textbox', { name: '变量 1 名称', exact: true }).fill('theme');
    await dialog.getByRole('textbox', { name: '变量 1 值', exact: true }).fill('数据');
    await dialog.getByRole('button', { name: '离线预览', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('未绑定');
    expect(source.prompts).toHaveLength(0);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    await expect(settings.getByRole('button', { name: '预览与实验提示词', exact: true })).toBeFocused();
    expect(await source.current()).toEqual(source.project);
  } finally { await source.close(); }
});
