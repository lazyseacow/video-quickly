import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { test } from './isolated-workspace';
import { modelCatalog } from './model-catalog';
import { modelSchema, workflowNodeSchema, type ProjectDocument, type WorkflowNode } from '@video-quickly/contracts';
import { DocumentStore, openDatabase } from '../../packages/runtime/src/database';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const result = await response.json(); expect(response.ok()).toBe(true); expect(result.error).toBeUndefined(); return result.result;
}
async function fixture(request: APIRequestContext, nodes: Array<Pick<WorkflowNode, 'id' | 'kind' | 'label'> & Partial<WorkflowNode>> = [{ id: 'script', kind: 'script', label: '本地脚本' }]) {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `制作检查 ${randomUUID().slice(0, 8)}` });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
    shots: [{ id: 'shot', title: '检查镜头', narration: '本地旁白', visualPrompt: '', durationUs: 1_000_000 }],
    workflow: { ...created.workflow, nodes, edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, source: nodes[index].id, target: node.id })) },
  } });
  return project;
}
async function current(request: APIRequestContext, id: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: id })).project; }
async function open(page: Page, project: ProjectDocument) {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/');
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
  await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(project.title);
}
function gate() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
let errors: string[], expectedMissingMedia: Set<string>;
test.beforeEach(async ({ page, baseURL }) => {
  errors = []; expectedMissingMedia = new Set(); page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => {
    if (entry.type() !== 'error') return;
    if (entry.text().startsWith('Failed to load resource: the server responded with a status of 404')) {
      try {
        const url = new URL(entry.location().url);
        if (url.origin === baseURL && url.pathname === '/__desktop_asset' && url.searchParams.size === 1 && expectedMissingMedia.has(url.searchParams.get('path') ?? '')) return;
      } catch { /* A missing module or unrecognized diagnostic remains an error. */ }
    }
    errors.push(entry.text());
  });
});
test.afterEach(async ({ page }) => { expect(errors).toEqual([]); await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0); });

