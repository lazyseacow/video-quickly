import { expect, test } from '@playwright/test';
import { modelSchema, runInspectionSchema, type RunSummary } from '@video-quickly/contracts';
import { fixture, latest, rpc } from './native-video-fixture';
import { openProjectFromList } from './workspace-navigation';

function gate() { let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); return { pending, release }; }
for (const kind of ['image', 'video'] as const) for (const viewport of [{ width: 1536, height: 960, theme: 'dark', reducedMotion: 'no-preference' }, { width: 390, height: 844, theme: 'light', reducedMotion: 'reduce' }] as const) {
  test(`shows real partial ${kind} progress and keeps the selected shot at ${viewport.width}px`, async ({ page, request }, info) => {
    // Nine real model requests, partial-result interaction and video export share this budget.
    test.setTimeout(60_000);
    const held = gate(), blocked = gate(); let submissions = 0;
    const source = await fixture(request, info, false, 3, { beforeReply: async (_body, path) => {
      if ((kind === 'image' ? path.endsWith('/images/generations') : path.includes('contents/generations/tasks')) && ++submissions === 2) { blocked.release(); await held.pending; }
    } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: viewport.reducedMotion });
      await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
      const image = modelSchema.parse(await rpc(request, 'model.save', { model: { name: '等待体验参考图', provider: 'openai-compatible', connectionType: 'image', capabilities: ['image'], model: 'fixture-image', baseUrl: source.models[0].baseUrl } }));
      await rpc(request, 'project.update', { projectId: source.project.id, patch: { workflow: { ...source.project.workflow, production: { ...source.project.workflow.production, textModelId: source.models[0].id, videoModelId: source.video.id, imageModelId: image.id, referenceMode: 'generate' } } } });
      const run = await rpc<RunSummary>(request, 'run.start', { projectId: source.project.id });
      const nodeId = kind === 'image' ? 'assets' : 'video';
      await blocked.pending;
      await expect.poll(async () => runInspectionSchema.parse(await rpc(request, 'run.inspect', { runId: run.id })).steps.find(step => step.id === nodeId)?.progress?.completed).toBe(1);
      await page.goto('/'); await openProjectFromList(page, source.project.title);
      const trigger = page.getByRole('button', { name: '打开阶段：素材与配音', exact: true });
      await expect(trigger).toContainText('1/3'); await expect(trigger.locator('.spin')).toBeVisible(); await trigger.click();
      const dialog = page.getByRole('dialog', { name: '本次制作', exact: true }), progress = dialog.getByRole('region', { name: '步骤进度', exact: true });
      await expect(dialog).toBeVisible(); await expect(progress).toContainText('1 / 3');
      await expect(progress.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33');
      await expect(progress).toContainText('已等待'); await expect(dialog).not.toContainText('这个步骤尚未保存产物');
      const gallery = dialog.getByRole('group', { name: '选择预览素材', exact: true });
      await expect(gallery.getByRole('button', { name: /^预览/ })).toHaveCount(3);
      await expect(gallery.locator('[data-generation-state="completed"]')).toHaveCount(1);
      const second = gallery.getByRole('button', { name: /^预览/ }).nth(1); await second.click();
      const preview = dialog.locator('.step-result__preview'); await expect(preview).toContainText('等待模型返回');
      if (kind === 'video') { await expect(preview.getByText('参考图', { exact: true })).toBeVisible(); await expect(preview.locator('img')).toBeVisible(); }
      const bounds = await preview.boundingBox(), requests = source.requests.length;
      await expect.poll(async () => progress.locator('.step-progress__time').innerText()).not.toContain('已等待 00:00');
      expect(await preview.boundingBox()).toEqual(bounds); expect(source.requests).toHaveLength(requests);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`waiting-${kind}-${viewport.width}.png`) });
      held.release(); await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30000 }).toBe('succeeded');
      expect(runInspectionSchema.parse(await rpc(request, 'run.inspect', { runId: run.id })).steps.find(step => step.id === 'export')?.progress).toMatchObject({ phase: 'completed', fraction: 1 });
      await expect(second).toHaveAttribute('aria-pressed', 'true'); await expect(preview).toContainText('生成的蓝色镜头 2');
      await expect(preview.getByText('已保存', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: /^重新生成镜头/ })).toHaveCount(3);
      await expect(dialog.locator('.step-progress__time')).toHaveCount(0); expect(source.requests).toHaveLength(9); expect(errors).toEqual([]);
      await page.screenshot({ path: info.outputPath(`completed-${kind}-${viewport.width}.png`) });
    } finally { held.release(); await source.close(); }
  });
}

