import { productionStep, saveProduction } from './production-settings';
import { openProjectFromList } from './workspace-navigation';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { ProjectDocument, RunInspection, RunSummary } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const result = await response.json(); expect(result.error).toBeUndefined(); return result.result;
}
async function fixture(request: APIRequestContext, title: string) {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title: `${title} ${randomUUID().slice(0, 8)}` });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: {
    profile: { ...project.profile, width: 640, height: 360 }, shots: [{ id: 'shot', title: '配置验收镜头', narration: '', visualPrompt: '', durationUs: 1_000_000 }],
    workflow: { id: 'editable-flow', name: '配置验收流程', version: 1, production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [{ id: 'a', kind: 'brief', label: '简报 A', position: { x: 0, y: 0 } }, { id: 'b', kind: 'brief', label: '提案 B', position: { x: 360, y: 0 } }], edges: [{ id: 'ab', source: 'a', target: 'b' }] },
  } });
}
async function current(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
async function open(page: Page, title: string) {
  await page.goto('/'); await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
  await openProjectFromList(page, title);
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(title);
}
async function history(page: Page, name: '撤销' | '重做') { const button = page.getByRole('button', { name, exact: true }); await expect(button).toBeEnabled(); await button.click(); }

test('shares task-setting history with the workbench and preserves input when the same task changes elsewhere', async ({ page, request }) => {
  const project = await fixture(request, '步骤设置统一历史'); await open(page, project.title);
  await page.getByRole('button', { name: '制作设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '制作设置', exact: true });
  await dialog.locator('summary:visible').filter({ hasText: '高级设置' }).click();
  const prompt = dialog.getByLabel('简报 A补充要求', { exact: true });
  await prompt.fill('人工设置的提示词'); await saveProduction(dialog);
  await expect(dialog).toHaveCount(0); await history(page, '撤销');
  await expect.poll(async () => (await current(request, project.id)).workflow.nodes[0].prompt).toBe('');
  await history(page, '重做');
  await expect.poll(async () => (await current(request, project.id)).workflow.nodes[0].prompt).toBe('人工设置的提示词');
  await page.getByRole('button', { name: '制作设置', exact: true }).click(); await productionStep(dialog, '创作要求'); await dialog.locator('summary:visible').filter({ hasText: '高级设置' }).click(); await prompt.fill('尚未应用的输入');
  const saved = await current(request, project.id);
  const remote = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: saved.revision, patch: { workflow: { ...saved.workflow, nodes: saved.workflow.nodes.map(node => node.id === 'a' ? { ...node, prompt: '另一视图的提示词' } : node) } } });
  await expect(page.locator('.project-heading-copy')).toHaveAttribute('data-revision', String(remote.revision));
  await saveProduction(dialog);
  await expect(dialog.getByRole('alert')).toContainText('当前输入已保留');
  await expect(page.getByText('阶段任务已在其他视图更新，当前输入已保留，请核对后重新打开。', { exact: true })).toBeVisible();
  await productionStep(dialog, '创作要求'); await expect(prompt).toHaveValue('尚未应用的输入');
  expect((await current(request, project.id)).workflow.nodes[0].prompt).toBe('另一视图的提示词');
});

test('freezes task input during final saving and never executes a run as part of saving', async ({ page, request }) => {
  const project = await fixture(request, '最终保存期间冻结输入'); await open(page, project.title);
  await page.getByRole('button', { name: '制作设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '制作设置', exact: true }); await dialog.locator('summary:visible').filter({ hasText: '高级设置' }).click();
  const prompt = dialog.getByLabel('简报 A补充要求', { exact: true });
  await prompt.fill('先提交的步骤要求');
  let release!: () => void, entered!: () => void, held = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), committed = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/__desktop_rpc', async route => {
    const body = route.request().postDataJSON();
    if (!held && body.method === 'project.update' && body.params.projectId === project.id) {
      held = true; const response = await route.fetch(); entered(); await gate; await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await saveProduction(dialog); await committed;
    await expect(prompt).toBeDisabled();
    await expect(dialog.getByRole('navigation', { name: '制作设置步骤', exact: true }).getByRole('button').first()).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
    expect((await current(request, project.id)).workflow.nodes[0].prompt).toBe('先提交的步骤要求');
    expect((await rpc<{ items: unknown[] }>(request, 'run.list', { projectId: project.id })).items).toEqual([]);
    release(); await expect(dialog).toHaveCount(0);
    await history(page, '撤销'); await expect.poll(async () => (await current(request, project.id)).workflow.nodes[0].prompt).toBe('');
    expect((await rpc<{ items: unknown[] }>(request, 'run.list', { projectId: project.id })).items).toEqual([]);
  } finally { release(); }
});

test('freezes settings during start submission and saves subsequent task input for the next run', async ({ page, request }) => {
  const pending: ServerResponse[] = [], errors: string[] = [];
  const server = createServer((incoming, response) => { incoming.resume(); incoming.on('end', () => pending.push(response)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('单任务生成夹具未启动');
  let entered!: () => void, release!: () => void, runId: string | undefined;
  const accepted = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const created = await fixture(request, '启动期间保留单任务输入');
    const model = await rpc<{ id: string }>(request, 'model.save', { model: { name: '单任务启动边界', provider: 'openai-compatible', model: 'single-task-fixture', baseUrl: `http://127.0.0.1:${address.port}/v1`, connectionType: 'text', capabilities: ['text'] } });
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { workflow: { ...created.workflow, stages: [{ id: 'planning', label: '策划', nodeIds: created.workflow.nodes.map(node => node.id) }], nodes: created.workflow.nodes.map(node => node.id === 'a' ? { ...node, modelId: model.id } : node) } } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__desktop_rpc', async route => {
      if (route.request().postDataJSON()?.method === 'run.start') {
        const response = await route.fetch(); const payload = await response.json(); runId = payload.result.id; entered(); await gate; await route.fulfill({ response }); return;
      }
      await route.continue();
    });
    await open(page, project.title); await page.getByRole('button', { name: '制作设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '制作设置', exact: true }); await dialog.locator('summary:visible').filter({ hasText: '高级设置' }).click(); const prompt = dialog.getByLabel('简报 A补充要求', { exact: true });
    await prompt.fill('这次执行使用已保存的输入'); await saveProduction(dialog); await expect(dialog).toHaveCount(0); await page.getByRole('button', { name: '开始制作', exact: true }).click(); await accepted;
    await expect.poll(() => pending.length).toBe(1); await expect(page.locator('.project-heading-actions [data-guide="produce"]')).toBeDisabled(); release(); await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: '制作设置', exact: true }).click(); await productionStep(dialog, '创作要求'); await dialog.locator('summary:visible').filter({ hasText: '高级设置' }).click(); await prompt.fill('请求在途期间补充的下一次输入');
    const inspection = await rpc<RunInspection>(request, 'run.inspect', { runId, nodeId: 'a' });
    expect(inspection.selected?.node.prompt).toBe('这次执行使用已保存的输入'); expect(inspection.run.status).toBe('running');
    const before = await current(request, project.id); expect(before.workflow.nodes[0].prompt).toBe('这次执行使用已保存的输入');
    await saveProduction(dialog); await expect(dialog).toHaveCount(0);
    expect(await current(request, project.id)).toEqual(before); expect((await rpc<{ items: RunSummary[] }>(request, 'run.list', { projectId: project.id })).items).toHaveLength(1);
    await page.getByRole('button', { name: '制作设置', exact: true }).click(); await productionStep(dialog, '创作要求'); await dialog.locator('summary:visible').filter({ hasText: '高级设置' }).click(); await expect(prompt).toHaveValue('请求在途期间补充的下一次输入');
    await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click(); expect(errors).toEqual([]);
  } finally {
    release(); if (runId) await rpc(request, 'run.cancel', { runId });
    await page.unrouteAll({ behavior: 'ignoreErrors' }); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
