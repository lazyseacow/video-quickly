import { openWorks, openProjectFromList } from './workspace-navigation';

import { expect, type APIRequestContext } from '@playwright/test';
import { createSceneTemplate, type ProjectDocument } from '@video-quickly/contracts';
import { test } from './isolated-workspace';
import { productionFixture, productionStep } from './production-settings';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const viewport of [{ width: 1536, height: 960, theme: 'light' }, { width: 1464, height: 900, theme: 'dark' }, { width: 1100, height: 800, theme: 'light' }, { width: 1024, height: 720, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }] as const) {
  test(`keeps project cards and stage settings compact and removes built-in research and review waits at ${viewport.width}px`, async ({ page, request }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
    const source = await productionFixture(request), created = source.project;
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
      workflow: { ...created.workflow, production: { ...created.workflow.production, textModelId: source.text.id, videoModelId: source.video.id }, nodes: created.workflow.nodes.map(node => node.id === 'style' ? { ...node, prompt: 'style原有提示词', modelId: source.override.id, config: { ...node.config, modelOverride: true } } : node) },
      shots: [{ id: 'compact-shot', title: '保留的镜头', narration: '已有旁白', visualPrompt: '', durationUs: 2_000_000, sceneTemplate: createSceneTemplate('process') }],
    } });
    expect(project.workflow.nodes.map(node => node.id)).toEqual(['screenplay', 'brief', 'style', 'script', 'assets', 'video', 'animation', 'export']);
    expect(project.workflow.nodes.every(node => !node.requiresReview)).toBe(true);
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/);
    await openWorks(page); await page.getByLabel('搜索作品', { exact: true }).fill(project.title);
    const card = page.locator('.drama-work-card').filter({ has: page.getByRole('heading', { name: project.title, exact: true }) });
    await expect(card.getByRole('heading')).toHaveText(project.title);
    await expect(card).toContainText('1 集'); await expect(card).toContainText('最近编辑');
    await expect(card).not.toContainText(/个镜头|1920|1080|00:02/);
    const libraryBounds = (await page.locator('.drama-library').boundingBox())!;
    const cardBounds = (await card.boundingBox())!;
    expect(cardBounds.x).toBeGreaterThanOrEqual(libraryBounds.x);
    expect(cardBounds.x + cardBounds.width).toBeLessThanOrEqual(libraryBounds.x + libraryBounds.width);
    await page.screenshot({ path: info.outputPath(`compact-projects-${viewport.theme}-${viewport.width}.png`) });
    await openProjectFromList(page, project.title);
    for (const [group, names] of [
      ['分集文稿', ['分集剧本', '场次与对白']],
      ['制作操作', ['制作设置', '制作前检查', '开始制作', '导出']],
    ] as const) {
      const actions = page.getByRole('group', { name: group, exact: true });
      const buttons = actions.getByRole('button');
      await expect(buttons).toHaveCount(names.length);
      const actionBounds = (await actions.boundingBox())!;
      for (const [index, name] of names.entries()) {
        const button = buttons.nth(index);
        await expect(button).toHaveAccessibleName(name);
        await expect(button).toBeInViewport({ ratio: 1 });
        const bounds = (await button.boundingBox())!;
        expect(bounds.x, `${name} left edge`).toBeGreaterThanOrEqual(actionBounds.x);
        expect(bounds.x + bounds.width, `${name} right edge`).toBeLessThanOrEqual(Math.min(viewport.width, actionBounds.x + actionBounds.width) + 1);
      }
    }
    for (const name of ['后期工具', '收起镜头导航', '切换属性面板', '专注预览', '撤销', '重做', '保存修改']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
    }
    await expect(page.locator('.project-heading').getByRole('button', { name: '更多', exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`compact-workbench-actions-${viewport.theme}-${viewport.width}.png`) });
    const guide = page.getByRole('region', { name: '制作指引', exact: true }); await expect(guide.locator('.workbench-guide__step')).toHaveCount(4); await expect(guide).not.toContainText('人工审阅'); await expect(guide).not.toContainText('审阅点');
    await page.getByRole('button', { name: '制作设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '制作设置', exact: true }); await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('group', { name: '制作视图', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('navigation', { name: '制作设置步骤', exact: true }).getByRole('button')).toHaveText(['1创作要求', '2模型与素材', '3声音与成片', '4确认保存']); await expect(dialog.getByRole('region', { name: '步骤指引', exact: true })).toHaveCount(0);
    await expect(dialog.getByText(/本步产出|前置步骤|后续步骤|一次确定创作方向|完成后等待人工审阅|资料与史实/)).toHaveCount(0);
    await expect(dialog.getByRole('checkbox', { name: /人工审核|人工审阅/ })).toHaveCount(0); expect((await dialog.locator('.dialog__surface').boundingBox())!.height).toBeLessThanOrEqual(viewport.height);
    await expect(dialog.getByText('高级设置', { exact: true })).toHaveCount(0);
    const creativeSkills = dialog.getByRole('button', { name: '创作 Skill', exact: true });
    await expect(creativeSkills).toBeVisible();
    await dialog.getByLabel('简报内容', { exact: true }).fill('精简弹窗也保留可编辑的配置');
    await creativeSkills.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`planning-settings-${viewport.theme}-${viewport.width}.png`) });
    await productionStep(dialog, '模型与素材');
    await expect(dialog.getByText('高级设置', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('combobox', { name: '文本模型', exact: true })).toHaveValue(source.text.name);
    await expect(dialog.getByRole('region', { name: '生成并发', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: '确认保存', exact: true }).click(); const save = dialog.getByRole('button', { name: '保存设置', exact: true }); await expect(save).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`compact-planning-${viewport.theme}-${viewport.width}.png`) }); await save.click(); await expect(dialog).toHaveCount(0);
    const saved = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
    expect(saved.brief).toBe('精简弹窗也保留可编辑的配置');
    expect(saved.workflow.nodes.find(node => node.id === 'brief')?.prompt).toBe(project.workflow.nodes.find(node => node.id === 'brief')?.prompt);
    expect(saved.workflow.nodes.find(node => node.id === 'style')).toMatchObject({ prompt: 'style原有提示词', modelId: source.override.id, config: { modelOverride: true } });
    expect(saved.workflow.nodes.map(node => node.kind)).not.toContain('research');
    expect(saved.workflow.nodes.some(node => node.kind === 'review' || node.requiresReview)).toBe(false);
    await expect(page.getByRole('region', { name: '制作指引', exact: true }).locator('.workbench-guide__step')).toHaveCount(4);
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project).toEqual(saved);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
  });
}
