import { openProjectFromList } from './workspace-navigation';
import { setWorkspaceTheme } from './workspace-settings';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { test } from './isolated-workspace';
import { modelCatalog } from './model-catalog';
import { exportBatchSchema, modelSchema, workflowNodeSchema, type CharacterProfile, type ProjectDocument, type WorkflowNode } from '@video-quickly/contracts';
import { DocumentStore, openDatabase } from '../../packages/runtime/src/database';
import { importSkillFixture } from '../fixtures/import-skill';

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
  await openProjectFromList(page, project.title);
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(project.title);
}
async function openCheck(page: Page) {
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '制作前检查', exact: true }).click();
  return page.getByRole('dialog', { name: '制作前检查', exact: true });
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
  const more = page.getByRole('button', { name: '更多', exact: true });
  const check = page.getByRole('button', { name: '制作前检查', exact: true });
  await expect(check).toHaveCount(0);
  await more.press('Enter');
  await expect(check).toBeVisible(); await page.keyboard.press('Tab'); await expect(check).toBeFocused();
  await page.screenshot({ path: info.outputPath('more-actions-dark-1536.png') });
  await page.keyboard.press('Escape'); await expect(check).toHaveCount(0); await expect(more).toBeFocused();
  await more.press('Space'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  let dialog = page.getByRole('dialog', { name: '制作前检查', exact: true });
  await expect(dialog.getByText('本地检查通过。', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('当前有未保存的修改'); await expect(dialog).toContainText('供应商连通性和计费状态需单独验证');
  expect(await current(request, project.id)).toMatchObject({ revision: project.revision, title: project.title });
  expect(methods.filter(method => ['run.start', 'project.update', 'shot.regenerate'].includes(method))).toEqual([]);
  await page.screenshot({ path: info.outputPath('readiness-dark-1536.png') });
  await dialog.getByRole('button', { name: '返回保存修改', exact: true }).click(); await expect(more).toBeFocused();
  await expect(title).toHaveValue(`${project.title} 草稿`); await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(title).toHaveValue(project.title);
  await page.getByRole('button', { name: '重做', exact: true }).click(); await expect(title).toHaveValue(`${project.title} 草稿`);
  // Redo from the saved baseline intentionally saves a new revision; checking must not save another one.
  await expect.poll(async () => (await current(request, project.id)).title).toBe(`${project.title} 草稿`);
  const afterHistory = await current(request, project.id); methods.length = 0;
  await setWorkspaceTheme(page, 'light'); await page.setViewportSize({ width: 600, height: 900 });
  dialog = await openCheck(page);
  await expect(dialog.getByText('本地检查通过。', { exact: true })).toBeVisible();
  const box = await dialog.locator('.dialog__surface').boundingBox(); expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(601);
  await page.screenshot({ path: info.outputPath('readiness-light-600.png') });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(more).toBeFocused();
  expect((await current(request, project.id)).revision).toBe(afterHistory.revision);
  expect(methods.filter(method => ['run.start', 'project.update', 'shot.regenerate'].includes(method))).toEqual([]);
});

test('opens the interrupted export batch directly from production checks', async ({ page, request, isolatedWorkspace }) => {
  const project = await fixture(request);
  const timestamp = new Date().toISOString();
  const batch = exportBatchSchema.parse({
    id: 'interrupted-batch', projectId: project.id, projectRevision: project.revision, revision: 1, status: 'interrupted',
    targets: [{ id: 'wide', label: '横屏', profile: project.profile, status: 'interrupted' }],
    createdAt: timestamp, updatedAt: timestamp,
  });
  const database = openDatabase(isolatedWorkspace.directory);
  try {
    const store = new DocumentStore(database);
    store.put('export-batch', batch.id, batch);
    store.put('export-batch', 'previous-batch', { ...batch, id: 'previous-batch', status: 'canceled' });
  } finally { database.close(); }
  await page.addInitScript(id => localStorage.setItem(`vq-export-batch:${id}`, 'previous-batch'), project.id);
  await open(page, project);
  const check = await openCheck(page);
  await check.getByRole('button', { name: '查看批量导出', exact: true }).click();
  await expect(check).toHaveCount(0);
  const exports = page.getByRole('dialog', { name: '多比例批量导出', exact: true });
  await expect(exports.getByRole('tab', { name: '导出记录', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(exports.getByRole('combobox', { name: '批量导出记录', exact: true })).toHaveValue(batch.id);
  await expect(exports.getByRole('button', { name: '继续未完成导出', exact: true })).toBeEnabled();
});

test('opens the role view of the asset library from a character readiness issue', async ({ page, request, isolatedWorkspace }) => {
  const initial = await fixture(request);
  const role = await rpc<CharacterProfile>(request, 'character.save', { character: { name: '旧项目归档角色', description: '', referenceAssetIds: [] } });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: initial.id, revision: initial.revision,
    patch: { shots: [{ ...initial.shots[0], characterIds: [role.id] }] },
  });
  const database = openDatabase(isolatedWorkspace.directory);
  try { new DocumentStore(database).put('character', role.id, { ...role, archived: true }); }
  finally { database.close(); }

  await open(page, project);
  const check = await openCheck(page);
  await expect(check.getByText('角色「旧项目归档角色」已归档。', { exact: true })).toBeVisible();
  await check.getByRole('button', { name: '查看角色', exact: true }).click();
  await expect(check).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '素材库', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '角色', exact: true })).toHaveAttribute('aria-selected', 'true');
  const roleView = page.getByRole('tabpanel', { name: '角色', exact: true });
  await roleView.getByRole('button', { name: '已归档', exact: true }).click();
  await expect(roleView.getByRole('heading', { name: role.name, exact: true })).toBeVisible();
});

