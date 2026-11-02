import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ProjectDocument, RunSummary } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
async function fixture(request: APIRequestContext) {
  let calls = 0;
  const server = createServer(async (incoming, response) => {
    let body = ''; for await (const chunk of incoming) body += chunk.toString();
    calls++;
    const content = body.includes('生成分镜夹具') ? JSON.stringify({ shots: [{ title: '流程生成镜头', narration: '审核通过后生成的旁白。', visualPrompt: '纸张纹理的城市剪影', durationUs: 2_000_000 }] }) : '统一纸张纹理与柔和的城市剪影。';
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('制作夹具未启动');
  try {
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `工作台连续制作 ${randomUUID().slice(0, 8)}` });
    const model = await rpc<{ id: string }>(request, 'model.save', { model: { name: '制作夹具', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', capabilities: ['text'] } });
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
      shots: [{ id: 'original', title: '原镜头', narration: '原旁白', visualPrompt: '', durationUs: 2_000_000 }],
      workflow: { id: 'continuous', name: '连续制作', version: 1, nodes: [
        { id: 'style', kind: 'style', label: '风格确认', modelId: model.id, requiresReview: true },
        { id: 'script', kind: 'script', label: '分镜确认', prompt: '生成分镜夹具', modelId: model.id, requiresReview: true },
        { id: 'finish', kind: 'brief', label: '制作收尾' },
      ], edges: [{ id: 'a', source: 'style', target: 'script' }, { id: 'b', source: 'script', target: 'finish' }] },
    } });
    return { project, server, calls: () => calls };
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
async function latest(request: APIRequestContext, projectId: string) { return (await rpc<{ items: RunSummary[] }>(request, 'run.list', { projectId })).items[0]; }

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`reviews, applies and continues production inside the workbench at ${viewport.width}px`, async ({ page, request }, info) => {
    const source = await fixture(request), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme); await page.setViewportSize(viewport);
      await open(page, source.project); await page.getByRole('button', { name: '开始制作', exact: true }).click();
      const panel = production(page);
      await expect(panel).toBeVisible(); await expect(panel.locator('.workbench-production__heading strong')).toHaveText('风格确认');
      await expect(panel.getByRole('button', { name: '通过审阅并继续', exact: true })).toBeEnabled();
      await expect(page.getByRole('button', { name: '开始制作', exact: true })).toBeDisabled();
      await panel.getByRole('button', { name: '查看产物', exact: true }).click();
      const output = page.getByRole('dialog', { name: '步骤产物', exact: true }); await expect(output).toContainText('统一纸张纹理');
      await output.getByRole('button', { name: '关闭', exact: true }).click();
      await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('workbench-review.png') });
      await panel.getByRole('button', { name: '通过审阅并继续', exact: true }).click();
      await expect(panel.locator('.workbench-production__heading strong')).toHaveText('分镜确认'); await expect(panel.getByRole('button', { name: '通过审阅并继续', exact: true })).toBeEnabled();
      await panel.getByRole('list', { name: '制作步骤进度', exact: true }).getByRole('button', { name: /风格确认/ }).click();
      const detail = page.getByRole('dialog', { name: '制作步骤详情', exact: true });
      await expect(detail.getByRole('region', { name: '步骤详情：风格确认', exact: true })).toBeVisible();
      await detail.getByRole('button', { name: '关闭', exact: true }).click();
      const run = await latest(request, source.project.id); expect(run.status).toBe('waiting_review');
      await page.reload(); await selectProject(page, source.project); await expect(production(page).getByRole('button', { name: '通过审阅并继续', exact: true })).toBeEnabled();
      await production(page).getByRole('button', { name: '查看产物', exact: true }).click();
      await expect(output).toContainText('流程生成镜头'); await output.getByRole('button', { name: '应用到项目', exact: true }).click(); await expect(output).toHaveCount(0);
      await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('流程生成镜头');
      await production(page).getByRole('button', { name: '通过审阅并继续', exact: true }).click();
      await expect.poll(async () => (await latest(request, source.project.id)).status).toBe('succeeded');
      await expect(production(page)).toContainText('已完成');
      await production(page).getByRole('button', { name: '查看产物', exact: true }).click();
      await expect(output).toContainText('流程生成镜头'); await output.getByRole('button', { name: '关闭', exact: true }).click();
      await expect(production(page).getByRole('button', { name: '通过审阅并继续', exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: '制作记录', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '导出', exact: true })).toBeEnabled();
      expect(source.calls()).toBe(2); expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await close(source.server); }
  });
}

