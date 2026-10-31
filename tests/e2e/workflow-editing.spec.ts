import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const result = await response.json(); expect(result.error).toBeUndefined(); return result.result;
}
async function fixture(request: APIRequestContext, title: string) {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title: `${title} ${randomUUID().slice(0, 8)}` });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: {
    profile: { ...project.profile, width: 640, height: 360 }, shots: [{ id: 'shot', title: '画布验收镜头', narration: '', visualPrompt: '', durationUs: 1_000_000 }],
    workflow: { id: 'editable-flow', name: '画布验收流程', version: 1, nodes: [{ id: 'a', kind: 'brief', label: '简报 A', position: { x: 0, y: 0 } }, { id: 'b', kind: 'brief', label: '提案 B', position: { x: 360, y: 0 } }], edges: [{ id: 'ab', source: 'a', target: 'b' }] },
  } });
}
async function current(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
async function open(page: Page, title: string, flow = true) {
  await page.goto('/'); await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
  await page.getByRole('button', { name: `打开项目：${title}`, exact: true }).click();
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(title);
  if (flow) { await page.getByRole('button', { name: '流程', exact: true }).click(); await expect(page.locator('.react-flow')).toBeVisible(); }
}
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
async function save(page: Page) { const button = page.getByRole('button', { name: '保存流程', exact: true }); await expect(button).toBeEnabled(); await button.click(); await expect(button).toBeDisabled(); await expect(button).not.toHaveAttribute('aria-busy', 'true'); }
async function history(page: Page, name: '撤销' | '重做') { const button = page.getByRole('button', { name, exact: true }); await expect(button).toBeEnabled(); await button.click(); }
async function center(element: Locator) { const box = await element.boundingBox(); if (!box) throw new Error('连接点不可见'); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }
async function connect(page: Page, from: string, to: string) {
  const source = node(page, from).locator('.react-flow__handle.source'), target = node(page, to).locator('.react-flow__handle.target');
  await source.click({ trial: true }); await target.click({ trial: true });
  const start = await center(source), end = await center(target);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
}

for (const width of [1536, 600]) test(`pans from blank canvas with the left button while preserving Shift selection and zoom at ${width}px`, async ({ page, request }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const project = await fixture(request, '画布空白拖动验收'); await open(page, project.title);
  await page.setViewportSize({ width, height: 960 });
  await page.locator('.react-flow__pane').scrollIntoViewIfNeeded();
  await expect(node(page, 'b')).toBeVisible();
  const viewport = () => page.locator('.react-flow__viewport').evaluate(element => { const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f, zoom: matrix.a }; });
  if (width === 600) {
    await page.getByRole('button', { name: '适应全部步骤', exact: true }).click();
    await expect(node(page, 'a')).toBeInViewport({ ratio: 1 }); await expect(node(page, 'b')).toBeInViewport({ ratio: 1 });
    await expect.poll(async () => (await viewport()).zoom).toBeLessThan(1);
  }
  const pane = await page.locator('.react-flow__pane').boundingBox(); if (!pane) throw new Error('流程画布不可见');
  const start = { x: pane.x + pane.width / 2, y: pane.y + 100 };
  const before = await viewport();
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + 90, start.y + 60, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => Math.round((await viewport()).x - before.x)).toBe(90);
  await expect.poll(async () => Math.round((await viewport()).y - before.y)).toBe(60);
  expect((await viewport()).zoom).toBeCloseTo(before.zoom, 5);
  await expect(page.locator('.react-flow__selection')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存流程', exact: true })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('blank-canvas-panned.png') });

  const first = await node(page, 'a').boundingBox(), second = await node(page, 'b').boundingBox();
  if (!first || !second) throw new Error('流程步骤不可见');
  const selectionStart = { x: Math.min(first.x + first.width / 2, second.x + second.width / 2), y: Math.min(first.y, second.y) - 12 };
  const selectionEnd = { x: Math.max(first.x + first.width / 2, second.x + second.width / 2), y: Math.max(first.y + first.height, second.y + second.height) + 12 };
  const beforeSelection = await viewport();
  await page.keyboard.down('Shift'); await page.mouse.move(selectionStart.x, selectionStart.y); await page.mouse.down();
  await page.mouse.move(selectionEnd.x, selectionEnd.y, { steps: 8 }); await page.mouse.up(); await page.keyboard.up('Shift');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  expect((await viewport()).zoom).toBeCloseTo(beforeSelection.zoom, 5);
  await expect(page.getByRole('button', { name: '保存流程', exact: true })).toBeDisabled();
  expect((await current(request, project.id)).workflow).toEqual(project.workflow);

  await page.mouse.move(start.x, start.y); await page.keyboard.down('Control'); await page.mouse.wheel(0, 120); await page.keyboard.up('Control');
  await expect.poll(async () => (await viewport()).zoom).toBeLessThan(before.zoom);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('keeps a new pointer pan when fitting finishes before the next animation frame', async ({ page, request }) => {
  const clockOrigin = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time: clockOrigin });
  await page.setViewportSize({ width: 1536, height: 960 });
  const project = await fixture(request, '适配与指针操作顺序'); await open(page, project.title);
  await page.setViewportSize({ width: 600, height: 960 });
  await page.locator('.react-flow__pane').scrollIntoViewIfNeeded();
  const viewport = () => page.locator('.react-flow__viewport').evaluate(element => { const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f, zoom: matrix.a }; });
  const fit = page.getByRole('button', { name: '适应全部步骤', exact: true });
  await fit.click();
  await expect(node(page, 'a')).toBeInViewport({ ratio: 1 }); await expect(node(page, 'b')).toBeInViewport({ ratio: 1 });
  const pane = await page.locator('.react-flow__pane').boundingBox(); if (!pane) throw new Error('流程画布不可见');
  const start = { x: pane.x + pane.width / 2, y: pane.y + 100 };
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x - 120, start.y - 50, { steps: 8 }); await page.mouse.up();
  // Pause the browser's real rendering boundary, without replacing fitView or
  // its node queue. Input events still arrive before that next frame.
  // This target exceeds the entire test deadline. A delayed protocol command
  // cannot arrive after it while this test is still allowed to run.
  const pauseTime = new Date(clockOrigin.getTime() + 2 * test.info().timeout);
  // Reproduce a slow protocol delivery without sleeping inside the fake clock.
  await new Promise(resolve => setTimeout(resolve, 180));
  await page.clock.pauseAt(pauseTime);
  await fit.dispatchEvent('click');
  const before = await viewport();
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 90, start.y + 60, { steps: 8 }); await page.mouse.up();
  await page.clock.runFor(34);
  await expect.poll(async () => Math.round((await viewport()).x - before.x)).toBe(90);
  await expect.poll(async () => Math.round((await viewport()).y - before.y)).toBe(60);
  expect((await viewport()).zoom).toBeCloseTo(before.zoom, 5);
  expect((await current(request, project.id)).workflow).toEqual(project.workflow);
  await fit.focus(); await expect(fit).toBeFocused(); await fit.press('Enter');
  await expect(node(page, 'a')).toBeInViewport({ ratio: 1 }); await expect(node(page, 'b')).toBeInViewport({ ratio: 1 });
  await expect(fit).toBeFocused();
});

