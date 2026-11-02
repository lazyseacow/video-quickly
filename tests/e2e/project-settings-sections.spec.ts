import { openProjectFromList } from './workspace-navigation';
import { closeProjectSettings } from './settings';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 1024, height: 720, theme: 'light' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`edits project settings in one independent dialog across shots and navigation at ${viewport.width}px`, async ({ page, request }, info) => {
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `项目分类验收 ${viewport.width}`, profile: { width: 320, height: 180, frameRate: { numerator: 24, denominator: 1 }, fitMode: 'contain', previewScale: 1 } });
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: ['第一镜头', '第二镜头'].map((title, index) => ({ id: `settings-shot-${index}`, title, narration: '保留所有输入与真实预览。', visualPrompt: '', durationUs: 1_000_000 })) } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    await page.goto('/'); await openProjectFromList(page, project.title); await page.setViewportSize(viewport);
    const settings = page.getByRole('button', { name: '项目设置', exact: true });
    await expect(settings).toHaveCount(1); await expect(page.locator('.inspector').getByRole('button', { name: '项目设置', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /预览设置|编辑视频规格/ })).toHaveCount(0);
    await settings.click();
    const dialog = page.getByRole('dialog', { name: '项目设置', exact: true }), panel = dialog.locator('.project-settings-panel'), nav = panel.getByRole('tablist', { name: '项目设置分类' });
    await expect(nav).toHaveAttribute('aria-orientation', 'horizontal'); await expect(nav.getByRole('tab')).toHaveText(['创作', '画面', '声音']);
    const brief = `主题与问题 ${viewport.width}`, style = '淡雅青绿，使用一致的字幕和画面风格。';
    await panel.getByLabel('主题与核心问题', { exact: true }).fill(brief); await panel.getByLabel('系列风格', { exact: true }).fill(style);
    await panel.getByRole('tab', { name: '声音', exact: true }).click(); await panel.getByRole('button', { name: '背景音乐', exact: true }).click();
    const music = page.getByRole('dialog', { name: '背景音乐', exact: true }); await expect(music).toBeVisible(); await expect(dialog).toHaveCount(0);
    await music.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(music).toHaveCount(0); await settings.click();
    await expect(panel.getByRole('tab', { name: '声音', exact: true })).toHaveAttribute('aria-selected', 'true');
    await panel.getByRole('tab', { name: '声音', exact: true }).focus(); await page.keyboard.press('ArrowRight');
    await expect(panel.getByRole('tab', { name: '创作', exact: true })).toBeFocused();
    await expect(panel.getByLabel('主题与核心问题', { exact: true })).toHaveValue(brief); await expect(panel.getByLabel('系列风格', { exact: true })).toHaveValue(style);
    await panel.getByRole('tab', { name: '画面', exact: true }).click(); await panel.getByLabel('画面比例', { exact: true }).selectOption('9:16'); await panel.getByLabel('预览质量', { exact: true }).selectOption('0.5');
    const layout = await panel.evaluate(element => {
      const body = element.parentElement!, footer = element.querySelector('.project-settings-panel__footer')!, content = element.querySelector('.settings-sections__content')!;
      return { outerScroll: body.scrollHeight - body.clientHeight, footerBottom: footer.getBoundingClientRect().bottom, bodyBottom: body.getBoundingClientRect().bottom, contentBottom: content.getBoundingClientRect().bottom, footerTop: footer.getBoundingClientRect().top };
    });
    expect(layout.outerScroll).toBeLessThanOrEqual(1); expect(layout.footerBottom).toBeLessThanOrEqual(layout.bodyBottom + 1); expect(layout.contentBottom).toBeLessThanOrEqual(layout.footerTop + 1);
    const save = panel.getByRole('button', { name: '保存项目设置', exact: true }); await expect(save).toBeInViewport({ ratio: 1 }); await expect(panel.getByRole('button', { name: '备份项目与素材', exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`project-settings-${viewport.width}.png`) }); await save.click(); await expect(save).toBeDisabled(); await closeProjectSettings(page);
    await page.locator('.outline-shot').nth(1).click(); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('第二镜头'); await expect(settings).toHaveCount(1);
    await page.getByRole('button', { name: '素材库', exact: true }).click(); await openProjectFromList(page); await settings.click();
    await expect(panel.getByRole('tab', { name: '画面', exact: true })).toHaveAttribute('aria-selected', 'true'); await panel.getByRole('tab', { name: '创作', exact: true }).click(); await expect(panel.getByLabel('主题与核心问题', { exact: true })).toHaveValue(brief);
    const saved = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
    expect(saved).toMatchObject({ brief, style, profile: { width: 180, height: 320, previewScale: .5 } }); expect(saved.shots).toEqual(project.shots); expect(errors).toEqual([]);
  });
}
