import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectDocument } from '@video-quickly/contracts';
import { importSkillFixture } from '../fixtures/import-skill';
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
  await dialog.getByRole('button', { name: '打开高级编排', exact: true }).click();
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
  // Both the active snapshot and the reloaded settings complete a real video export.
  test.setTimeout(60_000);
  const source = await fixture(request, info, true);
  try {
    let project = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, patch: { workflow: { ...source.project.workflow, production: { ...source.project.workflow.production, textModelId: source.models[0].id, videoModelId: source.video.id } } } });
    const run = await rpc<{ id: string; snapshotDigest: string }>(request, 'run.start', { projectId: project.id }); await source.pending;
    let dialog = await openProduction(page, project); await productionStep(dialog, '模型与素材');
    await dialog.getByLabel('镜头同时处理数', { exact: true }).selectOption('3'); await dialog.getByLabel(`${source.video.name} 并发上限`, { exact: true }).selectOption('2');
    await saveProduction(dialog); await expect(dialog).toHaveCount(0);
    expect((await saved(request, project.id)).workflow.execution).toBeUndefined();
    expect(await rpc(request, 'run.get', { runId: run.id })).toMatchObject({ snapshotDigest: run.snapshotDigest });
    await page.reload(); await openProjectFromList(page, project.title); await page.getByRole('button', { name: '制作设置', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '制作设置', exact: true }); await expect(dialog).toContainText('已保存待用配置'); await productionStep(dialog, '模型与素材');
    await expect(dialog.getByLabel('镜头同时处理数', { exact: true })).toHaveValue('3'); await expect(dialog.getByLabel(`${source.video.name} 并发上限`, { exact: true })).toHaveValue('2');
    await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
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

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 1024, height: 720, theme: 'light' }, { width: 390, height: 844, theme: 'light' }]) test(`edits compact advanced tasks without losing input or selector focus at ${viewport.width}px`, async ({ page, request }, info) => {
  const errors: string[] = [], writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
  const source = await productionFixture(request), skillDirectory = info.outputPath('compact-skills');
  const skillNames = ['brief', 'style'].map(suffix => `compact-${source.project.id.slice(0, 8)}-${suffix}`);
  for (const name of skillNames) {
    const directory = join(skillDirectory, name); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: 高级任务布局验收\n---\n保持当前任务的创作要求。`);
  }
  const imported = await importSkillFixture((method, params) => rpc(request, method, params), { path: skillDirectory });
  const dialog = await openProduction(page, source.project);
  page.on('request', request => {
    if (!request.url().endsWith('/__desktop_rpc') || request.method() !== 'POST') return;
    const method = request.postDataJSON().method;
    if (['project.update', 'run.start'].includes(method)) writes.push(method);
  });
  const advanced = dialog.locator('[data-production-step="planning"] > .production-settings__advanced');
  await advanced.locator(':scope > summary').click();
  const task = advanced.getByRole('combobox', { name: '任务', exact: true });
  await pickProductionModel(dialog, '创意简报模型', source.override);
  await advanced.getByLabel('创意简报补充要求', { exact: true }).fill('围绕三个具体场景展开');
  await task.focus(); await task.selectOption('style'); await expect(task).toBeFocused();
  await advanced.getByLabel('风格与角色补充要求', { exact: true }).fill('保持人物外观与色调一致');
  await task.focus(); await task.selectOption('brief'); await expect(task).toBeFocused();
  await expect(advanced.getByRole('combobox', { name: '创意简报模型', exact: true })).toHaveValue(source.override.name);
  await expect(advanced.getByLabel('创意简报补充要求', { exact: true })).toHaveValue('围绕三个具体场景展开');
  await advanced.scrollIntoViewIfNeeded();
  const skills = advanced.locator('.production-settings__task-skills'), skillSummary = skills.locator(':scope > summary');
  await expect(skillSummary).toContainText('已选 0 个'); await expect(skills.locator('.skill-picker')).not.toBeVisible();
  if (viewport.width >= 1024) {
    const controls = (await advanced.locator('.production-settings__task-controls').boundingBox())!;
    const prompt = (await advanced.locator('.production-settings__task-prompt').boundingBox())!;
    expect(prompt.x).toBeGreaterThan(controls.x + controls.width); expect(Math.abs(prompt.y - controls.y)).toBeLessThan(1);
    expect((await advanced.boundingBox())!.height).toBeLessThanOrEqual(280);
    const buttons = await advanced.locator('.production-settings__task-actions > button').all();
    const boxes = await Promise.all(buttons.map(button => button.boundingBox()));
    expect(Math.max(...boxes.map(box => box!.y)) - Math.min(...boxes.map(box => box!.y))).toBeLessThan(1);
  }
  await expect(advanced.getByRole('button', { name: '查看替代模型', exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath(`advanced-text-${viewport.width}.png`) });
  await advanced.getByRole('button', { name: '查看替代模型', exact: true }).click();
  await expect(advanced.getByRole('region', { name: '替代模型建议', exact: true })).toBeVisible();
  await advanced.getByRole('button', { name: '查看替代模型', exact: true }).click();
  await skillSummary.click();
  const picker = advanced.getByRole('group', { name: '创意简报 Skill', exact: true });
  await picker.getByRole('searchbox').fill(skillNames[0]); await picker.getByRole('checkbox', { name: new RegExp(skillNames[0]) }).check();
  await expect(skillSummary).toContainText('已选 1 个'); await skillSummary.click();
  await task.focus(); await task.selectOption('style'); await expect(skillSummary).toContainText('已选 0 个');
  await task.selectOption('brief'); await expect(skillSummary).toContainText('已选 1 个');
  await productionStep(dialog, '模型与素材'); await dialog.getByLabel('参考素材', { exact: true }).selectOption('generate');
  const media = dialog.locator('[data-production-step="materials"] > .production-settings__advanced').first();
  await media.locator(':scope > summary').click();
  const mediaTask = media.getByRole('combobox', { name: '任务', exact: true });
  await mediaTask.focus(); await mediaTask.selectOption('video'); await expect(mediaTask).toBeFocused();
  const videoNode = source.project.workflow.nodes.find(node => node.id === 'video')!;
  await pickProductionModel(dialog, `${videoNode.label}模型`, source.video);
  await media.getByLabel(`${videoNode.label}补充要求`, { exact: true }).fill('镜头运动平缓，避免突然切换');
  await mediaTask.focus(); await mediaTask.selectOption({ index: 0 }); await expect(mediaTask).toBeFocused();
  await mediaTask.selectOption('video'); await expect(mediaTask).toBeFocused();
  await expect(media.getByLabel(`${videoNode.label}补充要求`, { exact: true })).toHaveValue('镜头运动平缓，避免突然切换');
  await media.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`advanced-video-${viewport.width}.png`) });
  await productionStep(dialog, '创作要求');
  await expect(advanced.getByLabel('创意简报补充要求', { exact: true })).toHaveValue('围绕三个具体场景展开');
  expect(writes).toEqual([]); await saveProduction(dialog); await expect(dialog).toHaveCount(0);
  const saved = await source.saved();
  expect(saved.workflow.nodes.find(node => node.id === 'brief')).toMatchObject({ modelId: source.override.id, prompt: '围绕三个具体场景展开' });
  expect(saved.workflow.nodes.find(node => node.id === 'brief')?.skillIds).toEqual([imported.skills.find(skill => skill.name === skillNames[0])!.id]);
  expect(saved.workflow.nodes.find(node => node.id === 'style')?.prompt).toBe('保持人物外观与色调一致');
  expect(saved.workflow.nodes.find(node => node.id === 'video')?.prompt).toBe('镜头运动平缓，避免突然切换');
  expect(writes).toEqual(['project.update']); await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
