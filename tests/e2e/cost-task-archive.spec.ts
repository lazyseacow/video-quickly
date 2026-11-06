import { openCosts as openCostsPage, setWorkspaceTheme } from './workspace-settings';
import { createServer, type Server } from 'node:http';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ModelProfile, ProjectDocument, RunInspection, RunRecord, UsageRecord } from '@video-quickly/contracts';
import { costFailureEvidence, type ProviderCounts } from '../fixtures/cost-failure-evidence';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}, timeout?: number): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params }, timeout });
  const body = await response.json(); expect(body.error).toBeUndefined(); return body.result;
}
async function fixture(request: APIRequestContext, title: string, usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { cached_tokens: 2 } }) {
  const counts: ProviderCounts = { received: 0, finished: 0, closed: 0 }, receipts = new Map<string, ProviderCounts>();
  const server = createServer((request, response) => {
    const operationId = request.headers['x-client-request-id'];
    const runId = typeof operationId === 'string' ? /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):archive-step-\d+$/i.exec(operationId)?.[1] : undefined;
    const receipt = runId ? receipts.get(runId) ?? { received: 0, finished: 0, closed: 0 } : undefined;
    if (runId && receipt) receipts.set(runId, receipt);
    counts.received++; if (receipt) receipt.received++;
    response.once('finish', () => { counts.finished++; if (receipt) receipt.finished++; });
    response.once('close', () => { if (!response.writableFinished) { counts.closed++; if (receipt) receipt.closed++; } });
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: '归档测试结果' } }], usage }));
  });
  // Disable idle connection closes; explicit teardown owns this local provider's lifetime.
  server.keepAliveTimeout = 0;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('夹具服务启动失败');
  const project = await rpc<ProjectDocument>(request, 'project.create', { title });
  const model = await rpc<ModelProfile>(request, 'model.save', { model: { name: title + '模型', model: 'archive-model', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, connectionType: 'text', capabilities: ['text'], parameters: { internal_fixture: 'do-not-expose-parameters' } } });
  async function start(count: number) {
    let run: RunRecord | undefined, succeeded = false;
    try {
      const nodes = Array.from({ length: count }, (_, index) => ({ id: `archive-step-${index}`, kind: 'brief', label: `归档步骤 ${index + 1}`, modelId: model.id }));
      await rpc(request, 'workflow.save', { projectId: project.id, workflow: { id: 'archive-workflow', version: 1, name: '归档制作流程', production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes, edges: [] } });
      const created = await rpc<RunRecord>(request, 'run.start', { projectId: project.id });
      run = created; const runId = created.id;
      await expect.poll(async () => {
        const latest = (await rpc<{ items: RunRecord[] }>(request, 'run.list', { projectId: project.id })).items.find(item => item.id === runId);
        if (latest) run = latest;
        return latest?.status;
      }, { timeout: 30_000 }).toBe('succeeded');
      succeeded = true; return created;
    } finally {
      if (!succeeded) {
        // Read-only evidence is bounded and must never replace the original failure.
        try {
          let inspection: RunInspection | undefined, records: UsageRecord[] | undefined;
          if (run) {
            const [inspectionRead, receiptsRead] = await Promise.allSettled([
              rpc<RunInspection>(request, 'run.inspect', { runId: run.id }, 2_000),
              rpc<{ items: UsageRecord[] }>(request, 'cost.list', { runId: run.id, limit: 100 }, 2_000),
            ]);
            if (inspectionRead.status === 'fulfilled') inspection = inspectionRead.value;
            if (receiptsRead.status === 'fulfilled') records = receiptsRead.value.items;
          }
          const evidence = costFailureEvidence(counts, run ? receipts.get(run.id) : undefined, run, inspection, records);
          await test.info().attach('cost-fixture-failure', { body: Buffer.from(JSON.stringify(evidence)), contentType: 'application/json' });
        } catch { console.warn('成本夹具失败证据记录未完成。'); }
      }
    }
  }
  return { server, project, model, start, calls: () => counts.received };
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function openCosts(page: Page, projectId: string) {
  await page.goto('/'); await openCostsPage(page); await page.getByLabel('用量项目', { exact: true }).selectOption(projectId);
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
    await page.reload(); await openCostsPage(page); await page.getByLabel('用量项目').selectOption(source.project.id);
    await page.getByRole('button', { name: '加载更多任务', exact: true }).click();
    await page.getByRole('button', { name: `查看任务用量详情：${older.id}`, exact: true }).click();
    await expect(summary.locator('[data-metric="cachedInputTokens"] > .token-amount')).toHaveText('960');
    expect(source.calls()).toBe(53); expect(errors).toEqual([]);
  } finally { await close(source.server); }
});

