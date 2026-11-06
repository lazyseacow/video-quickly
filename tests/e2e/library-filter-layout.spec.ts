import { expect, test, type Locator } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';
import { openCosts } from './workspace-settings';

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
  const toolbar = () => page.locator('.content-page:visible .page-toolbar');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  const search = page.getByLabel('搜索项目', { exact: true });
  await search.fill(project.title); await expect(page.locator('.project-card')).toHaveCount(1);
  await expect(page.locator('.project-card')).toContainText(project.title);
  await inspect('projects', toolbar()); await search.fill('');
  await page.getByRole('button', { name: '作品与分集', exact: true }).click();
  const archived = page.getByRole('checkbox', { name: '已归档作品', exact: true });
  await archived.check(); await expect(archived).toBeChecked(); await inspect('works', toolbar());
  const checkboxOffset = await archived.evaluate(element => {
    const checkbox = element.getBoundingClientRect(), label = element.closest('label')!.getBoundingClientRect();
    return Math.abs(checkbox.y + checkbox.height / 2 - label.y - label.height / 2);
  });
  expect.soft(checkboxOffset, 'works: checkbox and label alignment').toBeLessThanOrEqual(1);
  for (const [pageName, buttonName, artifact] of [
    ['模型连接', '视频模型', 'models'], ['素材库', '音频', 'assets'],
    ['角色参考库', '已归档', 'characters'], ['系列模板', '已归档模板', 'templates'],
  ]) {
    await page.getByRole('button', { name: pageName, exact: true }).click();
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
