import { createServer } from 'node:http';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ModelProfile, ProjectDocument, RunRecord, TextProtocol } from '@video-quickly/contracts';
import { addModelConnection, settingControl, settingField } from './settings';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }); const payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}

for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  for (const protocol of ['chat-completions', 'responses', 'messages'] as const) {
    test(`saves and executes ${protocol} from the model form at ${viewport.width}px`, async ({ page, request }, info) => {
      const calls: Array<{ path: string; body: Record<string, unknown> }> = [], errors: string[] = [];
      const server = createServer(async (incoming, response) => {
        let body = ''; for await (const chunk of incoming) body += chunk.toString();
        calls.push({ path: incoming.url ?? '', body: body ? JSON.parse(body) : {} }); response.setHeader('Content-Type', 'application/json');
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
        await (await settingField(dialog, '服务地址')).fill(`http://127.0.0.1:${address.port}/proxy/v1`); await (await settingField(dialog, '模型 ID')).fill('fixture-protocol');
        await (await settingField(dialog, '最大输出 Token')).fill('128'); await (await settingField(dialog, '文本温度')).fill('0.5');
        await (await settingField(dialog, 'API 协议')).selectOption(protocol); await expect(await settingField(dialog, '最大输出 Token')).toHaveValue('128');
        await dialog.getByRole('tab', { name: '基本连接', exact: true }).click();
        await expect(dialog.getByLabel('服务协议', { exact: true })).toHaveCount(0); await expect(dialog.locator('.dialog__footer')).toBeInViewport({ ratio: 1 });
        await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
        await page.screenshot({ path: info.outputPath('model-api-protocol.png') });
        await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
        const workspace = await rpc<{ models: ModelProfile[] }>(request, 'workspace.summary'); const saved = workspace.models.find(model => model.name === name)!;
        expect(saved.textProtocol).toBe(protocol); expect(saved.parameters[protocol === 'responses' ? 'max_output_tokens' : 'max_tokens']).toBe(128);
        await page.getByRole('button', { name: `检查“${name}”连接`, exact: true }).click(); await expect.poll(() => calls.some(call => call.path === '/proxy/v1/models')).toBe(true);
        await page.reload(); await page.getByRole('button', { name: '模型连接', exact: true }).click(); await page.getByRole('button', { name: `编辑“${name}”`, exact: true }).click();
        dialog = page.getByRole('dialog', { name: '编辑模型连接', exact: true }); await expect(await settingField(dialog, 'API 协议')).toHaveValue(protocol);
        await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toHaveCount(0);
        const project = await rpc<ProjectDocument>(request, 'project.create', { title: name });
        await rpc(request, 'workflow.save', { projectId: project.id, workflow: { id: 'protocol', version: 1, name: '协议验收', nodes: [{ id: 'brief', kind: 'brief', label: '协议验收', modelId: saved.id }], edges: [] } });
        const run = await rpc<RunRecord>(request, 'run.start', { projectId: project.id });
        await expect.poll(async () => (await rpc<{ runs: RunRecord[] }>(request, 'workspace.snapshot')).runs.find(value => value.id === run.id)?.status).toBe('succeeded');
        const generated = calls.find(call => call.path.split('?')[0] !== '/proxy/v1/models')!;
        expect(generated.path).toBe(`/proxy/v1/${protocol === 'chat-completions' ? 'chat/completions' : protocol}`); expect(generated.body[protocol === 'responses' ? 'max_output_tokens' : 'max_tokens']).toBe(128);
        const costs = await rpc<{ items: Array<{ providerUsage: Record<string, unknown> }> }>(request, 'cost.list', { runId: run.id });
        expect(costs.items).toHaveLength(1); expect(costs.items[0].providerUsage).toMatchObject({ inputTokens: 40, outputTokens: 12, cachedInputTokens: 5 }); expect(costs.items[0].providerUsage.cachedOutputTokens).toBeUndefined();
        expect(errors).toEqual([]);
      } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    });
  }
}

test('keeps a legacy Claude connection on its saved protocol and exposes Ollama native API', async ({ page, request }) => {
  const old = await rpc<ModelProfile>(request, 'model.save', { model: { name: '旧版 Claude 兼容连接', platform: 'anthropic', provider: 'openai-compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', capabilities: ['text'] } });
  await page.goto('/'); await page.getByRole('button', { name: '模型连接', exact: true }).click(); await page.getByRole('button', { name: `编辑“${old.name}”`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑模型连接', exact: true }); await expect(await settingField(dialog, 'API 协议')).toHaveValue('chat-completions');
  await (await settingField(dialog, '模型平台')).selectOption('ollama');
  await expect(await settingField(dialog, 'API 协议')).toBeDisabled(); await expect(dialog.getByLabel('API 协议')).toHaveValue('ollama');
  await expect(dialog.locator('.capability-grid')).toHaveCount(0);
});