test('blocks production and opens the exact step, model and media repairs', async ({ page, request }, info) => {
  const catalog = await modelCatalog(['fixture']);
  try {
  let project = await fixture(request, [{ id: 'bad-script', kind: 'script', label: '需要文本的脚本', modelId: 'readiness-image' }, { id: 'bad-image', kind: 'assets', label: '需要修正参数的画面', modelId: 'readiness-invalid' }, { id: 'export', kind: 'export', label: '本地导出' }]);
  const workspace = await rpc<{ system: { dataDirectory: string } }>(request, 'workspace.summary');
  const database = openDatabase(workspace.system.dataDirectory), store = new DocumentStore(database);
  const missingPath = join(workspace.system.dataDirectory, 'assets', `${project.id}-missing.png`); expectedMissingMedia.add(missingPath);
  try {
    for (const [id, name, parameters] of [['readiness-image', '检查图片连接', {}], ['readiness-invalid', '检查参数连接', { size: 'invalid-size' }]] as const) store.put('model', id, modelSchema.parse({ id, name, provider: 'openai-compatible', baseUrl: catalog.baseUrl, model: 'fixture', connectionType: 'image', capabilities: ['image'], parameters, createdAt: '', updatedAt: '' }));
    store.put('model', 'readiness-text', modelSchema.parse({ id: 'readiness-text', name: '可用文本连接', provider: 'openai-compatible', baseUrl: catalog.baseUrl, model: 'fixture', connectionType: 'text', capabilities: ['text'], createdAt: '', updatedAt: '' }));
    store.put('asset', 'readiness-missing', { id: 'readiness-missing', name: '检查缺失画面', kind: 'image', path: missingPath, mimeType: 'image/png', projectId: project.id, shotId: 'shot', size: 1, sha256: createHash('sha256').update('x').digest('hex'), version: 1, createdAt: '', provenance: 'fixture', retained: false, active: true });
  } finally { database.close(); }
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ ...project.shots[0], assetId: 'readiness-missing', locked: true }] } });
  await open(page, project);
  const methods: string[] = []; page.on('request', value => { if (value.url().endsWith('/__desktop_rpc')) methods.push(value.postDataJSON().method); });
  const start = page.getByRole('button', { name: '开始制作', exact: true });
  await start.click(); const dialog = page.getByRole('dialog', { name: '暂无法开始制作', exact: true });
  const issues = dialog.getByRole('list', { name: '制作检查结果', exact: true });
  await expect(issues).toContainText('需要文本的脚本'); await expect(issues).toContainText('需要修正参数的画面'); await expect(issues).toContainText('检查缺失画面');
  await expect(dialog.locator('.readiness-summary')).toHaveCount(0);
  const adjust = issues.getByRole('listitem').filter({ hasText: '需要文本的脚本' }).getByRole('button', { name: '调整步骤', exact: true });
  await expect(adjust).toBeFocused();
  await page.screenshot({ path: info.outputPath('production-blockers-dark-1536.png') });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(start).toBeFocused();
  await start.click(); await adjust.click();
  const step = page.getByRole('dialog', { name: '需要文本的脚本', exact: true });
  await expect(step.locator('.dialog__footer').getByRole('button')).toHaveText(['取消', '保存']);
  const modelControl = step.getByLabel('使用模型', { exact: true }); await expect(modelControl).toHaveValue('readiness-image');
  await modelControl.selectOption('readiness-text'); await step.getByRole('button', { name: '保存', exact: true }).click();
  await expect(step).toHaveCount(0);
  await start.click(); await expect(issues).toContainText('需要修正参数的画面'); await expect(issues).not.toContainText('需要文本的脚本');
  await dialog.locator('li').filter({ hasText: '需要修正参数的画面' }).getByRole('button', { name: '配置模型', exact: true }).click();
  const model = page.getByRole('dialog', { name: '编辑模型连接', exact: true }); await expect(model).toBeVisible(); await expect(model.getByLabel('连接名称', { exact: true })).toHaveValue('检查参数连接');
  await expect(model.getByLabel('模型 ID', { exact: true })).toHaveValue('fixture');
  await model.getByLabel('模型 ID', { exact: true }).click();
  await expect(model.getByRole('option', { name: 'fixture', exact: true })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await model.getByRole('button', { name: '取消', exact: true }).click();
  await openProjectFromList(page); await start.click();
  await dialog.locator('li').filter({ hasText: '检查缺失画面' }).getByRole('button', { name: '修复素材', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '恢复缺失素材', exact: true })).toBeVisible();
  expect(methods.filter(method => ['run.start', 'model.test', 'shot.regenerate', 'project.update'].includes(method))).toEqual(['project.update']);
  } finally { await catalog.close(); }
});

