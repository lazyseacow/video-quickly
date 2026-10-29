import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

test('preserves a draft across disconnect and reconnect without retrying a mutation', async ({ page, request }) => {
  const created = await request.post('/__desktop_rpc', { data: { method: 'project.create', params: { title: '执行组件重连验收' } } });
  const project = (await created.json()).result;
  await request.post('/__desktop_rpc', { data: { method: 'project.saveShot', params: { projectId: project.id, shot: { id: 'reconnect-shot', title: '重连验证', narration: '', visualPrompt: '', durationUs: 1_000_000 } } } });
  await page.goto('/');
  await page.getByRole('button', { name: '打开项目：执行组件重连验收', exact: true }).click();
  await expect(page.getByLabel('镜头标题')).toBeVisible();
  await page.getByLabel('镜头标题').fill('重连后保留的编辑草稿');
  let offline = true; let mutations = 0; let reconnects = 0;
  await page.route('**/__desktop_rpc', async route => {
    const body = route.request().postDataJSON();
    if (body.method === 'project.saveShot') { mutations++; if (offline) { await route.abort('failed'); return; } }
    if (body.method === 'runtime.reconnect') {
      reconnects++;
      if (reconnects === 1) { await route.fulfill({ status: 400, json: { error: '执行组件启动失败，请重试。' } }); return; }
    }
    await route.continue();
  });
  await page.getByRole('button', { name: '保存镜头', exact: true }).click();
  await expect(page.getByText('本地执行组件已断开', { exact: true })).toBeVisible();
  await expect(page.getByLabel('镜头标题')).toHaveValue('重连后保留的编辑草稿');
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect(page.getByText('执行组件启动失败，请重试。', { exact: true })).toBeVisible();
  offline = false;
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect(page.locator('.runtime-connection-notice')).toHaveCount(0);
  await expect(page.getByLabel('镜头标题')).toHaveValue('重连后保留的编辑草稿');
  expect(mutations).toBe(1);
  await page.getByRole('button', { name: '保存镜头', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存镜头', exact: true })).toBeDisabled();
  expect(mutations).toBe(2);
});

test('scrubs continuously, steps fractional frames and preserves the editing draft', async ({ page, request }) => {
  const rpc = async (method: string, params: unknown = {}) => {
    const response = await request.post('/__desktop_rpc', { data: { method, params } });
    const payload = await response.json();
    expect(payload.error).toBeUndefined();
    return payload.result;
  };
  const project = await rpc('project.create', { title: '时间轴交互验收', profile: { width: 640, height: 360, frameRate: { numerator: 30000, denominator: 1001 }, fitMode: 'contain', previewScale: .5 } });
  const shots = [0, 1].map(index => ({ id: `scrub-${index}`, title: `拖动镜头 ${index + 1}`, narration: `旁白 ${index + 1}`, visualPrompt: '', durationUs: 3_000_000, claimIds: [], locked: false, animation: { panX: 0, panY: 0, zoom: 1.02, transition: 'cut' } }));
  await rpc('project.update', { projectId: project.id, revision: project.revision, patch: { shots } });
  await page.goto('/');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: '时间轴交互验收' }).getByRole('button', { name: /继续创作/ }).click();
  await page.getByLabel('镜头标题').fill('尚未保存的标题');
  const ruler = page.getByRole('slider', { name: '预览播放位置' });
  await ruler.focus(); await ruler.press('Home'); await ruler.press('ArrowRight');
  await expect(ruler).toHaveAttribute('aria-valuenow', '33');
  await ruler.press('Shift+ArrowRight');
  await expect(ruler).toHaveAttribute('aria-valuenow', '367');
  const bounds = await ruler.boundingBox(); expect(bounds).not.toBeNull();
  if (!bounds) throw new Error('时间尺不可见');
  await page.mouse.move(bounds.x + bounds.width * .2, bounds.y + 18); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .75, bounds.y + 18, { steps: 12 });
  await expect.poll(async () => Number(await ruler.getAttribute('aria-valuenow'))).toBeGreaterThan(4400);
  await expect(page.locator('.preview-panel canvas')).toHaveAttribute('aria-label', '拖动镜头 2 · 镜头预览');
  await expect(page.getByLabel('镜头标题')).toHaveValue('尚未保存的标题');
  await page.mouse.move(bounds.x + bounds.width + 80, bounds.y + 18); await page.mouse.up();
  await expect(ruler).toHaveAttribute('aria-valuenow', '5973');
  await ruler.press('Home');
  await page.getByRole('button', { name: '播放预览', exact: true }).click();
  await expect.poll(async () => Number(await ruler.getAttribute('aria-valuenow'))).toBeGreaterThan(100);
  await page.getByRole('button', { name: '暂停预览', exact: true }).click();
  await expect(page.getByLabel('镜头标题')).toHaveValue('尚未保存的标题');
  await page.getByRole('button', { name: '保存镜头', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存镜头', exact: true })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: '时间轴交互验收' }).getByRole('button', { name: /继续创作/ }).click();
  await expect(page.getByLabel('镜头标题')).toHaveValue('尚未保存的标题');
});

test('edits real project state, output profiles, graph and theme', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveTitle(/Video Quickly/);
  await expect(page.getByRole('button', { name: '模型连接', exact: true })).toBeVisible();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expect(page.getByLabel('镜头标题')).toHaveValue('一纸登科，改变了什么？');
  await page.getByLabel('镜头标题').fill('一纸登科 · 已编辑');
  await page.getByRole('button', { name: '保存镜头', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存镜头', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel('镜头标题')).toHaveValue('一纸登科 · 已编辑');

  await page.getByRole('button', { name: '项目设置', exact: true }).click();
  await page.getByLabel('画面比例', { exact: true }).selectOption('9:16');
  await page.getByLabel('视频帧率').selectOption('29.97');
  await expect(page.getByLabel('视频宽度')).toHaveValue('1080');
  await expect(page.getByLabel('视频高度')).toHaveValue('1920');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '项目设置', exact: true }).click();
  await expect(page.getByLabel('视频帧率')).toHaveValue('29.97');
  await expect(page.getByLabel('视频高度')).toHaveValue('1920');

  await page.getByRole('button', { name: '流程', exact: true }).click();
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存流程', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '添加编排步骤', exact: true }).click();
  await expect(page.getByLabel('步骤名称')).toHaveValue('新步骤');
  await page.getByLabel('步骤名称').fill('检查标题与字幕');
  await page.getByRole('button', { name: '保存流程', exact: true }).click();
  await expect(page.getByText('检查标题与字幕', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: '浅色外观', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(page.getByRole('button', { name: '模型连接', exact: true })).toBeVisible();
  const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  expect(layout.document).toBeLessThanOrEqual(layout.viewport + 1);
  expect(errors).toEqual([]);
});

test('keeps flow edits through background refresh and saves before switching views', async ({ page, request }) => {
  const response = await request.post('/__desktop_rpc', { data: { method: 'project.create', params: { title: '流程交互验收' } } });
  const project = (await response.json()).result;
  await page.goto('/');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: '流程交互验收' }).getByRole('button', { name: /继续创作/ }).click();
  await page.getByRole('button', { name: '流程', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存流程', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '添加编排步骤', exact: true }).click();
  await page.getByLabel('步骤名称').fill('后台刷新保留的步骤');
  const renamed = await request.post('/__desktop_rpc', { data: { method: 'project.update', params: { projectId: project.id, revision: project.revision, patch: { title: '流程交互验收 · 新修订' } } } });
  expect((await renamed.json()).error).toBeUndefined();
  await expect(page.getByLabel('项目名称')).toHaveValue('流程交互验收 · 新修订');
  await expect(page.getByLabel('步骤名称')).toHaveValue('后台刷新保留的步骤');
  await page.setViewportSize({ width: 600, height: 900 });
  const canvas = await page.locator('.react-flow').boundingBox();
  expect(canvas?.height).toBeGreaterThan(300);
  await page.getByRole('button', { name: '分镜', exact: true }).click();
  await expect(page.locator('.react-flow')).toHaveCount(0);
  await page.getByRole('button', { name: '流程', exact: true }).click();
  await expect(page.getByText('后台刷新保留的步骤', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '保存流程', exact: true })).toBeDisabled();
});

test('resizes and restores editor panels, and saves before opening a recent project', async ({ page, request }) => {
  const created = await request.post('/__desktop_rpc', { data: { method: 'project.create', params: { title: '侧栏切换验收项目' } } });
  const nextProject = (await created.json()).result;
  const snapshot = await request.post('/__desktop_rpc', { data: { method: 'workspace.snapshot' } });
  const original = (await snapshot.json()).result.projects.find((project: { id: string }) => project.id === 'example-history');
  await page.goto('/');
  await page.getByRole('button', { name: `打开项目：${original.title}`, exact: true }).click();
  const outline = page.getByRole('separator', { name: '调整镜头导航宽度' });
  await outline.press('ArrowRight'); await expect(outline).toHaveAttribute('aria-valuenow', '240');
  await outline.dblclick(); await expect(outline).toHaveAttribute('aria-valuenow', '224');
  const inspector = page.getByRole('separator', { name: '调整属性面板宽度' });
  await inspector.press('ArrowLeft'); await expect(inspector).toHaveAttribute('aria-valuenow', '320');
  await inspector.dblclick(); await expect(inspector).toHaveAttribute('aria-valuenow', '304');
  await page.getByRole('tab', { name: '制作步骤', exact: true }).click();
  await expect(page.locator('.outline-list .step-item').first()).toBeVisible();
  await page.getByRole('tab', { name: '镜头列表', exact: true }).click();
  await page.getByLabel('镜头标题').fill('专注模式保留的草稿');
  await page.getByRole('button', { name: '专注预览', exact: true }).click();
  await expect(page.locator('#project-outline')).toBeHidden();
  await expect(page.locator('#project-inspector')).toBeHidden();
  await page.getByRole('button', { name: '退出专注预览', exact: true }).click();
  await expect(page.getByLabel('镜头标题')).toHaveValue('专注模式保留的草稿');
  await page.getByRole('button', { name: `打开项目：${nextProject.title}`, exact: true }).click();
  await expect(page.getByLabel('项目名称')).toHaveValue(nextProject.title);
  const saved = await request.post('/__desktop_rpc', { data: { method: 'workspace.snapshot' } });
  expect((await saved.json()).result.projects.find((project: { id: string }) => project.id === original.id).shots[0].title).toBe('专注模式保留的草稿');
});

test('creates a project and connects a model without exposing credentials', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.getByRole('button', { name: '新建项目', exact: true }).last().click();
  const dialog = page.getByRole('dialog', { name: '新建视频项目' });
  await dialog.getByLabel('项目名称').fill('界面验收项目');
  await dialog.getByLabel('创意简报').fill('这是隔离数据目录中的编辑与恢复验证项目。');
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('项目名称')).toHaveValue('界面验收项目');

  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  await page.getByRole('button', { name: '添加模型', exact: true }).first().click();
  const modelDialog = page.getByRole('dialog');
  await modelDialog.getByLabel('连接名称').fill('本地文本服务');
  await modelDialog.getByLabel('服务地址').fill('http://127.0.0.1:11434');
  await modelDialog.getByLabel('模型 ID').fill('local-fixture');
  await modelDialog.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(page.getByText('本地文本服务', { exact: true })).toBeVisible();
});

