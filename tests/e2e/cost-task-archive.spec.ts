import { createServer, type Server } from 'node:http';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ModelProfile, ProjectDocument, RunRecord, UsageRecord } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const body = await response.json(); expect(body.error).toBeUndefined(); return body.result;
}
async function fixture(request: APIRequestContext, title: string) {
  let calls = 0;
  const server = createServer((_request, response) => { calls++; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: '归档测试结果' } }], usage: { prompt_tokens: 100, completion_tokens: 50 } })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('夹具服务启动失败');
  const project = await rpc<ProjectDocument>(request, 'project.create', { title });
  const model = await rpc<ModelProfile>(request, 'model.save', { model: { name: title + '模型', model: 'archive-model', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, capabilities: ['text'], parameters: { internal_fixture: 'do-not-expose-parameters' }, pricing: { currency: 'USD', inputPerMillionTokens: 2, outputPerMillionTokens: 4 } } });
  async function start(count: number) {
    const nodes = Array.from({ length: count }, (_, index) => ({ id: `archive-step-${index}`, kind: 'brief', label: `归档步骤 ${index + 1}`, modelId: model.id }));
    await rpc(request, 'workflow.save', { projectId: project.id, workflow: { id: 'archive-workflow', version: 1, name: '归档制作流程', nodes, edges: [] } });
    const run = await rpc<RunRecord>(request, 'run.start', { projectId: project.id });
    await expect.poll(async () => (await rpc<{ items: RunRecord[] }>(request, 'run.list', { projectId: project.id })).items.find(item => item.id === run.id)?.status, { timeout: 30_000 }).toBe('succeeded');
    return run;
  }
  return { server, project, model, start, calls: () => calls };
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
async function openCosts(page: Page, projectId: string) {
  await page.goto('/'); await page.getByRole('button', { name: '费用记录', exact: true }).click(); await page.getByLabel('费用项目', { exact: true }).selectOption(projectId);
}

