import { expect, test, type APIRequestContext } from '@playwright/test';
import type { CharacterProfile, ProjectDocument, RunRecord, SeriesTemplate } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(payload.error).toBeUndefined(); return payload.result;
}

test('keeps paginated cards and scroll visible during background validation and applies refreshed records', async ({ page, request }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  const prefix = '页面缓存角色';
  const characters: CharacterProfile[] = [];
  for (let index = 0; index < 25; index++) characters.push(await rpc<CharacterProfile>(request, 'character.save', { character: { name: `${prefix} ${index + 1}`, description: '用于页面切换和分页缓存验收', referenceAssetIds: [] } }));
  await page.goto('/'); await page.getByRole('button', { name: '角色参考库', exact: true }).click();
  const cards = page.locator('.character-card').filter({ hasText: prefix });
  await expect(cards).toHaveCount(20);
  await page.getByRole('button', { name: '加载更多角色', exact: true }).click(); await expect(cards).toHaveCount(25);
  await page.locator('.page-body').evaluate(element => { element.scrollTop = 300; });
  const before = await page.locator('.page-body').evaluate(element => element.scrollTop);
  expect(before).toBeGreaterThan(0);
  const card = await cards.first().elementHandle();
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  await expect(page.getByRole('heading', { name: '模型连接', exact: true })).toBeVisible();
  expect(await card!.evaluate(element => element.isConnected)).toBe(true);
  await rpc(request, 'character.archive', { characterId: characters[0].id, revision: characters[0].revision });
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; }); let intercepted = 0;
  await page.route('**/__desktop_rpc', async route => { if (route.request().postDataJSON().method === 'character.list') { intercepted++; await pending; } await route.continue(); });
  try {
    await page.getByRole('button', { name: '角色参考库', exact: true }).click();
    await expect.poll(() => intercepted).toBeGreaterThan(0);
    await expect(cards).toHaveCount(25);
    expect(await page.locator('.page-body').evaluate(element => element.scrollTop)).toBeCloseTo(before, 0);
    release?.(); await expect(cards).toHaveCount(24);
    await expect(page.getByRole('heading', { name: characters[0].name, exact: true })).toHaveCount(0);
  } finally { release?.(); }
});

test('keeps the current page visible while a lazy page loads and honors the latest navigation', async ({ page }) => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; }); let intercepted = 0;
  await page.route(/\/(?:src\/features\/SeriesTemplatesPage\.tsx|assets\/SeriesTemplatesPage-[^/?]+\.js)(?:\?|$)/, async route => { intercepted++; await pending; await route.continue(); });
  try {
    await page.goto('/'); await page.getByRole('button', { name: '模型连接', exact: true }).click();
    await page.getByRole('button', { name: '系列模板', exact: true }).click();
    await expect.poll(() => intercepted).toBeGreaterThan(0);
    await expect(page.getByRole('heading', { name: '模型连接', exact: true })).toBeVisible();
    await expect(page.getByText('正在打开页面…', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '素材库', exact: true }).click();
    await expect(page.getByRole('heading', { name: '素材库', exact: true })).toBeVisible();
    release?.();
    await page.getByRole('button', { name: '系列模板', exact: true }).click();
    await expect(page.getByRole('heading', { name: '系列模板', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '模型连接', exact: true }).click();
    await page.getByRole('button', { name: '系列模板', exact: true }).click();
    await expect(page.getByRole('heading', { name: '系列模板', exact: true })).toBeVisible();
    expect(intercepted).toBe(1);
  } finally { release?.(); }
});

