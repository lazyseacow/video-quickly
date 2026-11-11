import { expect, test, type Locator } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';
import { openCosts } from './workspace-settings';
import { openAssetLibrary } from './workspace-navigation';

for (const { width, theme } of [
  { width: 1536, theme: 'dark' }, { width: 1536, theme: 'light' },
  { width: 1024, theme: 'light' }, { width: 700, theme: 'dark' },
  { width: 600, theme: 'light' }, { width: 390, theme: 'light' }, { width: 360, theme: 'dark' },
]) test(`keeps library filters reachable and contained at ${width}px in ${theme}`, async ({ page, request }, info) => {
  test.setTimeout(45_000);
  const response = await request.post('/__desktop_rpc', { data: { method: 'project.create', params: { title: `筛选栏布局 ${width} ${theme}` } } });
  expect(response.ok()).toBe(true);
  const { result: project } = await response.json() as { result: ProjectDocument };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width, height: 960 });
  await page.addInitScript(value => localStorage.setItem('vq-theme', value), theme);
  await page.goto('/');
  const measurements: unknown[] = [];
  async function inspect(name: string, toolbar: Locator) {
    await expect(toolbar).toBeVisible();
    const measured = await toolbar.evaluate(element => {
      const rect = (target: Element) => { const { x, y, width, height } = target.getBoundingClientRect(); return { x, y, width, height }; };
      return { bounds: rect(element), overflow: element.scrollWidth - element.clientWidth, children: [...element.children].map(child => ({ text: child.textContent, ...rect(child) })).filter(child => child.width > 0 && child.height > 0) };
    });
    measurements.push({ name, ...measured });
    expect.soft(measured.overflow, `${name}: toolbar overflow`).toBeLessThanOrEqual(1);
    for (const child of measured.children) {
      expect.soft(child.x, `${name}: ${child.text} left edge`).toBeGreaterThanOrEqual(measured.bounds.x - 1);
      expect.soft(child.x + child.width, `${name}: ${child.text} right edge`).toBeLessThanOrEqual(measured.bounds.x + measured.bounds.width + 1);
    }
    expect.soft(await page.locator('.page-body').evaluate(element => element.scrollWidth - element.clientWidth), `${name}: page overflow`).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`${name}-${theme}-${width}.png`) });
  }
  const toolbar = () => page.locator('.content-page:visible .page-toolbar:visible');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  const search = page.getByLabel('搜索项目', { exact: true });
  await search.fill(project.title); await expect(page.locator('.project-card')).toHaveCount(1);
  await expect(page.locator('.project-card')).toContainText(project.title);
  const projectToolbar = toolbar();
  const projectFilters = projectToolbar.getByRole('group', { name: '项目筛选', exact: true });
  const projectTrash = projectFilters.getByRole('button', { name: '回收站', exact: true });
  const projectMultiSelect = projectToolbar.getByRole('button', { name: '多选', exact: true });
  await expect(projectMultiSelect).toBeEnabled();
  const filterBounds = await projectFilters.boundingBox();
  const multiSelectBounds = await projectMultiSelect.boundingBox();
  await inspect('projects', projectToolbar);
  await projectTrash.click();
  await expect(projectTrash).toHaveAttribute('aria-pressed', 'true');
  await expect(projectMultiSelect).toBeDisabled();
  await expect(search).toHaveValue(project.title);
  expect(await projectFilters.boundingBox()).toEqual(filterBounds);
  expect(await projectMultiSelect.boundingBox()).toEqual(multiSelectBounds);
  await inspect('projects-trash', projectToolbar);
  await projectFilters.getByRole('button', { name: '全部项目', exact: true }).click();
  await search.fill('');
  for (const [pageName, buttonName, artifact, view] of [
    ['模型连接', '视频模型', 'models'], ['素材库', '音频', 'assets', '媒体'],
    ['素材库', '已归档', 'characters', '角色'], ['系列模板', '已归档模板', 'templates'],
  ] as const) {
    if (view) await openAssetLibrary(page, view);
    else await page.getByRole('button', { name: pageName, exact: true }).click();
    await expect(page.getByRole('heading', { name: pageName, exact: true })).toBeVisible();
    const button = toolbar().getByRole('button', { name: buttonName, exact: true });
    await button.click(); await expect(button).toHaveClass(/active/); await inspect(artifact, toolbar());
  }
  await page.getByRole('button', { name: 'Skill 工作室', exact: true }).click();
  const skillSearch = page.getByLabel('搜索 Skill 或分组', { exact: true });
  await skillSearch.fill('没有匹配的 Skill'); await expect(page.locator('.skill-studio-group')).toHaveCount(0);
  await inspect('skills', toolbar()); await skillSearch.fill('');
  const crowdedText = await toolbar().getByRole('button', { name: '提示词实验与模板', exact: true }).evaluate(element => {
    const text = document.createRange(); text.selectNodeContents(element);
    const style = getComputedStyle(element);
    return text.getBoundingClientRect().width - (element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  });
  expect.soft(crowdedText, 'skills: action text fits within button padding').toBeLessThanOrEqual(1);
  await openCosts(page);
  await page.getByLabel('用量项目', { exact: true }).selectOption(project.id);
  await expect(page.getByLabel('用量项目', { exact: true })).toHaveValue(project.id);
  await inspect('costs', page.locator('.cost-archive-toolbar'));
  await info.attach('filter-layout-measurements', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  await expect(page).toHaveTitle(/Video Quickly/);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
});

test('recovers from project search misses and distinguishes loading, failed and empty asset filters', async ({ page, request }) => {
  const title = 'Library Search Fixture';
  const response = await request.post('/__desktop_rpc', { data: { method: 'project.create', params: { title } } });
  expect((await response.json()).result.title).toBe(title);
  await page.goto('/');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  const search = page.getByLabel('搜索项目', { exact: true });
  await search.fill('  library search fixture  ');
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await search.fill('不会匹配任何项目的关键词');
  await expect(page.getByText('没有匹配的项目', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();

  let rejectFirstRead!: () => void;
  const pendingRead = new Promise<void>(resolve => { rejectFirstRead = resolve; });
  let failRead = true;
  await page.route('**/__desktop_rpc', async route => {
    const { method, params } = route.request().postDataJSON();
    if (method !== 'asset.list' || params.kind !== 'audio') return route.continue();
    if (failRead) {
      await pendingRead;
      return route.fulfill({ status: 503, json: { error: '素材读取暂时失败' } });
    }
    return route.fulfill({ json: { result: { items: [], nextCursor: null } } });
  });
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  await expect(page.locator('.asset-card').first()).toBeVisible();
  await page.getByRole('button', { name: '音频', exact: true }).click();
  try {
    await expect(page.getByText('正在读取素材…', { exact: true })).toHaveAttribute('role', 'status');
    await expect(page.locator('.asset-card')).toHaveCount(0);
    await expect(page.getByText('没有此类素材', { exact: true })).toHaveCount(0);
  } finally { rejectFirstRead(); }
  await expect(page.getByRole('alert')).toContainText('素材读取暂时失败');
  await expect(page.getByText('没有此类素材', { exact: true })).toHaveCount(0);
  failRead = false;
  await page.getByRole('button', { name: '重试读取素材', exact: true }).click();
  await expect(page.getByText('没有此类素材', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看全部素材', exact: true }).click();
  await expect(page.getByRole('button', { name: '全部', exact: true, pressed: true })).toBeFocused();
  await expect(page.locator('.asset-card').first()).toBeVisible();
});
