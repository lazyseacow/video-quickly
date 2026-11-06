import { openAdvancedWorkflow } from './production-settings';

import { expect, type APIRequestContext } from '@playwright/test';
import { createSceneTemplate, type ProjectDocument } from '@video-quickly/contracts';
import { test } from './isolated-workspace';
import { productionFixture } from './production-settings';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const viewport of [{ width: 1536, height: 960, theme: 'light' }, { width: 1024, height: 720, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }] as const) {
  test(`keeps project cards and stage settings compact and removes built-in research and review waits at ${viewport.width}px`, async ({ page, request }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
    const source = await productionFixture(request), created = source.project;
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
      workflow: { ...created.workflow, production: { ...created.workflow.production, textModelId: source.text.id, videoModelId: source.video.id }, nodes: created.workflow.nodes.map(node => node.id === 'style' ? { ...node, prompt: 'style原有提示词' } : node) },
      shots: [{ id: 'compact-shot', title: '保留的镜头', narration: '已有旁白', visualPrompt: '', durationUs: 2_000_000, sceneTemplate: createSceneTemplate('process') }],
    } });
    expect(project.workflow.nodes.map(node => node.id)).toEqual(['brief', 'style', 'script', 'assets', 'video', 'animation', 'export']);
    expect(project.workflow.nodes.every(node => !node.requiresReview)).toBe(true);
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/);
    await page.getByRole('button', { name: '我的项目', exact: true }).click(); await page.getByLabel('搜索项目', { exact: true }).fill(project.title);
    const card = page.locator('.project-card').filter({ has: page.getByRole('heading', { name: project.title, exact: true }) });
    await expect(card.locator('.project-card-body > p')).toHaveCount(0); await expect(card.locator('.project-card-body')).not.toContainText(/个镜头|1920|1080|00:02/);
    expect((await card.locator('.project-card-body').boundingBox())!.height).toBeLessThanOrEqual(116);
    await page.screenshot({ path: info.outputPath(`compact-projects-${viewport.theme}-${viewport.width}.png`) });
    await card.getByRole('button', { name: '继续创作', exact: true }).click();
    const guide = page.getByRole('region', { name: '制作指引', exact: true }); await expect(guide.locator('.workbench-guide__step')).toHaveCount(4); await expect(guide).not.toContainText('人工审阅'); await expect(guide).not.toContainText('审阅点');
    await page.getByRole('button', { name: '制作设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '制作设置', exact: true }); await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('group', { name: '制作视图', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('navigation', { name: '制作设置步骤', exact: true }).getByRole('button')).toHaveText(['1创作要求', '2模型与素材', '3声音与成片', '4确认保存']); await expect(dialog.getByRole('region', { name: '步骤指引', exact: true })).toHaveCount(0);
    await expect(dialog.getByText(/本步产出|前置步骤|后续步骤|一次确定创作方向|完成后等待人工审阅|资料与史实/)).toHaveCount(0);
    await expect(dialog.getByRole('checkbox', { name: /人工审核|人工审阅/ })).toHaveCount(0); expect((await dialog.locator('.dialog__surface').boundingBox())!.height).toBeLessThanOrEqual(viewport.height);
    await dialog.locator('summary:visible').filter({ hasText: '高级设置' }).click();
    const prompt = dialog.getByLabel('创意简报补充要求', { exact: true }); await prompt.fill('精简弹窗也保留可编辑的配置');
    await dialog.getByRole('button', { name: '确认保存', exact: true }).click(); const save = dialog.getByRole('button', { name: '保存设置', exact: true }); await expect(save).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`compact-planning-${viewport.theme}-${viewport.width}.png`) }); await save.click(); await expect(dialog).toHaveCount(0);
    const saved = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
    expect(saved.workflow.nodes.find(node => node.id === 'brief')?.prompt).toBe('精简弹窗也保留可编辑的配置');
    expect(saved.workflow.nodes.find(node => node.id === 'style')?.prompt).toBe('style原有提示词');
    await openAdvancedWorkflow(page); await page.locator('.react-flow__node[data-id="script"]').click();
    const type = page.getByLabel('步骤类型', { exact: true }); await expect(type.locator('option[value="research"], option[value="review"]')).toHaveCount(0);
    await expect(page.getByLabel('完成后人工审阅', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '返回工作台', exact: true }).click();
    await expect(page.getByRole('region', { name: '制作指引', exact: true }).locator('.workbench-guide__step')).toHaveCount(4);
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project).toEqual(saved);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
  });
}
