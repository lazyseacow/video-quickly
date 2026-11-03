import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createNativeVideoWorkflow, createSceneTemplate, type ProjectDocument, type RunInspection, type RunSummary } from '@video-quickly/contracts';
import { test } from './isolated-workspace';

const stageLabels = ['策划与分镜', '素材与配音', '剪辑与动画', '审阅与导出'];
const taskIds = ['planning-style', 'material-note', 'editing-note', 'delivery-note'];
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function saved(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
const production = (page: Page) => page.getByRole('region', { name: '当前制作', exact: true });
const progress = (page: Page) => production(page).getByRole('list', { name: '制作阶段进度', exact: true });
const cards = (page: Page) => progress(page).locator('.workbench-guide__step');
function card(page: Page, label: string) { return cards(page).filter({ hasText: label }); }
async function shotOutlineOnly(page: Page) {
  const outline = page.locator('#project-outline');
  await expect(outline.locator('.outline-header')).toHaveCount(0); await expect(outline.getByRole('region', { name: '镜头列表', exact: true })).toBeVisible();
  await expect(outline.getByRole('tablist')).toHaveCount(0); await expect(outline.getByRole('tab')).toHaveCount(0); await expect(outline.getByRole('tabpanel')).toHaveCount(0); await expect(outline.locator('.step-list, .step-item')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '流程', exact: true })).toBeVisible();
}
async function descriptionHelp(page: Page, list: Locator, label: string, description: string, options: { touch: boolean; screenshot?: string }) {
  const main = list.locator('.workbench-guide__step').filter({ hasText: label }), help = list.getByRole('button', { name: `${label}说明`, exact: true }), tooltip = page.getByRole('tooltip');
  const states = () => list.locator('.workbench-guide__step').evaluateAll(buttons => buttons.map(button => ({ current: button.getAttribute('aria-current'), state: button.getAttribute('data-state') })));
  const before = await states();
  await expect(help).toHaveClass(/workbench-guide__help/); await expect(help).toHaveAttribute('title', ''); await expect(list.locator('button button')).toHaveCount(0); await expect(main).not.toContainText(description);
  expect(await help.evaluate(element => {
    const item = element.closest('.workbench-guide__card'), main = item?.querySelector('.workbench-guide__step');
    return Boolean(main && !main.contains(element) && !element.parentElement?.closest('button'));
  })).toBe(true);
  await help.hover(); await expect(tooltip).toBeVisible(); await expect(tooltip).toHaveText(description); await expect(tooltip).toBeInViewport({ ratio: 1 });
  const tooltipId = await tooltip.getAttribute('id'); if (!tooltipId) throw new Error('阶段说明必须有可关联的ID'); await expect(help).toHaveAttribute('aria-describedby', tooltipId);
  expect(await tooltip.evaluate(element => document.body.contains(element) && !element.closest('.workbench-guide__card'))).toBe(true);
  await tooltip.hover(); await expect(tooltip).toBeVisible();
  if (options.screenshot) await page.screenshot({ path: options.screenshot });
  await page.mouse.move(1, 1); await expect(tooltip).toHaveCount(0); await expect(help).not.toHaveAttribute('aria-describedby', /.+/);
  await help.focus(); await expect(tooltip).toBeVisible(); await expect(tooltip).toHaveText(description); await page.keyboard.press('Escape'); await expect(tooltip).toHaveCount(0); await expect(help).toBeFocused();
  if (options.touch) { await help.tap(); await expect(tooltip).toBeVisible(); }
  else await help.click();
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(await states()).toEqual(before);
  await page.keyboard.press('Escape'); await expect(tooltip).toHaveCount(0); await expect(help).toBeFocused(); await expect(help).not.toHaveAttribute('aria-describedby', /.+/);
  await page.mouse.move(1, 1); await help.press('Shift+Tab'); await expect(main).toBeFocused();
  const focusBoundary = await main.evaluate(button => {
    const card = button.closest('.workbench-guide__card');
    if (!card) throw new Error('阶段按钮必须属于阶段卡片');
    const rings = [card, ...card.querySelectorAll('button')].filter(element => {
      const style = getComputedStyle(element);
      return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
    });
    return { visible: button.matches(':focus-visible'), card: card.getBoundingClientRect().toJSON(), rings: rings.map(element => element.getBoundingClientRect().toJSON()) };
  });
  expect(focusBoundary.visible).toBe(true); expect(focusBoundary.rings).toEqual([focusBoundary.card]);
  await main.press('Tab'); await expect(help).toBeFocused(); await expect(help).toHaveCSS('outline-style', 'solid'); await expect(help.locator('..')).toHaveCSS('outline-style', 'none');
  await expect(tooltip).toBeVisible(); await page.keyboard.press('Escape'); await help.press('Shift+Tab'); await expect(main).toBeFocused(); expect(await states()).toEqual(before);
}
async function currentStage(page: Page, label: string, status: string) {
  await expect(progress(page).locator('[aria-current="step"]')).toHaveCount(1); await expect(card(page, label)).toHaveAttribute('aria-current', 'step'); await expect(card(page, label)).toHaveAttribute('data-state', status);
}
async function selectProject(page: Page, title: string) {
  await page.getByRole('button', { name: '我的项目', exact: true }).click(); await page.getByLabel('搜索项目', { exact: true }).fill(title);
  await page.locator('.project-card').filter({ hasText: title }).getByRole('button', { name: '继续创作', exact: true }).click(); await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(title);
}
function observe(page: Page) {
  const errors: string[] = [], writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) { const method = request.postDataJSON()?.method; if (['run.start', 'run.review', 'project.update', 'render.export'].includes(method)) writes.push(method); } }); return { errors, writes };
}
async function fixture(request: APIRequestContext) {
  const pending: ServerResponse[] = [];
  const server = createServer((incoming, response) => {
    void (async () => {
      for await (const _ of incoming) { /* Consume the real local provider request. */ }
      if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      pending.push(response);
    })().catch(error => response.destroy(error instanceof Error ? error : undefined));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('本地运行夹具未监听');
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  try {
    const model = await rpc<{ id: string }>(request, 'model.save', { model: { name: '阶段高亮本地边界', provider: 'openai-compatible', model: 'local-guide-progress', baseUrl: `http://127.0.0.1:${address.port}/v1`, connectionType: 'text', capabilities: ['text'] } });
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `真实阶段高亮 ${randomUUID().slice(0, 8)}`, brief: '只运行隔离的本地任务与本地HTTP夹具。' });
    // Local provider responses hold each stage at its real asynchronous boundary.
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { workflow: {
      id: 'local-stage-highlights', name: '本地阶段状态回归', version: 1,
      production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: taskIds.map((id, index) => ({ id, kind: 'style', label: `本地任务 ${index + 1}`, modelId: model.id, requiresReview: true })),
      edges: taskIds.slice(1).map((id, index) => ({ id: `local-edge-${index}`, source: taskIds[index], target: id })),
      stages: stageLabels.map((label, index) => ({ id: `local-stage-${index}`, label, description: '已有本地内容的阶段状态', nodeIds: [taskIds[index]] })),
    } } });
    return { project, calls: () => pending.length, reply(index: number, fail = false) {
      const response = pending[index]; if (!response || response.destroyed) throw new Error('待完成的本地模型请求不存在');
      response.writeHead(fail ? 400 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(fail ? { error: { message: 'local stage fixture failure' } } : { choices: [{ message: { content: '实际本地生成的风格结果' } }] }));
    }, close };
  } catch (error) { await close(); throw error; }
}
async function status(request: APIRequestContext, runId: string) { return (await rpc<RunSummary>(request, 'run.get', { runId })).status; }
async function completed(page: Page, completedLabels = stageLabels) {
  await expect(cards(page)).toHaveCount(stageLabels.length);
  await expect(progress(page).locator('[aria-current="step"]')).toHaveCount(1);
  await expect(card(page, completedLabels.at(-1)!)).toHaveAttribute('aria-current', 'step');
  await expect(production(page)).not.toContainText('下一步');
  await expect.poll(() => cards(page).evaluateAll(buttons => buttons.map(button => button.getAttribute('data-state')))).toEqual(stageLabels.map(label => completedLabels.includes(label) ? 'succeeded' : 'pending'));
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 600, height: 900, theme: 'light' }] as const) {
  test.describe(`top guide at ${viewport.width}px in ${viewport.theme}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.width === 600, reducedMotion: 'reduce', storageState: async ({ isolatedWorkspace }, use) => {
      await use({ cookies: [], origins: [{ origin: isolatedWorkspace.origin, localStorage: [{ name: 'vq-theme', value: viewport.theme }, { name: 'vq-onboarding-v1', value: 'done' }] }] });
    } });
    test('tracks automatic running stages at the top, preserves the pointer through details and completes all four cards', async ({ page, request, isolatedWorkspace }, info) => {
      const source = await fixture(request), observed = observe(page);
      try {
        await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await selectProject(page, source.project.title);
        await shotOutlineOnly(page);
        const configuration = page.getByRole('region', { name: '制作指引', exact: true }); await expect(configuration.locator('button[aria-label^="打开阶段："]')).toHaveCount(4); await expect(configuration.locator('[aria-current="step"]')).toHaveCount(1); await expect(configuration.locator('.workbench-guide__step').first()).toHaveAttribute('aria-current', 'step');
        await page.screenshot({ path: info.outputPath(`stage-titles-${viewport.theme}-${viewport.width}.png`) });
        await descriptionHelp(page, configuration.getByRole('list', { name: '流程步骤设置', exact: true }), stageLabels[2], '已有本地内容的阶段状态', { touch: viewport.width === 600 });
        await configuration.getByRole('button', { name: `打开阶段：${stageLabels[2]}`, exact: true }).click(); const settings = page.getByRole('dialog', { name: '制作设置', exact: true }); await expect(settings).toBeVisible(); await settings.getByRole('button', { name: '取消', exact: true }).click();
        await expect(configuration.locator('[aria-current="step"]')).toHaveCount(1); await expect(configuration.locator('.workbench-guide__step').first()).toHaveAttribute('aria-current', 'step'); expect(observed.writes).toEqual([]); expect(source.calls()).toBe(0);
        await page.getByRole('button', { name: '开始制作', exact: true }).click(); await expect.poll(source.calls).toBe(1);
        const run = (await rpc<{ items: RunSummary[] }>(request, 'run.list', { projectId: source.project.id })).items[0]; expect(run).toBeDefined();
        await expect(cards(page)).toHaveCount(4); await expect(configuration).toHaveCount(0); await expect(progress(page)).toHaveClass(/workbench-guide__steps/); await currentStage(page, stageLabels[0], 'running');
        await card(page, stageLabels[2]).click(); const details = page.getByRole('dialog', { name: '制作设置', exact: true }); await expect(details).toBeVisible(); await details.getByRole('button', { name: '本次制作', exact: true }).click(); await expect(details.getByRole('navigation', { name: '本阶段制作步骤', exact: true })).toContainText('本地任务 3'); await details.getByRole('button', { name: '关闭对话框', exact: true }).click(); await currentStage(page, stageLabels[0], 'running');
        source.reply(0); await expect.poll(source.calls).toBe(2); await currentStage(page, stageLabels[1], 'running');
        await page.reload(); await selectProject(page, source.project.title); await currentStage(page, stageLabels[1], 'running'); await shotOutlineOnly(page); await expect(page.locator('html')).toHaveAttribute('data-theme', viewport.theme);
        for (let index = 1; index < stageLabels.length; index++) {
          await currentStage(page, stageLabels[index], 'running'); await expect(card(page, stageLabels[index - 1])).toHaveAttribute('data-state', 'succeeded');
          if (index === 1) {
            await card(page, stageLabels[1]).scrollIntoViewIfNeeded(); await expect(card(page, stageLabels[1])).toBeInViewport({ ratio: 1 });
            await descriptionHelp(page, progress(page), stageLabels[1], '已有本地内容的阶段状态', { touch: viewport.width === 600, screenshot: info.outputPath(`top-stage-2-tooltip-${viewport.theme}-${viewport.width}.png`) });
            await currentStage(page, stageLabels[1], 'running'); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1); await page.screenshot({ path: info.outputPath(`top-stage-2-${viewport.theme}-${viewport.width}.png`) });
          }
          source.reply(index); if (index + 1 < stageLabels.length) await expect.poll(source.calls).toBe(index + 2);
        }
        await expect.poll(() => status(request, run.id)).toBe('succeeded'); await completed(page); await expect(progress(page).locator('.workbench-guide__step[data-state="succeeded"]')).toHaveCount(4);
        await shotOutlineOnly(page);
        const result = await saved(request, source.project.id); expect(result).toMatchObject({ style: '实际本地生成的风格结果', revision: source.project.revision + 1 }); expect(result.workflow).toEqual(source.project.workflow); expect(source.calls()).toBe(4); expect(await rpc(request, 'run.replay', { runId: run.id })).toMatchObject({ externalCalls: 0, matchesSnapshot: true });
        expect(observed.writes).toEqual(['run.start']); expect(observed.errors).toEqual([]); expect(new URL(page.url()).origin).toBe(isolatedWorkspace.origin); await page.screenshot({ path: info.outputPath('top-stages-completed.png') });
      } finally { await source.close(); }
    });
  });
}

test('keeps the newer run highlighted after an old inspection arrives and exposes a real local failure at 600px', async ({ page, request }) => {
  const source = await fixture(request), observed = observe(page), held = gate(), release = gate(), delivered = gate(); let holdOld = false;
  try {
    await page.setViewportSize({ width: 600, height: 900 }); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.addInitScript(() => localStorage.setItem('vq-theme', 'light')); await page.goto('/'); await selectProject(page, source.project.title);
    const old = await rpc<RunSummary>(request, 'run.start', { projectId: source.project.id, nodeId: taskIds[0] }); await expect.poll(source.calls).toBe(1); await currentStage(page, stageLabels[0], 'running'); source.reply(0);
    await expect.poll(() => status(request, old.id)).toBe('succeeded'); await completed(page, [stageLabels[0]]);
    await card(page, stageLabels[2]).click(); const configuration = page.getByRole('dialog', { name: '制作设置', exact: true }); await expect(configuration).toBeVisible(); await configuration.getByRole('button', { name: '取消', exact: true }).click();
    await completed(page, [stageLabels[0]]); await expect(card(page, stageLabels[0])).toContainText('1 / 1 任务');
    await page.route('**/__desktop_rpc', async route => {
      const input = route.request().postDataJSON();
      if (!holdOld && input?.method === 'run.inspect' && input.params?.runId === old.id) { holdOld = true; const response = await route.fetch(); held.release(); await release.promise; await route.fulfill({ response }); delivered.release(); return; }
      await route.continue();
    });
    const updated = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: { title: `${source.project.title} · 新修订` } }); await held.promise;
    const newer = await rpc<RunSummary>(request, 'run.start', { projectId: updated.id, nodeId: taskIds[1] }); await expect.poll(source.calls).toBe(2); await currentStage(page, stageLabels[1], 'running');
    release.release(); await delivered.promise; await currentStage(page, stageLabels[1], 'running'); await expect(cards(page)).toHaveCount(4); await expect(card(page, stageLabels[0])).toHaveAttribute('data-state', 'pending');
    source.reply(1); await expect.poll(() => status(request, newer.id)).toBe('succeeded'); await completed(page, [stageLabels[1]]);
    const failing = await rpc<RunSummary>(request, 'run.start', { projectId: updated.id, nodeId: taskIds[0] }); await expect.poll(source.calls).toBe(3); await currentStage(page, stageLabels[0], 'running'); source.reply(2, true);
    await expect.poll(async () => ['failed', 'needs_attention'].includes(await status(request, failing.id))).toBe(true); const failedStatus = await status(request, failing.id);
    await expect(card(page, stageLabels[0])).toHaveAttribute('data-state', failedStatus); await expect(card(page, stageLabels[0])).toContainText(/失败|需要核对/); await expect(cards(page)).toHaveCount(4);
    expect(source.calls()).toBe(3); expect((await saved(request, updated.id)).revision).toBe(updated.revision); expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light'); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(601);
  } finally { release.release(); await page.unrouteAll({ behavior: 'wait' }); await source.close(); }
});

for (const viewport of [{ width: 1536, height: 960, theme: 'light' }, { width: 600, height: 900, theme: 'dark' }] as const) {
  test(`keeps exactly four native stages before and after a single script run at ${viewport.width}px in ${viewport.theme}`, async ({ page, request }, info) => {
    const server = createServer((incoming, response) => { incoming.resume(); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ shots: [{ id: 'local-shot', title: '生成的本地分镜', narration: '本地视频制作文稿', visualPrompt: '', durationUs: 1_000_000 }] }) } }] })); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('本地分镜服务未启动');
    try {
    const model = await rpc<{ id: string }>(request, 'model.save', { model: { name: '四阶段分镜边界', provider: 'openai-compatible', connectionType: 'text', capabilities: ['text'], model: 'fixture-script', baseUrl: `http://127.0.0.1:${address.port}/v1` } });
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `视频流程完整进度 ${randomUUID().slice(0, 8)}`, templateId: 'history-handdrawn', brief: '只使用已有分镜验证完整流程，不请求模型服务。' });
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { workflow: { ...created.workflow, production: { ...created.workflow.production, textModelId: model.id } }, shots: [{ id: 'local-shot', title: '保留的本地分镜', narration: '已有旁白', visualPrompt: '', durationUs: 1_000_000, sceneTemplate: createSceneTemplate('process') }] } });
    expect(project.workflow.nodes.map(node => node.id)).toEqual(createNativeVideoWorkflow().nodes.map(node => node.id));
    const observed = observe(page); await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await selectProject(page, project.title);
    const guide = page.getByRole('region', { name: '制作指引', exact: true }); await expect(guide.locator('.workbench-guide__step strong')).toHaveText(stageLabels); await expect(guide.getByRole('list')).not.toContainText('史实');
    const run = await rpc<RunSummary>(request, 'run.start', { projectId: project.id, nodeId: 'script' });
    await expect.poll(() => status(request, run.id)).toBe('succeeded');
    const list = progress(page), steps = cards(page), planning = card(page, stageLabels[0]);
    await expect(steps).toHaveCount(4); await expect(steps.locator('strong')).toHaveText(stageLabels); await expect(list).not.toContainText('史实'); await expect(planning).toHaveAttribute('data-state', 'pending');
    await expect(planning).toHaveAttribute('aria-current', 'step'); await expect(planning.locator('..')).toHaveAttribute('data-current', 'true');
    await expect(planning).toBeInViewport({ ratio: 1 }); await page.screenshot({ path: info.outputPath(`native-four-stages-active-${viewport.theme}-${viewport.width}.png`) });
    await planning.click(); const details = page.getByRole('dialog', { name: '制作设置', exact: true }); await expect(details.getByRole('tablist', { name: '制作配置分区', exact: true }).getByRole('tab')).toHaveText([stageLabels[0], stageLabels[1], stageLabels[3]]); await details.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('button', { name: '通过审阅并继续', exact: true })).toHaveCount(0);
    await expect(steps).toHaveCount(4); await expect(list.locator('[aria-current="step"]')).toHaveCount(1); await expect(planning).toHaveAttribute('aria-current', 'step'); await expect(production(page)).not.toContainText('下一步'); await expect(planning).toHaveAttribute('data-state', 'pending'); await expect(planning).toContainText('1 / 3 任务');
    await expect(card(page, stageLabels[0])).toContainText('1 / 3 任务');
    await list.getByRole('button', { name: '打开阶段：素材与配音', exact: true }).click(); const configuration = page.getByRole('dialog', { name: '制作设置', exact: true });
    await expect(configuration).toBeVisible(); await configuration.getByRole('button', { name: '取消', exact: true }).click();
    await page.reload(); await selectProject(page, project.title); await expect(steps).toHaveCount(4); await expect(steps.locator('strong')).toHaveText(stageLabels); await expect(list).not.toContainText('史实'); await expect(planning).toContainText('1 / 3 任务');
    await expect(card(page, stageLabels[1])).toHaveAttribute('data-state', 'pending'); await expect(card(page, stageLabels[0])).toContainText('1 / 3 任务');
    expect(await saved(request, project.id)).toEqual(project); expect(await rpc(request, 'run.replay', { runId: run.id })).toMatchObject({ externalCalls: 0, matchesSnapshot: true });
    expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]); await expect(page.locator('html')).toHaveAttribute('data-theme', viewport.theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1); await production(page).scrollIntoViewIfNeeded(); await list.getByRole('button', { name: `${stageLabels[0]}说明`, exact: true }).press('Shift+Tab'); await expect(planning).toBeFocused();
    await page.screenshot({ path: info.outputPath(`native-four-stages-completed-${viewport.theme}-${viewport.width}.png`) }); await production(page).screenshot({ path: info.outputPath(`stage-card-focus-${viewport.theme}-${viewport.width}.png`) });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
