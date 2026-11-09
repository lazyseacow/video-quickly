import { openProjectFromList } from './workspace-navigation';
import { openCosts, openGuide, openWorkspaceSettings } from './workspace-settings';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { createSceneTemplate, type ModelProfile, type ProjectDocument, type RunSummary } from '@video-quickly/contracts';
import { test as isolatedTest } from './isolated-workspace';
import { selectModel, settingField } from './settings';

const preference = 'vq-onboarding-v1';
const targets: Record<string, string[]> = {
  '新建创作项目': ['create-project'], '打开模型连接': ['models'], '添加模型连接': ['model-connection'], '打开我的项目': ['projects'], '进入创作工作台': ['project-open'],
  '制作设置': ['view'], '展开镜头导航': ['outline-toggle'], '整理镜头': ['shots'], '预览画面': ['preview'],
  '安排镜头节奏': ['timeline'], '展开属性面板': ['inspector-toggle'], '编辑属性': ['inspector'],
  '制作前检查': ['check'], '自动制作': ['produce'], '导出成片': ['export'], '随时重开指引': ['help'],
};
function freshProfile(origin: string, theme = 'dark') {
  return { cookies: [], origins: [{ origin: new URL(origin).origin, localStorage: [{ name: 'vq-theme', value: theme }] }] };
}
test.use({ storageState: async ({ baseURL }, use) => {
  if (!baseURL) throw new Error('Getting-started tests require a local application origin');
  await use(freshProfile(baseURL));
} });