test('shows an indeterminate text wait and keeps the chosen step during background completion', async ({ page, request }, info) => {
  const source = await fixture(request, info, true);
  try {
    await rpc(request, 'project.update', { projectId: source.project.id, patch: { workflow: { ...source.project.workflow, production: { ...source.project.workflow.production, textModelId: source.models[0].id, videoModelId: source.video.id } } } });
    await rpc(request, 'run.start', { projectId: source.project.id }); await source.pending;
    await page.goto('/'); await openProjectFromList(page, source.project.title);
    await page.getByRole('button', { name: '打开阶段：策划与分镜', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '本次制作', exact: true }), progress = dialog.getByRole('region', { name: '步骤进度', exact: true });
    await expect(progress).toContainText('等待模型返回'); await expect(progress.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    await expect(dialog).not.toContainText('这个步骤尚未保存产物');
    const steps = dialog.getByRole('navigation', { name: '本次制作步骤', exact: true });
    await steps.getByRole('button', { name: /风格与角色生成/ }).click();
    await expect(dialog).toContainText('等待上游步骤完成后执行。');
    source.release(); await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30000 }).toBe('succeeded');
    await expect(steps.getByRole('button', { name: /风格与角色生成/ })).toHaveAttribute('aria-current', 'step');
    await expect(dialog.getByRole('region', { name: '步骤详情：风格与角色', exact: true })).toBeVisible();
  } finally { source.release(); await source.close(); }
});

test('restores partial previews on reload and stops without submitting a second production', async ({ page, request }, info) => {
  const held = gate(); let submissions = 0;
  const source = await fixture(request, info, false, 2, { beforeReply: async (_body, path) => { if (path.includes('contents/generations/tasks') && ++submissions === 2) await held.pending; } });
  try {
    await rpc(request, 'project.update', { projectId: source.project.id, patch: { workflow: { ...source.project.workflow, production: { ...source.project.workflow.production, textModelId: source.models[0].id, videoModelId: source.video.id } } } });
    const run = await rpc<RunSummary>(request, 'run.start', { projectId: source.project.id });
    await expect.poll(async () => runInspectionSchema.parse(await rpc(request, 'run.inspect', { runId: run.id })).steps.find(step => step.id === 'video')?.progress?.completed).toBe(1);
    await page.goto('/'); await openProjectFromList(page, source.project.title);
    await page.getByRole('button', { name: '打开阶段：素材与配音', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '本次制作', exact: true }); await expect(dialog.getByRole('region', { name: '步骤进度', exact: true })).toContainText('1 / 2');
    await page.reload(); await openProjectFromList(page, source.project.title);
    await page.getByRole('button', { name: '打开阶段：素材与配音', exact: true }).click();
    await expect(dialog.getByRole('region', { name: '步骤进度', exact: true })).toContainText('1 / 2');
    await expect(dialog.locator('[data-generation-state="completed"]')).toHaveCount(1);
    await dialog.getByRole('button', { name: '停止', exact: true }).click();
    await expect.poll(async () => (await latest(request, source.project.id))?.status).toBe('canceled');
    await expect(dialog.getByRole('region', { name: '步骤进度', exact: true })).toContainText('制作已停止');
    await expect(dialog.locator('[data-generation-state="completed"]')).toHaveCount(1); expect(submissions).toBe(2); expect(source.requests).toHaveLength(5);
  } finally { held.release(); await source.close(); }
});

