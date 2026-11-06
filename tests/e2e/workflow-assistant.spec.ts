import { openAdvancedWorkflow } from './production-settings';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import type { ModelProfile, ProjectDocument } from '@video-quickly/contracts';
import { openProduction, saveProduction } from './production-settings';
import { openProjectFromList } from './workspace-navigation';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(payload.error).toBeUndefined(); return payload.result;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
async function fixture(request: APIRequestContext, mode: 'complete' | 'hold-first' | 'fail-first' = 'complete') {
  const prompts: string[] = [], suffix = randomUUID().slice(0, 7);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = createServer((incoming, response) => { void (async () => {
    let body = ''; for await (const bytes of incoming) body += String(bytes);
    const request = JSON.parse(body); prompts.push(request.messages[0].content);
    const index = prompts.length;
    if (mode === 'hold-first' && index === 1) await gate;
    if (mode === 'fail-first' && index === 1) { response.writeHead(500); response.end(); return; }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '补充动作与节奏', patch: { prompt: '缓慢推近木盒，保持人物动作连续。' } }) } }], usage: { prompt_tokens: 23, completion_tokens: 17 } }));
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture');
  const model = await rpc<ModelProfile>(request, 'model.save', { model: { name: `建议文本 ${suffix}`, provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, connectionType: 'text', capabilities: ['text'], model: 'fixture', pricing: { currency: 'CNY', inputPerMillionTokens: 1, outputPerMillionTokens: 2 } } });
  const alternative = await rpc<ModelProfile>(request, 'model.save', { model: { name: `替代文本 ${suffix}`, provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/alternate`, connectionType: 'text', capabilities: ['text'], model: 'other' } });
  let project = await rpc<ProjectDocument>(request, 'project.create', { title: `可审阅修改 ${suffix}`, brief: '寻找木盒' });
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, production: { ...project.workflow.production, textModelId: model.id } } } });
  return { project, model, alternative, prompts, current: async () => (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project, close: async () => { release(); await close(server); } };
}
async function openAssistant(settings: Locator) {
  await settings.locator('summary:visible').filter({ hasText: '高级设置' }).click();
  await settings.getByRole('button', { name: '对话修改任务', exact: true }).click();
  return settings.page().getByRole('dialog', { name: '对话修改任务', exact: true });
}
for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) test(`previews, applies and saves a reviewed assistant proposal at ${viewport.width}px`, async ({ page, request }, info) => {
  const source = await fixture(request), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    const settings = await openProduction(page, source.project), dialog = await openAssistant(settings);
    await dialog.getByRole('textbox', { name: '修改要求', exact: true }).fill('加强人物动作，镜头节奏更从容');
    await dialog.getByRole('combobox', { name: '建议生成模型', exact: true }).selectOption(source.model.id);
    await dialog.getByRole('button', { name: '生成修改预览', exact: true }).click();
    await expect(dialog.getByRole('region', { name: '修改预览', exact: true })).toContainText('缓慢推近木盒');
    await expect(dialog.getByText(/已记录 1 次用量/)).toBeVisible(); expect(source.prompts).toHaveLength(1); expect(await source.current()).toEqual(source.project);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`workflow-assistant-${viewport.theme}.png`) });
    await dialog.getByRole('button', { name: '应用到任务草稿', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect(settings.getByRole('textbox', { name: /补充要求$/ })).toHaveValue('缓慢推近木盒，保持人物动作连续。'); expect(await source.current()).toEqual(source.project);
    await saveProduction(settings); await expect(settings).toHaveCount(0);
    await expect.poll(async () => (await source.current()).workflow.nodes.find(node => node.id === source.project.workflow.nodes.find(node => node.kind === 'brief')!.id)?.prompt).toBe('缓慢推近木盒，保持人物动作连续。');
    const runs = await rpc<{ items: Array<{ purpose: string }> }>(request, 'run.list', { projectId: source.project.id, purpose: 'workflow-assistant' }); expect(runs.items).toHaveLength(1);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
  } finally { await source.close(); }
});

for (const mode of ['hold-first', 'fail-first'] as const) test(`requires review before creating another suggestion after ${mode === 'hold-first' ? 'a canceled uncertain submission' : 'an uncertain needs_attention result'}`, async ({ page, request }) => {
  const source = await fixture(request, mode);
  try {
    const settings = await openProduction(page, source.project), dialog = await openAssistant(settings);
    await dialog.getByRole('textbox', { name: '修改要求', exact: true }).fill('保留未知任务，核对后再创建新建议');
    await dialog.getByRole('combobox', { name: '建议生成模型', exact: true }).selectOption(source.model.id);
    await dialog.getByRole('button', { name: '生成修改预览', exact: true }).click();
    await expect.poll(() => source.prompts.length).toBe(1);
    const list = () => rpc<{ items: Array<{ id: string; status: string }> }>(request, 'run.list', { projectId: source.project.id, purpose: 'workflow-assistant' });
    const oldRun = (await list()).items[0];
    if (mode === 'hold-first') {
      await expect(dialog.getByRole('button', { name: '核对后新建', exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: '新建建议', exact: true })).toBeDisabled();
      await dialog.getByRole('button', { name: '停止建议任务', exact: true }).click();
      await expect.poll(async () => (await list()).items.find(run => run.id === oldRun.id)?.status).toBe('canceled');
    } else {
      await expect.poll(async () => (await list()).items.find(run => run.id === oldRun.id)?.status).toBe('failed');
      await rpc(request, 'run.resume', { runId: oldRun.id });
      await expect.poll(async () => (await list()).items.find(run => run.id === oldRun.id)?.status).toBe('needs_attention');
      await dialog.getByRole('button', { name: '刷新结果', exact: true }).click();
      expect(source.prompts).toHaveLength(1);
    }
    await expect(dialog.getByText(/本次提交结果尚未确认/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: '核对后新建', exact: true })).toBeVisible();
    const before = await rpc(request, 'run.get', { runId: oldRun.id });
    const receipt = await rpc(request, 'run.activities', { runId: oldRun.id });
    await dialog.getByRole('button', { name: '核对后新建', exact: true }).click();
    const confirmation = page.getByRole('alertdialog');
    await expect(confirmation).toContainText('人工核对'); await expect(confirmation).toContainText('计费');
    await confirmation.getByRole('button', { name: '取消', exact: true }).click(); await expect(confirmation).toHaveCount(0);
    await expect(dialog.getByText(oldRun.id, { exact: true })).toBeVisible(); expect(source.prompts).toHaveLength(1);
    await dialog.getByRole('button', { name: '核对后新建', exact: true }).click();
    await confirmation.getByRole('button', { name: '已核对，准备新建', exact: true }).click(); await expect(confirmation).toHaveCount(0);
    await expect(dialog.getByRole('textbox', { name: '修改要求', exact: true })).toBeEnabled();
    await expect(dialog.getByRole('textbox', { name: '修改要求', exact: true })).toHaveValue('保留未知任务，核对后再创建新建议');
    expect(source.prompts).toHaveLength(1); expect((await list()).items).toHaveLength(1);
    expect(await rpc(request, 'run.get', { runId: oldRun.id })).toEqual(before);
    expect(await rpc(request, 'run.activities', { runId: oldRun.id })).toEqual(receipt);
    await dialog.getByRole('button', { name: '生成修改预览', exact: true }).click();
    await expect(dialog.getByRole('region', { name: '修改预览', exact: true })).toContainText('缓慢推近木盒');
    expect(source.prompts).toHaveLength(2); expect((await list()).items).toHaveLength(2);
    expect(await rpc(request, 'run.get', { runId: oldRun.id })).toEqual(before);
    expect(await rpc(request, 'run.activities', { runId: oldRun.id })).toEqual(receipt); expect(await source.current()).toEqual(source.project);
  } finally { await source.close(); }
});

test('reuses a lost start response and keeps alternative selection as a reversible configuration edit', async ({ page, request }) => {
  const source = await fixture(request); let lost = false;
  await page.route('**/__desktop_rpc', async route => {
    const input = route.request().postDataJSON();
    if (input.method === 'workflowAssistant.start' && !lost) { lost = true; await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  try {
    const settings = await openProduction(page, source.project), dialog = await openAssistant(settings);
    await dialog.getByRole('textbox', { name: '修改要求', exact: true }).fill('补充动作与节奏');
    await dialog.getByRole('combobox', { name: '建议生成模型', exact: true }).selectOption(source.model.id);
    await dialog.getByRole('button', { name: '生成修改预览', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '重试读取建议任务', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '重试读取建议任务', exact: true }).click();
    await expect(dialog.getByRole('region', { name: '修改预览', exact: true })).toContainText('缓慢推近木盒');
    expect(source.prompts).toHaveLength(1); expect(await source.current()).toEqual(source.project);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await settings.getByRole('button', { name: '取消', exact: true }).click(); await expect(settings).toHaveCount(0);
    await openAdvancedWorkflow(page);
    const node = source.project.workflow.nodes.find(node => node.kind === 'brief')!;
    await page.locator(`.react-flow__node[data-id="${node.id}"]`).click();
    await page.getByRole('button', { name: '查看替代模型', exact: true }).click();
    const alternatives = page.getByRole('region', { name: '替代模型建议', exact: true });
    await alternatives.getByRole('listitem').filter({ hasText: source.alternative.name }).getByRole('button', { name: '用于下次配置', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '使用模型', exact: true })).toHaveValue(source.alternative.id); expect(source.prompts).toHaveLength(1);
    expect(await source.current()).toEqual(source.project);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '使用模型', exact: true })).toHaveValue(source.model.id); expect(source.prompts).toHaveLength(1);
  } finally { await source.close(); }
});

test('restores a saved suggestion after reopening and rejects applying it after the project revision changes', async ({ page, request }) => {
  const source = await fixture(request);
  try {
    let settings = await openProduction(page, source.project), dialog = await openAssistant(settings);
    await dialog.getByRole('textbox', { name: '修改要求', exact: true }).fill('保留可恢复的建议输入');
    await dialog.getByRole('combobox', { name: '建议生成模型', exact: true }).selectOption(source.model.id);
    await dialog.getByRole('button', { name: '生成修改预览', exact: true }).click();
    await expect(dialog.getByRole('region', { name: '修改预览', exact: true })).toContainText('缓慢推近木盒');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await settings.getByRole('button', { name: '取消', exact: true }).click(); await expect(settings).toHaveCount(0);
    let failedHistory = false;
    await page.route('**/__desktop_rpc', async route => {
      const input = route.request().postDataJSON();
      if (input.method === 'workflowAssistant.latest' && !failedHistory) { failedHistory = true; await route.abort('failed'); } else await route.continue();
    });
    settings = await openProduction(page, source.project); dialog = await openAssistant(settings);
    await expect(dialog.getByRole('button', { name: '重试读取已保存建议', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '生成修改预览', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: '重试读取已保存建议', exact: true }).click();
    await expect(dialog.getByRole('region', { name: '修改预览', exact: true })).toContainText('缓慢推近木盒');
    await expect(dialog.getByRole('textbox', { name: '修改要求', exact: true })).toHaveValue('保留可恢复的建议输入');
    await expect(dialog.getByRole('textbox', { name: '修改要求', exact: true })).toBeDisabled();
    expect(source.prompts).toHaveLength(1); expect(await source.current()).toEqual(source.project);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await settings.getByRole('button', { name: '取消', exact: true }).click(); await expect(settings).toHaveCount(0);
    const changed = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: { title: `${source.project.title} 修订` } });
    settings = await openProduction(page, changed); dialog = await openAssistant(settings);
    await expect(dialog.getByRole('region', { name: '修改预览', exact: true })).toContainText('缓慢推近木盒');
    await expect(dialog.getByText('项目已修改，请基于当前修订重新生成建议。', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '应用到任务草稿', exact: true })).toBeDisabled(); expect(source.prompts).toHaveLength(1);
    await dialog.getByRole('button', { name: '新建建议', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: '修改要求', exact: true })).toHaveValue('保留可恢复的建议输入');
    await dialog.getByRole('textbox', { name: '修改要求', exact: true }).fill('基于当前修订再生成');
    await dialog.getByRole('button', { name: '生成修改预览', exact: true }).click();
    await expect(dialog.getByRole('region', { name: '修改预览', exact: true })).toContainText('缓慢推近木盒');
    await expect(dialog.getByRole('button', { name: '应用到任务草稿', exact: true })).toBeEnabled(); expect(source.prompts).toHaveLength(2);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await settings.getByRole('button', { name: '取消', exact: true }).click(); await expect(settings).toHaveCount(0);
    await page.getByRole('button', { name: '制作记录', exact: true }).click();
    await page.getByRole('combobox', { name: '记录来源', exact: true }).selectOption('workflow-assistant');
    await page.locator('.run-card').filter({ hasText: changed.title }).first().getByRole('button', { name: '查看步骤', exact: true }).click();
    const history = page.getByRole('dialog', { name: '制作步骤详情', exact: true });
    await expect(history.getByRole('region', { name: '任务修改建议', exact: true })).toContainText('缓慢推近木盒');
    await expect(history.getByRole('button', { name: '在项目中查看与应用', exact: true })).toHaveCount(0);
    await history.getByText('原始模型结果', { exact: true }).click();
    await expect(history.locator('.step-result__document pre')).toContainText('缓慢推近木盒'); expect(source.prompts).toHaveLength(2);
  } finally { await source.close(); }
});
