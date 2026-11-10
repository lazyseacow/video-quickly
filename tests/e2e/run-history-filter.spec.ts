import { setWorkspaceTheme } from './workspace-settings';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ProjectDocument, RunRecord } from '@video-quickly/contracts';
import { DocumentStore, openDatabase } from '../../packages/runtime/src/database';

test.use({ timezoneId: 'UTC' });

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
function seedRuns(directory: string, project: ProjectDocument, count: number, prefix = 'saved', options: { status?: RunRecord['status']; createdAt?: (index: number) => string } = {}) {
  const database = openDatabase(directory), store = new DocumentStore(database), ids: string[] = [];
  try {
    database.transaction(() => {
      for (let index = 0; index < count; index++) {
        const id = `${project.id}-${prefix}-${index}`, timestamp = options.createdAt?.(index) ?? new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
        const run: RunRecord = { id, projectId: project.id, projectRevision: project.revision, workflowVersion: project.workflow.version, snapshotDigest: 'saved-history-fixture', status: options.status ?? 'succeeded', createdAt: timestamp, updatedAt: timestamp, events: [], activities: [] };
        store.put('run', id, run); ids.push(id);
      }
    })();
  } finally { database.close(); }
  return ids;
}
async function fixture(request: APIRequestContext, count = 105) {
  const prefix = `制作记录项目筛选 ${randomUUID().slice(0, 8)}`;
  const first = await rpc<ProjectDocument>(request, 'project.create', { title: `${prefix} 一` });
  const second = await rpc<ProjectDocument>(request, 'project.create', { title: `${prefix} 二` });
  const empty = await rpc<ProjectDocument>(request, 'project.create', { title: `${prefix} 空项目` });
  const workspace = await rpc<{ system: { dataDirectory: string } }>(request, 'workspace.summary');
  const firstIds = seedRuns(workspace.system.dataDirectory, first, count), secondIds = seedRuns(workspace.system.dataDirectory, second, 2);
  return { first, second, empty, firstIds, secondIds, directory: workspace.system.dataDirectory };
}
async function open(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/');
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '制作记录', exact: true }).click();
  const filter = page.getByLabel('制作项目', { exact: true }); await expect(filter).toBeVisible(); return filter;
}
async function visibleIds(page: Page) { return page.locator('.run-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-run-id'))); }
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
let errors: string[];
test.beforeEach(async ({ page }) => { errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); }); });
test.afterEach(async ({ page }) => { expect(errors).toEqual([]); await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0); });

test('filters the actual run list by project, shows its empty state and clears back to all projects', async ({ page, request }) => {
  const data = await fixture(request, 3), reads: Array<{ projectId?: string; before?: number }> = [];
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) { const input = request.postDataJSON(); if (input.method === 'run.list') reads.push(input.params); } });
  const filter = await open(page);
  await filter.selectOption(data.first.id); await expect.poll(() => visibleIds(page)).toEqual([...data.firstIds].reverse());
  expect(reads.some(read => read.projectId === data.first.id && read.before === undefined)).toBe(true);
  await filter.selectOption(data.second.id); await expect.poll(() => visibleIds(page)).toEqual([...data.secondIds].reverse());
  await filter.selectOption(data.empty.id); await expect(page.locator('.run-card')).toHaveCount(0);
  await expect(page.getByText('这个项目还没有制作记录', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除制作记录筛选', exact: true }).click(); await expect(filter).toHaveValue('');
  await expect(page.locator(`.run-card[data-run-id="${data.secondIds[1]}"]`)).toBeVisible();
  expect(reads.at(-1)?.projectId).toBeUndefined();
});