test('archives complete task totals, opens paginated detail and retains manual payments across reload', async ({ page, request }) => {
  test.setTimeout(60_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const source = await fixture(request, '任务费用分页验收');
  try {
    const older = await source.start(32), newer = await source.start(2);
    for (let index = 0; index < 19; index++) await source.start(1);
    await rpc(request, 'model.save', { model: { ...source.model, pricing: { currency: 'USD', inputPerMillionTokens: 99, outputPerMillionTokens: 99 } } });
    await openCosts(page, source.project.id);
    await expect(page.locator('.cost-task')).toHaveCount(20);
    await page.getByRole('button', { name: '加载更早任务', exact: true }).click();
    await expect(page.locator('.cost-task')).toHaveCount(21);
    const card = page.locator(`.cost-task[data-task-id="${older.id}"]`);
    await expect(card).toContainText('32 条费用'); await expect(card).toContainText('0.0128');
    await card.getByRole('button', { name: `查看任务费用详情：${older.id}`, exact: true }).click();
    const summary = page.getByRole('region', { name: '任务费用汇总', exact: true });
    await expect(summary).toContainText(older.id); await expect(summary).not.toContainText(newer.id);
    await expect(page.locator('.cost-record')).toHaveCount(30);
    await page.getByRole('button', { name: '加载更早明细', exact: true }).click(); await expect(page.locator('.cost-record')).toHaveCount(32);
    const row = page.locator('.cost-record').filter({ has: page.getByRole('heading', { name: '归档步骤 1', exact: true }) });
    await row.getByText('用量与价格详情', { exact: true }).click();
    await expect(row).toContainText('100 输入 Token'); await expect(row).toContainText('输入 / 百万 Token：US$2.00');
    await expect(page.locator('body')).not.toContainText('do-not-expose-parameters');
    await row.getByRole('button', { name: '核对费用', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '核对费用', exact: true });
    await editor.getByLabel('实际支付金额').fill('0.03'); await editor.getByLabel('实付币种').selectOption('CNY'); await editor.getByLabel('费用备注').fill('按任务核对完成');
    await editor.getByRole('button', { name: '保存实付记录' }).click(); await expect(editor).toHaveCount(0);
    await expect(summary).toContainText('¥0.03'); await expect(row).toContainText('按任务核对完成');
    await page.getByRole('button', { name: '返回任务归档', exact: true }).click();
    await expect(card.getByRole('button')).toBeFocused(); await expect(card).toContainText('¥0.03');
    await page.reload(); await page.getByRole('button', { name: '费用记录', exact: true }).click(); await page.getByLabel('费用项目').selectOption(source.project.id);
    await page.getByRole('button', { name: '加载更早任务', exact: true }).click();
    await page.getByRole('button', { name: `查看任务费用详情：${older.id}`, exact: true }).click();
    await page.getByRole('button', { name: '加载更早明细', exact: true }).click();
    await expect(page.locator('.cost-record').filter({ hasText: '按任务核对完成' })).toContainText(/实付 .*¥0.03/);
    expect(source.calls()).toBe(53); expect(errors).toEqual([]);
  } finally { await close(source.server); }
});

test('keeps task detail scoped during delayed reads and rejects stale payment edits without losing input', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const source = await fixture(request, '任务费用并发验收'); let release: (() => void) | undefined;
  const delayed = new Promise<void>(resolve => { release = resolve; }); let intercepted = 0;
  try {
    const older = await source.start(1), newer = await source.start(1);
    await openCosts(page, source.project.id);
    await page.route('**/__desktop_rpc', async route => {
      const body = route.request().postDataJSON();
      if (body.method === 'cost.task.get' && body.params.runId === older.id) { intercepted++; await delayed; }
      await route.continue();
    });
    await page.getByRole('button', { name: `查看任务费用详情：${older.id}`, exact: true }).click();
    await expect.poll(() => intercepted).toBeGreaterThan(0);
    await page.getByRole('button', { name: '返回任务归档', exact: true }).click();
    await page.getByRole('button', { name: `查看任务费用详情：${newer.id}`, exact: true }).click();
    const summary = page.getByRole('region', { name: '任务费用汇总', exact: true }); await expect(summary).toContainText(newer.id);
    const oldResponse = page.waitForResponse(response => response.request().postDataJSON()?.method === 'cost.task.get' && response.request().postDataJSON()?.params.runId === older.id);
    release?.(); await oldResponse;
    const records = await rpc<{ items: UsageRecord[] }>(request, 'cost.list', { runId: newer.id }); const record = records.items[0];
    await page.getByRole('button', { name: '核对费用', exact: true }).click(); const editor = page.getByRole('dialog', { name: '核对费用' });
    await editor.getByLabel('实际支付金额').fill('0.05'); await editor.getByLabel('费用备注').fill('仍保留的核对输入');
    await rpc(request, 'cost.update', { id: record.id, revision: record.revision, actualAmount: .02, actualCurrency: 'USD' });
    await editor.getByRole('button', { name: '保存实付记录' }).click();
    await expect(editor.getByRole('alert')).toContainText('已修改'); await expect(editor.getByLabel('实际支付金额')).toHaveValue('0.05'); await expect(editor.getByLabel('费用备注')).toHaveValue('仍保留的核对输入');
    await editor.getByRole('button', { name: '取消', exact: true }).click(); await page.getByRole('button', { name: '刷新详情', exact: true }).click();
    await expect(summary).toContainText(newer.id); await expect(summary).not.toContainText(older.id); await expect(page.locator('.cost-record')).toContainText('实付 US$0.02');
    await page.getByRole('button', { name: '浅色外观', exact: true }).click(); await page.setViewportSize({ width: 600, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(source.calls()).toBe(2); expect(errors).toEqual([]);
  } finally { release?.(); await close(source.server); }
});