test('shows and saves Skills inline in the export step editor', async ({ page, request }, info) => {
  const directory = info.outputPath('export-skills');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), '---\nname: export-checklist\ndescription: 导出前核对画面、声音和字幕。\n---\n按项目规格检查成片。');
  const { group, skills } = await importSkillFixture((method, params) => rpc(request, method, params), { path: directory });
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: '导出步骤 Skill 验收' });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
    workflow: { ...created.workflow, nodes: [{ id: 'export', kind: 'export', label: '导出成片' }], edges: [], stages: undefined },
  } });
  await open(page, project);
  const readiness = await openCheck(page);
  await readiness.getByRole('listitem').filter({ hasText: '当前没有可导出的镜头。' }).getByRole('button', { name: '调整步骤', exact: true }).click();
  const step = page.getByRole('dialog', { name: '导出成片', exact: true });
  const picker = step.getByRole('group', { name: '应用 Skill', exact: true });
  const trigger = picker.getByRole('button', { name: '应用 Skill', exact: true });
  const search = picker.getByRole('searchbox', { name: '搜索 Skill 或分组', exact: true });
  await trigger.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(search).toBeFocused();
  const groupTrigger = picker.getByRole('button', { name: new RegExp(`^${group.name}`) });
  await groupTrigger.press('Enter');
  await expect(groupTrigger).toHaveAttribute('aria-expanded', 'true');
  await picker.getByRole('list', { name: `${group.name}中的 Skill`, exact: true }).getByRole('checkbox', { name: /^export-checklist/ }).check();
  await expect(trigger).toContainText('已选 1 个');
  const save = step.getByRole('button', { name: '保存', exact: true });
  for (const width of [1536, 390]) {
    await page.setViewportSize({ width, height: 720 });
    await expect(picker).toBeInViewport({ ratio: 1 });
    await expect(save).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`export-step-skills-${width}.png`) });
  }
  await save.click();
  await expect(step).toHaveCount(0);
  expect((await current(request, project.id)).workflow.nodes.find(node => node.id === 'export')?.skillIds).toEqual([skills[0].id]);
});

test('marks reports stale, refreshes explicitly and isolates a late result after closing and switching projects', async ({ page, request }) => {
  let first = await fixture(request); const second = await fixture(request, [{ id: 'agent', kind: 'agent', label: '另一个项目的Agent' }]);
  await open(page, first);
  const reads: Array<{ projectId: string; requestId: string }> = [], cancels: Array<{ projectId: string; requestId: string }> = [];
  page.on('request', value => { if (value.url().endsWith('/__desktop_rpc')) { const input = value.postDataJSON(); if (input.method === 'project.readiness') reads.push(input.params); if (input.method === 'project.readiness.cancel') cancels.push(input.params); } });
  let dialog = await openCheck(page); await expect(dialog.getByText('本地检查通过。', { exact: true })).toBeVisible();
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
    await openProjectFromList(page, second.title);
    dialog = await openCheck(page); await expect(dialog.getByRole('list', { name: '制作检查结果', exact: true })).toContainText('另一个项目的Agent');
    const late = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.params?.requestId === captured?.requestId);
    release.release(); await (await late).finished();
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await expect(dialog.getByRole('list', { name: '制作检查结果', exact: true })).toContainText('另一个项目的Agent'); await expect(dialog.getByText('本地检查通过。', { exact: true })).toHaveCount(0);
  } finally { release.release(); await page.unrouteAll({ behavior: 'wait' }); }
});

