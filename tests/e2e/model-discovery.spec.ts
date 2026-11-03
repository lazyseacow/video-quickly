import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import type { ModelProfile } from '@video-quickly/contracts';
import { selectModel, addModelConnection, settingField } from './settings';

let server: Server;
test.afterEach(async () => { if (server) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); });

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`retains a saved API key when editing the service address at ${viewport.width}px`, async ({ page, request }, info) => {
    const calls: string[] = [], errors: string[] = [], inputs: unknown[] = [];
    server = createServer((incoming, response) => {
      expect(incoming.headers.authorization).toBe('Bearer retained-ui-fixture-key');
      calls.push(incoming.url ?? '');
      response.end(JSON.stringify({ data: [{ id: 'fixture-key-model' }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('无测试端口');
    const baseUrl = `http://127.0.0.1:${address.port}/updated/v1`, name = `密钥保留 ${viewport.width}`;
    const created = await request.post('/__desktop_rpc', { data: { method: 'model.save', params: { model: { name, platform: 'custom', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/original', model: 'fixture-key-model', connectionType: 'text', capabilities: ['text'] }, secret: 'retained-ui-fixture-key' } } });
    const original = (await created.json()).result as ModelProfile; expect(original.hasSecret).toBe(true);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', outgoing => { if (outgoing.url().endsWith('/__desktop_rpc') && outgoing.method() === 'POST') inputs.push(outgoing.postDataJSON()); });
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme); await page.setViewportSize(viewport); await page.goto('/');
    await page.getByRole('button', { name: '模型连接', exact: true }).click(); await page.getByRole('button', { name: `编辑“${name}”`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '编辑模型连接', exact: true }), key = await settingField(dialog, 'API Key');
    await expect(key).toHaveValue(''); await expect(key).toHaveAttribute('placeholder', '••••••••••••');
    await (await settingField(dialog, '服务地址')).fill(baseUrl);
    await expect(key).toHaveAttribute('placeholder', '••••••••••••'); await expect(dialog).toContainText('已保存密钥；留空保留原值。');
    expect(calls).toEqual([]);
    await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('已读取 1 个模型'); await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.getByRole('combobox', { name: '模型 ID', exact: true })).toHaveValue('fixture-key-model');
    expect(calls).toEqual(['/updated/v1/models']);
    await expect(key).toHaveValue('');
    await page.screenshot({ path: info.outputPath('model-saved-key-edited-address.png') });
    await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const summary = await request.post('/__desktop_rpc', { data: { method: 'workspace.summary' } });
    const saved = ((await summary.json()).result.models as ModelProfile[]).find(value => value.id === original.id);
    expect(saved).toMatchObject({ baseUrl, hasSecret: true, credentialRef: original.credentialRef });
    await page.getByRole('button', { name: `编辑“${name}”`, exact: true }).click();
    const reopened = page.getByRole('dialog', { name: '编辑模型连接', exact: true });
    await expect(await settingField(reopened, 'API Key')).toHaveAttribute('placeholder', '••••••••••••');
    await reopened.getByRole('button', { name: '获取模型列表', exact: true }).click(); await expect(reopened.getByRole('status')).toContainText('已读取');
    expect(calls).toEqual(['/updated/v1/models', '/updated/v1/models']);
    expect(JSON.stringify(inputs)).not.toContain('retained-ui-fixture-key'); expect(errors).toEqual([]);
    await (await settingField(reopened, 'API Key')).fill('replacement-fixture-key');
    await (await settingField(reopened, '服务地址')).fill(`${baseUrl}/edited`);
    await expect(await settingField(reopened, 'API Key')).toHaveValue('replacement-fixture-key');
    await reopened.getByRole('button', { name: '取消', exact: true }).click();
  });

  test(`validates the address and API key before manually reading models at ${viewport.width}px`, async ({ page }, info) => {
    const calls: Array<{ secret?: string }> = [];
    await page.route('**/__desktop_rpc', async route => {
      const input = route.request().postDataJSON();
      if (input.method !== 'model.discover') { await route.continue(); return; }
      calls.push(input.params);
      await route.fulfill({ json: { result: { source: 'remote', items: [{ id: 'fixture-image', label: 'Fixture image' }], message: '已读取 1 个模型' } } });
    });
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme); await page.setViewportSize(viewport); await page.goto('/');
    await page.getByRole('button', { name: '模型连接', exact: true }).click(); const dialog = await addModelConnection(page, '图片模型');
    const download = dialog.getByRole('button', { name: '获取模型列表', exact: true });
    const key = await settingField(dialog, 'API Key'), address = await settingField(dialog, '服务地址');
    await download.click(); await expect(dialog.getByRole('alert')).toHaveText('请填写 API Key 后获取模型列表。');
    await expect(key).toBeFocused(); await expect(key).toHaveAttribute('aria-invalid', 'true');
    await page.screenshot({ path: info.outputPath('model-key-required.png') });
    await key.fill('   '); await download.click(); await expect(dialog.getByRole('alert')).toContainText('请填写 API Key');
    await address.fill(''); await download.click(); await expect(dialog.getByRole('alert')).toHaveText('请填写服务地址。');
    await expect(address).toBeFocused(); await expect(address).toHaveAttribute('aria-invalid', 'true');
    await address.fill('ftp://models.invalid'); await download.click(); await expect(dialog.getByRole('alert')).toContainText('HTTP 或 HTTPS');
    expect(calls).toEqual([]);
    await address.fill('https://models.invalid/v1'); await key.fill(' fixture-key ');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(page.waitForRequest(request => request.url().endsWith('/__desktop_rpc') && request.postDataJSON()?.method === 'model.discover', { timeout: 800 })).rejects.toThrow(/Timeout/);
    expect(calls).toEqual([]); await expect(dialog.getByLabel('模型 ID', { exact: true })).toBeDisabled();
    await download.click(); await expect(dialog.getByLabel('模型 ID', { exact: true })).toBeEnabled();
    expect(calls).toEqual([expect.objectContaining({ secret: 'fixture-key' })]);
    await expect(dialog.getByRole('status')).toContainText('已读取 1 个模型');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
  });

  test(`manually reads models, preserves a selection, and requires a successful retry at ${viewport.width}px`, async ({ page }, info) => {
    const errors: string[] = [], consoleErrors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) consoleErrors.push(message.text()); });
    const requests: string[] = []; let recovered = false;
    server = createServer((request, response) => {
      requests.push(request.url!);
      if (request.url === '/unsupported/models') {
        if (recovered) response.end(JSON.stringify({ data: [{ id: 'fixture-text-2' }] }));
        else { response.writeHead(404); response.end('unsupported'); }
        return;
      }
      expect(request.method).toBe('GET'); expect(request.headers.authorization).toBe('Bearer fixture-key');
      response.end(JSON.stringify({ data: [{ id: 'fixture-text-1', created: Date.UTC(2025, 0, 1) / 1000 }, { id: 'fixture-text-2', display_name: '创作模型', created: Date.UTC(2026, 9, 30) / 1000 }, { id: 'o1', created: Date.now() / 1000, shutdown_date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('无测试端口');
    const base = `http://127.0.0.1:${address.port}`;
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme); await page.setViewportSize(viewport); await page.goto('/');
    await expect(page).toHaveTitle(/Video Quickly/); await expect(page).toHaveURL('/');
    await page.getByRole('button', { name: '模型连接', exact: true }).click(); const dialog = await addModelConnection(page);
    await (await settingField(dialog, '模型平台')).selectOption('custom'); await (await settingField(dialog, '连接名称')).fill(`手动读取 ${viewport.width}`);
    await (await settingField(dialog, 'API Key')).fill('fixture-key'); await (await settingField(dialog, '服务地址')).fill(`${base}/v1`);
    const download = dialog.getByRole('button', { name: '获取模型列表', exact: true }); await download.click();
    const selector = dialog.getByRole('combobox', { name: '模型 ID', exact: true }); await expect(selector).toBeEnabled();
    await expect(dialog.locator('.model-discovery input')).toHaveCount(1);
    await selector.click();
    const list = dialog.getByRole('listbox', { name: '模型 ID列表', exact: true });
    await expect(list.getByRole('option')).toHaveText(['创作模型 · fixture-text-2', 'fixture-text-1']);
    const beforeSearch = requests.length;
    await selector.fill('missing-model');
    await expect(list).toContainText('没有匹配的模型'); await expect(list.getByRole('option')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '保存连接', exact: true })).toBeDisabled();
    await selector.fill('  FIXTURE-TEXT-1  ');
    await expect(list.getByRole('option')).toHaveText(['fixture-text-1']);
    await selector.press('Enter'); await expect(selector).toHaveValue('fixture-text-1'); await expect(list).toHaveCount(0);
    await selector.click(); await selector.press('ArrowDown'); await selector.press('Enter');
    await expect(selector).toHaveValue('fixture-text-2');
    await selectModel(dialog, 'fixture-text-1');
    await selector.fill('创作');
    await expect(list.getByRole('option')).toHaveText(['创作模型 · fixture-text-2']);
    await selector.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    await expect(list).toBeVisible(); await expect(dialog).toBeVisible();
    await page.screenshot({ path: info.outputPath('model-combobox-filtered.png') });
    await selector.press('Escape'); await expect(list).toHaveCount(0);
    await expect(selector).toHaveValue('fixture-text-1'); await expect(selector).toBeFocused(); await expect(dialog).toBeVisible();
    await selector.fill('missing-model'); await expect(list).toContainText('没有匹配的模型');
    await expect(dialog.getByRole('button', { name: '保存连接', exact: true })).toBeEnabled();
    await selector.press('Tab'); await expect(list).toHaveCount(0); await expect(selector).toHaveValue('fixture-text-1');
    await selector.fill(''); await expect(list.getByRole('option')).toHaveCount(2); await selector.press('Escape');
    expect(requests).toHaveLength(beforeSearch);
    const selectBox = await selector.boundingBox(), iconBox = await download.boundingBox();
    expect(iconBox!.x).toBeGreaterThan(selectBox!.x + selectBox!.width / 2);
    await selector.fill('创作');
    const before = requests.length; await download.click(); await expect.poll(() => requests.length).toBeGreaterThan(before);
    await expect(dialog.getByRole('status')).toContainText('已读取 2 个模型');
    await expect(selector).toHaveValue('fixture-text-1'); await expect(list).toHaveCount(0);
    await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1'); await page.screenshot({ path: info.outputPath('model-combobox-selected.png') });
    await selector.fill('创作');
    await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: `编辑“手动读取 ${viewport.width}”`, exact: true }).click();
    const reopened = page.getByRole('dialog', { name: '编辑模型连接', exact: true });
    await expect(reopened.getByRole('combobox', { name: '模型 ID', exact: true })).toHaveValue('fixture-text-1');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(consoleErrors).toEqual([]);
    await (await settingField(reopened, '服务地址')).fill(`${base}/unsupported`); await (await settingField(reopened, 'API Key')).fill('fixture-key');
    await reopened.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(reopened.getByRole('status')).toContainText('HTTP 404');
    const retrySelector = reopened.getByLabel('模型 ID', { exact: true });
    await expect(retrySelector).toBeDisabled(); await expect(retrySelector).toHaveValue('');
    await expect(reopened.getByRole('button', { name: '保存连接', exact: true })).toBeDisabled();
    recovered = true; await reopened.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(retrySelector).toBeEnabled(); await expect(retrySelector).toHaveValue('');
    await expect(reopened.getByRole('button', { name: '保存连接', exact: true })).toBeDisabled();
    await selectModel(reopened, 'fixture-text-2');
    await reopened.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(reopened).toHaveCount(0);
    expect(requests).toContain('/unsupported/models'); expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
  });
}

test('keeps an empty model catalogue read-only until the service returns a selectable model', async ({ page }) => {
  let available = false;
  server = createServer((_request, response) => response.end(JSON.stringify({ data: available ? [{ id: 'remote-model' }] : [] })));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('无测试端口');
  await page.goto('/'); await page.getByRole('button', { name: '模型连接', exact: true }).click(); const dialog = await addModelConnection(page);
  await (await settingField(dialog, '模型平台')).selectOption('custom'); await (await settingField(dialog, '连接名称')).fill('空目录重试');
  await (await settingField(dialog, '服务地址')).fill(`http://127.0.0.1:${address.port}/v1`);
  await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('未返回适合当前连接类型的模型');
  const selector = dialog.getByLabel('模型 ID', { exact: true });
  await expect(selector).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '保存连接', exact: true })).toBeDisabled();
  available = true; await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await expect(selector).toBeEnabled(); await selectModel(dialog, 'remote-model');
  await expect(dialog.getByRole('button', { name: '保存连接', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
});

test('filters OpenAI discovery by connection type', async ({ page }, info) => {
  server = createServer((request, response) => {
    expect(request.method).toBe('GET'); expect(request.url).toBe('/v1/models');
    response.end(JSON.stringify({ data: [
      { id: 'gpt-4o', created: 1_700_000_000 }, { id: 'gpt-4.1', created: 1_800_000_000 },
      { id: 'gpt-image-1' }, { id: 'sora-2' }, { id: 'gpt-4o-mini-tts' }, { id: 'gpt-4o-mini-transcribe' },
      { id: 'gpt-realtime' }, { id: 'text-embedding-3-large' }, { id: 'omni-moderation-latest' },
    ] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('无测试端口');
  await page.goto('/'); await page.getByRole('button', { name: '模型连接', exact: true }).click();
  for (const item of [
    { type: '文本模型', expected: ['gpt-4.1', 'gpt-4o'] },
    { type: '图片模型', expected: ['gpt-image-1'] },
    { type: '视频模型', expected: ['sora-2'] },
  ]) {
    const dialog = await addModelConnection(page, item.type);
    await expect(dialog.getByLabel('模型平台', { exact: true })).toHaveValue('openai');
    await (await settingField(dialog, '服务地址')).fill(`http://127.0.0.1:${address.port}/v1`);
    await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
    const selector = dialog.getByRole('combobox', { name: '模型 ID', exact: true });
    await expect(selector).toBeEnabled(); await selector.click();
    await expect(dialog.getByRole('listbox').getByRole('option')).toHaveText(item.expected); await selector.press('Escape');
    await expect(dialog.getByRole('status')).toContainText('按当前连接类型筛选');
    if (item.type === '文本模型') {
      await selectModel(dialog, 'gpt-4.1'); await page.screenshot({ path: info.outputPath('openai-text-discovery.png') });
    }
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toHaveCount(0);
  }
});

test('keeps the latest service results after the address changes', async ({ page }) => {
  let firstRequest: (() => void) | undefined;
  const started = new Promise<void>(resolve => { firstRequest = resolve; });
  server = createServer((request, response) => {
    if (request.url === '/slow/models') { firstRequest?.(); setTimeout(() => response.end(JSON.stringify({ data: [{ id: 'stale-model' }] })), 1200); }
    else response.end(JSON.stringify({ data: [{ id: 'latest-model' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('无测试端口');
  const base = `http://127.0.0.1:${address.port}`;
  await page.goto('/'); await page.getByRole('button', { name: '模型连接', exact: true }).click(); const dialog = await addModelConnection(page);
  await (await settingField(dialog, '模型平台')).selectOption('custom');
  const slowResponse = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postData()?.includes('/slow') === true);
  await (await settingField(dialog, '服务地址')).fill(`${base}/slow`); await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await started; await (await settingField(dialog, '服务地址')).fill(`${base}/latest`); await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
  const current = dialog.getByRole('combobox', { name: '模型 ID', exact: true }); await expect(current).toBeEnabled(); await current.click();
  await expect(dialog.getByRole('listbox').getByRole('option')).toHaveText(['latest-model']);
  await slowResponse; await expect(dialog.getByRole('listbox').getByRole('option')).toHaveText(['latest-model']);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
});
