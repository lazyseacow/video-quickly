import { expect, test } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';
import { productionFixture, productionStep, openProduction, pickProductionModel, saveProduction } from './production-settings';
import { fixture, latest, rpc, saved } from './native-video-fixture';
import { openProjectFromList } from './workspace-navigation';

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 600, height: 900, theme: 'light' }]) test(`configures concurrency in normal settings and enters advanced composition at ${viewport.width}px`, async ({ page, request }, info) => {
  const source = await productionFixture(request), errors: string[] = [], mutations: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) mutations.push(request.postDataJSON()?.method); });
  await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
  let dialog = await openProduction(page, source.project);
  await expect(page.locator('.project-heading-actions').getByRole('button', { name: '流程', exact: true })).toHaveCount(0);
  await productionStep(dialog, '模型与素材');
  await pickProductionModel(dialog, '文本模型', source.text); await pickProductionModel(dialog, '视频模型', source.video);
  await dialog.getByLabel('参考素材', { exact: true }).selectOption('generate'); await pickProductionModel(dialog, '图片模型', source.image);
  await dialog.getByLabel('镜头同时处理数', { exact: true }).selectOption('3');
  await dialog.getByLabel(`${source.video.name} 并发上限`, { exact: true }).selectOption('2');
  await dialog.getByLabel(`${source.image.name} 并发上限`, { exact: true }).selectOption('1');
  await productionStep(dialog, '创作要求'); await dialog.getByLabel('创作要求', { exact: true }).fill('保留修改后进入高级编排');
  await productionStep(dialog, '模型与素材');
  await dialog.getByRole('region', { name: '生成并发', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('normal-concurrency-settings.png') });
  await dialog.locator('summary').filter({ hasText: /^高级编排$/ }).click(); await dialog.getByRole('button', { name: '打开高级编排', exact: true }).click();
  await expect(dialog).toContainText('保存设置后将打开高级编排');
  expect((await source.saved()).workflow.execution).toBeUndefined();
  await dialog.getByRole('button', { name: '保存并打开', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(page.locator('.react-flow')).toBeVisible();
  const current = await source.saved();
  expect(current.brief).toBe('保留修改后进入高级编排');
  expect(current.workflow.execution).toEqual({ maxConcurrentShots: 3, modelLimits: { [source.video.id]: 2, [source.image.id]: 1 } });
  expect(current.workflow.nodes.map(node => node.id)).toEqual(source.project.workflow.nodes.map(node => node.id)); expect(current.workflow.edges).toEqual(source.project.workflow.edges);
  await expect(page.getByLabel('镜头同时处理数', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存为子流程', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '插入子流程', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('advanced-composition.png') });
  await page.getByRole('button', { name: '返回工作台', exact: true }).click();
  await page.getByRole('button', { name: '制作设置', exact: true }).click(); dialog = page.getByRole('dialog', { name: '制作设置', exact: true }); await productionStep(dialog, '模型与素材');
  await expect(dialog.getByLabel('镜头同时处理数', { exact: true })).toHaveValue('3');
  await expect(dialog.getByLabel(`${source.video.name} 并发上限`, { exact: true })).toHaveValue('2');
  await dialog.getByLabel(`${source.video.name} 并发上限`, { exact: true }).selectOption(''); await saveProduction(dialog); await expect(dialog).toHaveCount(0);
  expect((await source.saved()).workflow.execution?.modelLimits).toEqual({ [source.image.id]: 1 });
  expect(mutations).not.toContain('run.start'); expect(errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

test('persists pending concurrency across reload while the active production keeps its frozen configuration', async ({ page, request }, info) => {
  const source = await fixture(request, info, true);
  try {
    let project = await rpc<ProjectDocument>(request, 'workflow.save', { projectId: source.project.id, workflow: { ...source.project.workflow, production: { ...source.project.workflow.production, textModelId: source.models[0].id, videoModelId: source.video.id } } });
    const run = await rpc<{ id: string; snapshotDigest: string }>(request, 'run.start', { projectId: project.id }); await source.pending;
    let dialog = await openProduction(page, project); await productionStep(dialog, '模型与素材');
    await dialog.getByLabel('镜头同时处理数', { exact: true }).selectOption('3'); await dialog.getByLabel(`${source.video.name} 并发上限`, { exact: true }).selectOption('2');
    await saveProduction(dialog); await expect(dialog).toHaveCount(0);
    expect((await saved(request, project.id)).workflow.execution).toBeUndefined();
    expect(await rpc(request, 'run.get', { runId: run.id })).toMatchObject({ snapshotDigest: run.snapshotDigest });
    await page.reload(); await openProjectFromList(page, project.title); await page.getByRole('button', { name: '制作设置', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '制作设置', exact: true }); await expect(dialog).toContainText('已保存待用配置'); await productionStep(dialog, '模型与素材');
    await expect(dialog.getByLabel('镜头同时处理数', { exact: true })).toHaveValue('3'); await expect(dialog.getByLabel(`${source.video.name} 并发上限`, { exact: true })).toHaveValue('2');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    source.release(); await expect.poll(async () => (await latest(request, project.id))?.status, { timeout: 30000 }).toBe('succeeded');
    expect((await saved(request, project.id)).workflow.execution).toBeUndefined();
    await page.getByRole('button', { name: '开始制作', exact: true }).click();
    await expect.poll(async () => (await latest(request, project.id))?.id).not.toBe(run.id);
    await expect.poll(async () => (await latest(request, project.id))?.status, { timeout: 30000 }).toBe('succeeded');
    project = await saved(request, project.id); expect(project.workflow.execution).toEqual({ maxConcurrentShots: 3, modelLimits: { [source.video.id]: 2 } });
  } finally { await source.close(); }
});

test('retains concurrency input when another view saves a conflicting concurrency setting', async ({ page, request }) => {
  const source = await productionFixture(request), dialog = await openProduction(page, source.project);
  await productionStep(dialog, '模型与素材'); await dialog.getByLabel('镜头同时处理数', { exact: true }).selectOption('2');
  const remote = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: { workflow: { ...source.project.workflow, execution: { maxConcurrentShots: 4, modelLimits: {} } } } });
  await expect(page.locator('.project-heading-copy')).toHaveAttribute('data-revision', String(remote.revision));
  await saveProduction(dialog); await expect(page.getByRole('alert').filter({ hasText: '生成并发已在其他视图修改' })).toBeVisible();
  await productionStep(dialog, '模型与素材'); await expect(dialog.getByLabel('镜头同时处理数', { exact: true })).toHaveValue('2');
  expect((await source.saved()).workflow.execution?.maxConcurrentShots).toBe(4);
});
