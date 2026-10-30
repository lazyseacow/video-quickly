import { createServer, type Server } from 'node:http';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ModelProfile, ProjectDocument, RunRecord, UsageRecord } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const body = await response.json(); expect(body.error).toBeUndefined(); return body.result;
}
async function fixture(request: APIRequestContext, title: string, usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { cached_tokens: 2 } }) {
  let calls = 0;
  const server = createServer((_request, response) => { calls++; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: '归档测试结果' } }], usage })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('夹具服务启动失败');
  const project = await rpc<ProjectDocument>(request, 'project.create', { title });
  const model = await rpc<ModelProfile>(request, 'model.save', { model: { name: title + '模型', model: 'archive-model', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, capabilities: ['text'], parameters: { internal_fixture: 'do-not-expose-parameters' } } });
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
  await page.goto('/'); await page.getByRole('button', { name: 'Token 消耗', exact: true }).click(); await page.getByLabel('用量项目', { exact: true }).selectOption(projectId);
}

for (const width of [1536, 390]) {
  test(`keeps the usage layout and empty state mounted during project filtering at ${width}px`, async ({ page, request }, info) => {
    const projects: ProjectDocument[] = [];
    for (const suffix of ['A', 'B', 'C']) projects.push(await rpc<ProjectDocument>(request, 'project.create', { title: `稳定用量筛选 ${width} ${suffix}` }));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 }); await openCosts(page, projects[0].id);
    const selector = page.getByLabel('用量项目', { exact: true }); const overview = page.getByRole('region', { name: 'Token 用量汇总', exact: true });
    await expect(overview).toHaveAttribute('aria-busy', 'false'); const empty = page.getByRole('heading', { name: '还没有 Token 用量', exact: true }); await expect(empty).toBeVisible();
    const stableOverview = await overview.elementHandle(), stableEmpty = await empty.elementHandle(); const before = await selector.boundingBox();
    let release: (() => void) | undefined; const pending = new Promise<void>(resolve => { release = resolve; }); const held = new Set<string>();
    await page.route('**/__desktop_rpc', async route => {
      const body = route.request().postDataJSON();
      if (['cost.tasks', 'cost.summary'].includes(body.method) && body.params.projectId === projects[1].id) { held.add(body.method); await pending; }
      await route.continue();
    });
    try {
      await selector.focus(); await selector.selectOption(projects[1].id); await expect.poll(() => held.size).toBe(2);
      await expect(selector).toBeFocused(); await expect(selector).toHaveValue(projects[1].id);
      expect(await stableOverview!.evaluate(element => element.isConnected)).toBe(true); expect(await stableEmpty!.evaluate(element => element.isConnected)).toBe(true);
      expect((await selector.boundingBox())!.y).toBeCloseTo(before!.y, 0);
      await expect(overview).toHaveAttribute('aria-busy', 'true'); await expect(page.getByText('正在读取任务用量…', { exact: true })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath('usage-filter-pending.png') });
      await selector.selectOption(projects[2].id); await expect(overview).toHaveAttribute('aria-busy', 'false');
      const slowResults = Promise.all(['cost.tasks', 'cost.summary'].map(method => page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === method && response.request().postDataJSON()?.params.projectId === projects[1].id)));
      release?.(); await slowResults;
      await expect(selector).toHaveValue(projects[2].id); await expect(overview.locator('[data-metric="inputTokens"] > .token-amount')).toHaveText('—'); await expect(empty).toBeVisible();
      expect((await selector.boundingBox())!.y).toBeCloseTo(before!.y, 0); await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    } finally { release?.(); }
  });
}

test('retains usage rows and totals until new project results arrive, then replaces them locally', async ({ page, request }) => {
  const first = await fixture(request, '局部用量刷新 A'); const second = await fixture(request, '局部用量刷新 B', { prompt_tokens: 900, completion_tokens: 80 });
  let release: (() => void) | undefined;
  try {
    const oldRun = await first.start(1), newRun = await second.start(1); await openCosts(page, first.project.id);
    const overview = page.getByRole('region', { name: 'Token 用量汇总', exact: true });
    await expect(overview.locator('[data-metric="inputTokens"] > .token-amount')).toHaveText('100'); const row = page.locator(`.cost-task[data-task-id="${oldRun.id}"]`); await expect(row).toBeVisible();
    const previous = await row.elementHandle(), previousOverview = await overview.elementHandle(); const pending = new Promise<void>(resolve => { release = resolve; }); const held = new Set<string>();
    await page.route('**/__desktop_rpc', async route => { const body = route.request().postDataJSON(); if (['cost.tasks', 'cost.summary'].includes(body.method) && body.params.projectId === second.project.id) { held.add(body.method); await pending; } await route.continue(); });
    await page.getByLabel('用量项目', { exact: true }).selectOption(second.project.id); await expect.poll(() => held.size).toBe(2);
    expect(await previous!.evaluate(element => element.isConnected)).toBe(true); expect(await previousOverview!.evaluate(element => element.isConnected)).toBe(true);
    await expect(row.getByRole('button')).toBeDisabled(); await expect(overview.locator('[data-metric="inputTokens"] > .token-amount')).toHaveText('100');
    release?.(); await expect(page.locator(`.cost-task[data-task-id="${newRun.id}"]`)).toBeVisible(); await expect(row).toHaveCount(0);
    await expect(overview.locator('[data-metric="inputTokens"] > .token-amount')).toHaveText('900'); await expect(page.locator('.cost-task').getByRole('button')).toBeEnabled();
  } finally { release?.(); await Promise.all([close(first.server), close(second.server)]); }
});

