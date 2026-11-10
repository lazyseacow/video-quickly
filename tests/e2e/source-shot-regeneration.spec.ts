import { confirmAction } from './confirmation-actions';
import { expect, test } from '@playwright/test';
import { type ModelProfile, type ProjectDocument, type RunSummary } from '@video-quickly/contracts';
import { fixture, latest, open, pick, rpc, saved } from './native-video-fixture';
import { saveAndStartProduction } from './production-settings';

for (const viewport of [{ width: 1536, height: 960, theme: 'dark', shotCount: 3 }, { width: 390, height: 844, theme: 'light', shotCount: 3 }, { width: 1536, height: 960, theme: 'light', shotCount: 1 }]) {
  test(`regenerates and applies only the selected recorded shot at ${viewport.width}px with ${viewport.shotCount} shots`, async ({ page, request }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const source = await fixture(request, info, false, viewport.shotCount), selectedIndex = viewport.shotCount > 1 ? 1 : 0;
    try {
      await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
      const settings = await open(page, source.project);
      await pick(settings, '文本模型', source.models[0]); await pick(settings, '视频模型', source.video);
      await saveAndStartProduction(settings);
      await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30000 }).toBe('succeeded');
      const originalRun = (await latest(request, source.project.id))!;
      const original = await saved(request, source.project.id), generationCount = source.requests.length;
      const edited = await rpc<ProjectDocument>(request, 'project.update', { projectId: original.id, revision: original.revision, patch: { brief: '后来修改的项目简报', style: '后来修改的项目风格', shots: original.shots.map((shot, index) => index === 0 ? { ...shot, narration: '其他镜头的新旁白' } : shot) } });
      await rpc<ModelProfile>(request, 'model.save', { model: { ...source.video, model: 'changed-for-next-production', name: '下一次制作使用的视频模型' } });
      await page.getByRole('button', { name: '打开阶段：素材与配音', exact: true }).click();
      const results = page.getByRole('dialog', { name: '本次制作', exact: true });
      await results.getByRole('navigation', { name: '本次制作步骤', exact: true }).getByRole('button', { name: /镜头视频生成/ }).click();
      await expect(results.getByRole('button', { name: /^重新生成镜头/ })).toHaveCount(viewport.shotCount);
      await expect.poll(() => results.locator('.step-result__thumbnail').first().getAttribute('data-state')).toBe('ready');
      await results.locator('video').evaluate(async (video: HTMLVideoElement) => { video.muted = true; await video.play(); video.pause(); });
      await page.screenshot({ path: info.outputPath('shot-card-regeneration.png') });
      await results.getByRole('button', { name: /^重新生成镜头/ }).nth(selectedIndex).click();
      const dialog = page.getByRole('dialog', { name: '镜头候选', exact: true });
      await expect(dialog).toBeVisible(); await expect(results).toHaveCount(0);
      await expect(dialog).toContainText('只重新生成此镜头的视频'); await expect(dialog).toContainText('其他镜头保留');
      await expect(dialog.getByLabel('生成内容', { exact: true })).toHaveCount(0); await expect(dialog.getByLabel('生成模型', { exact: true })).toHaveCount(0);
      const beforeGeneration = await saved(request, source.project.id);
      await dialog.getByRole('button', { name: '生成候选', exact: true }).click();
      const estimate = page.getByRole('alertdialog').getByRole('region', { name: '生成与费用预估' });
      await expect(estimate).toContainText(source.video.name);
      await expect(estimate).toContainText('1 段视频');
      await confirmAction(page, '确认生成');
      await expect(dialog.getByRole('button', { name: '应用所选候选', exact: true })).toBeEnabled({ timeout: 30000 });
      expect(source.requests).toHaveLength(generationCount + 1);
      const submitted = source.requests.at(-1)!;
      expect(submitted.model).toBe(source.video.model); expect(JSON.stringify(submitted)).not.toContain('后来修改的项目风格');
      const runs = await rpc<{ items: RunSummary[] }>(request, 'run.list', { projectId: source.project.id });
      const regenerated = runs.items.find(run => run.regenerationSource);
      expect(regenerated?.regenerationSource?.shotId).toBe(original.shots[selectedIndex].id); expect(regenerated?.parentRunId).toBe(originalRun.id);
      expect((await latest(request, source.project.id))?.id).toBe(regenerated?.id);
      const detail = await rpc<{ project: ProjectDocument; latestRun: RunSummary }>(request, 'project.get', { projectId: source.project.id });
      expect(detail.latestRun.id).toBe(originalRun.id); expect(detail.project).toEqual(beforeGeneration);
      await page.screenshot({ path: info.outputPath('single-shot-candidate.png') });
      await dialog.getByRole('button', { name: '应用所选候选', exact: true }).click(); await expect(dialog).toHaveCount(0);
      await expect.poll(async () => (await saved(request, original.id)).shots[selectedIndex].videoAssetId).not.toBe(edited.shots[selectedIndex].videoAssetId);
      const applied = await saved(request, original.id);
      for (const [index, shot] of edited.shots.entries()) if (index !== selectedIndex) expect(applied.shots[index]).toEqual(shot);
      expect(applied.shots[selectedIndex].narration).toBe(edited.shots[selectedIndex].narration);
      expect(applied.brief).toBe(edited.brief); expect(applied.style).toBe(edited.style);
      await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect.poll(async () => (await saved(request, original.id)).shots[selectedIndex].videoAssetId).toBe(edited.shots[selectedIndex].videoAssetId);
      expect(source.requests).toHaveLength(generationCount + 1);
      await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await source.close(); }
  });
}
