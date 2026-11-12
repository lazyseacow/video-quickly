import { createServer } from 'node:http';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ModelProfile, ProjectDocument, RunRecord, RunSummary } from '@video-quickly/contracts';
import { selectModel, addModelConnection, settingField } from './settings';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }); const payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const viewport of [{ width: 1024, height: 720 }, { width: 390, height: 844 }]) {
  test(`selects a model at a full Messages endpoint with default authentication at ${viewport.width}px`, async ({ page, request }, info) => {
    const calls: unknown[] = [];
    const server = createServer((incoming, response) => {
      calls.push({ method: incoming.method, path: incoming.url, auth: incoming.headers.authorization, apiKey: incoming.headers['x-api-key'] });
      if (incoming.method === 'GET' && incoming.url === '/relay/v1/models?limit=1000') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'relay-model' }] }));
      } else response.writeHead(incoming.method === 'HEAD' && incoming.url === '/relay/v1/messages' ? 405 : 404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('无测试端口');
      const baseUrl = `http://127.0.0.1:${address.port}/relay/v1/messages`, name = `完整中转地址 ${viewport.width}`;
      await page.setViewportSize(viewport); await page.goto('/');
      await page.getByRole('button', { name: '模型连接', exact: true }).click();
      const dialog = await addModelConnection(page);
      await (await settingField(dialog, '模型平台')).selectOption('custom');
      await (await settingField(dialog, '连接名称')).fill(name);
      await (await settingField(dialog, 'API 协议')).selectOption('messages');
      await expect(dialog.getByLabel('服务地址格式', { exact: true })).toHaveCount(0);
      await (await settingField(dialog, '服务地址')).fill(baseUrl);
      await (await settingField(dialog, 'API Key')).fill('fixture-relay-token');
      await expect(dialog.getByLabel('鉴权方式', { exact: true })).toHaveCount(0);
      await expect(dialog.getByLabel('模型来源', { exact: true })).toHaveCount(0);
      await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
      await selectModel(dialog, 'relay-model');
      await expect(dialog.locator('.dialog__footer')).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: info.outputPath('model-full-messages.png') });
      await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
      const saved = (await rpc<{ models: ModelProfile[] }>(request, 'workspace.summary')).models.find(model => model.name === name)!;
      expect(saved).toMatchObject({ baseUrl, model: 'relay-model', fullUrl: true, textProtocol: 'messages' });
      await expect(rpc(request, 'model.test', { modelId: saved.id })).resolves.toMatchObject({ connected: true });
      expect(calls).toEqual([
        { method: 'GET', path: '/relay/v1/models?limit=1000', auth: undefined, apiKey: 'fixture-relay-token' },
        { method: 'HEAD', path: '/relay/v1/messages', auth: undefined, apiKey: 'fixture-relay-token' },
      ]);
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

