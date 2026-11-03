import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ModelProfile } from '@video-quickly/contracts';
import { modelCatalog } from './model-catalog';

let catalog: Awaited<ReturnType<typeof modelCatalog>>;
test.beforeEach(async () => { catalog = await modelCatalog(['fixture-category']); });
test.afterEach(async () => { await catalog.close(); });

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }); const payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const width of [1536, 390]) {
  test(`filters three model types and preserves settings at ${width}px`, async ({ page, request }, info) => {
    const entries = [
      { label: '文本模型', provider: 'openai-compatible', connectionType: 'text', capabilities: ['text'], parameters: { temperature: .25 } },
      { label: '图片模型', provider: 'seedream', connectionType: 'image', capabilities: ['image'], parameters: { size: '2048x2048' } },
      { label: '视频模型', provider: 'seedance', connectionType: 'video', capabilities: ['video'], parameters: { resolution: '720p' } },
    ];
    const saved: Array<{ label: string; model: ModelProfile }> = [];
    for (const entry of entries) saved.push({ label: entry.label, model: await rpc<ModelProfile>(request, 'model.save', { model: { name: `旧连接归类 ${entry.label} ${width}`, provider: entry.provider, baseUrl: catalog.baseUrl, model: 'fixture-category', connectionType: ((entry.capabilities) as readonly string[]).includes('text') ? 'text' : ((entry.capabilities) as readonly string[]).includes('video') ? 'video' : 'image', capabilities: entry.capabilities, parameters: entry.parameters } }) });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 }); await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/);
    await page.getByRole('button', { name: '模型连接', exact: true }).click(); const filters = page.getByRole('group', { name: '模型类型筛选' });
    await expect(filters.getByRole('button')).toHaveText(['全部', '文本模型', '图片模型', '视频模型']);
    await page.screenshot({ path: info.outputPath('model-categories.png') });
    for (const entry of saved) {
      await filters.getByRole('button', { name: entry.label, exact: true }).click();
      for (const other of saved) await expect(page.getByRole('heading', { name: other.model.name, exact: true })).toHaveCount(other.label === entry.label ? 1 : 0);
      await page.getByRole('button', { name: `编辑“${entry.model.name}”`, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '编辑模型连接', exact: true });
      await expect(dialog.locator('.model-connection-type .pill')).toHaveText(entry.label); await expect(dialog.locator('.capability-grid')).toHaveCount(0);
      await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
      const workspace = await rpc<{ models: ModelProfile[] }>(request, 'workspace.summary');
      const after = workspace.models.find(model => model.id === entry.model.id)!;
      expect(after).toMatchObject({ provider: entry.model.provider, baseUrl: entry.model.baseUrl, model: entry.model.model, parameters: entry.model.parameters, connectionType: ((entry.model.capabilities) as readonly string[]).includes('text') ? 'text' : ((entry.model.capabilities) as readonly string[]).includes('video') ? 'video' : 'image', capabilities: entry.model.capabilities });
    }
    await page.reload(); await page.getByRole('button', { name: '模型连接', exact: true }).click(); await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  });
}
