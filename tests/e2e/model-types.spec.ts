import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ModelConnectionType, ModelProfile } from '@video-quickly/contracts';
import { addModelConnection, settingField } from './settings';

async function models(request: APIRequestContext) {
  const response = await request.post('/__desktop_rpc', { data: { method: 'workspace.summary' } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return (payload.result as { models: ModelProfile[] }).models;
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`adds and filters four model types with automatic audio roles at ${viewport.width}px`, async ({ page, request }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme); await page.setViewportSize(viewport); await page.goto('/');
    await page.getByRole('button', { name: '模型连接', exact: true }).click(); await page.locator('.page-heading').getByRole('button', { name: '添加模型', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '选择模型类型', exact: true });
    for (const type of ['文本模型', '图片模型', '视频模型', '音频模型']) await expect(picker.getByRole('button', { name: new RegExp(`^${type}`) })).toBeVisible();
    await expect(picker.locator('.dialog__surface')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: info.outputPath('model-type-picker.png') });
    await picker.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(picker).toHaveCount(0);
    const cases: Array<{ type: string; kind: ModelConnectionType; platform: string; capability: 'text' | 'image' | 'video' | 'tts' | 'asr'; protocol?: string; parameterTab: string }> = [
      { type: '文本模型', kind: 'text', platform: 'anthropic', capability: 'text', parameterTab: '文本参数' },
      { type: '图片模型', kind: 'image', platform: 'seedream', capability: 'image', parameterTab: '图片参数' },
      { type: '视频模型', kind: 'video', platform: 'seedance', capability: 'video', parameterTab: '视频参数' },
      { type: '音频模型', kind: 'audio', platform: 'openai', capability: 'asr', protocol: 'openai-asr', parameterTab: '识别参数' },
      { type: '音频模型', kind: 'audio', platform: 'qwen-tts', capability: 'tts', parameterTab: '配音参数' },
    ];
    for (const item of cases) {
      await page.getByRole('group', { name: '模型类型筛选' }).getByRole('button', { name: item.type, exact: true }).click();
      const dialog = await addModelConnection(page, item.type); const name = `分类型 ${item.capability} ${viewport.width}`;
      await (await settingField(dialog, '模型平台')).selectOption(item.platform);
      await expect(dialog.getByLabel('API 协议', { exact: true })).toHaveCount(1); await expect(dialog.locator('.capability-grid')).toHaveCount(0);
      if (item.protocol) await (await settingField(dialog, 'API 协议')).selectOption(item.protocol);
      if (item.kind === 'text') await expect(dialog.getByLabel('API 协议', { exact: true })).toHaveValue('messages');
      await (await settingField(dialog, '连接名称')).fill(name); await (await settingField(dialog, '模型 ID')).fill(`fixture-${item.capability}`);
      await (await settingField(dialog, '服务地址')).fill('http://127.0.0.1:1/v1');
      for (const tab of ['文本参数', '图片参数', '视频参数', '配音参数', '识别参数']) {
        if (tab === item.parameterTab) await expect(dialog.getByRole('tab', { name: tab, exact: true })).toBeVisible();
        else await expect(dialog.getByRole('tab', { name: tab, exact: true })).toHaveCount(0);
      }
      await expect(dialog.locator('.dialog__footer')).toBeInViewport({ ratio: 1 }); await page.screenshot({ path: info.outputPath(`model-${item.capability}.png`) });
      await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
      const saved = (await models(request)).find(model => model.name === name)!;
      expect(saved.connectionType).toBe(item.kind); expect(saved.capabilities).toEqual(item.kind === 'text' ? ['text', 'vision', 'tools', 'structured-output'] : [item.capability]);
      expect(saved.provider).toBe(item.platform === 'seedream' || item.platform === 'seedance' || item.platform === 'qwen-tts' ? item.platform : 'openai-compatible');
      await expect(page.locator('.list-card').filter({ has: page.getByRole('heading', { name, exact: true }) })).toContainText(item.type);
    }
    await expect(page.getByRole('heading', { name: '凭据保存在本机', exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('model-connections-page.png') });
    await page.reload(); await page.getByRole('button', { name: '模型连接', exact: true }).click();
    const filters = page.getByRole('group', { name: '模型类型筛选' }); await filters.getByRole('button', { name: '音频模型', exact: true }).click();
    await expect(page.locator('.list-card').filter({ hasText: `分类型 asr ${viewport.width}` })).toHaveCount(1); await expect(page.locator('.list-card').filter({ hasText: `分类型 tts ${viewport.width}` })).toHaveCount(1);
    await expect(page.locator('.list-card').filter({ hasText: `分类型 image ${viewport.width}` })).toHaveCount(0);
    await page.getByRole('button', { name: `编辑“分类型 asr ${viewport.width}”`, exact: true }).click();
    const reopened = page.getByRole('dialog', { name: '编辑模型连接', exact: true }); await expect(reopened.getByLabel('API 协议', { exact: true })).toHaveValue('openai-asr');
    await expect(reopened.getByRole('tab', { name: '识别参数', exact: true })).toBeVisible(); await expect(reopened.locator('.capability-grid')).toHaveCount(0);
    await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
  });
}
