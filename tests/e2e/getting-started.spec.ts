import { ensureSampleProject, openProjectFromList, openWorks, sampleProjectTitle } from './workspace-navigation';
import { openCosts, openGuide, openWorkspaceSettings } from './workspace-settings';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { createSceneTemplate, type DramaWork, type ModelProfile, type ProjectDocument, type ProjectSummary, type RunSummary } from '@video-quickly/contracts';
import { test as isolatedTest } from './isolated-workspace';
import { selectModel, settingField } from './settings';
import { creationInput, creationMode, sendCreationSource, setCreationTitle } from './drama-creation';

const preference = 'vq-onboarding-v1';
const targets: Record<string, string[]> = {
  '新建短剧': ['create-project'], '打开模型连接': ['models'], '添加模型连接': ['model-connection'], '打开短剧工作室': ['projects'], '进入分集工作台': ['project-open', 'work-library'],
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
test.beforeEach(async ({ page }) => { await ensureSampleProject(page); });

function guide(page: Page) { return page.locator('[data-guide-popover]'); }
function settings(page: Page) { return page.getByRole('button', { name: '设置', exact: true }); }
function active(page: Page) { return page.locator('.driver-active-element'); }
async function nextStep(page: Page) {
  const previous = await guide(page).getByRole('heading').innerText();
  await guide(page).getByRole('button', { name: '下一步', exact: true }).click();
  await expect(guide(page).getByRole('heading')).not.toHaveText(previous);
}
async function enterHighlightedWorks(page: Page) {
  const expand = active(page).and(page.getByRole('button', { name: '工作室菜单', exact: true }));
  if (await expand.isVisible()) await expand.click();
  if (await active(page).getAttribute('data-guide') === 'work-library') {
    const works = active(page).and(page.getByRole('button', { name: '我的作品', exact: true }));
    await works.click();
    await expect(active(page)).toHaveAttribute('data-guide', 'project-open');
  }
}
async function openHighlightedProject(page: Page) {
  await enterHighlightedWorks(page);
  const opensWork = await active(page).evaluate(element => Boolean(element.closest('.drama-work-card')));
  await active(page).click();
  if (opensWork) {
    await expect(page.locator('.drama-episode-row').getByRole('button', { name: '打开分集', exact: true }).first()).toBeVisible();
    await expect(guide(page).getByRole('heading')).toHaveText('进入分集工作台');
    await expect(active(page)).toHaveText('打开分集');
    await active(page).click();
  }
  await expect(guide(page).getByRole('heading')).toHaveText('制作设置');
}
function observe(page: Page) {
  const writes: string[] = [], errors: string[] = [];
  page.on('request', request => {
    if (!request.url().endsWith('/__desktop_rpc')) return;
    const method: unknown = request.postDataJSON()?.method;
    if (typeof method === 'string' && /^(?:dramaStudio\.create|project\.(?:create|update|saveShot)|workflow\.save|run\.(?:start|review|resume|restart)|node\.apply|shot\.candidate\.(?:generate|apply)|render\.(?:export|batch\.start)|model\.(?:save|test)|asset\.(?:import|select))$/.test(method)) writes.push(method);
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
  await expect(guide(page).getByRole('heading')).toHaveText('新建短剧');
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
    if (target === 'project-open' || target === 'work-library') await openHighlightedProject(page);
    else await nextStep(page);
  }
  throw new Error('The tour did not finish within its configured target count');
}
async function reach(page: Page, heading: string) {
  for (let index = 0; index < 20; index++) {
    const current = await guide(page).getByRole('heading').innerText();
    if (current === heading) { await anchored(page); return; }
    if (current === '进入分集工作台') { await openHighlightedProject(page); continue; }
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
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `${title} ${randomUUID().slice(0, 8)}`, originalText: '第一场：清晨，值班员推门进入办公室。第二场：他整理桌上的维修记录，决定向同事核对遗漏的信息。', profile: { width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: 1 } });
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
  isolatedTest.describe(`spotlight tour at ${viewport.width}px in ${viewport.theme}`, () => {
    isolatedTest.use({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: viewport.reducedMotion,
      storageState: async ({ baseURL }, use) => { if (!baseURL) throw new Error('A local application origin is required'); await use(freshProfile(baseURL, viewport.theme)); },
    });
    isolatedTest('tracks every real target, remembers completion and restores Help focus after several steps', async ({ page }, info) => {
      const observed = observe(page); await page.goto('/'); await opened(page); await anchored(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', viewport.theme);
      const styleTrigger = page.getByRole('button', { name: '快速选择画风', exact: true });
      await styleTrigger.click();
      const picker = page.getByRole('dialog', { name: '选择画风', exact: true });
      const search = picker.getByRole('searchbox', { name: '搜索画风', exact: true });
      await expect(search).toBeFocused();
      await search.press('Tab');
      await expect(picker.getByRole('button', { name: '关闭画风选择', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(picker).toBeHidden();
      await expect(styleTrigger).toBeFocused();
      await expect(guide(page).getByRole('heading')).toHaveText('新建短剧');
      const previous = guide(page).getByRole('button', { name: '上一步', exact: true }); if (await previous.count()) await expect(previous).toBeDisabled();
      await page.screenshot({ path: info.outputPath(`tour-first-${viewport.theme}-${viewport.width}.png`) });
      await guide(page).getByRole('button', { name: '下一步', exact: true }).click(); await expect(guide(page).getByRole('heading')).toHaveText('打开模型连接'); await anchored(page);
      await guide(page).getByRole('button', { name: '上一步', exact: true }).click(); await expect(guide(page).getByRole('heading')).toHaveText('新建短剧');
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

test('dismisses the compact workspace menu before closing its guide step', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/'); await opened(page); await reach(page, '进入分集工作台');
  const menuToggle = page.getByRole('button', { name: '工作室菜单', exact: true });
  await menuToggle.click();
  const navigation = page.getByRole('navigation', { name: '工作室菜单', exact: true });
  const works = navigation.getByRole('button', { name: '我的作品', exact: true });
  const guideHeading = guide(page).getByRole('heading', { name: '进入分集工作台', exact: true });
  await expect(active(page)).toHaveText('我的作品');
  await expect(guideHeading).toBeFocused();
  await works.press('Escape');
  await expect(navigation).toBeHidden();
  await expect(active(page)).toHaveAccessibleName('工作室菜单');
  await expect(guideHeading).toBeFocused();
  await page.keyboard.press('Escape'); await expect(guide(page)).toHaveCount(0);
});

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

test('resumes the same episode guide after an unchanged background refresh completes', async ({ page, request }) => {
  const sample = await ensureSampleProject(page), observed = observe(page);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await opened(page); await reach(page, '进入分集工作台');
  await enterHighlightedWorks(page);
  await expect(active(page)).toHaveText('查看分集');
  expect(await active(page).evaluate(element => element.closest('.drama-work-card')?.getAttribute('data-work-id'))).toBe(sample.drama!.workId);
  await active(page).click();
  const openEpisode = page.locator(`.drama-episode-row[data-project-id="${sample.id}"]`).getByRole('button', { name: '打开分集', exact: true });
  await expect(openEpisode).toBeVisible(); await atStep(page, '进入分集工作台');
  await expect(active(page)).toHaveText('打开分集');
  const episodes = await rpc<ProjectSummary[]>(request, 'dramaWork.episodes', { workId: sample.drama!.workId });
  const held = await holdNextRpc(page, 'dramaWork.episodes');
  try {
    await rpc<ProjectDocument>(request, 'project.create', { title: `独立刷新触发 ${randomUUID().slice(0, 8)}`, originalText: '第一场：夜班员在另一间办公室核对独立的值班记录。' });
    await held.entered;
    await expect(guide(page)).toHaveCount(0); await expect(openEpisode).toBeVisible();
    const response = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'dramaWork.episodes' && response.request().postDataJSON()?.params?.workId === sample.drama!.workId);
    held.release();
    const payload = await (await response).json(); expect(payload.error).toBeUndefined(); expect(payload.result).toEqual(episodes);
    await atStep(page, '进入分集工作台'); await expect(active(page)).toHaveText('打开分集');
    await active(page).click();
    await expect(page.locator('.workbench')).toBeVisible(); await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(sample.title);
    await atStep(page, '制作设置');
    expect((await savedProject(request, sample.id)).revision).toBe(sample.revision);
    expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
  } finally { held.release(); }
});

test('targets panel toggles when their actual workbench panels are hidden', async ({ page }) => {
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await dismissFirst(page);
  await openProjectFromList(page, sampleProjectTitle);
  await page.locator('[data-guide="outline-toggle"]').click(); await page.locator('[data-guide="inspector-toggle"]').click();
  await expect(page.locator('[data-guide="shots"]')).toBeHidden(); await expect(page.locator('[data-guide="inspector"]')).toBeHidden();
  await openGuide(page); await opened(page); const seen = await walk(page);
  expect(seen).toContain('outline-toggle'); expect(seen).toContain('inspector-toggle'); expect(seen).not.toContain('shots'); expect(seen).not.toContain('inspector');
  await expect(page.locator('[data-guide="outline-toggle"]')).toHaveAttribute('aria-pressed', 'false'); await expect(page.locator('[data-guide="inspector-toggle"]')).toHaveAttribute('aria-pressed', 'false');
  expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
});

test('does not navigate or target the hidden cached workbench when reopened from the asset library', async ({ page }) => {
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await dismissFirst(page);
  await openProjectFromList(page, sampleProjectTitle);
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
  await openCosts(page); await openProjectFromList(page, sampleProjectTitle); await expect(page.getByLabel('项目名称', { exact: true })).toBeVisible();
  expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
});

test('isolates editor shortcuts and preserves an unsaved project draft throughout a multi-step tour', async ({ page, request }) => {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `定位指引保留草稿 ${randomUUID().slice(0, 8)}`, originalText: '第一场：值班员在清晨整理桌面的维修单。第二场：他看向门外，与赶来的同事确认今天的安排。' });
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

test('continues the same tour only after a real short drama is created and preserves failed inputs', async ({ page, request }) => {
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await opened(page);
  const composer = page.locator('section.drama-composer[data-guide="create-project"]');
  await expect(active(page)).toHaveClass(/drama-composer/);
  await creationMode(composer, '上传剧本').check();
  const submit = composer.getByRole('button', { name: '创建短剧', exact: true });
  await creationInput(composer).press('Enter'); await atStep(page, '新建短剧'); expect(observed.writes).toEqual([]);
  const screenplay = '第一场：夜班员把维修单放在桌上，抬头看见熟悉的签名。';
  await sendCreationSource(composer, screenplay); await atStep(page, '新建短剧'); expect(observed.writes).toEqual([]);
  const title = '导览失败时保留输入';
  await setCreationTitle(composer, title);
  const failed = await holdNextRpc(page, 'dramaStudio.create', '隔离的新建失败');
  await submit.click(); await failed.entered; await atStep(page, '新建短剧'); await expect(submit).toBeDisabled(); failed.release();
  await expect(page.getByText('隔离的新建失败', { exact: true })).toBeVisible(); await atStep(page, '新建短剧');
  await expect(composer.getByRole('textbox', { name: '短剧名称', exact: true })).toHaveValue(title);
  await expect(composer.getByText(screenplay, { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), preference)).toBeNull();
  await setCreationTitle(composer, `导览中真实短剧 ${randomUUID().slice(0, 8)}`);
  const pending = await holdNextRpc(page, 'dramaStudio.create');
  const response = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'dramaStudio.create');
  await submit.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); }); await pending.entered;
  await expect(submit).toBeDisabled(); await atStep(page, '新建短剧'); pending.release();
  const created: { project: ProjectDocument } = (await (await response).json()).result;
  await atStep(page, '打开模型连接'); await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(created.project.title);
  expect((await savedProject(request, created.project.id)).originalText).toContain('夜班员');
  expect(observed.writes).toEqual(['dramaStudio.create', 'dramaStudio.create']); expect(observed.errors).toEqual([]);
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
    await expect(guide(page)).toHaveCount(0); pending.release(); await expect(dialog).toHaveCount(0); await atStep(page, '打开短剧工作室');
    const summary = await rpc<{ models: ModelProfile[] }>(request, 'workspace.summary'); expect(summary.models.find(model => model.name === name)).toMatchObject({ model: 'guide-local-text', baseUrl: provider.baseUrl });
    await active(page).click(); await atStep(page, '进入分集工作台'); await openHighlightedProject(page); await expect(page.getByLabel('项目名称', { exact: true })).toBeVisible(); await atStep(page, '制作设置');
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
    const confirmProduction = page.getByRole('alertdialog').getByRole('button', { name: '确认开始制作', exact: true });
    const failed = await holdNextRpc(page, 'run.start', '隔离的制作接收失败'); await active(page).click(); await confirmProduction.click(); await failed.entered; await atStep(page, '自动制作'); failed.release();
    await expect(page.getByText('隔离的制作接收失败', { exact: true })).toBeVisible(); await atStep(page, '自动制作'); expect(provider.calls).toEqual([]);
    const accepted = await holdNextRpc(page, 'run.start'), response = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'run.start');
    await active(page).click(); await confirmProduction.click(); await accepted.entered; await atStep(page, '自动制作'); accepted.release();
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

isolatedTest('guides an empty studio and preserves works and episodes through restore and archive', async ({ page, request, isolatedWorkspace }) => {
  const sample = await rpc<ProjectDocument>(request, 'project.create', { title: '空工作室恢复验收', originalText: '人物在清晨打开值班室的门。' });
  const before = await rpc<{ items: DramaWork[] }>(request, 'dramaWork.list');
  for (const work of before.items) await rpc(request, 'dramaWork.archive', { workId: work.id, revision: work.revision });
  const observed = observe(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await opened(page);
  const main = page.getByRole('main'), heading = main.getByRole('heading', { name: '短剧工作室', level: 1, exact: true });
  await expect(heading).toBeVisible();
  const seen = await walk(page); expect(seen).toEqual(['create-project', 'models', 'projects', 'help']);
  await expect(creationInput(main.getByRole('region', { name: '新建短剧', exact: true }))).toBeEnabled();
  await openWorks(page);
  await expect(main.getByRole('heading', { name: '还没有作品', exact: true })).toBeVisible();
  await expect(main.getByLabel('搜索作品', { exact: true })).toBeVisible();
  expect((await rpc<{ items: DramaWork[] }>(request, 'dramaWork.list')).items).toEqual([]);
  expect(isolatedWorkspace.origin).toBe(new URL(page.url()).origin); expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
  await page.setViewportSize({ width: 360, height: 844 });
  const filters = main.getByRole('group', { name: '作品筛选', exact: true });
  await filters.getByRole('button', { name: '已归档', exact: true }).click();
  const card = main.locator(`.drama-work-card[data-work-id="${sample.drama!.workId}"]`);
  await card.getByRole('button', { name: '查看分集', exact: true }).click();
  await main.getByRole('button', { name: '恢复作品', exact: true }).click();
  await expect(main.getByRole('button', { name: '新建分集', exact: true })).toBeEnabled();
  await main.locator(`.drama-episode-row[data-project-id="${sample.id}"]`).getByRole('button', { name: '打开分集', exact: true }).click();
  await expect(page.locator('.workbench')).toBeVisible(); await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(sample.title);
  await openWorks(page);
  await filters.getByRole('button', { name: '可用', exact: true }).click();
  await main.getByRole('searchbox', { name: '搜索作品', exact: true }).fill('');
  const restored = await rpc<DramaWork>(request, 'dramaWork.get', { workId: sample.drama!.workId });
  await rpc(request, 'dramaWork.archive', { workId: restored.id, revision: restored.revision });
  await expect(heading).toBeVisible(); await expect(main.getByRole('heading', { name: '还没有作品', exact: true })).toBeVisible();
  expect((await savedProject(request, sample.id)).archived).toBe(false);
  expect(await main.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  expect(observed.errors).toEqual([]);
});