test('persists a review decision and supports read-only replay', async ({ page, request }) => {
  const initial = await request.post('/__desktop_rpc', { data: { method: 'workspace.snapshot' } });
  const payload = await initial.json();
  const project = payload.result.projects.find((value: { id: string }) => value.id === 'example-history');
  const started = await request.post('/__desktop_rpc', { data: { method: 'run.start', params: { projectId: project.id, nodeId: 'style' } } });
  const { result: run } = await started.json();
  await page.goto('/');
  await page.getByRole('button', { name: '制作记录', exact: true }).click();
  await expect(page.getByText('等待审阅', { exact: true }).first()).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '制作记录', exact: true }).click();
  await expect(page.getByText('等待审阅', { exact: true }).first()).toBeVisible();
  await request.post('/__desktop_rpc', { data: { method: 'run.review', params: { runId: run.id, approved: true } } });
  await expect.poll(async () => {
    const response = await request.post('/__desktop_rpc', { data: { method: 'workspace.snapshot' } });
    return (await response.json()).result.runs.find((value: { id: string }) => value.id === run.id).status;
  }).toBe('succeeded');
  const replay = await request.post('/__desktop_rpc', { data: { method: 'run.replay', params: { runId: run.id } } });
  expect((await replay.json()).result.externalCalls).toBe(0);
});