test('recovers unfinished graph input without saving or starting an agent, then commits the corrected graph', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const project = await fixture(request, '流程未完成草稿恢复'); await open(page, project.title);
  await page.getByRole('button', { name: '添加编排步骤', exact: true }).click();
  await page.getByLabel('步骤名称', { exact: true }).fill('');
  const added = await page.locator('.react-flow__node').evaluateAll(elements => elements.map(element => element.getAttribute('data-id')).find(id => id !== 'a' && id !== 'b'));
  if (!added) throw new Error('新增步骤不存在');
  await page.getByRole('button', { name: '保存流程', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('填写名称');
  await expect.poll(() => page.evaluate(async id => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('video-quickly-drafts', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    return new Promise<boolean>(resolve => { const request = db.transaction('projects').objectStore('projects').getAll(); request.onsuccess = () => { resolve(request.result.some(value => value.projectId === id && value.version === 2 && value.present.workflow.nodes.some((node: { label: string }) => node.label === ''))); db.close(); }; });
  }, project.id)).toBe(true);
  page.once('dialog', dialog => dialog.accept()); await page.reload(); await open(page, project.title);
  await expect(page.getByText('已恢复未保存的本地草稿，含撤销与重做历史。')).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await page.getByRole('button', { name: '适应全部步骤', exact: true }).click(); await node(page, added).click();
  await expect(page.getByLabel('步骤名称', { exact: true })).toHaveValue('');
  expect((await current(request, project.id)).workflow).toEqual(project.workflow);
  expect((await rpc<{ items: unknown[] }>(request, 'run.list', { projectId: project.id })).items).toEqual([]);
  await page.getByLabel('步骤名称', { exact: true }).fill('恢复后确认的步骤'); await save(page);
  expect((await current(request, project.id)).workflow.nodes).toHaveLength(3);
  expect((await current(request, project.id)).workflow.version).toBe(project.workflow.version + 1);
  expect(errors).toEqual([]);
});

test('groups real node dragging and text edits, restoring shared history and server versions after reload', async ({ page, request }) => {
  const project = await fixture(request, '流程移动与撤销恢复'); await open(page, project.title);
  await node(page, 'a').click(); await page.getByLabel('步骤名称', { exact: true }).fill('新的简报');
  const before = await center(node(page, 'a').locator('.flow-node__title'));
  await page.mouse.move(before.x, before.y); await page.mouse.down(); await page.mouse.move(before.x + 75, before.y + 45, { steps: 10 }); await page.mouse.up();
  await history(page, '撤销');
  await expect(page.getByLabel('步骤名称', { exact: true })).toHaveValue('新的简报');
  await history(page, '撤销'); await expect(page.getByLabel('步骤名称', { exact: true })).toHaveValue('简报 A');
  await history(page, '重做'); await history(page, '重做'); await expect(page.getByRole('button', { name: '保存流程', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: '保存流程', exact: true })).not.toHaveAttribute('aria-busy', 'true');
  const saved = await current(request, project.id); expect(saved.workflow.nodes[0].position).not.toEqual(project.workflow.nodes[0].position);
  expect(saved.workflow.version).toBe(project.workflow.version + 2);
  await page.reload(); await open(page, project.title); await node(page, 'a').click(); await history(page, '撤销');
  await expect.poll(async () => (await current(request, project.id)).workflow.nodes[0].position).toEqual(project.workflow.nodes[0].position);
  await history(page, '撤销');
  await expect.poll(async () => (await current(request, project.id)).workflow.nodes[0].label).toBe('简报 A');
  expect((await current(request, project.id)).workflow.version).toBe(saved.workflow.version + 2);
});

test('connects nodes, blocks a cycle and undoes node deletion with its edges as one command', async ({ page, request }) => {
  const project = await fixture(request, '流程连接与移除恢复'); await open(page, project.title);
  await page.getByRole('button', { name: '添加编排步骤', exact: true }).click(); await page.getByLabel('步骤名称', { exact: true }).fill('汇合 C');
  const added = await page.locator('.react-flow__node').evaluateAll(elements => elements.map(element => element.getAttribute('data-id')).find(id => id !== 'a' && id !== 'b'));
  if (!added) throw new Error('新增步骤不存在');
  await page.getByRole('button', { name: '适应全部步骤', exact: true }).click();
  await connect(page, 'b', added); await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await connect(page, added, 'a'); await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await node(page, 'b').click(); await page.getByRole('button', { name: '移除步骤', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(2); await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await history(page, '撤销'); await expect(page.locator('.react-flow__node')).toHaveCount(3); await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await save(page); expect((await current(request, project.id)).workflow.edges.map(edge => edge.source)).toEqual(['a', 'b']);
});

test('rebases an unrelated title and compares competing graphs without losing either draft', async ({ page, request }, info) => {
  const project = await fixture(request, '流程外部修订保护'); await open(page, project.title);
  await node(page, 'a').click(); await page.getByLabel('提示词', { exact: true }).fill('我的流程草稿');
  const renamed = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { title: '外部更新的项目名称' } });
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue('外部更新的项目名称');
  await expect(page.getByLabel('提示词', { exact: true })).toHaveValue('我的流程草稿');
  const remote = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: renamed.revision, patch: { workflow: { ...renamed.workflow, nodes: renamed.workflow.nodes.map(node => node.id === 'b' ? { ...node, label: '外部提案步骤' } : node) } } });
  await page.getByRole('button', { name: '比较并处理', exact: true }).click();
  const comparison = page.getByRole('dialog', { name: '比较草稿与已保存内容' });
  await expect(comparison).toContainText('我的流程草稿'); await expect(comparison).toContainText('外部提案步骤');
  await page.screenshot({ path: info.outputPath('workflow-graph-conflict.png') });
  await comparison.getByLabel('我的草稿', { exact: true }).check(); await comparison.getByRole('button', { name: '合并所选内容', exact: true }).click(); await save(page);
  const saved = await current(request, project.id); expect(saved.title).toBe('外部更新的项目名称'); expect(saved.workflow.nodes[0].prompt).toBe('我的流程草稿');
  expect(saved.workflow.nodes[1].label).toBe('提案 B'); expect(saved.workflow.version).toBe(remote.workflow.version + 1);
  await history(page, '撤销'); await expect.poll(async () => (await current(request, project.id)).workflow.nodes[1].label).toBe('外部提案步骤');
  expect((await current(request, project.id)).title).toBe('外部更新的项目名称');
});