for (const viewport of [{ width: 1464, height: 895, theme: 'dark' }, { width: 1024, height: 720, theme: 'light' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`replaces six storyboard skeletons individually as parallel video results arrive at ${viewport.width}px`, async ({ page, request }, info) => {
    const held = Array.from({ length: 6 }, gate), submitted = gate(); let submissions = 0;
    const source = await fixture(request, info, false, 6, { beforeReply: async (_body, path) => {
      if (path.includes('contents/generations/tasks')) { const index = submissions++; if (submissions === 2) submitted.release(); await held[index].pending; }
    } });
    try {
      await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
      await rpc(request, 'project.update', { projectId: source.project.id, patch: { workflow: { ...source.project.workflow,
        execution: { maxConcurrentShots: 2, modelLimits: { [source.video.id]: 2 } },
        production: { ...source.project.workflow.production, textModelId: source.models[0].id, videoModelId: source.video.id } } } });
      const run = await rpc<RunSummary>(request, 'run.start', { projectId: source.project.id });
      await submitted.pending; expect(submissions).toBe(2);
      await page.goto('/'); await openProjectFromList(page, source.project.title);
      await page.getByRole('button', { name: '打开阶段：素材与配音', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '本次制作', exact: true }), gallery = dialog.getByRole('group', { name: '选择预览素材', exact: true });
      const cards = gallery.locator('.step-result__media-card');
      await expect(cards).toHaveCount(6); await expect(gallery.locator('[data-skeleton]')).toHaveCount(6); await expect(gallery.locator('canvas')).toHaveCount(0);
      const identities = await cards.evaluateAll(elements => elements.map(element => element.getAttribute('data-shot-id')));
      await page.screenshot({ path: info.outputPath(`six-video-skeletons-${viewport.width}.png`) });
      held[1].release();
      await expect(gallery.locator('[data-skeleton]')).toHaveCount(5);
      await expect(gallery.locator('[data-generation-state="completed"]')).toHaveCount(1);
      const completed = gallery.locator('[data-generation-state="completed"]');
      await expect(completed.getByRole('button', { name: /^预览/ })).toHaveAttribute('aria-pressed', 'true');
      await expect(dialog.getByRole('region', { name: '步骤进度', exact: true })).toContainText('1 / 6');
      const selectedId = await completed.getAttribute('data-shot-id');
      const player = dialog.locator('.step-result__preview video'); await expect(player).toHaveCount(1);
      await player.evaluate(async (video: HTMLVideoElement) => { video.muted = true; await video.play(); video.pause(); });
      expect((await latest(request, source.project.id))?.status).toBe('running'); expect(submissions).toBe(2);
      expect(await cards.evaluateAll(elements => elements.map(element => element.getAttribute('data-shot-id')))).toEqual(identities);
      await page.screenshot({ path: info.outputPath(`one-video-ready-${viewport.width}.png`) });
      held.forEach(item => item.release());
      await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30000 }).toBe('succeeded');
      await expect(gallery.locator('[data-skeleton]')).toHaveCount(0); await expect(cards).toHaveCount(6);
      expect(await gallery.locator('[data-selected="true"]').getAttribute('data-shot-id')).toBe(selectedId);
      const action = cards.first().getByRole('button', { name: /^重新生成镜头/ });
      await expect(action).toBeVisible();
      const cardBounds = await cards.first().boundingBox(), actionBounds = await action.boundingBox();
      if (!cardBounds || !actionBounds) throw new Error('Missing media card action bounds');
      expect(cardBounds.x + cardBounds.width - actionBounds.x - actionBounds.width).toBeGreaterThanOrEqual(8);
      expect(await action.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(submissions).toBe(6); expect(source.requests).toHaveLength(9);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`six-videos-ready-${viewport.width}.png`) });
    } finally { held.forEach(item => item.release()); await source.close(); }
  });
}
