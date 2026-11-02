import { openProjectFromList } from './workspace-navigation';
import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';
import { test } from './isolated-workspace';
import { openCosts, openGuide, openWorkspaceSettings } from './workspace-settings';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const viewport of [{ width: 1536, height: 960, theme: 'light' }, { width: 1024, height: 720, theme: 'dark' }, { width: 390, height: 844, theme: 'dark' }] as const) {
  test.describe(`workspace settings at ${viewport.width}px`, () => {
    test.use({ storageState: async ({ isolatedWorkspace }, use) => { await use({ cookies: [], origins: [{ origin: isolatedWorkspace.origin, localStorage: [{ name: 'vq-theme', value: viewport.theme }, { name: 'vq-onboarding-v1', value: 'done' }] }] }); } });
    test(`groups the sidebar and anchors capsule appearance settings at the bottom left at ${viewport.width}px`, async ({ page, request }, info) => {
      const errors: string[] = [], writes: string[] = [];
      page.on('pageerror', error => errors.push(error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
      page.on('request', request => { if (request.url().endsWith('/__desktop_rpc') && /^(project\.(create|update)|run\.(start|review)|render\.export)$/.test(request.postDataJSON()?.method)) writes.push(request.postDataJSON().method); });
      for (let index = 0; index < 6; index++) await rpc(request, 'project.create', { title: `最近项目 ${index} ${randomUUID().slice(0, 8)}` });
      await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/);
      const sidebar = page.getByRole('complementary', { name: '工作空间导航', exact: true }), settings = sidebar.getByRole('button', { name: '设置', exact: true });
      for (const [label, names] of [['主导航', ['我的项目', '制作记录']], ['资源导航', ['素材库', '角色参考库', '系列模板']], ['工具导航', ['模型连接', 'Skill 工作室']]] as const) {
        const navigation = sidebar.getByRole('navigation', { name: label, exact: true }); await expect(navigation.getByRole('button')).toHaveCount(names.length);
        for (const name of names) await expect(navigation.getByRole('button', { name, exact: true })).toHaveCount(1);
      }
      for (const name of ['我的项目', '制作记录', '素材库', '角色参考库', '系列模板', '模型连接', 'Skill 工作室']) {
        const control = sidebar.locator('.sidebar-rail').getByRole('button', { name, exact: true }); await expect(control.locator('span')).toHaveCount(0); await control.hover(); await expect(page.getByRole('tooltip')).toHaveText(name); await expect(page.getByRole('tooltip')).toBeInViewport({ ratio: 1 }); await page.mouse.move(viewport.width - 1, viewport.height - 1); await expect(page.getByRole('tooltip')).toHaveCount(0);
      }
      const assets = sidebar.getByRole('button', { name: '素材库', exact: true }); await assets.focus(); await expect(page.getByRole('tooltip')).toHaveText('素材库'); await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).toHaveCount(0);
      expect((await sidebar.boundingBox())!.width).toBe(52); await expect(sidebar.locator('.sidebar-panel, .sidebar-projects')).toHaveCount(0); await expect(sidebar.getByRole('button', { name: '创作工作台', exact: true })).toHaveCount(0); await expect(sidebar.getByText('项目', { exact: true })).toHaveCount(0); await expect(sidebar.locator('.sidebar-footer button')).toHaveCount(1);
      for (const name of ['Token 消耗', '使用指南', '浅色外观', '深色外观']) await expect(sidebar.getByRole('button', { name, exact: true })).toHaveCount(0);
      await expect(page.locator('.statusbar')).toHaveCount(0); await expect(page.getByText(/媒体引擎已就绪|媒体引擎待配置|播放 \/ 暂停/, { exact: true })).toHaveCount(0);
      const frame = await page.locator('.main-shell').evaluate(element => {
        const style = getComputedStyle(element), box = element.getBoundingClientRect();
        return { radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius], overflow: style.overflow, corners: [[box.left + 2, box.top + 2], [box.right - 2, box.top + 2], [box.left + 2, box.bottom - 2], [box.right - 2, box.bottom - 2]].map(([x, y]) => element.contains(document.elementFromPoint(x!, y!))) };
      });
      expect(frame.radii).toEqual(['16px', '16px', '16px', '16px']); expect(frame.overflow).toBe('hidden'); expect(frame.corners).toEqual([false, false, false, false]);
      await page.screenshot({ path: info.outputPath(`workspace-rail-${viewport.theme}-${viewport.width}.png`) });
      await expect(settings).toBeInViewport({ ratio: 1 }); await settings.focus(); await settings.press('Enter');
      const popup = page.getByRole('dialog', { name: '设置', exact: true }); await expect(popup).toBeVisible(); await expect(popup).toBeInViewport({ ratio: 1 });
      await expect.poll(async () => { const box = await popup.boundingBox(), anchor = await settings.boundingBox(); return Boolean(box && anchor && box.x <= 24 && box.y + box.height <= anchor.y - 4 && box.x + box.width <= viewport.width); }).toBe(true);
      expect((await popup.boundingBox())!.width).toBeLessThanOrEqual(280);
      const appearance = popup.getByRole('group', { name: '外观', exact: true });
      expect(await appearance.evaluate(element => parseFloat(getComputedStyle(element).borderRadius) >= element.getBoundingClientRect().height / 2)).toBe(true);
      await expect(appearance.getByRole('button', { name: viewport.theme === 'light' ? '浅色外观' : '深色外观', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await page.screenshot({ path: info.outputPath(`sidebar-settings-${viewport.theme}-${viewport.width}.png`) });
      const changed = viewport.theme === 'light' ? 'dark' : 'light'; await appearance.getByRole('button', { name: changed === 'dark' ? '深色外观' : '浅色外观', exact: true }).click(); await expect(page.locator('html')).toHaveAttribute('data-theme', changed); await expect(popup).toBeVisible();
      await page.keyboard.press('Escape'); await expect(popup).toHaveCount(0); await expect(settings).toBeFocused();
      await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme', changed); await openWorkspaceSettings(page); await settings.click(); await expect(popup).toHaveCount(0);
      await openWorkspaceSettings(page); await sidebar.getByRole('button', { name: '我的项目', exact: true }).click(); await expect(popup).toHaveCount(0); await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
      await openCosts(page); await expect(settings).toHaveAttribute('aria-current', 'page'); await openGuide(page); await expect(page.locator('[data-guide-popover]').getByRole('heading')).toHaveText('新建创作项目'); await page.keyboard.press('Escape'); await expect(page.locator('[data-guide-popover]')).toHaveCount(0); await expect(settings).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(writes).toEqual([]); expect(errors).toEqual([]);
    });
  });
}

test('preserves a dirty draft through appearance and guide settings and saves it before opening Token usage', async ({ page, request }) => {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `设置保留草稿 ${randomUUID().slice(0, 8)}` });
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [{ id: 'settings-shot', title: '原镜头', narration: '', visualPrompt: '', durationUs: 1_000_000 }] } });
  await page.goto('/'); await openProjectFromList(page, project.title); const title = page.getByLabel('镜头标题', { exact: true }); await title.fill('设置期间保留的草稿');
  const settings = await openWorkspaceSettings(page); await settings.getByRole('button', { name: '浅色外观', exact: true }).click(); await page.keyboard.press('Escape'); await expect(title).toHaveValue('设置期间保留的草稿');
  await openGuide(page); await page.keyboard.press('Escape'); await expect(page.locator('[data-guide-popover]')).toHaveCount(0); await expect(title).toHaveValue('设置期间保留的草稿');
  expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project).toEqual(project);
  await openCosts(page); await expect.poll(async () => (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project.shots[0].title).toBe('设置期间保留的草稿');
  await openProjectFromList(page); await expect(title).toHaveValue('设置期间保留的草稿');
});

test('opens the anchored Settings from the last guide target and can restart the guide from there', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await openGuide(page);
  const guide = page.locator('[data-guide-popover]');
  for (let index = 0; index < 20; index++) {
    const previous = await guide.getByRole('heading').innerText(); if (previous === '随时重开指引') break;
    await guide.getByRole('button', { name: '下一步', exact: true }).click(); await expect(guide.getByRole('heading')).not.toHaveText(previous);
  }
  await expect(guide.getByRole('heading')).toHaveText('随时重开指引'); await page.locator('[data-guide="help"].driver-active-element').click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true }); await expect(settings).toBeVisible(); await expect(guide).toHaveCount(0);
  await settings.getByRole('button', { name: '使用指南', exact: true }).click(); await expect(settings).toHaveCount(0); await expect(guide.getByRole('heading')).toHaveText('新建创作项目'); await page.keyboard.press('Escape'); await expect(guide).toHaveCount(0); await expect(page.getByRole('button', { name: '设置', exact: true })).toBeFocused();
});