function guide(page: Page) { return page.locator('[data-guide-popover]'); }
function settings(page: Page) { return page.getByRole('button', { name: '设置', exact: true }); }
function active(page: Page) { return page.locator('.driver-active-element'); }
async function nextStep(page: Page) {
  const previous = await guide(page).getByRole('heading').innerText();
  await guide(page).getByRole('button', { name: '下一步', exact: true }).click();
  await expect(guide(page).getByRole('heading')).not.toHaveText(previous);
}
function observe(page: Page) {
  const writes: string[] = [], errors: string[] = [];
  page.on('request', request => {
    if (!request.url().endsWith('/__desktop_rpc')) return;
    const method: unknown = request.postDataJSON()?.method;
    if (typeof method === 'string' && /^(?:project\.(?:create|update|saveShot)|workflow\.save|run\.(?:start|review|resume|restart)|node\.apply|shot\.candidate\.(?:generate|apply)|render\.(?:export|batch\.start)|model\.(?:save|test)|asset\.(?:import|select))$/.test(method)) writes.push(method);
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
  return { writes, errors };
}
async function opened(page: Page) {
  await expect(page).toHaveTitle(/Video Quickly/);
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
  await expect(guide(page)).toBeVisible(); await expect(guide(page)).toHaveAttribute('role', 'dialog');
  await expect(guide(page)).toHaveAttribute('aria-label', '使用指南');
  await expect(guide(page).getByRole('heading')).toHaveText('新建创作项目');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
}
async function anchored(page: Page) {
  const popover = guide(page); await expect(popover).toBeVisible(); await expect(popover).toBeInViewport({ ratio: 1 });
  await expect(active(page)).toHaveCount(1); await expect(active(page)).toBeVisible();
  const heading = await popover.getByRole('heading').innerText(), target = await active(page).getAttribute('data-guide');
  expect(targets[heading], `Unknown tour step: ${heading}`).toBeDefined(); expect(targets[heading]).toContain(target);
  await expect.poll(() => page.evaluate(() => {
    const target = document.querySelector('.driver-active-element'), path = document.querySelector<SVGPathElement>('.driver-overlay path');
    if (!target || !path) return false;
    const matrix = path.getScreenCTM(); if (!matrix) return false;
    const box = target.getBoundingClientRect();
    const x = (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2, y = (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2;
    if (box.width <= 0 || box.height <= 0 || x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    // Query SVG geometry directly; do not reproduce Driver's cutout path algorithm.
    return !path.isPointInFill(new DOMPoint(x, y).matrixTransform(matrix.inverse()));
  }), `Spotlight must expose the real ${target} target`).toBe(true);
  const geometry = await popover.evaluate(popover => {
    const target = document.querySelector('.driver-active-element')!;
    const box = target.getBoundingClientRect(), bubble = popover.getBoundingClientRect();
    const x = (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2, y = (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2;
    return {
      coversTargetCenter: x >= bubble.left && x <= bubble.right && y >= bubble.top && y <= bubble.bottom,
      gap: Math.hypot(Math.max(box.left - bubble.right, bubble.left - box.right, 0), Math.max(box.top - bubble.bottom, bubble.top - box.bottom, 0)),
    };
  });
  expect(geometry.coversTargetCenter, `${heading} popover must leave its target center visible`).toBe(false);
  expect(geometry.gap, `${heading} popover must remain next to its target`).toBeLessThan(64);
  return target!;
}
async function walk(page: Page, info?: TestInfo, screenshotPrefix = '') {
  const seen: string[] = [];
  for (let index = 0; index < 20; index++) {
    const target = await anchored(page); seen.push(target);
    if (info && ['preview', 'timeline'].includes(target)) await page.screenshot({ path: info.outputPath(`${screenshotPrefix}tour-${target}.png`) });
    const done = guide(page).getByRole('button', { name: '完成引导', exact: true });
    if (await done.isVisible()) { await done.click(); await expect(guide(page)).toHaveCount(0); return seen; }
    await nextStep(page);
  }
  throw new Error('The tour did not finish within its configured target count');
}
async function reach(page: Page, heading: string) {
  for (let index = 0; index < 20; index++) {
    if (await guide(page).getByRole('heading').innerText() === heading) { await anchored(page); return; }
    const next = guide(page).getByRole('button', { name: '下一步', exact: true });
    if (!await next.isVisible()) break;
    await nextStep(page);
  }
  throw new Error(`Tour step not reachable: ${heading}`);
}
async function remembered(page: Page) {
  await expect(guide(page)).toHaveCount(0); await expect(page.locator('.driver-overlay')).toHaveCount(0);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), preference)).toBe('done');
  await page.reload(); await expect(settings(page)).toBeVisible(); await expect(guide(page)).toHaveCount(0);
}
async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function dismissFirst(page: Page) {
  await page.goto('/'); await opened(page); await guide(page).getByRole('button', { name: '暂时跳过', exact: true }).click(); await expect(guide(page)).toHaveCount(0);
}
async function atStep(page: Page, heading: string) {
  await expect(guide(page).getByRole('heading')).toHaveText(heading); await anchored(page);
}
async function projectFixture(request: APIRequestContext, title: string, count = 2, durationUs = 5_000_000) {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `${title} ${randomUUID().slice(0, 8)}`, profile: { width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: 1 } });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: Array.from({ length: count }, (_, index) => ({ id: `interactive-guide-${index}`, title: `操作镜头 ${index + 1}`, narration: '', visualPrompt: '', durationUs, sceneTemplate: createSceneTemplate('process') })) } });
}
async function openProjectTour(page: Page, project: ProjectDocument) {
  await dismissFirst(page); await openProjectFromList(page, project.title);
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(project.title); await openGuide(page); await opened(page);
}
async function savedProject(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
async function holdNextRpc(page: Page, method: string, error?: string) {
  let release!: () => void, entered!: () => void, held = false;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  page.once('close', release);
  await page.route('**/__desktop_rpc', async route => {
    if (!held && route.request().postDataJSON()?.method === method) {
      held = true; entered(); await gate;
      if (error) { await route.fulfill({ json: { error } }); return; }
    }
    await route.continue();
  });
  return { entered: waiting, release };
}
async function localProvider() {
  const calls: Array<{ method: string; path: string }> = [];
  const server = createServer({ keepAliveTimeout: 0 }, async (request, response) => {
    for await (const _ of request) { /* Consume the real provider request. */ }
    calls.push({ method: request.method ?? '', path: request.url ?? '' }); response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.method === 'GET' ? { data: [{ id: 'guide-local-text', display_name: '本地操作指引模型' }] } : { choices: [{ message: { content: '本地指引夹具已完成。' } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('本地模型夹具未监听');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, calls, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark', reducedMotion: 'no-preference' }, { width: 390, height: 844, theme: 'light', reducedMotion: 'reduce' }] as const) {
  test.describe(`spotlight tour at ${viewport.width}px in ${viewport.theme}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: viewport.reducedMotion,
      storageState: async ({ baseURL }, use) => { if (!baseURL) throw new Error('A local application origin is required'); await use(freshProfile(baseURL, viewport.theme)); },
    });
    test('tracks every real target, remembers completion and restores Help focus after several steps', async ({ page }, info) => {
      const observed = observe(page); await page.goto('/'); await opened(page); await anchored(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', viewport.theme);
      const previous = guide(page).getByRole('button', { name: '上一步', exact: true }); if (await previous.count()) await expect(previous).toBeDisabled();
      await page.screenshot({ path: info.outputPath(`tour-first-${viewport.theme}-${viewport.width}.png`) });
      await guide(page).getByRole('button', { name: '下一步', exact: true }).click(); await expect(guide(page).getByRole('heading')).toHaveText('打开模型连接'); await anchored(page);
      await guide(page).getByRole('button', { name: '上一步', exact: true }).click(); await expect(guide(page).getByRole('heading')).toHaveText('新建创作项目');
      const seen = await walk(page, info, `${viewport.theme}-${viewport.width}-`);
      expect(seen).toContain('create-project'); expect(seen).toContain('models'); expect(seen).toContain('preview'); expect(seen).toContain('timeline'); expect(seen.at(-1)).toBe('help');
      await remembered(page); await openGuide(page); await opened(page);
      for (let index = 0; index < 3; index++) await nextStep(page);
      await page.keyboard.press('Escape'); await expect(guide(page)).toHaveCount(0); await expect(settings(page)).toBeFocused();
      await openGuide(page); await opened(page); await page.keyboard.press('Escape'); await remembered(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', viewport.theme);
      expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
    });
  });
}

for (const dismissal of ['skip', 'close', 'overlay'] as const) {
  test(`remembers ${dismissal} dismissal and leaves the workspace unchanged`, async ({ page }) => {
    const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await opened(page);
    if (dismissal === 'skip') await guide(page).getByRole('button', { name: '暂时跳过', exact: true }).click();
    else if (dismissal === 'close') await guide(page).getByRole('button', { name: '关闭指引', exact: true }).click();
    else await page.mouse.click(2, 2);
    await remembered(page); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
  });
}

isolatedTest('shows the tour to an independent new profile after another profile has dismissed it', async ({ page, browser, baseURL }) => {
  if (!baseURL) throw new Error('A local application origin is required');
  const original = observe(page); await dismissFirst(page); await remembered(page);
  const context = await browser.newContext({ baseURL, storageState: freshProfile(baseURL, 'light'), reducedMotion: 'reduce' });
  try {
    const fresh = await context.newPage(), observed = observe(fresh); await fresh.goto('/'); await opened(fresh); await anchored(fresh);
    await expect(fresh.locator('html')).toHaveAttribute('data-theme', 'light'); expect(await fresh.evaluate(key => localStorage.getItem(key), preference)).toBeNull();
    expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
  } finally { await context.close(); }
  expect(original.writes).toEqual([]); expect(original.errors).toEqual([]);
});

test('refreshes the spotlight after nested scrolling, window resizing and target layout scaling', async ({ page }, info) => {
  const observed = observe(page); await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/'); await opened(page); await reach(page, '预览画面');
  const path = page.locator('.driver-overlay path'), before = await path.getAttribute('d');
  const scroll = await page.locator('.page-body').evaluate(element => { const before = element.scrollTop; element.scrollBy(0, 80); return { before, after: element.scrollTop }; });
  expect(scroll.after).not.toBe(scroll.before); await expect.poll(() => path.getAttribute('d')).not.toBe(before); await anchored(page);
  await page.setViewportSize({ width: 1024, height: 720 }); await anchored(page);
  await page.setViewportSize({ width: 1536, height: 960 }); await anchored(page);
  const beforeScale = await path.getAttribute('d'), beforeBounds = await active(page).boundingBox();
  // Transform the real target to guarantee a measurable bounds change even
  // when its grid track constrains its size.
  await active(page).evaluate(element => { (element as HTMLElement).style.transform = 'scale(.9)'; });
  await expect.poll(() => active(page).boundingBox()).not.toEqual(beforeBounds);
  await expect.poll(() => path.getAttribute('d')).not.toBe(beforeScale); await anchored(page);
  await page.screenshot({ path: info.outputPath('tour-preview-followed-layout.png') });
  await page.keyboard.press('Escape'); await expect(page.locator('.driver-overlay')).toHaveCount(0);
  expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
});

test('moves away from a target that becomes hidden instead of leaving a stale cutout', async ({ page }) => {
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await opened(page); await reach(page, '预览画面');
  await page.addStyleTag({ content: '[data-guide="preview"] { display: none !important; }' });
  await expect(page.locator('.driver-active-element[data-guide="preview"]')).toHaveCount(0);
  await anchored(page); await page.keyboard.press('Escape'); await expect(guide(page)).toHaveCount(0);
  expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
});

test('targets panel toggles when their actual workbench panels are hidden', async ({ page }) => {
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await dismissFirst(page);
  await page.locator('[data-guide="outline-toggle"]').click(); await page.locator('[data-guide="inspector-toggle"]').click();
  await expect(page.locator('[data-guide="shots"]')).toBeHidden(); await expect(page.locator('[data-guide="inspector"]')).toBeHidden();
  await openGuide(page); await opened(page); const seen = await walk(page);
  expect(seen).toContain('outline-toggle'); expect(seen).toContain('inspector-toggle'); expect(seen).not.toContain('shots'); expect(seen).not.toContain('inspector');
  await expect(page.locator('[data-guide="outline-toggle"]')).toHaveAttribute('aria-pressed', 'false'); await expect(page.locator('[data-guide="inspector-toggle"]')).toHaveAttribute('aria-pressed', 'false');
  expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
});

test('does not navigate or target the hidden cached workbench when reopened from the asset library', async ({ page }) => {
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await dismissFirst(page);
  await page.getByRole('button', { name: '素材库', exact: true }).click(); await expect(page.getByRole('heading', { name: '素材库', exact: true })).toBeVisible();
  await openGuide(page); await opened(page); const seen = await walk(page);
  expect(seen).toEqual(['create-project', 'models', 'projects', 'help']);
  await expect(page.getByRole('heading', { name: '素材库', exact: true })).toBeVisible();
  expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
});

test('keeps the consolidated settings and scrollable navigation reachable at the native minimum window', async ({ page }, info) => {
  const observed = observe(page); await page.setViewportSize({ width: 1024, height: 720 }); await page.emulateMedia({ reducedMotion: 'reduce' }); await dismissFirst(page);
  await expect(settings(page)).toBeInViewport({ ratio: 1 }); await openGuide(page); await opened(page); await page.keyboard.press('Escape'); await expect(guide(page)).toHaveCount(0); await expect(settings(page)).toBeFocused();
  await expect(settings(page)).toBeInViewport({ ratio: 1 }); const dialog = await openWorkspaceSettings(page);
  await expect(dialog.getByRole('group', { name: '外观', exact: true })).toBeInViewport({ ratio: 1 }); await expect(dialog.getByRole('button', { name: 'Token 消耗', exact: true })).toBeInViewport({ ratio: 1 }); await expect(dialog.getByRole('button', { name: '使用指南', exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('workspace-settings-rail-1024x720.png') }); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(settings(page)).toBeFocused();
  await openGuide(page); await opened(page); await page.keyboard.press('Escape'); await expect(guide(page)).toHaveCount(0); await expect(settings(page)).toBeFocused();
  await openCosts(page); await openProjectFromList(page); await expect(page.getByLabel('项目名称', { exact: true })).toBeVisible();
  expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
});

test('isolates editor shortcuts and preserves an unsaved project draft throughout a multi-step tour', async ({ page, request }) => {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `定位指引保留草稿 ${randomUUID().slice(0, 8)}` });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [0, 1].map(index => ({ id: `guide-shot-${index}`, title: `原始镜头 ${index}`, narration: '', visualPrompt: '', durationUs: 5_000_000, sceneTemplate: createSceneTemplate('process') })) } });
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await dismissFirst(page);
  await openProjectFromList(page, project.title);
  const title = page.getByLabel('镜头标题', { exact: true }); await expect(title).toHaveValue('原始镜头 0');
  const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true }); await ruler.focus(); for (let index = 0; index < 10; index++) await ruler.press('ArrowRight');
  const time = await page.locator('.preview-controls .timecode b').innerText(); await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeEnabled();
  await title.fill('尚未保存的定位指引草稿'); await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeEnabled();
  await openGuide(page); await opened(page); await reach(page, '自动制作');
  await guide(page).getByRole('heading').focus();
  for (const key of ['ControlOrMeta+s', 's', 'Space', 'ArrowRight', 'ArrowLeft']) await page.keyboard.press(key);
  await page.keyboard.press('Escape'); await expect(guide(page)).toHaveCount(0); await expect(settings(page)).toBeFocused();
  await expect(title).toHaveValue('尚未保存的定位指引草稿'); await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeEnabled();
  await expect(page.locator('.outline-shot')).toHaveCount(2); await expect(page.getByRole('button', { name: '播放预览', exact: true })).toHaveAttribute('aria-pressed', 'false'); await expect(page.locator('.preview-controls .timecode b')).toHaveText(time);
  const saved = await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id });
  expect(saved.project.revision).toBe(project.revision); expect(saved.project.shots[0].title).toBe('原始镜头 0');
  expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
});

test('continues the same tour only after a real project is created, preserving cancellation and failure', async ({ page, request }) => {
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await opened(page);
  const dialog = page.getByRole('dialog', { name: '新建视频项目', exact: true });
  await active(page).click(); await expect(dialog).toBeVisible(); await expect(guide(page)).toHaveCount(0); await expect(page.locator('.driver-overlay')).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), preference)).toBeNull();
  await expect(dialog.getByLabel('项目名称', { exact: true })).toBeFocused(); await dialog.getByLabel('项目名称', { exact: true }).fill('取消时不创建'); await page.keyboard.press('Escape'); await atStep(page, '新建创作项目');
  const failed = await holdNextRpc(page, 'project.create', '隔离的新建失败');
  await active(page).click(); await dialog.getByLabel('项目名称', { exact: true }).fill('失败时不推进'); await dialog.getByRole('button', { name: '创建项目', exact: true }).click();
  await failed.entered; await expect(guide(page)).toHaveCount(0); failed.release();
  await expect(page.getByText('隔离的新建失败', { exact: true })).toBeVisible(); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await atStep(page, '新建创作项目');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const cancelled = await holdNextRpc(page, 'project.create'), cancelledTitle = `关闭动画中的迟到创建 ${randomUUID().slice(0, 8)}`;
  await active(page).click(); await dialog.getByLabel('项目名称', { exact: true }).fill(cancelledTitle);
  const cancelledResponse = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'project.create');
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click(); await cancelled.entered;
  const dismissal = await dialog.locator('.dialog__surface').evaluateHandle(element => {
    const state = { becameInert: false };
    const observer = new MutationObserver(() => { state.becameInert ||= (element as HTMLElement).inert; });
    observer.observe(element, { attributes: true, attributeFilter: ['inert'] });
    return { state, stop: () => observer.disconnect() };
  });
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  cancelled.release();
  try { expect(await dismissal.evaluate(value => { value.stop(); return value.state.becameInert; })).toBe(true); }
  finally { await dismissal.dispose(); }
  const cancelledProject: ProjectDocument = (await (await cancelledResponse).json()).result;
  expect((await savedProject(request, cancelledProject.id)).title).toBe(cancelledTitle); await atStep(page, '新建创作项目');
  expect(await page.evaluate(key => localStorage.getItem(key), preference)).toBeNull(); await page.emulateMedia({ reducedMotion: 'reduce' });
  const pending = await holdNextRpc(page, 'project.create'), title = `导览中真实新建 ${randomUUID().slice(0, 8)}`;
  await active(page).click(); await dialog.getByLabel('项目名称', { exact: true }).fill(title);
  const response = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'project.create');
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click(); await pending.entered;
  await expect(guide(page)).toHaveCount(0); expect(await page.evaluate(key => localStorage.getItem(key), preference)).toBeNull(); pending.release();
  const created: ProjectDocument = (await (await response).json()).result;
  await expect(dialog).toHaveCount(0); await atStep(page, '打开模型连接'); await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(title);
  expect((await savedProject(request, created.id)).title).toBe(title); expect(observed.writes).toEqual(['project.create', 'project.create', 'project.create']); expect(observed.errors).toEqual([]);
});

test('navigates to current model controls, saves a real local connection and returns to the workbench', async ({ page, request }) => {
  const provider = await localProvider(), observed = observe(page);
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await opened(page); await reach(page, '打开模型连接');
    await active(page).click(); await expect(page.getByRole('heading', { name: '模型连接', exact: true })).toBeVisible(); await atStep(page, '添加模型连接');
    await active(page).click(); const picker = page.getByRole('dialog', { name: '选择模型类型', exact: true }); await expect(picker).toBeVisible(); await expect(guide(page)).toHaveCount(0);
    await picker.getByRole('button', { name: /^文本模型/ }).click();
    const dialog = page.getByRole('dialog', { name: '添加文本模型', exact: true }), name = `导览本地模型 ${randomUUID().slice(0, 8)}`;
    await (await settingField(dialog, '模型平台')).selectOption('custom'); await (await settingField(dialog, '连接名称')).fill(name);
    await (await settingField(dialog, 'API Key')).fill('guide-local-fixture-key'); await (await settingField(dialog, '服务地址')).fill(provider.baseUrl);
    await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
    const model = dialog.getByLabel('模型 ID', { exact: true }); await expect(model).toBeEnabled(); await selectModel(dialog, 'guide-local-text');
    const pending = await holdNextRpc(page, 'model.save'); await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await pending.entered;
    await expect(guide(page)).toHaveCount(0); pending.release(); await expect(dialog).toHaveCount(0); await atStep(page, '打开我的项目');
    const summary = await rpc<{ models: ModelProfile[] }>(request, 'workspace.summary'); expect(summary.models.find(model => model.name === name)).toMatchObject({ model: 'guide-local-text', baseUrl: provider.baseUrl });
    await active(page).click(); await atStep(page, '进入创作工作台'); await active(page).click(); await expect(page.getByLabel('项目名称', { exact: true })).toBeVisible(); await atStep(page, '制作设置');
    await active(page).click(); await expect(page.getByRole('dialog', { name: '制作设置', exact: true })).toBeVisible();
    await page.getByRole('dialog', { name: '制作设置', exact: true }).getByRole('button', { name: '关闭对话框', exact: true }).click(); await atStep(page, '整理镜头');
    expect(provider.calls.length).toBeGreaterThan(0); expect(provider.calls.every(call => call.method === 'GET')).toBe(true);
    expect(observed.writes).toEqual(['model.save']); expect(observed.errors).toEqual([]);
  } finally { await provider.close(); }
});

test('advances for an actual shot selection, playback start and user seek without persisting edits', async ({ page, request }) => {
  const project = await projectFixture(request, '导览真实播放'), observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await openProjectTour(page, project);
  await reach(page, '整理镜头'); const second = page.locator('.outline-shot').nth(1); await second.click(); await expect(second).toHaveAttribute('aria-pressed', 'true'); await atStep(page, '预览画面');
  await page.getByRole('button', { name: '播放预览', exact: true }).click(); await expect(page.getByRole('button', { name: '暂停预览', exact: true })).toHaveAttribute('aria-pressed', 'true'); await atStep(page, '安排镜头节奏');
  await guide(page).getByRole('button', { name: '上一步', exact: true }).click(); await atStep(page, '预览画面'); await page.getByRole('button', { name: '暂停预览', exact: true }).click();
  await expect(page.getByRole('button', { name: '播放预览', exact: true })).toHaveAttribute('aria-pressed', 'false'); await atStep(page, '预览画面');
  await guide(page).getByRole('button', { name: '下一步', exact: true }).click(); await atStep(page, '安排镜头节奏');
  const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true }), before = Number(await ruler.getAttribute('aria-valuenow')), bounds = await ruler.boundingBox();
  if (!bounds) throw new Error('真实时间轴标尺不可见');
  expect(await page.locator('.playhead-lane, .playhead').evaluateAll(elements => elements.map(element => getComputedStyle(element).pointerEvents))).toEqual(['none', 'none']);
  await ruler.click({ position: { x: bounds.width * .8, y: bounds.height / 2 } });
  await expect.poll(async () => Number(await ruler.getAttribute('aria-valuenow'))).not.toBe(before); await atStep(page, '编辑属性');
  expect((await savedProject(request, project.id)).revision).toBe(project.revision); expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
});

test('waits for an explicit dirty save to persist and lets a failed save retry in the same step', async ({ page, request }) => {
  const project = await projectFixture(request, '导览保存重试'), observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await openProjectTour(page, project); await reach(page, '编辑属性');
  const title = page.getByLabel('镜头标题', { exact: true }); await title.fill('需要实际保存的导览输入');
  const failed = await holdNextRpc(page, 'project.update', '隔离的导览保存失败'); await page.getByRole('button', { name: '保存镜头', exact: true }).click(); await failed.entered;
  await atStep(page, '编辑属性'); expect((await savedProject(request, project.id)).revision).toBe(project.revision); failed.release();
  await expect(page.getByText('隔离的导览保存失败', { exact: true })).toBeVisible(); await atStep(page, '编辑属性'); await expect(title).toHaveValue('需要实际保存的导览输入');
  const retry = await holdNextRpc(page, 'project.update'); await page.getByRole('button', { name: '保存镜头', exact: true }).click(); await retry.entered; await atStep(page, '编辑属性'); retry.release();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].title).toBe('需要实际保存的导览输入'); await atStep(page, '制作前检查');
  const more = active(page).getByRole('button', { name: '更多', exact: true });
  const check = page.getByRole('button', { name: '制作前检查', exact: true });
  await more.click(); await expect(check).toBeVisible();
  await page.keyboard.press('Escape'); await expect(check).toHaveCount(0); await atStep(page, '制作前检查');
  const failedCheck = await holdNextRpc(page, 'project.readiness', '隔离的检查失败'); await more.click(); await check.click(); await failedCheck.entered; await expect(guide(page)).toHaveCount(0); failedCheck.release();
  const report = page.getByRole('dialog', { name: '制作前检查', exact: true }); await expect(report.getByText('隔离的检查失败', { exact: true })).toBeVisible();
  await report.getByRole('button', { name: '关闭', exact: true }).click(); await atStep(page, '制作前检查');
  await more.click(); await check.click(); await expect(report.locator('.readiness-summary')).toBeVisible(); await expect(guide(page)).toHaveCount(0);
  await report.getByRole('button', { name: '关闭', exact: true }).click(); await atStep(page, '自动制作');
  expect((await savedProject(request, project.id)).revision).toBe(project.revision + 1); expect(observed.writes).toEqual(['project.update', 'project.update']); expect(observed.errors).toEqual([]);
});

test('ignores late save completions after manually advancing or closing the guide', async ({ page, request }) => {
  const project = await projectFixture(request, '导览过期保存'), observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await openProjectTour(page, project); await reach(page, '编辑属性');
  const title = page.getByLabel('镜头标题', { exact: true }); await title.fill('手动下一步后的真实保存');
  const first = await holdNextRpc(page, 'project.update'); await page.getByRole('button', { name: '保存镜头', exact: true }).click(); await first.entered;
  await guide(page).getByRole('button', { name: '下一步', exact: true }).click(); await atStep(page, '制作前检查'); first.release();
  await expect.poll(async () => (await savedProject(request, project.id)).revision).toBe(project.revision + 1); await expect(page.getByRole('button', { name: '保存镜头', exact: true })).toBeDisabled(); await atStep(page, '制作前检查');
  await guide(page).getByRole('button', { name: '上一步', exact: true }).click(); await atStep(page, '编辑属性'); await title.fill('关闭指引后的真实保存');
  const second = await holdNextRpc(page, 'project.update'); await page.getByRole('button', { name: '保存镜头', exact: true }).click(); await second.entered;
  await guide(page).getByRole('button', { name: '关闭指引', exact: true }).click(); await expect(guide(page)).toHaveCount(0); second.release();
  await expect.poll(async () => (await savedProject(request, project.id)).shots[0].title).toBe('关闭指引后的真实保存'); await expect(page.getByRole('button', { name: '保存镜头', exact: true })).toBeDisabled(); await expect(guide(page)).toHaveCount(0); await expect(page.locator('.driver-overlay')).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), preference)).toBe('done'); expect(observed.writes).toEqual(['project.update', 'project.update']); expect(observed.errors).toEqual([]);
});

test('starts production only on the user click and advances only when the real runtime accepts it', async ({ page, request }) => {
  test.setTimeout(60_000);
  const provider = await localProvider();
  try {
    const source = await projectFixture(request, '导览本地制作'), model = await rpc<ModelProfile>(request, 'model.save', { model: { name: `导览制作 ${randomUUID().slice(0, 8)}`, model: 'guide-local-text', provider: 'openai-compatible', baseUrl: provider.baseUrl, connectionType: 'text', capabilities: ['text'] } });
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.id, revision: source.revision, patch: { workflow: { id: 'guide-local-production', name: '导览本地制作', version: 1, production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [{ id: 'style', kind: 'style', label: '本地制作确认', modelId: model.id, requiresReview: true }], edges: [] } } });
    const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await openProjectTour(page, project); await reach(page, '自动制作');
    expect(provider.calls).toEqual([]); expect(observed.writes).toEqual([]);
    const failed = await holdNextRpc(page, 'run.start', '隔离的制作接收失败'); await active(page).click(); await failed.entered; await atStep(page, '自动制作'); failed.release();
    await expect(page.getByText('隔离的制作接收失败', { exact: true })).toBeVisible(); await atStep(page, '自动制作'); expect(provider.calls).toEqual([]);
    const accepted = await holdNextRpc(page, 'run.start'), response = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'run.start');
    await active(page).click(); await accepted.entered; await atStep(page, '自动制作'); accepted.release();
    const run: RunSummary = (await (await response).json()).result; expect(run.id).toBeTruthy(); await atStep(page, '导出成片');
    await expect.poll(async () => (await rpc<RunSummary>(request, 'run.get', { runId: run.id })).status, { timeout: 30_000 }).toBe('succeeded');
    expect(provider.calls.filter(call => call.method === 'POST')).toHaveLength(1); expect(observed.writes).toEqual(['run.start', 'run.start']); expect(observed.errors).toEqual([]);
  } finally { await provider.close(); }
});

test('keeps export cancellation and failure in place and advances only after a real MP4 is exported', async ({ page, request }, info) => {
  const project = await projectFixture(request, '导览真实导出', 1, 700_000), observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await openProjectTour(page, project); await reach(page, '导出成片');
  const dialog = page.getByRole('dialog', { name: '导出视频', exact: true }); await active(page).click(); await expect(dialog).toBeVisible(); await expect(guide(page)).toHaveCount(0);
  expect(observed.writes).toEqual([]); await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click(); await atStep(page, '导出成片');
  await active(page).click(); await (await settingField(dialog, '输出文件路径')).fill(info.outputPath('guide-real-output.mp4'));
  const failed = await holdNextRpc(page, 'render.export', '隔离的导出失败'); await dialog.getByRole('button', { name: '导出 MP4', exact: true }).click(); await failed.entered; await expect(guide(page)).toHaveCount(0); failed.release();
  await expect(page.getByText('隔离的导出失败', { exact: true })).toBeVisible(); await expect(dialog).toBeVisible(); await expect(guide(page)).toHaveCount(0);
  await dialog.getByRole('button', { name: '导出 MP4', exact: true }).click(); await expect(dialog.getByText(/文件已保存/)).toBeVisible({ timeout: 30_000 });
  await expect(guide(page)).toHaveCount(0); const runs = await rpc<{ items: RunSummary[] }>(request, 'run.list', { projectId: project.id }); expect(runs.items).toHaveLength(1); expect(runs.items[0].status).toBe('succeeded');
  const output = await rpc<{ videoPath: string }>(request, 'node.result', { runId: runs.items[0].id, nodeId: 'export' }); expect(output.videoPath).toBe(info.outputPath('guide-real-output.mp4')); expect((await stat(output.videoPath)).size).toBeGreaterThan(500);
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click(); await atStep(page, '随时重开指引'); expect(observed.writes).toEqual(['render.export', 'render.export']); expect(observed.errors).toEqual([]);
});

isolatedTest('guides an empty workspace through the normal project list and preserves its layout through restore and archive', async ({ page, request, isolatedWorkspace }) => {
  const sample = await rpc<ProjectDocument>(request, 'project.create', { title: '空列表恢复验收' });
  const before = await rpc<{ projects: ProjectDocument[] }>(request, 'workspace.snapshot');
  for (const project of before.projects.filter(project => !project.archived)) await rpc(request, 'project.archive', { projectId: project.id, revision: project.revision });
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await opened(page);
  const main = page.getByRole('main');
  const heading = main.getByRole('heading', { name: '我的项目', level: 1, exact: true });
  await expect(heading).toBeVisible();
  const seen = await walk(page); expect(seen).toEqual(['create-project', 'models', 'projects', 'help']);
  const list = main.getByRole('region', { name: '项目列表', exact: true });
  const empty = list.getByRole('heading', { name: '还没有视频项目', exact: true });
  await expect(empty).toBeVisible();
  await expect(main.getByLabel('搜索项目', { exact: true })).toBeVisible();
  await expect(main.getByRole('button', { name: '全部项目', exact: true })).toHaveText('全部 0');
  for (const name of ['作品与分集', '导入项目', '新建项目']) await expect(main.getByRole('button', { name, exact: true })).toBeEnabled();
  expect((await rpc<{ projects: ProjectDocument[] }>(request, 'workspace.snapshot')).projects.every(project => project.archived)).toBe(true);
  expect(isolatedWorkspace.origin).toBe(new URL(page.url()).origin); expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);

  await page.setViewportSize({ width: 360, height: 844 });
  const listElement = await list.elementHandle();
  await main.getByRole('button', { name: '回收站', exact: true }).click();
  const card = list.locator('.project-card').filter({ has: page.getByRole('heading', { name: sample.title, exact: true }) });
  await card.getByRole('button', { name: '恢复项目', exact: true }).click();
  await main.getByRole('button', { name: '全部项目', exact: true }).click();
  await expect(card).toBeVisible();
  expect(await listElement!.evaluate(element => element.isConnected)).toBe(true);
  await card.getByRole('button', { name: '继续创作', exact: true }).click();
  await expect(page.locator('.workbench')).toBeVisible();
  await rpc(request, 'project.archive', { projectId: sample.id });
  await expect(heading).toBeVisible();
  await expect(empty).toBeVisible();
  expect(await main.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  expect(observed.errors).toEqual([]);
});
