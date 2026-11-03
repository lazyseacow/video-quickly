import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ProjectDocument, RunSummary } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
async function fixture(request: APIRequestContext, holdStyle = false) {
  let calls = 0;
  let releaseStyle!: () => void, styleEntered!: () => void;
  const release = new Promise<void>(resolve => { releaseStyle = resolve; });
  const entered = new Promise<void>(resolve => { styleEntered = resolve; });
  const server = createServer(async (incoming, response) => {
    let body = ''; for await (const chunk of incoming) body += chunk.toString();
    calls++;
    if (calls === 1 && holdStyle) { styleEntered(); await release; }
    const content = body.includes('生成分镜夹具') ? JSON.stringify({ shots: [{ title: '流程生成镜头', narration: '根据上游风格自动生成的旁白。', visualPrompt: '纸张纹理的城市剪影', durationUs: 2_000_000 }] }) : '统一纸张纹理与柔和的城市剪影。';
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('制作夹具未启动');
  try {
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `工作台连续制作 ${randomUUID().slice(0, 8)}` });
    const model = await rpc<{ id: string }>(request, 'model.save', { model: { name: '制作夹具', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', connectionType: 'text', capabilities: ['text'] } });
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
      shots: [{ id: 'original', title: '原镜头', narration: '原旁白', visualPrompt: '', durationUs: 2_000_000 }],
      workflow: { id: 'continuous', name: '连续制作', version: 1, production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [
        { id: 'style', kind: 'style', label: '风格确认', modelId: model.id, requiresReview: true },
        { id: 'script', kind: 'script', label: '分镜确认', prompt: '生成分镜夹具', modelId: model.id, requiresReview: true },
        { id: 'finish', kind: 'brief', label: '制作收尾' },
      ], edges: [{ id: 'a', source: 'style', target: 'script' }, { id: 'b', source: 'script', target: 'finish' }] },
    } });
    return { project, server, entered, releaseStyle, calls: () => calls };
  } catch (error) { await close(server); throw error; }
}
async function selectProject(page: Page, project: ProjectDocument) {
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.getByLabel('搜索项目', { exact: true }).fill(project.title);
  await page.locator('.project-card').filter({ hasText: project.title }).getByRole('button', { name: '继续创作', exact: true }).click();
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(project.title);
}
async function open(page: Page, project: ProjectDocument) { await page.goto('/'); await selectProject(page, project); }
const production = (page: Page) => page.getByRole('region', { name: '当前制作', exact: true });
const productionControl = (page: Page) => page.locator('.project-heading-actions [data-guide="produce"]');
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function latest(request: APIRequestContext, projectId: string) { return (await rpc<{ items: RunSummary[] }>(request, 'run.list', { projectId })).items[0]; }

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`automatically continues generation and saves its output inside the workbench at ${viewport.width}px`, async ({ page, request }, info) => {
    const source = await fixture(request), errors: string[] = [], reviews: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().endsWith('/__desktop_rpc') && request.postDataJSON()?.method === 'run.review') reviews.push(request.postData() ?? ''); });
    try {
      await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme); await page.setViewportSize(viewport);
      await open(page, source.project); await expect(productionControl(page)).toHaveAccessibleName('开始制作'); await expect(productionControl(page)).toBeEnabled(); await productionControl(page).click();
      await expect.poll(async () => (await latest(request, source.project.id)).status).toBe('succeeded');
      const panel = production(page);
      await expect(panel).toBeVisible(); await expect(panel).toContainText('已完成');
      await expect(productionControl(page)).toHaveAccessibleName('开始制作'); await expect(productionControl(page)).toBeEnabled(); await expect(panel.getByRole('button', { name: '停止制作', exact: true })).toHaveCount(0);
      await expect(panel.getByRole('button', { name: /通过审阅|停止并修改/ })).toHaveCount(0);
      await expect(panel).not.toContainText('等待审阅'); await expect(page.locator('vite-error-overlay')).toHaveCount(0); await expect(page).toHaveTitle(/Video Quickly/);
      await panel.getByRole('list', { name: '制作步骤进度', exact: true }).getByRole('button', { name: '打开步骤：风格确认', exact: true }).click();
      const detail = page.getByRole('dialog', { name: '本次制作', exact: true });
      await expect(detail.getByRole('region', { name: '步骤详情：风格确认', exact: true })).toBeVisible();
      await detail.getByRole('tab', { name: '制作信息', exact: true }).click(); await expect(detail).not.toContainText('人工审阅');
      await detail.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await page.reload(); await selectProject(page, source.project);
      await production(page).getByRole('button', { name: '查看产物', exact: true }).click();
      const output = page.getByRole('dialog', { name: '步骤产物', exact: true });
      await expect(output).toContainText('流程生成镜头'); await output.getByRole('button', { name: '关闭', exact: true }).click(); await expect(output).toHaveCount(0);
      await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('流程生成镜头');
      await expect(page.getByRole('button', { name: '导出', exact: true })).toBeEnabled();
      await production(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`automatic-production-${viewport.width}.png`) });
      expect(source.calls()).toBe(2); expect(reviews).toEqual([]); expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await close(source.server); }
  });
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`switches the top production control to stop, cancels once and preserves unsaved edits at ${viewport.width}px`, async ({ page, request }, info) => {
  const source = await fixture(request, true), cancel = gate(), entered = gate(), writes: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) { const method = request.postDataJSON()?.method; if (['run.start', 'run.cancel', 'project.update'].includes(method)) writes.push(method); } });
  await page.route('**/__desktop_rpc', async route => {
    if (route.request().postDataJSON()?.method === 'run.cancel') { entered.release(); await cancel.promise; }
    await route.continue();
  });
  try {
    await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    await open(page, source.project); const control = productionControl(page);
    await expect(control).toHaveAccessibleName('开始制作'); await expect(control).toBeEnabled();
    const originalControl = await control.elementHandle(), startBounds = await control.boundingBox(); expect(startBounds).not.toBeNull();
    await control.click(); await source.entered; await expect(control).toBeFocused();
    const panel = production(page); await expect(control).toHaveAccessibleName('停止制作'); await expect(control).toHaveText('停止'); await expect(control).toBeEnabled();
    await expect(page.getByRole('button', { name: '停止制作', exact: true })).toHaveCount(1); await expect(panel.getByRole('button', { name: '停止制作', exact: true })).toHaveCount(0);
    expect(await control.evaluate((button, original) => button === original, originalControl)).toBe(true); const stopBounds = await control.boundingBox(); expect(stopBounds).not.toBeNull(); expect(Math.abs(stopBounds!.width - startBounds!.width)).toBeLessThan(1);
    await panel.locator('.workbench-guide__step[aria-current="step"]').click();
    const detail = page.getByRole('dialog', { name: '本次制作', exact: true }); await expect(detail).toContainText('风格确认'); await expect(detail.getByRole('navigation', { name: '本阶段制作步骤', exact: true })).toContainText('风格确认'); await detail.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(detail).toHaveCount(0);
    await page.getByLabel('镜头标题', { exact: true }).fill('停止时保留的镜头草稿');
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('停止时保留的镜头草稿'); await expect(page.locator('.unsaved-dot')).toBeVisible();
    await control.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`top-production-stop-${viewport.width}.png`) });
    await control.focus(); await control.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); }); await entered.promise;
    await expect(control).toBeDisabled(); expect(writes).toEqual(['run.start', 'run.cancel']);
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('停止时保留的镜头草稿'); await expect(page.locator('.unsaved-dot')).toBeVisible();
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: source.project.id })).project).toEqual(source.project);
    cancel.release();
    await expect.poll(async () => (await latest(request, source.project.id)).status).toBe('canceled'); source.releaseStyle();
    await expect(control).toHaveAccessibleName('开始制作'); await expect(control).toBeEnabled(); await expect(control).toBeFocused();
    expect(await control.evaluate((button, original) => button === original, originalControl)).toBe(true);
    await expect(page.getByRole('button', { name: '停止制作', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('停止时保留的镜头草稿'); await expect(page.locator('.unsaved-dot')).toBeVisible();
    expect(writes).toEqual(['run.start', 'run.cancel']); expect(source.calls()).toBe(1); expect(errors).toEqual([]);
    await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await control.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`top-production-stopped-${viewport.width}.png`) });
  } finally { cancel.release(); source.releaseStyle(); await page.unrouteAll({ behavior: 'wait' }); await close(source.server); }
  });
}