test('retains the full address of an existing custom endpoint when editing its name', async ({ page, request }) => {
  const baseUrl = 'http://127.0.0.1:1/relay/invoke';
  const previous = await rpc<ModelProfile>(request, 'model.save', { model: {
    name: '旧完整端点', baseUrl, fullUrl: true, provider: 'openai-compatible', platform: 'custom',
    connectionType: 'text', capabilities: ['text'], model: 'saved-relay',
  } });
  await page.goto('/'); await page.getByRole('button', { name: '模型连接', exact: true }).click();
  await page.getByRole('button', { name: `编辑“${previous.name}”`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑模型连接', exact: true });
  await expect(dialog.getByLabel('服务地址格式', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('服务地址', { exact: true })).toHaveValue(baseUrl);
  const name = '已改名的旧完整端点';
  await dialog.getByLabel('连接名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const { models } = await rpc<{ models: ModelProfile[] }>(request, 'workspace.summary');
  expect(models.find(model => model.id === previous.id)).toMatchObject({ name, baseUrl, fullUrl: true, model: 'saved-relay' });
});

test('requires a confirmed selection when saving from the model catalogue', async ({ page, request }) => {
  let releaseModels!: () => void, requestedModels!: () => void;
  const released = new Promise<void>(resolve => { releaseModels = resolve; });
  const requested = new Promise<void>(resolve => { requestedModels = resolve; });
  const server = createServer({ keepAliveTimeout: 0 }, async (incoming, response) => {
    expect(incoming.method).toBe('GET'); expect(incoming.url).toBe('/v1/models');
    requestedModels(); await released;
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'discovered-model' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。');
  try {
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
    await page.getByRole('button', { name: '模型连接', exact: true }).click();
    const dialog = await addModelConnection(page), name = '接口获取型号后保存';
    await (await settingField(dialog, '连接名称')).fill(name);
    await (await settingField(dialog, '模型平台')).selectOption('custom');
    await (await settingField(dialog, '服务地址')).fill(`http://127.0.0.1:${address.port}/v1`);
    await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await requested;
    const selector = dialog.getByRole('combobox', { name: '模型 ID', exact: true });
    await expect(selector).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '保存连接', exact: true })).toBeDisabled();
    releaseModels();
    await expect(dialog.getByRole('status')).toContainText('已读取 1 个模型');
    await expect(selector).toBeEnabled();
    await expect(selector).toHaveValue('');
    await selector.fill('unknown-model');
    await selector.press('Enter');
    await selector.press('Tab');
    await expect(selector).toHaveValue('');
    await expect(dialog.getByRole('button', { name: '保存连接', exact: true })).toBeDisabled();
    await selectModel(dialog, 'discovered-model');
    await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const workspace = await rpc<{ models: ModelProfile[] }>(request, 'workspace.summary');
    expect(workspace.models.find(model => model.name === name)?.model).toBe('discovered-model');
  } finally { releaseModels(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  for (const protocol of ['chat-completions', 'responses', 'messages'] as const) {
    test(`saves a connection and executes ${protocol} with stored parameters at ${viewport.width}px`, async ({ page, request }, info) => {
      test.setTimeout(60_000);
      const calls: Array<{ method?: string; path: string; body: Record<string, unknown> }> = [], errors: string[] = [];
      // Explicit teardown owns this successful provider's connection lifetime.
      const server = createServer({ keepAliveTimeout: 0 }, async (incoming, response) => {
        let body = ''; for await (const chunk of incoming) body += chunk.toString();
        calls.push({ method: incoming.method, path: incoming.url ?? '', body: body ? JSON.parse(body) : {} }); response.setHeader('Content-Type', 'application/json');
        if (incoming.method === 'GET') response.end(JSON.stringify({ data: [{ id: 'fixture-protocol' }] }));
        else if (protocol === 'responses') response.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '协议执行完成。' }] }], usage: { input_tokens: 40, output_tokens: 12, input_tokens_details: { cached_tokens: 5 } } }));
        else if (protocol === 'messages') response.end(JSON.stringify({ content: [{ type: 'text', text: '协议执行完成。' }], stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 12, cache_read_input_tokens: 5, cache_creation_input_tokens: 5 } }));
        else response.end(JSON.stringify({ choices: [{ message: { content: '协议执行完成。' } }], usage: { prompt_tokens: 40, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 5 } } }));
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。');
      try {
        page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme); await page.setViewportSize(viewport); await page.goto('/');
        await page.getByRole('button', { name: '模型连接', exact: true }).click(); let dialog = await addModelConnection(page); const name = `协议 ${protocol} ${viewport.width}`;
        await (await settingField(dialog, '连接名称')).fill(name);
        await (await settingField(dialog, '模型平台')).selectOption(protocol === 'messages' ? 'anthropic' : 'custom');
        await expect(await settingField(dialog, 'API 协议')).toHaveValue(protocol === 'messages' ? 'messages' : 'chat-completions');
        expect(await (await settingField(dialog, 'API 协议')).locator('option').allTextContents()).toEqual(['Chat Completions', 'Responses API', 'Anthropic Messages']);
        const baseUrl = `http://127.0.0.1:${address.port}/proxy/v1`;
        const endpointPath = `/proxy/v1/${protocol === 'chat-completions' ? 'chat/completions' : protocol}`;
        await (await settingField(dialog, '服务地址')).fill(baseUrl);
        await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
        await selectModel(dialog, 'fixture-protocol');
        await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
        const added = (await rpc<{ models: ModelProfile[] }>(request, 'workspace.summary')).models.find(model => model.name === name)!;
        await rpc(request, 'model.save', { model: { ...added, parameters: { max_tokens: 128, temperature: .5 } } });
        await page.reload(); await page.getByRole('button', { name: '模型连接', exact: true }).click();
        await page.getByRole('button', { name: `编辑“${name}”`, exact: true }).click();
        dialog = page.getByRole('dialog', { name: '编辑模型连接', exact: true });
        await (await settingField(dialog, 'API 协议')).selectOption(protocol);
        const fullUrl = viewport.width === 390;
        const savedAddress = fullUrl ? `http://127.0.0.1:${address.port}${endpointPath}` : baseUrl;
        await (await settingField(dialog, '服务地址')).fill(savedAddress);
        await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
        await expect(dialog.getByRole('status')).toContainText('已读取 1 个模型');
        await expect(dialog.getByLabel('服务协议', { exact: true })).toHaveCount(0); await expect(dialog.locator('.dialog__footer')).toBeInViewport({ ratio: 1 });
        await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
        await page.screenshot({ path: info.outputPath('model-api-protocol.png') });
        await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
        const workspace = await rpc<{ models: ModelProfile[] }>(request, 'workspace.summary'); const saved = workspace.models.find(model => model.name === name)!;
        expect(saved).toMatchObject({ textProtocol: protocol, baseUrl: savedAddress, fullUrl });
        expect(saved.parameters[protocol === 'responses' ? 'max_output_tokens' : 'max_tokens']).toBe(128);
        await page.getByRole('button', { name: `检查“${name}”连接`, exact: true }).click();
        await expect.poll(() => calls.some(call => fullUrl ? call.method === 'HEAD' && call.path === endpointPath : call.path === '/proxy/v1/models')).toBe(true);
        await page.reload(); await page.getByRole('button', { name: '模型连接', exact: true }).click(); await page.getByRole('button', { name: `编辑“${name}”`, exact: true }).click();
        dialog = page.getByRole('dialog', { name: '编辑模型连接', exact: true }); await expect(await settingField(dialog, 'API 协议')).toHaveValue(protocol);
        await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toHaveCount(0);
        const project = await rpc<ProjectDocument>(request, 'project.create', { title: name });
        await rpc(request, 'project.update', { projectId: project.id, patch: { workflow: { id: 'protocol', version: 1, name: '协议验收', production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [{ id: 'brief', kind: 'brief', label: '协议验收', modelId: saved.id }], edges: [] } } });
        const run = await rpc<RunRecord>(request, 'run.start', { projectId: project.id });
        await expect.poll(async () => (await rpc<RunSummary>(request, 'run.get', { runId: run.id })).status, { timeout: 30_000 }).toBe('succeeded');
        const generated = calls.find(call => call.method === 'POST')!;
        expect(generated.path).toBe(endpointPath); expect(generated.body[protocol === 'responses' ? 'max_output_tokens' : 'max_tokens']).toBe(128);
        const costs = await rpc<{ items: Array<{ providerUsage: Record<string, unknown> }> }>(request, 'cost.list', { runId: run.id });
        expect(costs.items).toHaveLength(1); expect(costs.items[0].providerUsage).toMatchObject({ inputTokens: 40, outputTokens: 12, cachedInputTokens: 5 }); expect(costs.items[0].providerUsage.cachedOutputTokens).toBeUndefined();
        expect(errors).toEqual([]);
      } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    });
  }
}

test('keeps the selected Claude API protocol and exposes Ollama native API', async ({ page, request }) => {
  const old = await rpc<ModelProfile>(request, 'model.save', { model: { name: 'Claude 协议配置', platform: 'anthropic', provider: 'openai-compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', connectionType: 'text', capabilities: ['text'] } });
  await page.goto('/'); await page.getByRole('button', { name: '模型连接', exact: true }).click(); await page.getByRole('button', { name: `编辑“${old.name}”`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑模型连接', exact: true }); await expect(await settingField(dialog, 'API 协议')).toHaveValue('chat-completions');
  await (await settingField(dialog, '模型平台')).selectOption('ollama');
  await expect(await settingField(dialog, 'API 协议')).toBeDisabled(); await expect(dialog.getByLabel('API 协议')).toHaveValue('ollama');
  await expect(dialog.locator('.capability-grid')).toHaveCount(0);
});