test('checks saved content without submitting or saving a dirty draft, preserving history, focus and narrow layouts', async ({ page, request }, info) => {
  const project = await fixture(request); await open(page, project);
  const methods: string[] = []; page.on('request', value => { if (value.url().endsWith('/__desktop_rpc')) methods.push(value.postDataJSON().method); });
  const title = page.getByLabel('项目名称', { exact: true }); await title.fill(`${project.title} 草稿`);
  const check = page.getByRole('button', { name: '制作前检查', exact: true }); await check.click();
  let dialog = page.getByRole('dialog', { name: '制作前检查', exact: true });
  await expect(dialog.getByText('本地检查通过。', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('当前有未保存的修改'); await expect(dialog).toContainText('供应商连通性和计费状态需单独验证');
  expect(await current(request, project.id)).toMatchObject({ revision: project.revision, title: project.title });
  expect(methods.filter(method => ['run.start', 'project.update', 'shot.regenerate'].includes(method))).toEqual([]);
  await page.screenshot({ path: info.outputPath('readiness-dark-1536.png') });
  await dialog.getByRole('button', { name: '返回保存修改', exact: true }).click(); await expect(check).toBeFocused();
  await expect(title).toHaveValue(`${project.title} 草稿`); await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(title).toHaveValue(project.title);
  await page.getByRole('button', { name: '重做', exact: true }).click(); await expect(title).toHaveValue(`${project.title} 草稿`);
  // Redo from the saved baseline intentionally saves a new revision; checking must not save another one.
  await expect.poll(async () => (await current(request, project.id)).title).toBe(`${project.title} 草稿`);
  const afterHistory = await current(request, project.id); methods.length = 0;
  await page.getByRole('button', { name: '浅色外观', exact: true }).click(); await page.setViewportSize({ width: 600, height: 900 });
  await check.click(); dialog = page.getByRole('dialog', { name: '制作前检查', exact: true });
  await expect(dialog.getByText('本地检查通过。', { exact: true })).toBeVisible();
  const box = await dialog.locator('.dialog__surface').boundingBox(); expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(601);
  await page.screenshot({ path: info.outputPath('readiness-light-600.png') });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(check).toBeFocused();
  expect((await current(request, project.id)).revision).toBe(afterHistory.revision);
  expect(methods.filter(method => ['run.start', 'project.update', 'shot.regenerate'].includes(method))).toEqual([]);
});

test('aggregates blockers and repairs the exact step, model and project media without generating', async ({ page, request }) => {
  const catalog = await modelCatalog(['fixture']);
  try {
  let project = await fixture(request, [{ id: 'bad-script', kind: 'script', label: '需要文本的脚本', modelId: 'readiness-image' }, { id: 'bad-image', kind: 'assets', label: '需要修正参数的画面', modelId: 'readiness-invalid' }, { id: 'export', kind: 'export', label: '本地导出' }]);
  const workspace = await rpc<{ system: { dataDirectory: string } }>(request, 'workspace.summary');
  const database = openDatabase(workspace.system.dataDirectory), store = new DocumentStore(database);
  const missingPath = join(workspace.system.dataDirectory, 'assets', `${project.id}-missing.png`); expectedMissingMedia.add(missingPath);
  try {
    for (const [id, name, parameters] of [['readiness-image', '检查图片连接', {}], ['readiness-invalid', '检查参数连接', { size: 'invalid-size' }]] as const) store.put('model', id, modelSchema.parse({ id, name, provider: 'openai-compatible', baseUrl: catalog.baseUrl, model: 'fixture', capabilities: ['image'], parameters, createdAt: '', updatedAt: '' }));
    store.put('asset', 'readiness-missing', { id: 'readiness-missing', name: '检查缺失画面', kind: 'image', path: missingPath, mimeType: 'image/png', projectId: project.id, shotId: 'shot', size: 1, sha256: createHash('sha256').update('x').digest('hex'), version: 1, createdAt: '', provenance: 'fixture', retained: false, active: true });
  } finally { database.close(); }
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ ...project.shots[0], assetId: 'readiness-missing' }] } });
  await open(page, project);
  const methods: string[] = []; page.on('request', value => { if (value.url().endsWith('/__desktop_rpc')) methods.push(value.postDataJSON().method); });
  const check = page.getByRole('button', { name: '制作前检查', exact: true });
  await check.click(); let dialog = page.getByRole('dialog', { name: '制作前检查', exact: true });
  const issues = dialog.getByRole('list', { name: '制作检查结果', exact: true });
  await expect(issues).toContainText('需要文本的脚本'); await expect(issues).toContainText('需要修正参数的画面'); await expect(issues).toContainText('检查缺失画面');
  await issues.locator('li').filter({ hasText: '需要文本的脚本' }).getByRole('button', { name: '调整步骤', exact: true }).click();
  const step = page.getByRole('dialog', { name: '需要文本的脚本', exact: true }); await expect(step.getByLabel('使用模型', { exact: true })).toHaveValue('readiness-image'); await step.getByRole('button', { name: '取消', exact: true }).click();
  await check.click(); dialog = page.getByRole('dialog', { name: '制作前检查', exact: true });
  await dialog.locator('li').filter({ hasText: '需要修正参数的画面' }).getByRole('button', { name: '配置模型', exact: true }).click();
  const model = page.getByRole('dialog', { name: '编辑模型连接', exact: true }); await expect(model).toBeVisible(); await expect(model.getByLabel('连接名称', { exact: true })).toHaveValue('检查参数连接');
  await expect(model.getByLabel('模型 ID', { exact: true })).toHaveValue('fixture');
  await expect(model.getByRole('option', { name: 'fixture', exact: true })).toHaveCount(1);
  await model.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '创作工作台', exact: true }).click(); await check.click();
  dialog = page.getByRole('dialog', { name: '制作前检查', exact: true });
  await dialog.locator('li').filter({ hasText: '检查缺失画面' }).getByRole('button', { name: '修复素材', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '恢复缺失素材', exact: true })).toBeVisible();
  expect(methods.filter(method => ['run.start', 'model.test', 'shot.regenerate', 'project.update'].includes(method))).toEqual([]);
  } finally { await catalog.close(); }
});