test('disables the shared production control during start submission and ignores repeated clicks', async ({ page, request }) => {
  const source = await fixture(request, true), start = gate(), entered = gate(); let starts = 0;
  await page.route('**/__desktop_rpc', async route => {
    if (route.request().postDataJSON()?.method === 'run.start') { starts++; entered.release(); await start.promise; }
    await route.continue();
  });
  try {
    await open(page, source.project); const control = productionControl(page);
    await expect(control).toHaveAccessibleName('开始制作'); await control.focus();
    await control.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); }); await entered.promise;
    await expect(control).toBeDisabled(); expect(starts).toBe(1);
    const title = page.getByLabel('镜头标题', { exact: true }); await title.focus();
    start.release(); await source.entered;
    await expect(control).toHaveAccessibleName('停止制作'); await expect(control).toBeEnabled(); await expect(title).toBeFocused();
    await expect(production(page).getByRole('button', { name: '停止制作', exact: true })).toHaveCount(0);
    await control.click(); await expect.poll(async () => (await latest(request, source.project.id)).status).toBe('canceled'); source.releaseStyle();
    await expect(control).toHaveAccessibleName('开始制作'); await expect(control).toBeEnabled(); expect(starts).toBe(1);
  } finally { start.release(); source.releaseStyle(); await page.unrouteAll({ behavior: 'wait' }); await close(source.server); }
});

