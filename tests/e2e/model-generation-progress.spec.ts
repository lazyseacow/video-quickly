import { expect, test } from '@playwright/test';
import type { ModelProfile, ProjectDocument } from '@video-quickly/contracts';
import { fixture, latest, open, rpc, saved } from './native-video-fixture';
import { saveAndStartProduction } from './production-settings';

function gate() { return { entered: false, ...Promise.withResolvers<void>() }; }
for (const viewport of [{ width: 1536, height: 960, theme: 'dark', references: true }, { width: 390, height: 844, theme: 'light', references: false }]) {
  test(`tracks only actual model generation at ${viewport.width}px`, async ({ page, request }, info) => {
    const errors: string[] = [], submissions: string[] = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const gates = { brief: gate(), style: gate(), script: gate(), assets: gate(), video: gate() };
    let textRequests = 0;
    const source = await fixture(request, info, false, 2, { beforeReply: async (_, path) => {
      const id = path.endsWith('/images/generations') ? 'assets' : path.includes('contents/generations/tasks') ? 'video' : (['brief', 'style', 'script'] as const)[textRequests++];
      if (!id) throw new Error('Unexpected model request');
      submissions.push(id); gates[id].entered = true; await gates[id].promise;
    } });
    try {
      const image = await rpc<ModelProfile>(request, 'model.save', { model: { name: '隔离参考图模型', provider: 'openai-compatible', baseUrl: source.video.baseUrl, model: 'fixture-image', connectionType: 'image', capabilities: ['image'] } });
      await rpc(request, 'workflow.save', { projectId: source.project.id, workflow: { ...source.project.workflow, production: { ...source.project.workflow.production, textModelId: source.models[0].id, videoModelId: source.video.id, imageModelId: image.id, referenceMode: viewport.references ? 'generate' : 'none' } } });
      await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
      const settings = await open(page, source.project);
      await saveAndStartProduction(settings);
      const production = page.getByRole('region', { name: '当前制作', exact: true }), progress = production.getByRole('list', { name: '模型生成进度', exact: true });
      const labels = ['简报生成', '风格与角色生成', '分镜生成', ...(viewport.references ? ['参考图生成'] : []), '镜头视频生成'];
      await expect(progress.locator('.workbench-guide__step-copy > strong')).toHaveText(labels);
      await expect(progress).not.toContainText('剪辑准备'); await expect(progress).not.toContainText('创作要求');
      const stages = [ ['brief', '简报生成', '创意简报'], ['style', '风格与角色生成', '风格与角色'], ['script', '分镜生成', '旁白与分镜'], ...(viewport.references ? [['assets', '参考图生成', '参考素材准备']] : []), ['video', '镜头视频生成', '镜头视频生成'] ] as const;
      for (const [id, label] of stages) {
        const selected = gates[id as keyof typeof gates]; await expect.poll(() => selected.entered).toBe(true);
        const card = progress.getByRole('button', { name: `打开步骤：${label}`, exact: true });
        await expect(card).toHaveAttribute('aria-current', 'step'); await expect(card).toHaveAttribute('data-state', 'running');
        expect(submissions.filter(value => value === id).length).toBeGreaterThan(0);
        await card.click();
        const record = page.getByRole('dialog', { name: '本次制作', exact: true });
        await expect(record.getByRole('tablist', { name: '制作阶段记录', exact: true })).toHaveCount(0);
        const navigation = record.getByRole('navigation', { name: '本次制作步骤', exact: true });
        await expect(navigation.getByRole('button').locator('strong')).toHaveText([...labels.slice(0, 3), viewport.references ? '参考图生成' : '参考素材准备', '镜头视频生成', '剪辑与运镜准备', '导出成片']);
        await expect(navigation.getByRole('button', { name: new RegExp(label) })).toHaveAttribute('aria-current', 'step');
        await expect(navigation.getByRole('button', { name: new RegExp(label) })).toBeInViewport({ ratio: 1 });
        if (id === 'script') await page.screenshot({ path: info.outputPath('flat-generation-record.png') });
        await record.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(card).toBeFocused();
        if (id === 'brief') {
          const current = await saved(request, source.project.id);
          await rpc<ProjectDocument>(request, 'project.update', { projectId: current.id, revision: current.revision, patch: { workflow: { ...current.workflow, production: { ...current.workflow.production, referenceMode: viewport.references ? 'none' : 'generate' } } } });
          await expect(progress.locator('.workbench-guide__step-copy > strong')).toHaveText(labels);
          await page.screenshot({ path: info.outputPath('model-generation-running.png') });
        }
        selected.resolve();
      }
      await expect.poll(async () => (await latest(request, source.project.id))?.status, { timeout: 30000 }).toBe('succeeded');
      await expect(progress.locator('.workbench-guide__step[data-state="succeeded"]')).toHaveCount(labels.length);
      await expect(production.getByLabel('成片状态', { exact: true })).toContainText('成片已完成');
      expect(submissions.filter(id => id === 'brief')).toHaveLength(1); expect(submissions.filter(id => id === 'style')).toHaveLength(1); expect(submissions.filter(id => id === 'script')).toHaveLength(1);
      expect(submissions.filter(id => id === 'video')).toHaveLength(2); expect(submissions.filter(id => id === 'assets')).toHaveLength(viewport.references ? 2 : 0);
      await production.getByRole('button', { name: '查看制作记录', exact: true }).click(); const record = page.getByRole('dialog', { name: '本次制作', exact: true });
      await expect(record.getByRole('tablist', { name: '制作阶段记录', exact: true })).toHaveCount(0); await expect(record.getByRole('navigation', { name: '本次制作步骤', exact: true }).getByRole('button', { name: /导出成片/ })).toHaveAttribute('aria-current', 'step'); await expect(record.getByRole('link', { name: '下载成片', exact: true })).toBeVisible();
      await record.getByRole('button', { name: '关闭对话框', exact: true }).click(); await page.screenshot({ path: info.outputPath('model-generation-complete.png') });
      await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { Object.values(gates).forEach(gate => gate.resolve()); await source.close(); }
  });
}