test('retains input added during a committed save and keeps the view open until the newer graph is saved', async ({ page, request }) => {
  const project = await fixture(request, '流程保存期间输入保护'); await open(page, project.title); await node(page, 'a').click();
  let release: (() => void) | undefined; const gate = new Promise<void>(resolve => { release = resolve; }); let captured = 0;
  await page.route('**/__desktop_rpc', async route => {
    const body = route.request().postDataJSON();
    if (body.method !== 'project.update' || body.params.patch.workflow?.nodes[0].label !== '先提交的名称') { await route.continue(); return; }
    const response = await route.fetch(); captured++; await gate; await route.fulfill({ response });
  });
  try {
    await page.getByLabel('步骤名称', { exact: true }).fill('先提交的名称'); await page.getByRole('button', { name: '保存流程', exact: true }).click();
    await expect.poll(() => captured).toBe(1); await page.getByLabel('步骤名称', { exact: true }).fill('等待期间的新名称');
    await page.getByRole('button', { name: '分镜', exact: true }).click(); release?.();
    await expect(page.locator('.react-flow')).toBeVisible(); await expect(page.getByLabel('步骤名称', { exact: true })).toHaveValue('等待期间的新名称');
    await expect(page.getByRole('button', { name: '保存流程', exact: true })).toBeEnabled();
    expect((await current(request, project.id)).workflow.nodes[0].label).toBe('先提交的名称');
    await save(page); expect((await current(request, project.id)).workflow.nodes[0].label).toBe('等待期间的新名称');
    expect(captured).toBe(1);
  } finally { release?.(); }
});