test('preserves project filtering and editor selection and undo while pausing the hidden editor', async ({ page, request }) => {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: '页面缓存编辑验收' });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [1, 2].map(index => ({ id: `cache-shot-${index}`, title: `缓存镜头 ${index}`, narration: '', visualPrompt: '', durationUs: 3_000_000 })) } });
  await page.goto('/'); await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.getByLabel('搜索项目', { exact: true }).fill(project.title);
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await expect(page.getByLabel('搜索项目', { exact: true })).toHaveValue(project.title);
  await page.locator('.project-card').filter({ hasText: project.title }).getByRole('button', { name: '继续创作', exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('缓存镜头 1');
  await page.locator('.outline-shot').filter({ hasText: '缓存镜头 2' }).click();
  await page.getByLabel('镜头标题', { exact: true }).fill('保留的镜头修改');
  await page.getByRole('button', { name: '保存镜头', exact: true }).click();
  await page.getByRole('button', { name: '播放预览', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停预览', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const editor = await page.locator('.workbench').elementHandle();
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  await expect(page.getByRole('heading', { name: '模型连接', exact: true })).toBeVisible();
  expect(await editor!.evaluate(element => element.isConnected)).toBe(true);
  await expect(page.locator('.workbench button[aria-label="播放预览"]')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('ControlOrMeta+z');
  await page.getByRole('button', { name: '创作工作台', exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('保留的镜头修改');
  await expect(page.getByRole('button', { name: '播放预览', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('缓存镜头 2');
});

test('resets a canceled template read after navigation and ignores its late result', async ({ page, request }) => {
  const template = await rpc<SeriesTemplate>(request, 'seriesTemplate.save', { template: { name: '页面缓存模板读取验收', description: '', settings: { style: '', captionStyle: null, scenePreset: null } } });
  await page.goto('/'); await page.getByRole('button', { name: '系列模板', exact: true }).click();
  const card = page.locator('.series-template-card').filter({ hasText: template.name });
  const edit = card.getByRole('button', { name: '编辑系列模板', exact: true });
  await expect(edit).toBeEnabled();
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; }); let intercepted = 0;
  await page.route('**/__desktop_rpc', async route => { if (route.request().postDataJSON().method === 'seriesTemplate.get' && intercepted++ === 0) await pending; await route.continue(); });
  try {
    await edit.click(); await expect(edit).toBeDisabled();
    await page.getByRole('button', { name: '模型连接', exact: true }).click();
    await expect(page.getByRole('heading', { name: '模型连接', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '系列模板', exact: true }).click();
    await expect(edit).toBeEnabled();
    const response = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON().method === 'seriesTemplate.get');
    release?.(); await (await response).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await edit.click();
    await expect(page.getByRole('dialog', { name: '编辑系列模板', exact: true }).getByLabel('系列模板名称', { exact: true })).toHaveValue(template.name);
  } finally { release?.(); }
});

test('reports voice task errors while the workbench is hidden without replaying them on navigation', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: '配音任务切页提示验收' });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
    shots: [{ id: 'voice-shot', title: '待配音镜头', narration: '没有导入配音的镜头', visualPrompt: '', durationUs: 3_000_000 }],
    workflow: { id: 'voice-flow', name: '配音提示验收', version: 1, nodes: [{ id: 'voice', kind: 'voice', label: '配音与字幕', position: { x: 0, y: 0 } }], edges: [] },
  } });
  const pageRunMutations: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc') && request.method() === 'POST') { const method = request.postDataJSON().method; if (/^run\.(start|resume|review|cancel)$/.test(method)) pageRunMutations.push(method); } });
  await page.goto('/'); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('待配音镜头');
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  await expect(page.getByRole('heading', { name: '模型连接', exact: true })).toBeVisible();
  const run = await rpc<RunRecord>(request, 'run.start', { projectId: project.id, nodeId: 'voice' });
  const message = '请为每个镜头导入配音素材，或为此步骤选择模型';
  await expect(page.locator('.toast[role="alert"]')).toContainText(message);
  await expect.poll(async () => (await rpc<RunRecord>(request, 'run.get', { runId: run.id })).status).toBe('needs_attention');
  await page.getByRole('button', { name: '关闭提示', exact: true }).click(); await expect(page.locator('.toast-anchor')).toHaveCount(0);
  for (const destination of ['模型连接', '素材库']) {
    await page.getByRole('button', { name: destination, exact: true }).click();
    await expect(page.getByRole('heading', { name: destination, exact: true })).toBeVisible();
    await page.getByRole('button', { name: '创作工作台', exact: true }).click();
    await expect(page.getByLabel('镜头标题', { exact: true })).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.waitForTimeout(250);
    await expect(page.locator('.toast-anchor')).toHaveCount(0);
  }
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  await expect(page.getByRole('heading', { name: '模型连接', exact: true })).toBeVisible();
  await rpc(request, 'run.resume', { runId: run.id });
  await expect(page.locator('.toast[role="alert"]')).toContainText(message);
  await page.getByRole('button', { name: '关闭提示', exact: true }).click(); await expect(page.locator('.toast-anchor')).toHaveCount(0);
  await page.getByRole('button', { name: '创作工作台', exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  await expect(page.locator('.toast-anchor')).toHaveCount(0);
  expect(pageRunMutations).toEqual([]);
});