for (const change of ['edit', 'leave'] as const) test(`discards a pending start check when the user changes course by ${change === 'edit' ? 'editing the draft' : 'leaving the workbench'}`, async ({ page, request }) => {
  const project = await fixture(request), checked = gate(), release = gate();
  let requestId: string | undefined, starts = 0;
  const cancels: string[] = [];
  page.on('request', value => {
    if (!value.url().endsWith('/__desktop_rpc')) return;
    const input = value.postDataJSON();
    if (input.method === 'run.start') starts++;
    if (input.method === 'project.readiness.cancel') cancels.push(input.params.requestId);
  });
  await page.route('**/__desktop_rpc', async route => {
    const input = route.request().postDataJSON();
    if (input.method !== 'project.readiness' || requestId) { await route.continue(); return; }
    requestId = input.params.requestId;
    const response = await route.fetch(); checked.release(); await release.promise;
    await route.fulfill({ response });
  });
  try {
    await open(page, project);
    const start = page.getByRole('button', { name: '开始制作', exact: true });
    const title = page.getByLabel('项目名称', { exact: true });
    await start.click(); await checked.promise;
    await expect(page.getByRole('button', { name: '正在检查', exact: true })).toBeDisabled();
    if (change === 'edit') await title.fill(`${project.title} 检查期间编辑`);
    else {
      await page.getByRole('button', { name: '我的项目', exact: true }).click();
      await expect.poll(() => cancels).toEqual([requestId]);
    }
    const completed = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'project.readiness' && response.request().postDataJSON()?.params?.requestId === requestId);
    release.release(); await (await completed).finished();
    if (change === 'edit') {
      await expect(page.getByText('检查期间项目内容已变化，请再次点击开始制作。', { exact: true })).toBeVisible();
      await expect(title).toHaveValue(`${project.title} 检查期间编辑`);
    } else await openProjectFromList(page, project.title);
    await expect(start).toBeEnabled();
    expect(starts).toBe(0); expect((await current(request, project.id)).revision).toBe(project.revision);
    await expect(page.getByRole('dialog', { name: '暂无法开始制作', exact: true })).toHaveCount(0);
  } finally { release.release(); await page.unrouteAll({ behavior: 'wait' }); }
});

for (const prefixIsSubflow of [false, true]) test(`locates a fixed subflow owner with a ${prefixIsSubflow ? 'subflow' : 'brief'} ID prefix without saving its expanded child`, async ({ page, request }) => {
  let project = await fixture(request);
  const child = workflowNodeSchema.parse({ id: 'child:script', kind: 'script', label: '固定版本内的脚本', modelId: 'missing-child-model' });
  const owner = workflowNodeSchema.parse({ id: 'a/subflow/b', kind: 'subflow', label: '需检查的固定子流程', subflow: { id: 'pinned', version: 1, inputs: {} } });
  const prefix = workflowNodeSchema.parse({ id: 'a', kind: prefixIsSubflow ? 'subflow' : 'brief', label: '同前缀的其他步骤', ...(prefixIsSubflow ? { subflow: { id: 'prefix', version: 1, inputs: {} } } : {}) });
  const definitions = [{ id: 'pinned', name: '固定流程', version: 1, inputs: [], outputs: [], nodes: [child], edges: [] }, ...(prefixIsSubflow ? [{ id: 'prefix', name: '同前缀的其他子流程', version: 1, inputs: [], outputs: [], nodes: [workflowNodeSchema.parse({ id: 'unrelated', kind: 'brief', label: '无关内部步骤' })], edges: [] }] : [])];
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, nodes: [prefix, owner], edges: [], subflows: definitions } } });
  await open(page, project); const report = await openCheck(page);
  await report.locator('li').filter({ hasText: '固定版本内的脚本' }).getByRole('button', { name: '调整步骤', exact: true }).click();
  const step = page.getByRole('dialog', { name: owner.label, exact: true }); await expect(step).toBeVisible(); await expect(step).toContainText('需处理的内部步骤：固定版本内的脚本'); await expect(step).toContainText('固定版本子流程');
  await step.getByRole('button', { name: '取消', exact: true }).click();
  expect(await current(request, project.id)).toMatchObject({ revision: project.revision, workflow: project.workflow });
});
