import { openStoryboardProfile, productionStep, saveProduction } from './production-settings';
import { openProjectFromList } from './workspace-navigation';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }), payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const grouped of [true, false]) test('keeps global project settings available for ' + (grouped ? 'grouped' : 'ungrouped') + ' custom workflows', async ({ page, request }) => {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: '自定义流程的项目设置 ' + grouped });
  const stages = grouped ? [{ id: 'custom', label: '自定义创作阶段', description: '', nodeIds: created.workflow.nodes.map(node => node.id) }] : undefined;
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { workflow: { ...created.workflow, id: 'custom-project-settings', stages } } });
  await page.goto('/'); await openProjectFromList(page, project.title);
  await expect(page.locator('.workbench-guide__step')).toHaveCount(grouped ? 1 : created.workflow.nodes.length);
  await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '制作设置', exact: true });
  await productionStep(dialog, '创作要求'); await productionStep(dialog, '创作要求'); await dialog.getByLabel('创作要求', { exact: true }).fill('自定义流程共用的创作要求');
  await (await openStoryboardProfile(dialog)).getByLabel('分辨率', { exact: true }).selectOption('720');
  await saveProduction(dialog); await expect(dialog).toHaveCount(0);
  const saved = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
  expect(saved.brief).toBe('自定义流程共用的创作要求'); expect(saved.workflow.stages).toEqual(stages); expect(Math.min(saved.profile.width, saved.profile.height)).toBe(720);
  await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '确认保存', exact: true })).toHaveAttribute('aria-current', 'step');
  await expect(dialog.getByLabel('预览质量', { exact: true })).toHaveCount(0);
});

test('retains the settings form when saving before opening a project tool fails', async ({ page, request }) => {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title: '工具打开前保存失败' });
  await page.goto('/'); await openProjectFromList(page, project.title);
  await page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '制作设置', exact: true }); await productionStep(dialog, '创作要求'); await dialog.getByLabel('创作要求', { exact: true }).fill('失败后保留的创作要求');
  await productionStep(dialog, '模型与素材');
  let fail = true;
  await page.route('**/__desktop_rpc', async route => { if (route.request().postDataJSON()?.method === 'project.update' && fail) { fail = false; await route.fulfill({ status: 400, json: { error: '隔离的配置保存失败' } }); } else await route.continue(); });
  await productionStep(dialog, '声音与成片'); await dialog.getByRole('button', { name: '背景音乐', exact: true }).click(); await dialog.getByRole('button', { name: '保存并打开', exact: true }).click(); await expect(dialog).toContainText('操作尚未完成');
  await expect(page.getByRole('dialog', { name: '背景音乐', exact: true })).toHaveCount(0);
  await productionStep(dialog, '创作要求'); await expect(dialog.getByLabel('创作要求', { exact: true })).toHaveValue('失败后保留的创作要求');
  await productionStep(dialog, '模型与素材'); await productionStep(dialog, '声音与成片'); await dialog.getByRole('button', { name: '背景音乐', exact: true }).click(); await dialog.getByRole('button', { name: '保存并打开', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '背景音乐', exact: true })).toBeVisible();
  expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project.brief).toBe('失败后保留的创作要求');
});

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 1024, height: 720, theme: 'light' }, { width: 390, height: 844, theme: 'light' }]) {
  test('edits project and production configuration through one entry at ' + viewport.width + 'px', async ({ page, request }, info) => {
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: '统一设置验收 ' + viewport.width, profile: { width: 320, height: 180, frameRate: { numerator: 24, denominator: 1 }, fitMode: 'contain', previewScale: 1 } });
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: ['第一镜头', '第二镜头'].map((title, index) => ({ id: 'settings-shot-' + index, title, narration: '保留所有输入与真实预览。', visualPrompt: '', durationUs: 1_000_000 })) } });
    const errors: string[] = [], writes: string[] = []; page.on('pageerror', error => errors.push(error.message));
    page.on('request', value => { if (value.url().endsWith('/__desktop_rpc') && value.postDataJSON()?.method === 'run.start') writes.push('run.start'); });
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    await page.goto('/'); await openProjectFromList(page, project.title); await page.setViewportSize(viewport);
    const settings = page.locator('.project-heading-actions').getByRole('button', { name: '制作设置', exact: true });
    await expect(settings).toHaveCount(1); await expect(page.getByRole('button', { name: '项目设置', exact: true })).toHaveCount(0);
    await settings.click();
    const dialog = page.getByRole('dialog', { name: '制作设置', exact: true }), nav = dialog.getByRole('navigation', { name: '制作设置步骤', exact: true });
    await expect(nav.getByRole('button')).toHaveText(['1创作要求', '2模型与素材', '3声音与成片', '4确认保存']);
    for (const label of ['创作要求', '视觉风格', '画面比例', '分辨率']) await expect(dialog.getByLabel(label, { exact: true })).toHaveCount(1);
    const brief = '统一的主题与受众 ' + viewport.width, style = '淡雅青绿，保持视觉风格一致。';
    await productionStep(dialog, '创作要求'); await dialog.getByLabel('创作要求', { exact: true }).fill(brief); await dialog.getByLabel('视觉风格', { exact: true }).fill(style);
    await productionStep(dialog, '模型与素材'); await productionStep(dialog, '声音与成片'); await dialog.getByLabel('声音要求', { exact: true }).fill('自然中文旁白');
    await productionStep(dialog, '声音与成片'); await dialog.getByRole('button', { name: '背景音乐', exact: true }).click(); await dialog.getByRole('button', { name: '保存并打开', exact: true }).click();
    const music = page.getByRole('dialog', { name: '背景音乐', exact: true }); await expect(music).toBeVisible(); await expect(dialog).toHaveCount(0);
    expect(await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).toMatchObject({ project: { brief, style } });
    await music.getByRole('button', { name: '关闭对话框', exact: true }).click(); await settings.click();
    await expect(nav.getByRole('button', { name: '确认保存', exact: true })).toHaveAttribute('aria-current', 'step');
    await nav.getByRole('button', { name: '声音与成片', exact: true }).focus(); await page.keyboard.press('Tab');
    await expect(nav.getByRole('button', { name: '确认保存', exact: true })).toBeFocused(); await productionStep(dialog, '创作要求');
    await openStoryboardProfile(dialog);
    await dialog.getByLabel('画面比例', { exact: true }).selectOption('9:16');
    await expect(dialog.getByLabel('分辨率', { exact: true }).locator('selectedcontent')).toContainText('180 × 320');
    await productionStep(dialog, '确认保存');
    const save = dialog.getByRole('button', { name: '保存设置', exact: true }); await expect(save).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('unified-project-settings-' + viewport.width + '.png') });
    await save.click(); await expect(dialog).toHaveCount(0);
    await page.locator('.outline-shot').nth(1).click(); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('第二镜头');
    await page.reload(); await openProjectFromList(page, project.title); await settings.click(); await productionStep(dialog, '创作要求');
    await expect(dialog.getByLabel('创作要求', { exact: true })).toHaveValue(brief); await expect(dialog.getByLabel('视觉风格', { exact: true })).toHaveValue(style);
    await productionStep(dialog, '创作要求'); await dialog.getByLabel('创作要求', { exact: true }).fill('尚未保存的修改'); await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
    const saved = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
    expect(saved).toMatchObject({ brief, style, profile: { width: 180, height: 320, previewScale: 1 }, workflow: { production: { soundPrompt: '自然中文旁白' } } });
    expect(saved.shots).toEqual(project.shots); expect(writes).toEqual([]); expect(errors).toEqual([]);
  });
}