test('rejects a review in the workbench and opens frozen step details without leaving the project', async ({ page, request }) => {
  const source = await fixture(request);
  try {
    await open(page, source.project); await page.getByRole('button', { name: '开始制作', exact: true }).click();
    const panel = production(page); await expect(panel.getByRole('button', { name: '通过审阅并继续', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: '制作详情', exact: true }).click();
    const detail = page.getByRole('dialog', { name: '制作步骤详情', exact: true }); await expect(detail).toContainText('风格确认');
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
    await panel.getByRole('button', { name: '停止并修改', exact: true }).click();
    await expect.poll(async () => (await latest(request, source.project.id)).status).toBe('needs_attention');
    await expect(panel).toContainText('需要核对'); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('原镜头');
    await panel.getByRole('button', { name: '停止制作', exact: true }).click();
    await expect.poll(async () => (await latest(request, source.project.id)).status).toBe('canceled');
    await expect(panel).toContainText('已停止'); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('原镜头');
    await expect(panel.getByRole('button', { name: '重新制作', exact: true })).toBeEnabled(); expect(source.calls()).toBe(1);
  } finally { await close(source.server); }
});

test('retains unsaved shot edits when the workbench approves a production step', async ({ page, request }) => {
  const source = await fixture(request);
  try {
    await open(page, source.project); await page.getByRole('button', { name: '开始制作', exact: true }).click();
    const panel = production(page); await expect(panel.getByRole('button', { name: '通过审阅并继续', exact: true })).toBeEnabled();
    await page.getByLabel('镜头标题', { exact: true }).fill('审核期间的镜头草稿');
    await panel.getByRole('button', { name: '通过审阅并继续', exact: true }).click();
    await expect(panel.locator('.workbench-production__heading strong')).toHaveText('分镜确认');
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('审核期间的镜头草稿');
    await expect(page.locator('.unsaved-dot')).toBeVisible();
    const saved = await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: source.project.id });
    expect(saved.project.shots[0].title).toBe('原镜头');
    expect(saved.project.revision).toBe(source.project.revision);
  } finally { await close(source.server); }
});

