import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ProjectDocument, RunInspection, RunSummary } from '@video-quickly/contracts';
import { openProjectFromList } from './workspace-navigation';
import { test as isolatedTest } from './isolated-workspace';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok(), JSON.stringify(payload.error)).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function fixture(request: APIRequestContext, flat = false, failure: 'download' | 'rejection' = 'download') {
  let ready = false, textCalls = 0;
  const submissions: string[] = [], downloads: string[] = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const server = createServer({ keepAliveTimeout: 0 }, async (incoming, response) => {
    if (incoming.url === '/v1/chat/completions') {
      incoming.resume(); textCalls++;
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: '本次生成的水彩风格' } }] })); return;
    }
    if (incoming.method === 'POST') {
      let body = ''; for await (const chunk of incoming) body += chunk.toString();
      const { shot } = JSON.parse(body) as { shot: string }; submissions.push(shot);
      if (failure === 'rejection' && !ready && shot === 'shot-2') { response.writeHead(400).end(JSON.stringify({ error: { message: 'invalid image parameter' } })); return; }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ url: `${base}/${shot}.png` })); return;
    }
    downloads.push(incoming.url ?? '');
    if (failure === 'download' && !ready && incoming.url === '/shot-2.png') { response.writeHead(404).end('controlled download failure'); return; }
    response.setHeader('content-type', 'image/png'); response.end(png);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('重试夹具未启动');
  const base = `http://127.0.0.1:${address.port}`;
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  try {
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `单步骤手动重试 ${randomUUID().slice(0, 8)}` });
    const text = await rpc<{ id: string }>(request, 'model.save', { model: { name: '冻结文本', model: 'retry-text', provider: 'openai-compatible', baseUrl: `${base}/v1`, connectionType: 'text', capabilities: ['text'] } });
    const image = await rpc<{ id: string }>(request, 'model.save', { model: { name: '冻结图片', model: 'retry-image', provider: 'custom-http', baseUrl: base, connectionType: 'image', capabilities: ['image'], parameters: { requestPath: 'generate', requestTemplate: { shot: '{{narration}}' }, resultUrlPath: 'url' } } });
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
      shots: [1, 2].map(index => ({ id: `shot-${index}`, title: `镜头 ${index}`, narration: `shot-${index}`, visualPrompt: '水彩画面', durationUs: 1_000_000 })),
      workflow: { id: flat ? 'native-video' : 'manual-retry', name: '重试验收', version: 1, production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' },
        nodes: [{ id: 'style', kind: 'style', label: '生成风格', modelId: text.id }, { id: 'images', kind: 'assets', label: '镜头图片生成', modelId: image.id }, { id: 'finish', kind: 'brief', label: '后续收尾' }],
        edges: [{ id: 'a', source: 'style', target: 'images' }, { id: 'b', source: 'images', target: 'finish' }], execution: { maxConcurrentShots: 1, modelLimits: {} },
        stages: [{ id: 'planning', label: '策划与分镜', nodeIds: ['style'] }, { id: 'media', label: '素材与配音', nodeIds: ['images'] }, { id: 'finish', label: '审阅与导出', nodeIds: ['finish'] }],
      },
    } });
    const run = await rpc<RunSummary>(request, 'run.start', { projectId: project.id });
    await expect.poll(async () => (await rpc<RunSummary>(request, 'run.get', { runId: run.id })).status).toMatch(/^(failed|needs_attention)$/);
    const inspect = () => rpc<RunInspection>(request, 'run.inspect', { runId: run.id });
    expect((await inspect()).steps.find(step => step.id === 'images')?.retry?.allowed).toBe(true);
    return { project, run, inspect, ready: () => { ready = true; }, counts: () => ({ textCalls, submissions: [...submissions], downloads: [...downloads] }), close };
  } catch (error) { await close(); throw error; }
}

