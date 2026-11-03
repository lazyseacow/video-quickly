import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';
import { openProjectFromList } from './workspace-navigation';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) test('changes preview quality locally without editing production settings at ' + viewport.width + 'px', async ({ page, request }, info) => {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: '预览质量 ' + randomUUID().slice(0, 8), profile: { width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, previewScale: 1 } });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [{ id: 'preview-shot', title: '预览镜头', narration: '', visualPrompt: '', durationUs: 1_000_000 }] } });
  const writes: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) { const method = request.postDataJSON()?.method; if (['project.update', 'workflow.save', 'run.start', 'render.export'].includes(method)) writes.push(method); } });
  await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
  await page.goto('/'); await openProjectFromList(page, project.title);
  const quality = page.locator('.preview-toolbar').getByRole('combobox', { name: '预览质量', exact: true }), canvas = page.locator('.preview-frame canvas');
  await expect(quality).toHaveValue('1'); await expect(quality).toBeInViewport();
  await quality.selectOption('0.25'); await expect(canvas).toHaveJSProperty('width', 160); await expect(canvas).toHaveJSProperty('height', 90);
  await expect(page.locator('.unsaved-dot')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('preview-quality-' + viewport.width + '.png') });
  await page.reload(); await openProjectFromList(page, project.title);
  await expect(quality).toHaveValue('0.25'); await expect(canvas).toHaveJSProperty('width', 160);
  await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '制作设置', exact: true });
  await expect(dialog.getByRole('navigation', { name: '制作设置步骤', exact: true }).getByRole('button')).toHaveText(['1创作要求', '2模型与素材', '3声音与成片', '4确认保存']);
  await expect(dialog.getByLabel('预览质量', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '备份项目与素材', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('production-sections-' + viewport.width + '.png') });
  expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project).toEqual(project);
  expect(writes).toEqual([]); expect(errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

test('backs up a project from its card, retries failures and ignores repeated submissions', async ({ page, request }, info) => {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title: '项目卡片备份 ' + randomUUID().slice(0, 8) });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/'); await page.getByRole('button', { name: '我的项目', exact: true }).click();
  const card = page.locator('.project-card').filter({ has: page.getByRole('heading', { name: project.title, exact: true }) });
  const backup = card.getByRole('button', { name: `备份“${project.title}”`, exact: true });
  let attempts = 0, enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/__desktop_rpc', async route => {
    if (route.request().postDataJSON()?.method !== 'project.backup') { await route.continue(); return; }
    attempts++;
    if (attempts === 1) { await route.fulfill({ status: 400, json: { error: '隔离的备份失败' } }); return; }
    enter(); await pending; await route.continue();
  });
  try {
    await backup.click(); await expect(page.getByRole('alert')).toContainText('隔离的备份失败'); await expect(backup).toBeEnabled();
    const response = page.waitForResponse(value => value.url().endsWith('/__desktop_rpc') && value.request().postDataJSON()?.method === 'project.backup');
    await backup.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); }); await entered;
    await expect(backup).toBeDisabled(); expect(attempts).toBe(2); release();
    const result = (await (await response).json()).result;
    await expect(page.locator('.notice--success')).toContainText(result.path); await expect(backup).toBeEnabled();
    await card.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('project-card-backup.png') });
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project).toEqual(project);
  } finally { release(); }
});
