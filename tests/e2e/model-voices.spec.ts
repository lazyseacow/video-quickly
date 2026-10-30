import { createServer } from 'node:http';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ModelProfile } from '@video-quickly/contracts';
import { addModelConnection, settingField } from './settings';

async function savedModel(request: APIRequestContext, name: string) {
  const response = await request.post('/__desktop_rpc', { data: { method: 'workspace.summary' } }); const payload = await response.json();
  expect(payload.error).toBeUndefined(); return (payload.result.models as ModelProfile[]).find(model => model.name === name)!;
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`selects searchable model-specific voices and preserves a custom voice at ${viewport.width}px`, async ({ page, request }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme); await page.setViewportSize(viewport); await page.goto('/');
    await expect(page).toHaveTitle(/Video Quickly/); await page.getByRole('button', { name: '模型连接', exact: true }).click();
    const dialog = await addModelConnection(page, '音频模型'); const name = `音色选择 ${viewport.width}`;
    await (await settingField(dialog, '连接名称')).fill(name); await (await settingField(dialog, '模型平台')).selectOption('volcengine');
    const voice = await settingField(dialog, '配音音色'); await expect(voice.locator('option[value="zh_female_vv_uranus_bigtts"]')).toHaveCount(1);
    await dialog.getByLabel('搜索配音音色', { exact: true }).fill('Vivi'); await expect(voice.locator('option[value="zh_female_xiaohe_uranus_bigtts"]')).toHaveCount(0);
    await voice.selectOption('zh_female_vv_uranus_bigtts'); await expect(voice).toHaveValue('zh_female_vv_uranus_bigtts');
    await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1'); await page.screenshot({ path: info.outputPath('voice-picker.png') });
    await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
    expect((await savedModel(request, name)).parameters.voice).toBe('zh_female_vv_uranus_bigtts');
    await page.getByRole('button', { name: `编辑“${name}”`, exact: true }).click(); const edit = page.getByRole('dialog', { name: '编辑模型连接', exact: true });
    await (await settingField(edit, '资源 ID')).selectOption('seed-tts-1.0');
    const old = await settingField(edit, '配音音色'); await expect(old.locator('option[value="zh_female_vv_uranus_bigtts"]')).toContainText('当前：');
    await edit.getByLabel('搜索配音音色', { exact: true }).fill('甜心小美');
    await old.selectOption('zh_female_tianxinxiaomei_emo_v2_mars_bigtts');
    await old.selectOption('__custom_voice__'); const custom = await settingField(edit, '配音音色'); await custom.fill('S_private_fixture');
    await edit.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(edit).toHaveCount(0); expect((await savedModel(request, name)).parameters.voice).toBe('S_private_fixture');
    await page.getByRole('button', { name: `编辑“${name}”`, exact: true }).click(); const again = page.getByRole('dialog', { name: '编辑模型连接', exact: true });
    await expect(await settingField(again, '配音音色')).toHaveValue('S_private_fixture');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
  });
}

test('loads Qwen account voices, selects by ID, and saves without training or synthesis', async ({ page, request }) => {
  const actions: string[] = [];
  const server = createServer(async (incoming, response) => {
    if (incoming.method === 'GET') { response.end(JSON.stringify({ data: [{ id: 'qwen3-tts-vc' }] })); return; }
    let raw = ''; for await (const chunk of incoming) raw += chunk.toString(); const body = JSON.parse(raw); actions.push(body.input.action);
    expect(incoming.headers.authorization).toBe('Bearer fixture-key'); expect(incoming.url).toBe('/api/v1/services/audio/tts/customization');
    response.end(JSON.stringify(body.input.action === 'list_voice' ? { output: { voice_list: [{ voice_id: 'fixture-account-voice', status: 'OK' }] } } : { output: { target_model: 'qwen3-tts-vc', status: 'OK' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('无测试端口');
  try {
    await page.goto('/'); await page.getByRole('button', { name: '模型连接', exact: true }).click(); const dialog = await addModelConnection(page, '音频模型');
    await (await settingField(dialog, '模型平台')).selectOption('qwen-tts'); await (await settingField(dialog, '连接名称')).fill('账号音色连接');
    await (await settingField(dialog, '模型 ID')).fill('qwen3-tts-vc'); await (await settingField(dialog, '服务地址')).fill(`http://127.0.0.1:${address.port}/api/v1`); await (await settingField(dialog, 'API Key')).fill('fixture-key');
    await dialog.getByRole('tab', { name: '配音参数', exact: true }).click(); const voice = dialog.locator('select[aria-label="配音音色"]');
    await expect(voice).toBeVisible(); await voice.selectOption('fixture-account-voice');
    await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
    expect((await savedModel(request, '账号音色连接')).parameters.voice).toBe('fixture-account-voice'); expect(actions).toEqual(['list_voice', 'query_voice']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