test('shares step-setting history with the graph and preserves input when the same step changes elsewhere', async ({ page, request }) => {
  const project = await fixture(request, '步骤设置统一历史'); await open(page, project.title, false);
  await page.getByRole('tab', { name: '制作步骤', exact: true }).click(); await page.locator('.step-list').getByRole('button').filter({ hasText: '简报 A' }).click();
  const dialog = page.getByRole('dialog', { name: '简报 A', exact: true });
  await dialog.getByLabel('提示词与补充要求').fill('人工设置的提示词'); await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0); await history(page, '撤销');
  await expect.poll(async () => (await current(request, project.id)).workflow.nodes[0].prompt).toBe('');
  await history(page, '重做');
  await expect.poll(async () => (await current(request, project.id)).workflow.nodes[0].prompt).toBe('人工设置的提示词');
  await page.locator('.step-list').getByRole('button').filter({ hasText: '简报 A' }).click(); await dialog.getByLabel('提示词与补充要求').fill('尚未应用的输入');
  const saved = await current(request, project.id);
  const remote = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: saved.revision, patch: { workflow: { ...saved.workflow, nodes: saved.workflow.nodes.map(node => node.id === 'a' ? { ...node, prompt: '另一视图的提示词' } : node) } } });
  await expect(page.locator('.project-heading-copy')).toHaveAttribute('data-revision', String(remote.revision));
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('步骤已在其他视图更新');
  await expect(dialog.getByLabel('提示词与补充要求')).toHaveValue('尚未应用的输入');
  expect((await current(request, project.id)).workflow.nodes[0].prompt).toBe('另一视图的提示词');
});