test('archives all four token counters with task and record pagination, retaining counts across reload', async ({ page, request }) => {
  test.setTimeout(60_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const source = await fixture(request, '任务 Token 分页验收');
  try {
    const older = await source.start(32), newer = await source.start(2);
    for (let index = 0; index < 19; index++) await source.start(1);
    await rpc(request, 'model.save', { model: { ...source.model, name: '改名后的模型' } });
    await openCosts(page, source.project.id);
    await expect(page.locator('.cost-task')).toHaveCount(20);
    await page.getByRole('button', { name: '加载更多任务', exact: true }).click();
    await expect(page.locator('.cost-task')).toHaveCount(21);
    const card = page.locator(`.cost-task[data-task-id="${older.id}"]`);
    await expect(card).toContainText('32 次调用'); await expect(card).toContainText('3,200');
    await card.getByRole('button', { name: `查看任务用量详情：${older.id}`, exact: true }).click();
    const summary = page.getByRole('region', { name: '任务 Token 汇总', exact: true });
    await expect(summary).toContainText(older.id); await expect(summary).not.toContainText(newer.id);
    for (const [metric, value] of Object.entries({ inputTokens: '3,200', outputTokens: '1,600', cachedInputTokens: '960', cachedOutputTokens: '64' })) await expect(summary.locator(`[data-metric="${metric}"] > .token-amount`)).toHaveText(value);
    await expect(page.locator('.cost-record')).toHaveCount(30);
    await page.getByRole('button', { name: '加载更多明细', exact: true }).click(); await expect(page.locator('.cost-record')).toHaveCount(32);
    const row = page.locator('.cost-record').filter({ has: page.getByRole('heading', { name: '归档步骤 1', exact: true }) });
    await expect(row.locator('[data-metric="inputTokens"] dd')).toHaveText('100');
    await expect(row.locator('[data-metric="cachedOutputTokens"] dd')).toHaveText('2');
    await row.getByText('调用详情', { exact: true }).click();
    await expect(row).toContainText(source.model.name); await expect(row).not.toContainText('改名后的模型');
    await expect(page.locator('body')).not.toContainText('do-not-expose-parameters');
    await page.getByRole('button', { name: '返回任务归档', exact: true }).click();
    await expect(card.getByRole('button')).toBeFocused(); await expect(card).toContainText('3,200');
    await page.reload(); await page.getByRole('button', { name: 'Token 消耗', exact: true }).click(); await page.getByLabel('用量项目').selectOption(source.project.id);
    await page.getByRole('button', { name: '加载更多任务', exact: true }).click();
    await page.getByRole('button', { name: `查看任务用量详情：${older.id}`, exact: true }).click();
    await expect(summary.locator('[data-metric="cachedInputTokens"] > .token-amount')).toHaveText('960');
    expect(source.calls()).toBe(53); expect(errors).toEqual([]);
  } finally { await close(source.server); }
});

test('keeps task details scoped during delayed reads and distinguishes zero cache usage from absent counters', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const source = await fixture(request, '任务 Token 并发验收', { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0 } }); let release: (() => void) | undefined;
  const delayed = new Promise<void>(resolve => { release = resolve; }); let intercepted = 0;
  try {
    const older = await source.start(1), newer = await source.start(1);
    await openCosts(page, source.project.id);
    await page.route('**/__desktop_rpc', async route => {
      const body = route.request().postDataJSON();
      if (body.method === 'cost.task.get' && body.params.runId === older.id) { intercepted++; await delayed; }
      await route.continue();
    });
    await page.getByRole('button', { name: `查看任务用量详情：${older.id}`, exact: true }).click();
    await expect.poll(() => intercepted).toBeGreaterThan(0);
    await page.getByRole('button', { name: '返回任务归档', exact: true }).click();
    await page.getByRole('button', { name: `查看任务用量详情：${newer.id}`, exact: true }).click();
    const summary = page.getByRole('region', { name: '任务 Token 汇总', exact: true }); await expect(summary).toContainText(newer.id);
    const oldResponse = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'cost.task.get' && response.request().postDataJSON()?.params.runId === older.id);
    release?.(); await oldResponse;
    await page.getByRole('button', { name: '刷新详情', exact: true }).click();
    await expect(summary).toContainText(newer.id); await expect(summary).not.toContainText(older.id);
    await expect(summary.locator('[data-metric="inputTokens"] > .token-amount')).toHaveText('100');
    await expect(summary.locator('[data-metric="cachedInputTokens"] > .token-amount')).toHaveText('0');
    await expect(summary.locator('[data-metric="cachedOutputTokens"] > .token-amount')).toHaveText('—');
    await page.getByRole('button', { name: '浅色外观', exact: true }).click();
    for (const width of [600, 390]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); }
    expect(source.calls()).toBe(2); expect(errors).toEqual([]);
  } finally { release?.(); await close(source.server); }
});