test('retains unsaved shot edits while automatic generation continues', async ({ page, request }) => {
  const source = await fixture(request, true);
  try {
    await open(page, source.project); await page.getByRole('button', { name: '开始制作', exact: true }).click(); await source.entered;
    await page.getByLabel('镜头标题', { exact: true }).fill('制作期间的镜头草稿'); source.releaseStyle();
    await expect.poll(async () => (await latest(request, source.project.id)).status).toBe('succeeded');
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('制作期间的镜头草稿'); await expect(page.locator('.unsaved-dot')).toBeVisible();
    const saved = await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: source.project.id });
    expect(saved.project.shots[0].title).toBe('流程生成镜头'); expect(saved.project.revision).toBe(source.project.revision + 1); expect(source.calls()).toBe(2);
  } finally { source.releaseStyle(); await close(source.server); }
});

test('retries failed progress reads while automatic generation completes without duplicate calls', async ({ page, request }) => {
  const source = await fixture(request); let failRead = true;
  try {
    await page.route('**/__desktop_rpc', async route => {
      if (route.request().postDataJSON().method === 'run.inspect' && failRead) { failRead = false; await route.fulfill({ status: 400, json: { error: '制作进度读取暂时失败' } }); return; }
      await route.continue();
    });
    await open(page, source.project); await page.getByRole('button', { name: '开始制作', exact: true }).click();
    const panel = production(page); await expect(panel).toContainText('制作进度读取暂时失败');
    await panel.getByRole('button', { name: '重试读取制作进度', exact: true }).click();
    await expect.poll(async () => (await latest(request, source.project.id)).status).toBe('succeeded');
    await expect(panel).toContainText('已完成'); await expect(panel.getByRole('button', { name: '查看产物', exact: true })).toBeEnabled();
    expect(source.calls()).toBe(2);
  } finally { await close(source.server); }
});