test('keeps newer step input after a committed save and requires confirmation before executing it', async ({ page, request }) => {
  const project = await fixture(request, '步骤保存期间继续输入'); await open(page, project.title, false);
  await page.getByRole('tab', { name: '制作步骤', exact: true }).click();
  await page.locator('.step-list').getByRole('button').filter({ hasText: '简报 A' }).click();
  const dialog = page.getByRole('dialog', { name: '简报 A', exact: true }), prompt = dialog.getByLabel('提示词与补充要求');
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
    await dialog.getByRole('button', { name: '执行', exact: true }).click(); await committed;
    await prompt.fill('等待保存期间补充的新要求'); release();
    await expect(dialog.getByRole('alert')).toContainText('保存期间有新修改');
    await expect(prompt).toHaveValue('等待保存期间补充的新要求');
    expect((await current(request, project.id)).workflow.nodes[0].prompt).toBe('先提交的步骤要求');
    expect((await rpc<{ items: unknown[] }>(request, 'run.list', { projectId: project.id })).items).toEqual([]);
    await dialog.getByRole('button', { name: '保存', exact: true }).click(); await expect(dialog).toHaveCount(0);
    expect((await current(request, project.id)).workflow.nodes[0].prompt).toBe('等待保存期间补充的新要求');
    await history(page, '撤销'); await expect.poll(async () => (await current(request, project.id)).workflow.nodes[0].prompt).toBe('先提交的步骤要求');
    expect((await rpc<{ items: unknown[] }>(request, 'run.list', { projectId: project.id })).items).toEqual([]);
  } finally { release(); }
});

