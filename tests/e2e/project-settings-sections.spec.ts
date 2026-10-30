import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }); const payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 1024, height: 720, theme: 'light' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`retains project edits across categories and navigation with a fixed save action at ${viewport.width}px`, async ({ page, request }, info) => {
    test.setTimeout(60000);
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `项目分类验收 ${viewport.width}`, profile: { width: 320, height: 180, frameRate: { numerator: 24, denominator: 1 }, fitMode: 'contain', previewScale: 1 } });
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [{ id: 'settings-shot', title: '分类设置镜头', narration: '保留所有输入与真实预览。', visualPrompt: '', durationUs: 1_000_000 }] } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    await page.goto('/'); await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('分类设置镜头');
    await page.setViewportSize(viewport); await page.getByRole('button', { name: '项目设置', exact: true }).click();
    const panel = page.locator('.project-settings-panel'); const nav = panel.getByRole('tablist', { name: '项目设置分类' });
    await expect(nav).toHaveAttribute('aria-orientation', 'horizontal'); await expect(nav.getByRole('tab')).toHaveCount(4);
    const brief = `主题与问题 ${viewport.width}`, style = '淡雅青绿，使用一致的字幕和画面风格。';
    await panel.getByLabel('主题与核心问题', { exact: true }).fill(brief); await panel.getByLabel('系列风格', { exact: true }).fill(style);
    await panel.getByRole('tab', { name: '声音', exact: true }).click();
    await panel.getByRole('button', { name: '背景音乐', exact: true }).click();
    const music = page.getByRole('dialog', { name: '背景音乐', exact: true }); await expect(music).toBeVisible();
    await music.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(music).toHaveCount(0);
    await panel.getByRole('tab', { name: '声音', exact: true }).focus(); await page.keyboard.press('ArrowRight');
    await expect(panel.getByRole('tab', { name: '资料', exact: true })).toBeFocused();
    await panel.getByLabel('画面引用编号', { exact: true }).selectOption('numbers');
    await panel.getByRole('tab', { name: '创作', exact: true }).click();
    await expect(panel.getByLabel('主题与核心问题', { exact: true })).toHaveValue(brief); await expect(panel.getByLabel('系列风格', { exact: true })).toHaveValue(style);
    await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('project-settings-creative.png') });
    await panel.getByRole('tab', { name: '画面', exact: true }).click(); await panel.getByLabel('画面比例', { exact: true }).selectOption('9:16');
    await panel.getByLabel('预览质量', { exact: true }).selectOption('0.5');
    await expect(panel.locator('[role="tabpanel"]:visible')).toHaveCount(1);
    const layout = await panel.evaluate(element => {
      const body = element.parentElement!, footer = element.querySelector('.project-settings-panel__footer')!, nav = element.querySelector('[role="tablist"]')!, content = element.querySelector('.settings-sections__content')!;
      return { outerScroll: body.scrollHeight - body.clientHeight, footerBottom: footer.getBoundingClientRect().bottom, bodyBottom: body.getBoundingClientRect().bottom, contentBottom: content.getBoundingClientRect().bottom, footerTop: footer.getBoundingClientRect().top, navScroll: nav.scrollWidth - nav.clientWidth };
    });
    expect(layout.outerScroll).toBeLessThanOrEqual(1); expect(layout.navScroll).toBeLessThanOrEqual(1);
    expect(layout.footerBottom).toBeLessThanOrEqual(layout.bodyBottom + 1); expect(layout.contentBottom).toBeLessThanOrEqual(layout.footerTop + 1);
    await panel.scrollIntoViewIfNeeded(); await expect(panel.locator('.project-settings-panel__footer')).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('project-settings-video.png') });
    await panel.getByRole('button', { name: '保存', exact: true }).click(); await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '素材库', exact: true }).click(); await expect(page.getByRole('heading', { name: '素材库', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '创作工作台', exact: true }).click(); await expect(panel.getByRole('tab', { name: '画面', exact: true })).toHaveAttribute('aria-selected', 'true');
    await panel.getByRole('tab', { name: '创作', exact: true }).click(); await expect(panel.getByLabel('主题与核心问题', { exact: true })).toHaveValue(brief);
    const saved = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
    expect(saved).toMatchObject({ brief, style, referenceDisplay: 'numbers', profile: { width: 180, height: 320, previewScale: .5 } }); expect(saved.shots).toEqual(project.shots);
    await page.getByRole('button', { name: '预览设置', exact: true }).click(); await expect(panel.getByRole('tab', { name: '画面', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(errors).toEqual([]);
  });
}
