import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { addModelConnection, settingField } from './settings';

let server: Server;
test.afterEach(async () => { if (server) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); });

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`automatically discovers models, preserves a selection, and requires a successful retry at ${viewport.width}px`, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
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
    await page.getByRole('button', { name: '模型连接', exact: true }).click(); const dialog = await addModelConnection(page);
    await (await settingField(dialog, '模型平台')).selectOption('custom'); await (await settingField(dialog, '连接名称')).fill(`自动读取 ${viewport.width}`);
    await (await settingField(dialog, 'API Key')).fill('fixture-key'); await (await settingField(dialog, '服务地址')).fill(`${base}/v1`);
    const selector = dialog.locator('select[aria-label="模型 ID"]'); await expect(selector).toBeEnabled();
    expect(await selector.locator('option').evaluateAll(options => options.map(option => option.value))).toEqual(['', 'fixture-text-2', 'fixture-text-1']);
    await selector.selectOption('fixture-text-1');
    const download = dialog.getByRole('button', { name: '获取模型列表', exact: true });
    await expect(dialog.getByRole('button', { name: '读取模型', exact: true })).toHaveCount(0);
    const selectBox = await selector.boundingBox(), iconBox = await download.boundingBox();
    expect(iconBox!.x).toBeGreaterThan(selectBox!.x + selectBox!.width / 2);
    const before = requests.length; await download.click(); await expect.poll(() => requests.length).toBeGreaterThan(before);
    await expect(dialog.getByRole('status')).toContainText('已读取 2 个模型');
    await expect(selector).toHaveValue('fixture-text-1');
    expect(await selector.locator('option').evaluateAll(options => options.map(option => option.value))).toEqual(['', 'fixture-text-2', 'fixture-text-1']);
    if (viewport.width < 650) await dialog.locator('.model-discovery').scrollIntoViewIfNeeded();
    await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1'); await page.screenshot({ path: info.outputPath('model-discovery.png') });
    await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: `编辑“自动读取 ${viewport.width}”`, exact: true }).click();
    const reopened = page.getByRole('dialog', { name: '编辑模型连接', exact: true }); await expect(reopened.locator('select[aria-label="模型 ID"]')).toHaveValue('fixture-text-1');
    await (await settingField(reopened, '服务地址')).fill(`${base}/unsupported`); await (await settingField(reopened, 'API Key')).fill('fixture-key');
    await expect(reopened.getByRole('status')).toContainText('HTTP 404');
    const retrySelector = reopened.getByLabel('模型 ID', { exact: true });
    await expect(retrySelector).toBeDisabled(); await expect(retrySelector).toHaveValue('');
    await expect(reopened.getByRole('button', { name: '保存连接', exact: true })).toBeDisabled();
    await expect(reopened.locator('input[aria-label="模型 ID"]')).toHaveCount(0); await expect(reopened.getByRole('button', { name: '手动填写', exact: true })).toHaveCount(0);
    if (viewport.width < 650) await reopened.locator('.model-discovery').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('model-discovery-retry.png') });
    recovered = true; await reopened.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(retrySelector).toBeEnabled(); await expect(retrySelector).toHaveValue('');
    expect(await retrySelector.locator('option').evaluateAll(options => options.map(option => option.value))).toEqual(['', 'fixture-text-2']);
    await expect(reopened.getByRole('button', { name: '保存连接', exact: true })).toBeDisabled();
    await retrySelector.selectOption('fixture-text-2');
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
  await expect(dialog.getByRole('status')).toContainText('未返回可用模型');
  const selector = dialog.getByLabel('模型 ID', { exact: true });
  await expect(selector).toBeDisabled(); await expect(dialog.locator('input[aria-label="模型 ID"]')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '保存连接', exact: true })).toBeDisabled();
  available = true; await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await expect(selector).toBeEnabled(); await selector.selectOption('remote-model');
  await expect(dialog.getByRole('button', { name: '保存连接', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
});

test('filters OpenAI discovery by connection type and separates speech from transcription', async ({ page }, info) => {
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
    { type: '音频模型', expected: ['gpt-4o-mini-tts'] },
  ]) {
    const dialog = await addModelConnection(page, item.type);
    await expect(dialog.getByLabel('模型平台', { exact: true })).toHaveValue('openai');
    await (await settingField(dialog, '服务地址')).fill(`http://127.0.0.1:${address.port}/v1`);
    const selector = dialog.locator('select[aria-label="模型 ID"]');
    await expect.poll(() => selector.locator('option').evaluateAll(options => options.map(option => option.value))).toEqual(['', ...item.expected]);
    await expect(dialog.getByRole('status')).toContainText('按当前连接类型筛选');
    if (item.type === '文本模型') {
      await selector.selectOption('gpt-4.1'); await page.screenshot({ path: info.outputPath('openai-text-discovery.png') });
    }
    if (item.type === '音频模型') {
      await (await settingField(dialog, 'API 协议')).selectOption('openai-asr');
      await expect.poll(() => selector.locator('option').evaluateAll(options => options.map(option => option.value))).toEqual(['', 'gpt-4o-mini-transcribe']);
    }
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toHaveCount(0);
  }
});

test('keeps the latest service results and selects Doubao resource presets with separate voice parameters', async ({ page }, info) => {
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
  await (await settingField(dialog, '服务地址')).fill(`${base}/slow`); await started; await (await settingField(dialog, '服务地址')).fill(`${base}/latest`);
  await expect(dialog.locator('select[aria-label="模型 ID"] option[value="latest-model"]')).toHaveCount(1);
  await slowResponse; await expect(dialog.locator('select[aria-label="模型 ID"] option[value="stale-model"]')).toHaveCount(0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  const audio = await addModelConnection(page, '音频模型'); await (await settingField(audio, '模型平台')).selectOption('volcengine');
  await expect(audio.getByLabel('API 协议', { exact: true })).toHaveValue('volcengine-tts');
  await expect(audio.locator('select[aria-label="资源 ID"]')).toHaveValue('seed-tts-2.0'); await expect(audio.getByRole('status')).toContainText('资源预设');
  await (await settingField(audio, '连接名称')).fill('豆包专用配音'); await (await settingField(audio, 'API Key')).fill('fixture-key');
  await (await settingField(audio, '配音音色')).selectOption('zh_female_vv_uranus_bigtts'); await audio.getByRole('tab', { name: '基本连接', exact: true }).click();
  await expect(audio.locator('select[aria-label="资源 ID"]')).toHaveValue('seed-tts-2.0'); await expect(audio.getByRole('status')).toContainText('资源预设');
  await expect(audio.locator('.dialog__surface')).toHaveCSS('opacity', '1'); await page.screenshot({ path: info.outputPath('doubao-speech.png') });
  await audio.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(audio).toHaveCount(0);
  await expect(page.locator('.list-card').filter({ hasText: '豆包专用配音' })).toContainText('配音生成');
  await page.getByRole('button', { name: '编辑“豆包专用配音”', exact: true }).click(); const edit = page.getByRole('dialog', { name: '编辑模型连接', exact: true });
  await (await settingField(edit, 'API 协议')).selectOption('volcengine-asr'); await expect(edit.getByLabel('资源 ID', { exact: true })).toHaveValue('volc.bigasr.auc_turbo');
  await expect(edit.getByRole('tab', { name: '识别参数', exact: true })).toBeVisible(); await expect(edit.getByRole('tab', { name: '配音参数', exact: true })).toHaveCount(0);
  await edit.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(edit).toHaveCount(0);
  await expect(page.locator('.list-card').filter({ hasText: '豆包专用配音' })).toContainText('语音识别');
});