test('exports an actual local MP4 from the asynchronous export dialog', async ({ page, request }) => {
  const rpc = async (method: string, params: unknown = {}) => {
    const response = await request.post('/__desktop_rpc', { data: { method, params } });
    const result = await response.json();
    if (result.error) throw new Error(result.error);
    return result.result;
  };
  const profile = { width: 320, height: 180, frameRate: { numerator: 30000, denominator: 1001 }, fitMode: 'contain', previewScale: 1 };
  const project = await rpc('project.create', { title: '本地导出验收', brief: '静音示例', profile });
  await rpc('project.saveShot', { projectId: project.id, shot: { id: 'export-shot', title: '本地渲染检查', narration: '这是静音画面小样。', visualPrompt: '示例画面', durationUs: 700000, claimIds: [], locked: false, animation: { panX: 0, panY: 0, zoom: 1.02, transition: 'cut' } } });
  await page.goto('/');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  const card = page.locator('.project-card').filter({ hasText: '本地导出验收' });
  await card.getByRole('button', { name: /继续创作/ }).click();
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导出视频' });
  await expect(dialog.getByText(/静音画面小样/)).toBeVisible();
  await dialog.getByRole('button', { name: '导出 MP4', exact: true }).click();
  await expect(dialog.getByText(/文件已保存/)).toBeVisible({ timeout: 30000 });
  const snapshot = await rpc('workspace.snapshot');
  const run = snapshot.runs.find((value: { projectId: string }) => value.projectId === project.id);
  expect(run.status).toBe('succeeded');
  const output = await rpc('node.result', { runId: run.id, nodeId: 'export' });
  expect(output.videoPath).toMatch(/\.mp4$/);
  expect(output.assets.some((asset: { kind: string; size: number }) => asset.kind === 'video' && asset.size > 500)).toBe(true);
});

test('imports and versions a real Skill, and registers tools in disabled state', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
  await page.getByRole('button', { name: '导入 Skill', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '导入 Skill' });
  await dialog.getByRole('textbox').fill(resolve('.agents/skills/make-interfaces-feel-better'));
  await dialog.getByRole('button', { name: '导入', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'make-interfaces-feel-better', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看“make-interfaces-feel-better”', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'make-interfaces-feel-better' });
  await expect(editor.getByLabel('Skill 指令')).toContainText('Details that make interfaces feel better');
  await editor.getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('button', { name: '添加工具连接', exact: true }).click();
  const toolDialog = page.getByRole('dialog', { name: '添加工具连接' });
  await toolDialog.getByLabel('连接名称').fill('本地工具验收');
  await toolDialog.getByLabel('可执行文件路径').fill(process.execPath);
  await toolDialog.getByRole('button', { name: '保存工具连接', exact: true }).click();
  await expect(toolDialog).toHaveCount(0);
  const toolCard = page.locator('.list-card').filter({ hasText: '本地工具验收' });
  await expect(toolCard.getByText('未启用', { exact: true })).toBeVisible();
  await expect(toolCard.getByRole('button', { name: '查看“本地工具验收”提供的工具' })).toBeDisabled();
});