for (const failure of ['download', 'rejection'] as const) for (const surface of ['history', 'stage', 'flat'] as const) for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`retries the selected ${failure} step from ${surface} at ${viewport.width}px without starting downstream`, async ({ page, request }, info) => {
    await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const source = await fixture(request, surface === 'flat', failure);
    const writes: string[] = [];
    page.on('request', outgoing => { if (outgoing.url().endsWith('/__desktop_rpc')) { const input = outgoing.postDataJSON(); if (['run.start', 'run.resume', 'run.cancel', 'run.step.retry'].includes(input.method)) writes.push(input.method); } });
    try {
      await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
      if (surface === 'history') {
        await page.getByRole('button', { name: '制作记录', exact: true }).click();
        await page.locator(`.run-card[data-run-id="${source.run.id}"]`).getByRole('button', { name: '查看步骤', exact: true }).click();
      } else {
        await openProjectFromList(page, source.project.title);
        await page.getByRole('button', { name: '打开阶段：素材与配音', exact: true }).click();
      }
      const dialog = page.getByRole('dialog', { name: surface === 'history' ? '制作步骤详情' : '本次制作', exact: true });
      const retry = dialog.getByRole('button', { name: '重试此步骤', exact: true });
      if (surface === 'flat') await expect(dialog.getByRole('tablist', { name: '制作阶段记录', exact: true })).toHaveCount(0);
      await expect(retry).toBeVisible(); await expect(retry).toBeEnabled();
      await expect(dialog).toContainText('沿用本次制作的配置与上游产物');
      if (failure === 'rejection') { await expect(dialog).toContainText('HTTP 400'); expect((await source.inspect()).steps.find(step => step.id === 'images')?.unknownSubmission).toBe(false); }
      expect(source.counts().textCalls).toBe(1); expect(source.counts().submissions).toEqual(['shot-1', 'shot-2']);
      await page.screenshot({ path: info.outputPath('failed-step.png') });
      source.ready(); await retry.focus(); await retry.press('Enter');
      await expect.poll(async () => (await source.inspect()).steps.find(step => step.id === 'images')?.status).toBe('succeeded');
      await expect(dialog).toContainText('后续步骤尚未执行'); await expect(retry).toHaveCount(0);
      await expect(dialog.getByRole('region', { name: '步骤详情：镜头图片生成', exact: true })).toBeVisible();
      if (surface === 'history') await dialog.getByRole('tab', { name: '步骤产物', exact: true }).click();
      const inspection = await source.inspect();
      expect(inspection.run.id).toBe(source.run.id); expect(inspection.run.status).toBe('needs_attention');
      expect(inspection.steps.map(step => [step.id, step.status])).toEqual([['style', 'succeeded'], ['images', 'succeeded'], ['finish', 'pending']]);
      expect(source.counts()).toEqual(failure === 'rejection'
        ? { textCalls: 1, submissions: ['shot-1', 'shot-2', 'shot-2'], downloads: ['/shot-1.png', '/shot-2.png'] }
        : { textCalls: 1, submissions: ['shot-1', 'shot-2'], downloads: ['/shot-1.png', '/shot-2.png', '/shot-2.png'] });
      expect(writes).toEqual(['run.step.retry']);
      expect((await rpc<{ items: RunSummary[] }>(request, 'run.list', { projectId: source.project.id })).items).toHaveLength(1);
      expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: source.project.id })).project).toEqual(source.project);
      expect(new URL(page.url()).origin).toBe(info.project.use.baseURL);
      await expect(dialog.locator('.dialog__footer')).toBeInViewport({ ratio: 1 });
      if (surface !== 'history') {
        const footer = dialog.locator('.dialog__footer');
        await expect(footer.getByRole('button')).toHaveText(['停止', '继续原制作']);
        await expect(dialog.getByRole('button', { name: '关闭对话框', exact: true })).toBeVisible();
        await expect(dialog.locator('.dialog__body').getByRole('button', { name: '继续原制作', exact: true })).toHaveCount(0);
        const positions = await footer.getByRole('button').evaluateAll(buttons => buttons.map(button => ({ x: button.getBoundingClientRect().x, y: button.getBoundingClientRect().y })));
        expect(positions[0].y).toBeCloseTo(positions[1].y);
        expect(positions[0].x).toBeLessThan(positions[1].x);
        await footer.getByRole('button', { name: '停止', exact: true }).focus(); await page.keyboard.press('Tab');
        await expect(footer.getByRole('button', { name: '继续原制作', exact: true })).toBeFocused();
      }
      if (surface === 'flat') {
        const notice = dialog.locator('.toast'), layout = dialog.locator('.run-inspector__layout');
        await expect(notice).toContainText('后续步骤尚未执行'); await expect(notice).toBeInViewport({ ratio: 1 });
        const bounds = await layout.boundingBox();
        await page.screenshot({ path: info.outputPath('retry-notice.png') });
        await expect(notice).not.toBeVisible({ timeout: 4000 }); expect(await layout.boundingBox()).toEqual(bounds);
        const refresh = dialog.getByRole('button', { name: '刷新制作记录', exact: true }); await refresh.click(); await expect(refresh).toBeEnabled();
        await expect(notice).not.toBeVisible(); expect(await layout.boundingBox()).toEqual(bounds);
      }
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
      await page.screenshot({ path: info.outputPath('retried-step.png') });
      if (surface === 'flat') {
        const stop = failure === 'rejection', footer = dialog.locator('.dialog__footer');
        await footer.getByRole('button', { name: stop ? '停止' : '继续原制作', exact: true }).click();
        await expect.poll(async () => (await source.inspect()).run.status).toBe(stop ? 'canceled' : 'succeeded');
        expect(writes).toEqual(['run.step.retry', stop ? 'run.cancel' : 'run.resume']);
        await expect(footer).not.toBeVisible();
        await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(dialog).toHaveCount(0);
      }
    } finally { await source.close(); }
  });
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) isolatedTest(`shows workspace failure and recovery as transient notices at ${viewport.width}px`, async ({ page, request }, info) => {
  const source = await fixture(request, true, 'rejection');
  try {
    await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    await page.goto('/'); await openProjectFromList(page, source.project.title);
    const production = page.getByRole('region', { name: '当前制作', exact: true }), toast = page.locator('.toast');
    await expect(toast).toContainText('HTTP 400'); await expect(production.locator('.notice')).toHaveCount(0);
    await expect(production.getByRole('button', { name: '打开阶段：素材与配音', exact: true })).toHaveAttribute('data-state', /failed|needs_attention/);
    const failedBounds = await page.locator('.preview-panel').boundingBox();
    await expect(toast).not.toBeVisible({ timeout: 4000 }); expect(await page.locator('.preview-panel').boundingBox()).toEqual(failedBounds);
    source.ready(); await rpc(request, 'run.step.retry', { runId: source.run.id, nodeId: 'images' });
    await expect.poll(async () => (await source.inspect()).run.stepRetry?.status).toBe('completed');
    await expect(toast).toContainText('后续步骤尚未执行'); await expect(toast).not.toHaveClass(/toast--error/);
    await expect(production.getByRole('button', { name: '继续原制作', exact: true })).toBeVisible();
    const completedBounds = await page.locator('.preview-panel').boundingBox();
    await page.screenshot({ path: info.outputPath('workspace-notice.png') });
    await expect(toast).not.toBeVisible({ timeout: 4000 }); expect(await page.locator('.preview-panel').boundingBox()).toEqual(completedBounds);
    await expect(production.locator('.notice')).toHaveCount(0);
    await page.getByRole('button', { name: '我的项目', exact: true }).click(); await openProjectFromList(page, source.project.title);
    await expect(production.getByRole('button', { name: '继续原制作', exact: true })).toBeVisible(); await expect(toast).not.toBeVisible();
    await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  } finally { await source.close(); }
});

