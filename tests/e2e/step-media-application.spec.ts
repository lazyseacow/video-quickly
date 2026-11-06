import { expect, test } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';
import { fixture, latest, rpc, saved } from './native-video-fixture';
import { openProjectFromList } from './workspace-navigation';
import { confirmAction } from './confirmation-actions';

test('applies completed videos after saving manual edits and supports undo without regenerating', async ({ page, request }, info) => {
  const source = await fixture(request, info, false, 3);
  try {
    await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: { shots: Array.from({ length: 3 }, (_, index) => ({ id: `shot-${index}`, title: `保留的分镜 ${index + 1}`, narration: '生成时的旁白', visualPrompt: '蓝色天空', durationUs: 2_000_000 })) } });
    const configured = await rpc<ProjectDocument>(request, 'workflow.save', { projectId: source.project.id, workflow: { ...source.project.workflow, production: { ...source.project.workflow.production!, textModelId: source.models[0].id, videoModelId: source.video.id } } });
    const node = configured.workflow.nodes.find(node => node.id === 'video')!;
    await rpc(request, 'run.start', { projectId: source.project.id, nodeId: node.id });
    await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30000 }).toBe('succeeded');
    const before = await saved(request, source.project.id), submissions = source.requests.length;
    expect(before.shots.every(shot => !shot.videoAssetId)).toBe(true);
    await page.goto('/'); await openProjectFromList(page, source.project.title);
    const title = page.getByLabel('镜头标题', { exact: true }); await title.fill('生成之后精修的标题');
    await page.getByRole('button', { name: '打开步骤：镜头视频生成', exact: true }).click();
    const results = page.getByRole('dialog', { name: '本次制作', exact: true });
    await results.getByRole('button', { name: '在项目中查看与应用', exact: true }).click();
    const output = page.getByRole('dialog', { name: '步骤产物', exact: true });
    await expect(output.locator('video')).toHaveCount(1);
    await output.getByRole('button', { name: '应用到项目', exact: true }).click(); await confirmAction(page, '确认应用');
    await expect(output).toHaveCount(0); await expect(title).toHaveValue('生成之后精修的标题');
    await expect.poll(async () => (await saved(request, source.project.id)).shots.every(shot => Boolean(shot.videoAssetId))).toBe(true);
    const applied = await saved(request, source.project.id);
    expect(applied.shots.map(shot => shot.id)).toEqual(before.shots.map(shot => shot.id));
    expect(applied.shots[0].title).toBe('生成之后精修的标题');
    expect(applied.shots.map(shot => shot.narration)).toEqual(before.shots.map(shot => shot.narration));
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await saved(request, source.project.id)).shots.every(shot => !shot.videoAssetId)).toBe(true);
    await expect(title).toHaveValue('生成之后精修的标题');
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect.poll(async () => (await saved(request, source.project.id)).shots.map(shot => shot.videoAssetId)).toEqual(applied.shots.map(shot => shot.videoAssetId));
    const repeated = await saved(request, source.project.id);
    await page.getByRole('button', { name: '打开步骤：镜头视频生成', exact: true }).click();
    await results.getByRole('button', { name: '在项目中查看与应用', exact: true }).click();
    await output.getByRole('button', { name: '应用到项目', exact: true }).click(); await confirmAction(page, '确认应用');
    await expect(output).toHaveCount(0);
    expect(await saved(request, source.project.id)).toEqual(repeated);
    expect(source.requests).toHaveLength(submissions);
    await page.screenshot({ path: info.outputPath('applied-videos-with-manual-edits.png') });
  } finally { await source.close(); }
});
