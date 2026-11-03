import { expect, type APIRequestContext } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';
import { test } from './isolated-workspace';
import { openProjectFromList } from './workspace-navigation';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const viewport of [{ width: 1536, height: 960 }, { width: 390, height: 844 }]) {
  test(`removes reference tools and production summary, and displays unavailable models at ${viewport.width}px`, async ({ page, request }, info) => {
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `工作台精简 ${viewport.width}` });
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
      referenceDisplay: 'numbers', claims: [{ id: 'legacy-claim', text: '旧项目中的主张', source: '旧资料' }],
      shots: [{ id: 'legacy-shot', title: '保留的镜头', narration: '保留的旁白。', visualPrompt: '', durationUs: 1_000_000, claimIds: ['legacy-claim'] }],
    } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await page.setViewportSize(viewport); await page.goto('/'); await openProjectFromList(page, project.title);
    await expect(page.getByRole('button', { name: /资料引用|资料与事实主张|管理资料与引用/ })).toHaveCount(0);
    await expect(page.locator('.inspector')).not.toContainText(/待核验|已核验|引用已失效/);
    await page.getByRole('region', { name: '制作指引', exact: true }).getByRole('button', { name: '打开阶段：策划与分镜', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '制作设置', exact: true });
    for (const label of ['文本模型', '视频模型']) {
      const select = editor.getByRole('combobox', { name: label, exact: true }); await expect(select).toHaveValue('');
      await select.click(); await expect(editor.getByRole('listbox').getByRole('option')).toHaveCount(0); await select.press('Escape');
    }
    await editor.getByRole('button', { name: '保存并开始制作', exact: true }).click(); await expect(editor).toContainText('请为「创意简报」选择可用的模型');
    await expect(editor.getByRole('button', { name: '添加模型连接', exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`no-available-models-${viewport.width}.png`) }); await editor.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click(); const settings = page.getByRole('dialog', { name: '制作设置', exact: true });
    await expect(settings.getByRole('tab', { name: '资料', exact: true })).toHaveCount(0); await expect(settings.getByLabel('画面引用编号', { exact: true })).toHaveCount(0); await settings.getByRole('button', { name: '关闭对话框', exact: true }).click();
    const rejected = await request.post('/__desktop_rpc', { data: { method: 'run.start', params: { projectId: project.id, nodeId: 'script' } } });
    expect(rejected.ok()).toBe(false); expect((await rejected.json()).error).toContain('选择可用的模型');
    const progress = page.getByRole('region', { name: '制作指引', exact: true }); await expect(progress.locator('.workbench-guide__step')).toHaveCount(4);
    await expect(progress.locator('.workbench-production__summary')).toHaveCount(0); await page.screenshot({ path: info.outputPath(`compact-production-${viewport.width}.png`) });
    const saved = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
    expect(saved.claims).toEqual(project.claims); expect(saved.shots[0].claimIds).toEqual(['legacy-claim']); expect(errors).toEqual([]);
  });
}