// Geometry belongs to this workspace; another test's Skill-import banners can
// legitimately change the shared workspace header while this toast expires.
isolatedTest('keeps a compact progress retry after the workspace read-error toast disappears', async ({ page, request }, info) => {
  const source = await fixture(request, true, 'rejection'); let rejectRead = true;
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/__desktop_rpc', route => route.request().postDataJSON().method === 'run.inspect' && route.request().postDataJSON().params?.runId === source.run.id && rejectRead
      ? route.fulfill({ status: 200, json: { error: '制作进度读取暂时失败' } }) : route.continue());
    await page.goto('/'); await openProjectFromList(page, source.project.title);
    const production = page.getByRole('region', { name: '当前制作', exact: true }), toast = page.locator('.toast'), retry = production.getByRole('button', { name: '重试读取制作进度', exact: true });
    await expect(toast).toContainText('制作进度读取暂时失败'); await expect(retry).toBeVisible(); await expect(production.locator('.notice')).toHaveCount(0);
    const bounds = await page.locator('.preview-panel').boundingBox();
    await expect(toast).not.toBeVisible({ timeout: 4000 }); expect(await page.locator('.preview-panel').boundingBox()).toEqual(bounds);
    await page.screenshot({ path: info.outputPath('workspace-progress-retry.png') });
    rejectRead = false; await retry.click(); await expect(retry).toHaveCount(0);
    await expect(production.getByRole('button', { name: '打开阶段：素材与配音', exact: true })).toHaveAttribute('data-state', /failed|needs_attention/);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  } finally { await page.unrouteAll({ behavior: 'wait' }); await source.close(); }
});
