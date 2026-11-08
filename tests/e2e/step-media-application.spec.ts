import { expect, test } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';
import { fixture, latest, rpc, saved } from './native-video-fixture';
import { openProjectFromList } from './workspace-navigation';
import { confirmAction } from './confirmation-actions';

test('automatically binds a completed video task to the open project', async ({ page, request }, info) => {
  const source = await fixture(request, info);
  try {
    const configured = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: {
      shots: [{ id: 'target', title: '视频自动应用', narration: '生成时的旁白', visualPrompt: '蓝色天空', durationUs: 2_000_000 }],
      workflow: { ...source.project.workflow, production: { ...source.project.workflow.production, videoModelId: source.video.id } },
    } });
    await page.goto('/'); await openProjectFromList(page, source.project.title);
    const video = page.getByLabel('镜头视频', { exact: true }); await expect(video).toHaveValue('');
    await rpc(request, 'run.start', { projectId: configured.id, revision: configured.revision, nodeId: 'video' });
    await expect.poll(async () => (await latest(request, configured.id))?.status, { timeout: 30000 }).toBe('succeeded');
    const applied = await saved(request, configured.id);
    expect(applied.revision).toBe(configured.revision + 1);
    expect(applied.shots[0].videoAssetId).toBeTruthy();
    await expect(video).toHaveValue(applied.shots[0].videoAssetId!);
    await expect(page.getByRole('checkbox', { name: '启用视频原声', exact: true })).toBeChecked();
    await page.screenshot({ path: info.outputPath('automatically-applied-video.png') });
  } finally { await source.close(); }
});

test('applies saved video results manually after an edit during generation and supports undo', async ({ page, request }, info) => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const source = await fixture(request, info, false, 3, { async beforeReply(_body, path) {
    if (path.includes('contents/generations/tasks')) { entered.resolve(); await release.promise; }
  } });
  try {
    await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: { shots: Array.from({ length: 3 }, (_, index) => ({ id: `shot-${index}`, title: `保留的分镜 ${index + 1}`, narration: '生成时的旁白', visualPrompt: '蓝色天空', durationUs: 2_000_000 })) } });
    const configured = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, patch: { workflow: { ...source.project.workflow, production: { ...source.project.workflow.production!, textModelId: source.models[0].id, videoModelId: source.video.id } } } });
    const node = configured.workflow.nodes.find(node => node.id === 'video')!;
    await rpc(request, 'run.start', { projectId: source.project.id, nodeId: node.id });
    await entered.promise;
    await page.goto('/'); await openProjectFromList(page, source.project.title);
    const title = page.getByLabel('镜头标题', { exact: true }); await title.fill('生成期间精修的标题');
    await page.getByRole('button', { name: '保存镜头', exact: true }).click();
    await expect.poll(async () => (await saved(request, source.project.id)).shots[0].title).toBe('生成期间精修的标题');
    release.resolve();
    await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30000 }).toBe('succeeded');
    const before = await saved(request, source.project.id), submissions = source.requests.length;
    expect(before.shots.every(shot => !shot.videoAssetId)).toBe(true);
    await page.getByRole('button', { name: '打开阶段：素材与配音', exact: true }).click();
    const results = page.getByRole('dialog', { name: '本次制作', exact: true });
    await results.getByRole('button', { name: '在项目中查看与应用', exact: true }).click();
    const output = page.getByRole('dialog', { name: '步骤产物', exact: true });
    await expect(output.locator('video')).toHaveCount(1);
    await output.getByRole('button', { name: '应用到项目', exact: true }).click(); await confirmAction(page, '确认应用');
    await expect(output).toHaveCount(0); await expect(title).toHaveValue('生成期间精修的标题');
    await expect.poll(async () => (await saved(request, source.project.id)).shots.every(shot => Boolean(shot.videoAssetId))).toBe(true);
    const applied = await saved(request, source.project.id);
    expect(applied.shots.map(shot => shot.id)).toEqual(before.shots.map(shot => shot.id));
    expect(applied.shots[0].title).toBe('生成期间精修的标题');
    expect(applied.shots.map(shot => shot.narration)).toEqual(before.shots.map(shot => shot.narration));
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await saved(request, source.project.id)).shots.every(shot => !shot.videoAssetId)).toBe(true);
    await expect(title).toHaveValue('生成期间精修的标题');
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect.poll(async () => (await saved(request, source.project.id)).shots.map(shot => shot.videoAssetId)).toEqual(applied.shots.map(shot => shot.videoAssetId));
    const repeated = await saved(request, source.project.id);
    await page.getByRole('button', { name: '打开阶段：素材与配音', exact: true }).click();
    await results.getByRole('button', { name: '在项目中查看与应用', exact: true }).click();
    await output.getByRole('button', { name: '应用到项目', exact: true }).click(); await confirmAction(page, '确认应用');
    await expect(output).toHaveCount(0);
    expect(await saved(request, source.project.id)).toEqual(repeated);
    expect(source.requests).toHaveLength(submissions);
    await page.screenshot({ path: info.outputPath('applied-videos-with-manual-edits.png') });
  } finally { release.resolve(); await source.close(); }
});
