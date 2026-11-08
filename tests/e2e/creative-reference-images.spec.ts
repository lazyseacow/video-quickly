import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { AssetRecord, ProjectDocument } from '@video-quickly/contracts';
import { openProduction, productionStep, saveProduction } from './production-settings';

// Browser plugin not available: use the repository's Playwright preview with an isolated test workspace.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok(), JSON.stringify(payload.error)).toBe(true); return payload.result;
}
async function fixture(request: APIRequestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-creative-reference-browser-')), suffix = randomUUID().slice(0, 8);
  async function image(name: string, projectId?: string) {
    const path = join(directory, `${name}-${suffix}.png`); await writeFile(path, png);
    return rpc<AssetRecord>(request, 'asset.import', { path, kind: 'image', projectId });
  }
  const primary = await image('花园原图');
  let project = await rpc<ProjectDocument>(request, 'project.create', { title: `图片参考 ${suffix}` });
  const privateImage = await image('项目私有图', project.id);
  // Push the selected reference beyond page one, so reopening requires asset.getMany.
  for (let index = 0; index < 31; index++) await image(`公共图片${index}`);
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { creativeContext: { characterIds: [], continuity: '同一傍晚', entities: [{ key: 'garden', kind: 'scene', name: '花园', description: '石喷泉与木门', referenceAssetIds: [primary.id] }] } } });
  const importedPath = join(directory, `新增花园图-${suffix}.png`); await writeFile(importedPath, png);
  return { project, primary, privateImage, importedPath, current: async () => (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark', name: 'desktop' }, { width: 390, height: 844, theme: 'light', name: 'narrow' }]) {
  test(`edits public scene references, preserves paginated selections and restores history at ${viewport.width}px`, async ({ page, request }, info) => {
    const source = await fixture(request), errors: string[] = [], consoleErrors: string[] = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    try {
      await page.setViewportSize(viewport); await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
      let dialog = await openProduction(page, source.project);
      await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      await dialog.locator('.creative-context-editor__entities > summary').click();
      let scene = dialog.getByRole('region', { name: '场景设定 1', exact: true });
      await scene.locator(':scope > details > summary').click();
      await scene.locator('.creative-reference-picker__disclosure > summary').click();
      let references = scene.getByRole('group', { name: '场景参考图（最多 4 张）', exact: true });
      await expect(references.getByRole('checkbox', { name: source.primary.name, exact: true })).toBeChecked();
      await expect(references.getByRole('checkbox', { name: source.privateImage.name, exact: true })).toHaveCount(0);
      await expect(references.locator('img').first()).toBeVisible();
      await references.getByRole('textbox', { name: '场景参考图路径', exact: true }).fill(source.importedPath);
      await references.getByRole('button', { name: '导入场景参考图', exact: true }).click();
      await expect(scene.locator('.creative-reference-picker__disclosure > summary')).toContainText('2 / 4');
      await expect(references.getByRole('checkbox', { name: /新增花园图-/ })).toBeChecked();
      await productionStep(dialog, '模型与素材'); await productionStep(dialog, '创作要求');
      await expect(scene.locator('.creative-reference-picker__disclosure > summary')).toContainText('2 / 4');
      await scene.locator('.creative-reference-picker__disclosure > summary').scrollIntoViewIfNeeded();
      await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 2)).toBe(true);
      const evidence = info.outputPath(`creative-reference-images-${viewport.name}.png`);
      await page.screenshot({ path: evidence }); await info.attach('scene-reference-ui', { path: evidence, contentType: 'image/png' });
      await saveProduction(dialog); await expect(dialog).toHaveCount(0);
      await expect.poll(async () => (await source.current()).creativeContext?.entities[0].referenceAssetIds?.length).toBe(2);
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await expect.poll(async () => (await source.current()).creativeContext?.entities[0].referenceAssetIds).toEqual([source.primary.id]);
      await page.getByRole('button', { name: '重做', exact: true }).click();
      await expect.poll(async () => (await source.current()).creativeContext?.entities[0].referenceAssetIds?.length).toBe(2);
      dialog = await openProduction(page, source.project);
      await dialog.locator('.creative-context-editor__entities > summary').click(); scene = dialog.getByRole('region', { name: '场景设定 1', exact: true });
      await scene.locator(':scope > details > summary').click();
      await scene.locator('.creative-reference-picker__disclosure > summary').click(); references = scene.getByRole('group', { name: '场景参考图（最多 4 张）', exact: true });
      const imported = references.getByRole('checkbox', { name: /新增花园图-/ }); await expect(imported).toBeChecked(); await imported.focus(); await page.keyboard.press('Space'); await expect(imported).not.toBeChecked();
      await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(dialog).toHaveCount(0);
      expect((await source.current()).creativeContext?.entities[0].referenceAssetIds).toHaveLength(2);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]); expect(consoleErrors).toEqual([]);
    } finally { await source.cleanup(); }
  });
}
