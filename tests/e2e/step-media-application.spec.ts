import { expect, test } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';
import { fixture, latest, rpc, saved } from './native-video-fixture';
import { openProjectFromList } from './workspace-navigation';
import { confirmAction } from './confirmation-actions';

test('renders validated videos in the workbench while later shots are still generating', async ({ page, request }, info) => {
  test.setTimeout(90_000);
  const second = Promise.withResolvers<void>(), third = Promise.withResolvers<void>();
  let submitted = 0;
  const source = await fixture(request, info, false, 3, { async beforeReply(_body, path) {
    if (!path.includes('contents/generations/tasks')) return;
    const index = submitted++;
    if (index === 1) await second.promise;
    if (index === 2) await third.promise;
  } });
  try {
    const configured = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: {
      shots: [{ id: 'existing-shot', title: '项目原镜头', narration: '', visualPrompt: '蓝色天空', durationUs: 2_000_000 }],
      workflow: { ...source.project.workflow, production: { ...source.project.workflow.production, textModelId: source.models[0].id, videoModelId: source.video.id, referenceMode: 'none' } },
    } });
    await page.goto('/'); await openProjectFromList(page, configured.title);
    const player = page.getByRole('region', { name: '视频预览播放器', exact: true });
    const shots = page.locator('.outline-shot'), clips = page.locator('.timeline-clip--video');
    const stage = page.getByRole('button', { name: '打开阶段：素材与配音', exact: true });
    await expect(player).toContainText('本地示例');
    await rpc(request, 'run.start', { projectId: configured.id, revision: configured.revision });
    await expect(stage).toContainText('1/3', { timeout: 30_000 });
    await expect(player.getByRole('button', { name: '编辑项目', exact: true })).toBeVisible();
    await expect(shots).toHaveCount(3);
    await expect(clips).toHaveCount(3);
    for (const canvas of [player.locator('.preview-frame canvas'), shots.first().locator('canvas'), clips.first().locator('canvas').first()]) {
      await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
        const [red, green, blue] = element.getContext('2d')!.getImageData(element.width / 2, element.height / 2, 1, 1).data;
        return blue > 150 && red < 60 && green < 60;
      })).toBe(true);
    }
    await expect(player.locator('.prepared-mix-preview')).toHaveAttribute('data-status', 'ready');
    expect(await saved(request, configured.id)).toEqual(configured);

    await clips.nth(1).getByRole('button', { name: /^定位镜头 2/ }).click();
    await expect(player).toContainText('待生成');
    second.resolve();
    await expect(stage).toContainText('2/3', { timeout: 30_000 });
    await expect(shots.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(player).toContainText('视频素材');
    await expect(player.locator('.prepared-mix-preview')).toHaveAttribute('data-status', 'ready');
    await page.screenshot({ path: info.outputPath('live-video-preview.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(player.getByRole('button', { name: '编辑项目', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('live-video-preview-narrow.png') });
    await page.setViewportSize({ width: 1536, height: 960 });

    await player.getByRole('button', { name: '编辑项目', exact: true }).click();
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('项目原镜头');
    await expect(shots).toHaveCount(1);
    await player.getByRole('button', { name: '制作预览', exact: true }).click();
    await expect(shots).toHaveCount(3);
    third.resolve();
    await expect.poll(async () => (await latest(request, configured.id))?.status, { timeout: 30_000 }).toBe('succeeded');
    await expect(player.getByRole('button', { name: '编辑项目', exact: true })).toHaveCount(0);
    expect((await saved(request, configured.id)).shots.every(shot => Boolean(shot.videoAssetId))).toBe(true);
  } finally { second.resolve(); third.resolve(); await source.close(); }
});

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