test('retains a requested detail page when a workspace refresh supersedes its response', async ({ page, request }, info) => {
  const source = await fixture(request, '翻页与后台刷新交错');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const clockOrigin = new Date('2026-01-01T00:00:00Z'); await page.clock.install({ time: clockOrigin });
  const nextPage = gate(), refreshPage = gate();
  let pages = 0, refreshes = 0;
  const limits: number[] = [];
  try {
    const run = await source.start(32); await openCosts(page, source.project.id);
    await page.getByRole('button', { name: `查看任务用量详情：${run.id}`, exact: true }).click();
    const records = page.locator('.cost-record-list');
    await expect(page.locator('.cost-record')).toHaveCount(30); await expect(records).toHaveAttribute('aria-busy', 'false');
    // Establish the pending cursor read before resuming real version delivery.
    await page.clock.pauseAt(new Date(clockOrigin.getTime() + 2 * test.info().timeout));
    await expect(records).toHaveAttribute('aria-busy', 'false');
    await page.route('**/__desktop_rpc', async route => {
      const input = route.request().postDataJSON();
      if (input.method !== 'cost.list' || input.params.runId !== run.id) { await route.continue(); return; }
      const response = await route.fetch();
      if (pages === 0 && (input.params.before !== undefined || input.params.limit > 30)) { pages++; await nextPage.promise; }
      else if (pages > 0) { refreshes++; limits.push(input.params.limit); await refreshPage.promise; }
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '加载更多明细', exact: true }).click(); await expect.poll(() => pages).toBe(1);
    await page.clock.resume();
    await rpc(request, 'project.create', { title: '触发同一列表的新鲜度检查' }); await expect.poll(() => refreshes).toBeGreaterThan(0);
    nextPage.release(); refreshPage.release();
    await expect(page.locator('.cost-record')).toHaveCount(32); await expect(records).toHaveAttribute('aria-busy', 'false');
    await page.screenshot({ path: info.outputPath('detail-page-after-refresh.png') });
    const before = refreshes; await page.getByRole('button', { name: '刷新详情', exact: true }).click();
    await expect.poll(() => refreshes).toBeGreaterThan(before); await expect(records).toHaveAttribute('aria-busy', 'false');
    expect(limits.at(-1)).toBe(32); await expect(page.locator('.cost-record')).toHaveCount(32);
  } finally { nextPage.release(); refreshPage.release(); await page.unrouteAll({ behavior: 'wait' }); await page.clock.resume(); await close(source.server); }
});

test('keeps a pending task page scoped to its original project when the filter changes', async ({ page, request }) => {
  // Prepare 66 real runs; each individual run retains its 30-second completion bound.
  test.setTimeout(90_000);
  const source = await fixture(request, '旧筛选分页范围'), target = await fixture(request, '新筛选独立范围');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const clockOrigin = new Date('2026-01-01T00:00:00Z'); await page.clock.install({ time: clockOrigin });
  const oldPage = gate(), newPage = gate();
  let pages = 0, filtered = 0;
  const newLimits: number[] = [];
  try {
    for (let index = 0; index < 41; index++) await source.start(1);
    for (let index = 0; index < 24; index++) await target.start(1);
    const newer = await target.start(1);
    await openCosts(page, source.project.id); await expect(page.locator('.cost-task')).toHaveCount(20);
    await page.getByRole('button', { name: '加载更多任务', exact: true }).click(); await expect(page.locator('.cost-task')).toHaveCount(40);
    // Keep the old page pending until the new filter owns its first read.
    // A background refresh may otherwise legitimately return all 41 old rows.
    await page.clock.pauseAt(new Date(clockOrigin.getTime() + 2 * test.info().timeout));
    await expect(page.locator('.cost-task-list')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('button', { name: '加载更多任务', exact: true })).toBeEnabled();
    await page.route('**/__desktop_rpc', async route => {
      const input = route.request().postDataJSON();
      if (input.method !== 'cost.tasks') { await route.continue(); return; }
      const response = await route.fetch();
      if (input.params.projectId === source.project.id) {
        if (pages === 0 && (input.params.before !== undefined || input.params.limit > 40)) { pages++; await oldPage.promise; }
        else if (pages > 0) await oldPage.promise;
      }
      else if (input.params.projectId === target.project.id) { filtered++; newLimits.push(input.params.limit); await newPage.promise; }
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '加载更多任务', exact: true }).click(); await expect.poll(() => pages).toBe(1);
    await page.getByLabel('用量项目', { exact: true }).selectOption(target.project.id); await expect.poll(() => filtered).toBeGreaterThan(0);
    await expect(page.locator('.cost-task')).toHaveCount(40); await expect(page.locator('.cost-task').getByRole('button').first()).toBeDisabled();
    await page.clock.resume();
    await rpc(request, 'project.create', { title: '新筛选读取期间的独立通知' }); await expect.poll(() => filtered).toBeGreaterThan(1);
    oldPage.release(); newPage.release();
    await expect(page.locator('.cost-task')).toHaveCount(20); await expect(page.locator(`.cost-task[data-task-id="${newer.id}"]`)).toBeVisible();
    expect(newLimits.every(limit => limit === 20)).toBe(true);
    await page.getByRole('button', { name: '加载更多任务', exact: true }).click(); await expect(page.locator('.cost-task')).toHaveCount(25);
  } finally { oldPage.release(); newPage.release(); await page.unrouteAll({ behavior: 'wait' }); await page.clock.resume(); await Promise.all([close(source.server), close(target.server)]); }
});