test('persists branch, model and review settings and supports keyboard edge history while preserving native input undo', async ({ page, request }) => {
  const project = await fixture(request, '流程条件与键盘操作');
  const model = await rpc<{ id: string }>(request, 'model.save', { model: { name: '仅保存不执行的连接', provider: 'openai-compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:19999/v1', capabilities: ['text'] } });
  await rpc(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, nodes: project.workflow.nodes.map(node => node.id === 'a' ? { ...node, kind: 'condition' } : node) } } });
  await open(page, project.title); await node(page, 'a').click();
  await page.getByLabel('条件分支结果', { exact: true }).selectOption('true');
  await page.getByLabel('使用模型', { exact: true }).selectOption(model.id);
  await page.getByLabel('完成后人工审阅', { exact: true }).check();
  await page.getByLabel('提案 B', { exact: true }).selectOption('true'); await save(page);
  const saved = await current(request, project.id);
  expect(saved.workflow.nodes[0]).toMatchObject({ modelId: model.id, requiresReview: true, config: { value: true } });
  expect(saved.workflow.edges[0].condition).toBe('true');
  await node(page, 'a').focus(); await page.keyboard.press('Control+z');
  await expect.poll(async () => (await current(request, project.id)).workflow.edges[0].condition).toBeUndefined();
  await expect(page.getByRole('button', { name: '重做', exact: true })).toBeEnabled();
  await node(page, 'a').focus(); await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await current(request, project.id)).workflow.edges[0].condition).toBe('true');
  const description = page.getByLabel('步骤说明', { exact: true }); await description.fill(''); await description.pressSequentially('native input'); await description.press('ControlOrMeta+z');
  await expect(description).not.toHaveValue('native input');
  expect((await current(request, project.id)).workflow.edges[0].condition).toBe('true');
  const position = await page.locator('.react-flow__edge[data-id="ab"] .react-flow__edge-interaction').evaluate((path: SVGPathElement) => {
    const point = path.getPointAtLength(path.getTotalLength() / 4), matrix = path.getScreenCTM();
    if (!matrix) throw new Error('连接没有画面坐标');
    return { x: point.x * matrix.a + point.y * matrix.c + matrix.e, y: point.x * matrix.b + point.y * matrix.d + matrix.f };
  });
  await page.mouse.click(position.x, position.y); await page.keyboard.press('Delete');
  await expect(page.locator('.react-flow__edge')).toHaveCount(0); await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await node(page, 'a').focus(); await page.keyboard.press('Control+z'); await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  expect((await rpc<{ items: unknown[] }>(request, 'run.list', { projectId: project.id })).items).toEqual([]);
});

test('keeps a rejected save recoverable and retries it without duplicating the edit command', async ({ page, request }) => {
  const project = await fixture(request, '流程保存失败与重试'); await open(page, project.title); await node(page, 'a').click();
  await page.getByLabel('提示词', { exact: true }).fill('保存失败后保留的提示词');
  let rejected = false;
  await page.route('**/__desktop_rpc', async route => {
    const body = route.request().postDataJSON();
    if (body.method === 'project.update' && body.params.projectId === project.id && !rejected) { rejected = true; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟保存失败' }) }); }
    else await route.continue();
  });
  await page.getByRole('button', { name: '保存流程', exact: true }).click();
  await expect(page.locator('.flow-inspector').getByRole('alert')).toContainText('编辑内容已保留');
  await expect(page.getByLabel('提示词', { exact: true })).toHaveValue('保存失败后保留的提示词');
  expect((await current(request, project.id)).workflow).toEqual(project.workflow);
  await save(page); expect((await current(request, project.id)).workflow.nodes[0].prompt).toBe('保存失败后保留的提示词');
  await history(page, '撤销'); await expect.poll(async () => (await current(request, project.id)).workflow.nodes[0].prompt).toBe('');
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled(); expect(rejected).toBe(true);
});

test('keeps unfinished shot fields reachable while retaining the workflow draft in the shared session', async ({ page, request }) => {
  const project = await fixture(request, '未完成镜头与流程草稿切换'); await open(page, project.title, false);
  await page.getByLabel('镜头标题', { exact: true }).fill('');
  await page.getByRole('button', { name: '流程', exact: true }).click(); await node(page, 'a').click();
  await page.getByLabel('步骤名称', { exact: true }).fill('保留的流程草稿');
  await page.getByRole('button', { name: '分镜', exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toBeVisible();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('');
  expect((await current(request, project.id)).workflow).toEqual(project.workflow);
  await page.getByLabel('镜头标题', { exact: true }).fill('修正后的镜头');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect.poll(async () => (await current(request, project.id)).workflow.nodes[0].label).toBe('保留的流程草稿');
  expect((await current(request, project.id)).shots[0].title).toBe('修正后的镜头');
  expect((await rpc<{ items: unknown[] }>(request, 'run.list', { projectId: project.id })).items).toEqual([]);
});