test('marks reports stale, refreshes explicitly and isolates a late result after closing and switching projects', async ({ page, request }) => {
  let first = await fixture(request); const second = await fixture(request, [{ id: 'agent', kind: 'agent', label: '另一个项目的Agent' }]);
  await open(page, first);
  const reads: Array<{ projectId: string; requestId: string }> = [], cancels: Array<{ projectId: string; requestId: string }> = [];
  page.on('request', value => { if (value.url().endsWith('/__desktop_rpc')) { const input = value.postDataJSON(); if (input.method === 'project.readiness') reads.push(input.params); if (input.method === 'project.readiness.cancel') cancels.push(input.params); } });
  await page.getByRole('button', { name: '制作前检查', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '制作前检查', exact: true }); await expect(dialog.getByText('本地检查通过。', { exact: true })).toBeVisible();
  const before = reads.length;
  first = await rpc<ProjectDocument>(request, 'project.update', { projectId: first.id, revision: first.revision, patch: { brief: '外部修订后仅标记检查过期' } });
  await expect(dialog).toContainText('工作区在检查后有更新'); expect(reads).toHaveLength(before);
  await dialog.getByRole('button', { name: '重新检查', exact: true }).click(); await expect(dialog.getByText('工作区在检查后有更新', { exact: false })).toHaveCount(0); expect(reads).toHaveLength(before + 1);
  const held = gate(), release = gate(); let captured: { projectId: string; requestId: string } | undefined;
  await page.route('**/__desktop_rpc', async route => {
    const input = route.request().postDataJSON();
    if (!captured && input.method === 'project.readiness' && input.params.projectId === first.id) { captured = input.params; const response = await route.fetch(); held.release(); await release.promise; await route.fulfill({ response }); return; }
    await route.continue();
  });
  try {
    await dialog.getByRole('button', { name: '重新检查', exact: true }).click(); await held.promise;
    await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await expect.poll(() => cancels).toEqual([captured]);
    await page.getByRole('button', { name: `打开项目：${second.title}`, exact: true }).click(); await page.getByRole('button', { name: '制作前检查', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '制作前检查', exact: true }); await expect(dialog.getByRole('list', { name: '制作检查结果', exact: true })).toContainText('另一个项目的Agent');
    const late = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.params?.requestId === captured?.requestId);
    release.release(); await (await late).finished();
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await expect(dialog.getByRole('list', { name: '制作检查结果', exact: true })).toContainText('另一个项目的Agent'); await expect(dialog.getByText('本地检查通过。', { exact: true })).toHaveCount(0);
  } finally { release.release(); await page.unrouteAll({ behavior: 'wait' }); }
});

for (const prefixIsSubflow of [false, true]) test(`locates a fixed subflow owner with a ${prefixIsSubflow ? 'subflow' : 'brief'} ID prefix without saving its expanded child`, async ({ page, request }) => {
  let project = await fixture(request);
  const child = workflowNodeSchema.parse({ id: 'child:script', kind: 'script', label: '固定版本内的脚本', modelId: 'missing-child-model' });
  const owner = workflowNodeSchema.parse({ id: 'a/subflow/b', kind: 'subflow', label: '需检查的固定子流程', subflow: { id: 'pinned', version: 1, inputs: {} } });
  const prefix = workflowNodeSchema.parse({ id: 'a', kind: prefixIsSubflow ? 'subflow' : 'brief', label: '同前缀的其他步骤', ...(prefixIsSubflow ? { subflow: { id: 'prefix', version: 1, inputs: {} } } : {}) });
  const definitions = [{ id: 'pinned', name: '固定流程', version: 1, inputs: [], outputs: [], nodes: [child], edges: [] }, ...(prefixIsSubflow ? [{ id: 'prefix', name: '同前缀的其他子流程', version: 1, inputs: [], outputs: [], nodes: [workflowNodeSchema.parse({ id: 'unrelated', kind: 'brief', label: '无关内部步骤' })], edges: [] }] : [])];
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, nodes: [prefix, owner], edges: [], subflows: definitions } } });
  await open(page, project); await page.getByRole('button', { name: '制作前检查', exact: true }).click();
  const report = page.getByRole('dialog', { name: '制作前检查', exact: true });
  await report.locator('li').filter({ hasText: '固定版本内的脚本' }).getByRole('button', { name: '调整步骤', exact: true }).click();
  const step = page.getByRole('dialog', { name: owner.label, exact: true }); await expect(step).toBeVisible(); await expect(step).toContainText('需处理的内部步骤：固定版本内的脚本'); await expect(step).toContainText('固定版本子流程');
  await step.getByRole('button', { name: '取消', exact: true }).click();
  expect(await current(request, project.id)).toMatchObject({ revision: project.revision, workflow: project.workflow });
});