test('retains the detail cursor after a failed page and retries only when requested', async ({ page, request }) => {
  const source = await fixture(request, '分页失败显式重试'); const cursors: unknown[] = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const clockOrigin = new Date('2026-01-01T00:00:00Z'); await page.clock.install({ time: clockOrigin });
  try {
    const run = await source.start(32); await openCosts(page, source.project.id);
    await page.getByRole('button', { name: `查看任务用量详情：${run.id}`, exact: true }).click();
    await expect(page.locator('.cost-record')).toHaveCount(30);
    // This case owns explicit retry; real notification interleavings are covered above.
    await page.clock.pauseAt(new Date(clockOrigin.getTime() + 2 * test.info().timeout));
    await expect(page.locator('.cost-record-list')).toHaveAttribute('aria-busy', 'false');
    await page.route('**/__desktop_rpc', async route => {
      const input = route.request().postDataJSON();
      if (input.method !== 'cost.list' || input.params.runId !== run.id || input.params.before === undefined) { await route.continue(); return; }
      cursors.push(input.params.before);
      if (cursors.length === 1) await route.fulfill({ status: 500, json: { error: '分页夹具暂时拒绝读取' } }); else await route.continue();
    });
    const more = page.getByRole('button', { name: '加载更多明细', exact: true });
    await more.click(); await expect(page.getByRole('alert')).toContainText('分页夹具暂时拒绝读取');
    await expect(page.locator('.cost-record')).toHaveCount(30); await expect(more).toBeEnabled(); expect(cursors).toHaveLength(1);
    await more.click(); await expect(page.locator('.cost-record')).toHaveCount(32);
    expect(cursors).toHaveLength(2); expect(cursors[1]).toBe(cursors[0]); await expect(page.getByRole('alert')).toHaveCount(0);
  } finally { await page.unrouteAll({ behavior: 'wait' }); await page.clock.resume(); await close(source.server); }
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
    await setWorkspaceTheme(page, 'light');
    for (const width of [600, 390]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); }
    expect(source.calls()).toBe(2); expect(errors).toEqual([]);
  } finally { release?.(); await close(source.server); }
});

test('waits for the current query range when returning to a retained project before its replacement resolves', async ({ page, request }) => {
  const source = await fixture(request, '快速筛选返回旧项目的分页范围');
  const other = await rpc<ProjectDocument>(request, 'project.create', { title: '尚未读取完的新筛选' });
  const first = gate(), second = gate(); let returning = false, firstReads = 0, secondReads = 0;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const clockOrigin = new Date('2026-01-01T00:00:00Z'); await page.clock.install({ time: clockOrigin });
  try {
    for (let index = 0; index < 41; index++) await source.start(1);
    await openCosts(page, source.project.id); await expect(page.locator('.cost-task')).toHaveCount(20);
    const more = page.getByRole('button', { name: '加载更多任务', exact: true });
    await more.click(); await expect(page.locator('.cost-task')).toHaveCount(40);
    await page.clock.pauseAt(new Date(clockOrigin.getTime() + 2 * test.info().timeout));
    await expect(page.locator('.cost-task-list')).toHaveAttribute('aria-busy', 'false');
    await page.route('**/__desktop_rpc', async route => {
      const input = route.request().postDataJSON();
      if (input.method === 'cost.tasks' && input.params.projectId === other.id) { secondReads++; await second.promise; }
      else if (returning && input.method === 'cost.tasks' && input.params.projectId === source.project.id && input.params.before === undefined) { firstReads++; await first.promise; }
      await route.continue();
    });
    const select = page.getByLabel('用量项目', { exact: true });
    await select.selectOption(other.id); await expect.poll(() => secondReads).toBeGreaterThan(0); await expect(more).toBeDisabled();
    returning = true; await select.selectOption(source.project.id); await expect.poll(() => firstReads).toBeGreaterThan(0);
    await expect(page.locator('.cost-task')).toHaveCount(40); await expect(page.locator('.cost-task-list')).toHaveAttribute('aria-busy', 'true');
    await expect(more).toBeDisabled();
    first.release(); await expect(page.locator('.cost-task')).toHaveCount(20); await expect(more).toBeEnabled();
    await more.click(); await expect(page.locator('.cost-task')).toHaveCount(40);
  } finally { first.release(); second.release(); await page.unrouteAll({ behavior: 'wait' }); await page.clock.resume(); await close(source.server); }
});