test('retries failed progress reads and review actions without leaving the workbench or duplicating generation', async ({ page, request }) => {
  const source = await fixture(request); let failRead = true, failReview = true, holdInspection = false, reviewAttempts = 0;
  const reviewTargets: Array<Record<string, unknown>> = [];
  let inspectionEntered!: () => void, releaseInspection!: () => void;
  const entered = new Promise<void>(resolve => { inspectionEntered = resolve; });
  const release = new Promise<void>(resolve => { releaseInspection = resolve; });
  try {
    await page.route('**/__desktop_rpc', async route => {
      const input = route.request().postDataJSON();
      if (input.method === 'run.inspect' && failRead) { failRead = false; await route.fulfill({ status: 400, json: { error: '制作进度读取暂时失败' } }); return; }
      if (input.method === 'run.inspect' && holdInspection) {
        holdInspection = false;
        const response = await route.fetch(); inspectionEntered(); await release;
        await route.fulfill({ response }); return;
      }
      if (input.method === 'run.review') {
        reviewAttempts++;
        reviewTargets.push({ runId: input.params.runId, expectedNodeId: input.params.expectedNodeId, expectedUpdatedAt: input.params.expectedUpdatedAt });
        if (failReview) { failReview = false; holdInspection = true; await route.fulfill({ status: 400, json: { error: '审阅提交暂时失败' } }); return; }
      }
      await route.continue();
    });
    await open(page, source.project); await page.getByRole('button', { name: '开始制作', exact: true }).click();
    const panel = production(page); await expect(panel).toContainText('制作进度读取暂时失败');
    await expect(panel.getByRole('button', { name: '通过审阅并继续', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: '重试读取制作进度', exact: true }).click();
    await expect(panel.getByRole('button', { name: '通过审阅并继续', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: '通过审阅并继续', exact: true }).click();
    await expect(panel).toContainText('操作未完成');
    await entered;
    const waiting = await latest(request, source.project.id);
    expect(waiting.status).toBe('waiting_review'); expect(source.calls()).toBe(1);
    const target = { runId: waiting.id, expectedNodeId: waiting.currentNodeId, expectedUpdatedAt: waiting.updatedAt };
    expect(reviewTargets).toEqual([target]);
    // A matching completed inspection remains usable while a background read is pending.
    await expect(panel.getByRole('button', { name: '通过审阅并继续', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: '通过审阅并继续', exact: true }).click();
    await expect.poll(() => reviewAttempts).toBe(2); expect(reviewTargets).toEqual([target, target]); releaseInspection();
    await expect(panel.locator('.workbench-production__heading strong')).toHaveText('分镜确认');
    await expect(panel).not.toContainText('操作未完成'); expect(source.calls()).toBe(2);
    await expect(page.getByRole('heading', { name: '制作记录', exact: true })).toHaveCount(0);
  } finally { releaseInspection(); await page.unrouteAll({ behavior: 'wait' }); await close(source.server); }
});

test('refreshes a lost review receipt without approving the next checkpoint or saving its draft', async ({ page, request }) => {
  const source = await fixture(request), reviews: Array<Record<string, unknown>> = [];
  try {
    await open(page, source.project); await page.getByRole('button', { name: '开始制作', exact: true }).click();
    const panel = production(page), approve = panel.getByRole('button', { name: '通过审阅并继续', exact: true });
    await expect(approve).toBeEnabled();
    const first = await latest(request, source.project.id);
    expect(first).toMatchObject({ status: 'waiting_review', currentNodeId: 'style' });
    const title = page.getByLabel('镜头标题', { exact: true }); await title.fill('回执丢失后的镜头草稿');
    await page.route('**/__desktop_rpc', async route => {
      const input = route.request().postDataJSON();
      if (input.method === 'run.review') {
        reviews.push({ runId: input.params.runId, expectedNodeId: input.params.expectedNodeId, expectedUpdatedAt: input.params.expectedUpdatedAt });
        if (reviews.length === 1) {
          const response = await route.fetch(); expect(response.ok()).toBe(true);
          await route.fulfill({ status: 400, json: { error: '审阅已经提交，但回执暂时丢失' } }); return;
        }
      }
      await route.continue();
    });
    await approve.click(); await expect(panel).toContainText('操作未完成');
    await expect(panel.locator('.workbench-production__heading strong')).toHaveText('分镜确认'); await expect(approve).toBeEnabled();
    const second = await latest(request, source.project.id);
    expect(second).toMatchObject({ id: first.id, status: 'waiting_review', currentNodeId: 'script' });
    expect(reviews).toEqual([{ runId: first.id, expectedNodeId: first.currentNodeId, expectedUpdatedAt: first.updatedAt }]);
    expect(source.calls()).toBe(2);
    await expect(title).toHaveValue('回执丢失后的镜头草稿'); await expect(page.locator('.unsaved-dot')).toBeVisible();
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: source.project.id })).project).toEqual(source.project);
    await approve.click();
    await expect.poll(async () => (await latest(request, source.project.id)).status).toBe('succeeded');
    expect(reviews).toEqual([
      { runId: first.id, expectedNodeId: first.currentNodeId, expectedUpdatedAt: first.updatedAt },
      { runId: second.id, expectedNodeId: second.currentNodeId, expectedUpdatedAt: second.updatedAt },
    ]);
    expect(source.calls()).toBe(2); await expect(panel).not.toContainText('操作未完成');
    await expect(title).toHaveValue('回执丢失后的镜头草稿');
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: source.project.id })).project).toEqual(source.project);
  } finally { await page.unrouteAll({ behavior: 'wait' }); await close(source.server); }
});
