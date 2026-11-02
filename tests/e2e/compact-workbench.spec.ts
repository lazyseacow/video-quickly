import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import { createSceneTemplate, type ProjectDocument, type RunRecord } from '@video-quickly/contracts';
import { test } from './isolated-workspace';
import { legacyHistoryWorkflow } from '../fixtures/legacy-workflow';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const viewport of [{ width: 1536, height: 960, theme: 'light' }, { width: 1024, height: 720, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }] as const) {
  test(`keeps project cards and stage settings compact and removes built-in research and review waits at ${viewport.width}px`, async ({ page, request }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `精简制作 ${randomUUID().slice(0, 6)}`, templateId: 'history-handdrawn' });
    const legacy = legacyHistoryWorkflow();
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
      workflow: { ...legacy, nodes: legacy.nodes.map(node => ({ ...node, label: created.workflow.nodes.find(current => current.id === node.id)?.label ?? node.label, modelId: undefined })) },
      shots: [{ id: 'compact-shot', title: '保留的镜头', narration: '已有旁白', visualPrompt: '', durationUs: 2_000_000, sceneTemplate: createSceneTemplate('process') }],
    } });
    expect(project.workflow.nodes.map(node => node.id)).toEqual(['brief', 'style', 'script', 'assets', 'voice', 'animation', 'export']);
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
    await guide.getByRole('button', { name: '配置阶段：策划与分镜', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '策划与分镜', exact: true }); await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab')).toHaveText(['创意简报', '风格与角色', '旁白与分镜']); await expect(dialog.getByRole('region', { name: '步骤指引', exact: true })).toHaveCount(0);
    await expect(dialog.getByText(/本步产出|前置步骤|后续步骤|一次确定创作方向|完成后等待人工审阅|资料与史实/)).toHaveCount(0);
    await expect(dialog.getByRole('checkbox', { name: /人工审核|人工审阅/ })).toHaveCount(0); expect((await dialog.locator('.dialog__surface').boundingBox())!.height).toBeLessThanOrEqual(560);
    const prompt = dialog.getByLabel('创意简报提示词与补充要求', { exact: true }); await prompt.fill('精简弹窗也保留可编辑的配置');
    const save = dialog.getByRole('button', { name: '保存阶段配置', exact: true }); await expect(save).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`compact-planning-${viewport.theme}-${viewport.width}.png`) }); await save.click(); await expect(dialog).toHaveCount(0);
    const saved = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
    expect(saved.workflow.nodes.find(node => node.id === 'brief')?.prompt).toBe('精简弹窗也保留可编辑的配置');
    expect(saved.workflow.nodes.find(node => node.id === 'style')?.prompt).toBe('style原有提示词');
    await page.getByRole('button', { name: '流程', exact: true }).click(); await page.locator('.react-flow__node[data-id="script"]').click();
    const type = page.getByLabel('步骤类型', { exact: true }); await expect(type.locator('option[value="research"], option[value="review"]')).toHaveCount(0);
    await expect(page.getByLabel('完成后人工审阅', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '分镜', exact: true }).click();
    const run = await rpc<RunRecord>(request, 'run.start', { projectId: project.id, nodeId: 'script' });
    await expect.poll(async () => (await rpc<RunRecord>(request, 'run.get', { runId: run.id })).status).toBe('succeeded');
    const progress = page.getByRole('region', { name: '当前制作', exact: true }); await expect(progress.locator('.workbench-guide__step')).toHaveCount(4);
    await expect(progress.getByRole('button', { name: '通过审阅并继续', exact: true })).toHaveCount(0);
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project).toEqual(saved);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
  });
}