test('owns queued paging and late refreshes by project and refreshes the loaded range after real notifications', async ({ page, request }) => {
  const data = await fixture(request), filter = await open(page), cards = page.locator('.run-card');
  const more = page.getByRole('button', { name: '加载更多制作记录', exact: true });
  await filter.selectOption(data.first.id); await expect(cards).toHaveCount(100); await expect(more).toBeEnabled();
  await page.getByLabel('制作状态', { exact: true }).selectOption('succeeded');
  await page.getByLabel('开始日期', { exact: true }).fill('2026-01-01'); await page.getByLabel('结束日期', { exact: true }).fill('2026-01-01');
  await expect(cards).toHaveCount(100); await expect(more).toBeEnabled();
  const held = gate(), replacementHeld = gate(), release = gate(); let holding = true, heldReads = 0;
  const ownsBaseRead = (params: Record<string, unknown>) => params.projectId === data.first.id && params.status === 'succeeded' && params.createdAfter === '2026-01-01T00:00:00.000Z' && params.createdBefore === '2026-01-02T00:00:00.000Z' && params.before === undefined;
  const reads: Array<{ projectId?: string; status?: string; createdAfter?: string; createdBefore?: string; before?: number; limit: number }> = [];
  await page.route('**/__desktop_rpc', async route => {
    const input = route.request().postDataJSON();
    if (input.method === 'run.list') {
      reads.push(input.params);
      if (holding && ownsBaseRead(input.params)) {
        // Notifications may supersede a pending read; keep every replacement pending too.
        const response = await route.fetch(); heldReads++; held.release(); if (heldReads >= 2) replacementHeld.release();
        await release.promise; await route.fulfill({ response }); return;
      }
    }
    await route.continue();
  });
  try {
    // A notification can start a held read before a click and disable the refresh button.
    await rpc(request, 'project.create', { title: `触发门闩读取 ${randomUUID().slice(0, 8)}` }); await held.promise;
    await rpc(request, 'project.create', { title: `门闩期间真实刷新 ${randomUUID().slice(0, 8)}` });
    await replacementHeld.promise;
    await expect(more).toBeEnabled(); await more.click(); await expect(more).toBeDisabled();
    await filter.selectOption(data.second.id); await expect.poll(() => visibleIds(page)).toEqual([...data.secondIds].reverse());
    const finished = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'run.list' && response.request().postDataJSON()?.params.projectId === data.first.id);
    holding = false; release.release(); await (await finished).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(() => visibleIds(page)).toEqual([...data.secondIds].reverse());
    expect(reads.some(read => read.projectId === data.first.id && read.before !== undefined)).toBe(false);
    await filter.selectOption(data.first.id); await expect(cards).toHaveCount(100); await more.click(); await expect.poll(() => visibleIds(page)).toEqual([...data.firstIds].reverse());
    const [added] = seedRuns(data.directory, data.first, 1, 'newer');
    await rpc(request, 'project.create', { title: `触发真实记录刷新 ${randomUUID().slice(0, 8)}` });
    await expect(page.locator(`.run-card[data-run-id="${added}"]`)).toBeVisible(); await expect(cards).toHaveCount(105);
    await expect(filter).toHaveValue(data.first.id); await expect(more).toBeEnabled(); await more.click();
    await expect.poll(() => visibleIds(page)).toEqual([added, ...[...data.firstIds].reverse()]);
    expect(new Set(await visibleIds(page)).size).toBe(106);
    expect(reads.filter(read => read.before !== undefined).every(read => read.projectId === data.first.id && read.status === 'succeeded' && read.createdAfter === '2026-01-01T00:00:00.000Z' && read.createdBefore === '2026-01-02T00:00:00.000Z')).toBe(true);
  } finally { release.release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('keeps history filters aligned and keyboard accessible in dark desktop and light narrow layouts', async ({ page, request }, info) => {
  const data = await fixture(request, 1), filter = await open(page);
  async function expectAlignedFilters() {
    const bounds = await page.locator('.run-history-filters').locator('select, input').evaluateAll(controls => controls.map(control => {
      const { y, height } = control.getBoundingClientRect(); return { y, height };
    }));
    expect(bounds).toEqual(Array.from({ length: 5 }, () => bounds[0]));
  }
  await expectAlignedFilters();
  await page.screenshot({ path: info.outputPath('run-filters-dark-default-1536.png') });
  await filter.selectOption(data.first.id); await expect.poll(() => visibleIds(page)).toEqual(data.firstIds);
  await expectAlignedFilters();
  await expect(page.locator('.run-card__actions').getByRole('button')).toHaveText(['查看步骤', '打开项目', '删除']);
  await filter.focus(); await expect(filter).toBeFocused();
  const clear = page.getByRole('button', { name: '清除制作记录筛选', exact: true }); await clear.focus(); await clear.press('Enter'); await expect(filter).toHaveValue('');
  await expectAlignedFilters();
  await filter.selectOption(data.first.id); await expect.poll(() => visibleIds(page)).toEqual(data.firstIds);
  await page.screenshot({ path: info.outputPath('run-project-filter-dark-1536.png') });
  await setWorkspaceTheme(page, 'light'); await page.setViewportSize({ width: 600, height: 900 });
  await expect(filter).toBeVisible(); await filter.focus(); await expect(filter).toBeFocused();
  await filter.selectOption(data.empty.id); await expect(page.getByText('这个项目还没有制作记录', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '清除制作记录筛选', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('run-project-filter-light-600.png') });
});

test.describe('local calendar date filters', () => {
  test.use({ timezoneId: 'America/New_York' });
  test('combines status and local dates across both DST transitions without submitting invalid intermediate ranges', async ({ page, request }) => {
    const data = await fixture(request, 0);
    const springTimes = ['2026-03-08T04:59:59.999Z', '2026-03-08T05:00:00.000Z', '2026-03-09T03:59:59.999Z', '2026-03-09T04:00:00.000Z'];
    const fallTimes = ['2026-11-01T03:59:59.999Z', '2026-11-01T04:00:00.000Z', '2026-11-02T04:59:59.999Z', '2026-11-02T05:00:00.000Z'];
    const spring = seedRuns(data.directory, data.first, 4, 'spring', { status: 'failed', createdAt: index => springTimes[index] });
    const fall = seedRuns(data.directory, data.first, 4, 'fall', { status: 'failed', createdAt: index => fallTimes[index] });
    seedRuns(data.directory, data.first, 1, 'different-status', { createdAt: () => springTimes[1] });
    const reads: Array<{ status?: string; createdAfter?: string; createdBefore?: string }> = [];
    page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) { const input = request.postDataJSON(); if (input.method === 'run.list') reads.push(input.params); } });
    const project = await open(page), status = page.getByLabel('制作状态', { exact: true }), start = page.getByLabel('开始日期', { exact: true }), end = page.getByLabel('结束日期', { exact: true });
    await project.selectOption(data.first.id); await status.selectOption('failed'); await start.fill('2026-03-08'); await end.fill('2026-03-08');
    await expect.poll(() => visibleIds(page)).toEqual([spring[2], spring[1]]);
    expect(reads.at(-1)).toMatchObject({ status: 'failed', createdAfter: springTimes[1], createdBefore: springTimes[3] });
    const beforeInvalid = reads.length; await start.fill('2026-11-01');
    await expect(page.getByRole('alert')).toContainText('开始日期不能晚于结束日期'); await expect(page.locator('.run-card')).toHaveCount(0);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const notifiedRead = page.waitForRequest(request => {
      const input = request.postDataJSON();
      return request.url().endsWith('/__desktop_rpc') && input?.method === 'run.list' && input.params.projectId === data.first.id && input.params.status === 'failed' && input.params.createdAfter === springTimes[1] && input.params.createdBefore === springTimes[3];
    });
    await rpc(request, 'project.create', { title: `无效日期期间真实通知 ${randomUUID().slice(0, 8)}` });
    const response = await (await notifiedRead).response(); expect(response).not.toBeNull(); await response!.finished();
    // Background notifications may refresh the last valid query while the invalid controls stay visible.
    const refreshedReads = reads.slice(beforeInvalid); expect(refreshedReads.length).toBeGreaterThan(0);
    for (const read of refreshedReads) expect(read).toEqual({ projectId: data.first.id, status: 'failed', createdAfter: springTimes[1], createdBefore: springTimes[3], limit: 100 });
    await expect(start).toHaveValue('2026-11-01'); await expect(end).toHaveValue('2026-03-08');
    await expect(page.getByRole('alert')).toContainText('开始日期不能晚于结束日期'); await expect(page.locator('.run-card')).toHaveCount(0);
    await end.fill('2026-11-01'); await expect.poll(() => visibleIds(page)).toEqual([fall[2], fall[1]]);
    expect(reads.at(-1)).toMatchObject({ status: 'failed', createdAfter: fallTimes[1], createdBefore: fallTimes[3] });
    await page.getByRole('button', { name: '清除制作记录筛选', exact: true }).click();
    await expect(project).toHaveValue(''); await expect(status).toHaveValue(''); await expect(start).toHaveValue(''); await expect(end).toHaveValue('');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('calendar dates when a DST transition skips midnight', () => {
  test.use({ timezoneId: 'America/Sao_Paulo' });
  test('uses the next local midnight after a day that began at one oclock', async ({ page, request }) => {
    const data = await fixture(request, 0);
    const times = ['2018-11-04T03:00:00.000Z', '2018-11-05T01:59:59.999Z', '2018-11-05T02:00:00.000Z'];
    const ids = seedRuns(data.directory, data.first, 3, 'midnight-gap', { createdAt: index => times[index] });
    const reads: Array<{ createdAfter?: string; createdBefore?: string }> = [];
    page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) { const input = request.postDataJSON(); if (input.method === 'run.list') reads.push(input.params); } });
    await (await open(page)).selectOption(data.first.id);
    await page.getByLabel('开始日期', { exact: true }).fill('2018-11-04'); await page.getByLabel('结束日期', { exact: true }).fill('2018-11-04');
    await expect.poll(() => visibleIds(page)).toEqual([ids[1], ids[0]]);
    expect(reads.at(-1)).toMatchObject({ createdAfter: times[0], createdBefore: times[2] });
  });
});
