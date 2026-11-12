import { confirmAction } from './confirmation-actions';
import { selectModel, addModelConnection, settingField } from './settings';
import { createServer } from 'node:http';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ModelProfile, ProjectDocument, RunSummary, WorkspaceSnapshot } from '@video-quickly/contracts';
import { storyboardFixtureResponse } from '../fixtures/planning-response';
import { modelCatalog } from './model-catalog';

let catalog: Awaited<ReturnType<typeof modelCatalog>>;
test.beforeEach(async () => { catalog = await modelCatalog(['fixture-parameters']); });
test.afterEach(async () => { await catalog.close(); });

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }); const payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function savedModel(request: APIRequestContext, name: string) { return (await rpc<WorkspaceSnapshot>(request, 'workspace.snapshot')).models.find(model => model.name === name)!; }
async function openModels(page: Page) { await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await page.getByRole('button', { name: '模型连接', exact: true }).click(); }
async function newModel(page: Page, name: string, url = catalog.baseUrl, type = '文本模型') {
  const dialog = await addModelConnection(page, type);
  await (await settingField(dialog, '模型平台')).selectOption('custom');
  await (await settingField(dialog, '连接名称')).fill(name); await (await settingField(dialog, '服务地址')).fill(url);
  await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await selectModel(dialog, 'fixture-parameters'); return dialog;
}
async function reopen(page: Page, name: string) { await page.getByRole('button', { name: `编辑“${name}”`, exact: true }).click(); return page.getByRole('dialog', { name: '编辑模型连接', exact: true }); }
function observe(page: Page) { const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); return errors; }

for (const { width, theme } of [{ width: 1536, theme: 'dark' }, { width: 390, theme: 'light' }]) test(`keeps API key visibility available after blur and keyboard toggling at ${width}px in ${theme} mode`, async ({ page }, info) => {
  const errors = observe(page), saved: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc') && request.method() === 'POST' && request.postDataJSON().method === 'model.save') saved.push('model.save'); });
  await page.addInitScript(value => localStorage.setItem('vq-theme', value), theme);
  await openModels(page); const dialog = await newModel(page, `密钥显示验收 ${theme}`);
  await page.setViewportSize({ width, height: 960 });
  const key = (await settingField(dialog, 'API Key'));
  const show = dialog.getByRole('button', { name: '显示密钥', exact: true });
  await expect(key).toHaveAttribute('type', 'password'); await expect(show).toBeDisabled();
  await key.fill('fixture-key-for-visibility');
  await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await (await settingField(dialog, '模型 ID')).focus();
  await expect(show).toBeVisible(); await expect(show).toBeEnabled();
  await key.click(); await show.click();
  await expect(key).toHaveAttribute('type', 'text'); await expect(key).toHaveValue('fixture-key-for-visibility');
  const hide = dialog.getByRole('button', { name: '隐藏密钥', exact: true });
  await expect(hide).toHaveAttribute('aria-pressed', 'true');
  await (await settingField(dialog, '模型 ID')).focus(); await expect(hide).toBeVisible();
  await hide.focus(); await page.keyboard.press('Space');
  await expect(key).toHaveAttribute('type', 'password'); await expect(show).toHaveAttribute('aria-pressed', 'false');
  await show.focus(); await page.keyboard.press('Enter');
  await expect(key).toHaveAttribute('type', 'text');
  await hide.click(); await (await settingField(dialog, '模型 ID')).focus();
  await expect(key).toHaveValue('fixture-key-for-visibility'); await expect(show).toBeInViewport();
  const button = await show.boundingBox(); expect(button!.width).toBeGreaterThanOrEqual(width < 650 ? 44 : 40);
  await page.screenshot({ path: info.outputPath('api-key-reveal-after-blur.png') });
  await expect(dialog).toBeVisible(); expect(saved).toEqual([]); expect(errors).toEqual([]);
});

test('offers branded platform presets and a persisted Gemini-compatible connection', async ({ page, request }) => {
  let checkedPath = '';
  const server = createServer({ keepAliveTimeout: 0 }, (incoming, response) => { checkedPath = incoming.url ?? ''; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'fixture-gemini' }] })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('无效测试服务地址');
  try {
    await openModels(page); const name = 'Gemini 平台预设验收'; const dialog = await newModel(page, name);
    const platform = dialog.getByRole('combobox', { name: '模型平台', exact: true });
    for (const [value, baseUrl] of [['anthropic', 'https://api.anthropic.com/v1'], ['google', 'https://generativelanguage.googleapis.com/v1beta/openai'], ['deepseek', 'https://api.deepseek.com'], ['moonshot', 'https://api.moonshot.cn/v1'], ['zhipu', 'https://open.bigmodel.cn/api/paas/v4'], ['siliconflow', 'https://api.siliconflow.cn/v1'], ['openrouter', 'https://openrouter.ai/api/v1']]) {
      await platform.selectOption(value); await expect((await settingField(dialog, '服务地址'))).toHaveValue(baseUrl);
      const logo = platform.locator('selectedcontent img'); await expect(logo).toBeVisible(); await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      if (value === 'moonshot') await expect(logo).toHaveCSS('filter', 'invert(1)');
    }
    await platform.selectOption('qwen'); await expect((await settingField(dialog, '服务地址'))).toHaveValue(''); await expect(dialog).toContainText('工作空间 ID');
    await platform.selectOption('custom'); await expect(await settingField(dialog, 'API 协议')).toHaveValue('chat-completions');
    await platform.selectOption('google');
    await expect(dialog.locator('.capability-grid')).toHaveCount(0);
    await (await settingField(dialog, '服务地址')).fill(`http://127.0.0.1:${address.port}/v1beta/openai`);
    await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await selectModel(dialog, 'fixture-gemini');
    await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const card = page.locator('.list-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(card).toContainText('Gemini'); await expect(card.locator('.platform-icon')).toBeVisible();
    await card.getByRole('button', { name: `检查“${name}”连接`, exact: true }).click();
    await expect.poll(() => checkedPath).toBe('/v1beta/openai/models');
    await page.reload(); await page.getByRole('button', { name: '模型连接', exact: true }).click();
    const saved = await savedModel(request, name); expect(saved.platform).toBe('google'); expect(saved.provider).toBe('openai-compatible');
    const reopened = await reopen(page, name); await expect((await settingField(reopened, '模型平台'))).toHaveValue('google'); await expect((await settingField(reopened, '服务地址'))).toHaveValue(`http://127.0.0.1:${address.port}/v1beta/openai`);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('keeps the latest saved image parameters, pricing and enabled state when editing basic fields', async ({ page, request }) => {
  const name = '图片连接配置', updatedName = '图片连接配置已改名';
  const parameters = { vendor_extension: { mode: 'keep-me' }, size: '1280x720', quality: 'high', imageSequenceMode: 'continuous' };
  const original = await rpc<ModelProfile>(request, 'model.save', { model: {
    name, provider: 'openai-compatible', baseUrl: catalog.baseUrl, model: 'fixture-parameters', connectionType: 'image', capabilities: ['image'],
    parameters, pricing: { currency: 'CNY', perImage: .25 }, enabled: false,
  } });
  await openModels(page); const dialog = await reopen(page, name);
  const latestParameters = { ...parameters, size: '1920x1080' }, latestPricing = { currency: 'CNY', perImage: .5 };
  await rpc(request, 'model.save', { model: { ...original, parameters: latestParameters, pricing: latestPricing } });
  await (await settingField(dialog, '连接名称')).fill(updatedName);
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const saved = await savedModel(request, updatedName);
  expect(saved).toMatchObject({ id: original.id, enabled: false });
  expect(saved.parameters).toEqual(latestParameters);
  expect(saved.pricing).toEqual(latestPricing);
});

test('offers ComfyUI only in video model connections', async ({ page, request }, info) => {
  await openModels(page);
  const image = await addModelConnection(page, '图片模型');
  const imagePlatform = await settingField(image, '模型平台');
  await expect(imagePlatform.locator('option[value="comfyui"]')).toHaveCount(0);
  await imagePlatform.selectOption('custom');
  await expect((await settingField(image, 'API 协议')).locator('option[value="comfyui"]')).toHaveCount(0);
  await image.screenshot({ path: info.outputPath('image-connections.png') });
  await image.getByRole('button', { name: '取消', exact: true }).click();
  const video = await addModelConnection(page, '视频模型');
  await (await settingField(video, '模型平台')).selectOption('comfyui');
  await expect(await settingField(video, 'API 协议')).toHaveValue('comfyui');
  const name = 'ComfyUI 视频连接验收';
  await (await settingField(video, '连接名称')).fill(name);
  await video.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await expect(video.getByText('生成视频需要预先配置 ComfyUI 工作流。', { exact: true })).toBeVisible();
  await video.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(video).toHaveCount(0);
  const saved = await savedModel(request, name);
  expect(saved).toMatchObject({ provider: 'comfyui', platform: 'comfyui', model: 'workflow', capabilities: ['video'], parameters: {} });
  const parameters = { workflow: { '1': { class_type: 'Fixture', inputs: {} } }, inputMapping: {} };
  await rpc(request, 'model.save', { model: { ...saved, parameters } });
  await openModels(page);
  const editor = await reopen(page, name);
  await editor.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect((await savedModel(request, name)).parameters).toEqual(parameters);
});

test('uses protocol defaults for incompatible stored parameters and rejects invalid explicit values', async ({ page, request }) => {
  const name = '协议参数边界';
  await rpc(request, 'model.save', { model: {
    name, provider: 'openai-compatible', baseUrl: catalog.baseUrl, model: 'fixture-parameters', connectionType: 'text', capabilities: ['text'],
    parameters: { temperature: 1.5, max_tokens: 8, vendor_extension: 'preserved' },
  } });
  await openModels(page);
  for (const [protocol, parameters] of [
    ['messages', { max_tokens: 8, vendor_extension: 'preserved' }],
    ['responses', { vendor_extension: 'preserved' }],
  ] as const) {
    const dialog = await reopen(page, name);
    await (await settingField(dialog, 'API 协议')).selectOption(protocol);
    await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('已读取 1 个模型');
    await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const saved = await savedModel(request, name);
    expect(saved.textProtocol).toBe(protocol); expect(saved.parameters).toEqual(parameters);
  }
  const response = await request.post('/__desktop_rpc', { data: { method: 'model.save', params: { model: { name: '非法参数不得保存', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'invalid', connectionType: 'text', capabilities: ['text'], parameters: { temperature: 3 } } } } });
  expect(response.ok()).toBe(false); expect((await response.json()).error).toContain('文本温度'); expect(await savedModel(request, '非法参数不得保存')).toBeUndefined();
});

for (const delayedProgress of [false, true]) test(`uses stored parameters in actual text and image HTTP requests after a basic edit${delayedProgress ? ' with delayed terminal progress' : ''}`, async ({ page, request }) => {
  const errors = observe(page), requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  function progressGate() {
    let release!: () => void, observe!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const observed = new Promise<void>(resolve => { observe = resolve; });
    return { release, observe, released, observed };
  }
  const gates = { script: progressGate(), image: progressGate() };
  const generatedKinds = new Map<string, keyof typeof gates>();
  // Hold only the observer response: the actual HTTP generation and runtime
  // still finish, while the dialog must retain its previous candidate list.
  if (delayedProgress) await page.route('**/__desktop_rpc', async route => {
    const input = route.request().postDataJSON();
    if (input.method === 'shot.regenerate' && (input.params.kind === 'script' || input.params.kind === 'image')) {
      const response = await route.fetch(), payload = await response.json(); generatedKinds.set(payload.result.id, input.params.kind);
      await route.fulfill({ response, json: payload }); return;
    }
    const kind = input.method === 'run.get' ? generatedKinds.get(input.params.runId) : undefined;
    if (kind) {
      const response = await route.fetch(), payload = await response.json();
      if (payload.result.status === 'succeeded') { gates[kind].observe(); await gates[kind].released; }
      await route.fulfill({ response, json: payload }); return;
    }
    await route.continue();
  });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const server = createServer({ keepAliveTimeout: 0 }, (incoming, response) => { void (async () => {
    if (incoming.method === 'GET') { response.end(JSON.stringify({ data: [{ id: 'fixture-parameters' }] })); return; }
    let text = ''; for await (const chunk of incoming) text += chunk.toString(); const path = incoming.url ?? '', body = JSON.parse(text) as Record<string, unknown> & { messages?: { content: string }[] }; requests.push({ path, body });
    if (path.endsWith('/chat/completions')) {
      const content = storyboardFixtureResponse(body.messages?.[0]?.content ?? '', JSON.stringify({
        shots: [{ title: '真实参数候选', narration: '旁白', visualPrompt: '画面', durationUs: 2_000_000 }],
      }));
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    }
    else if (path.endsWith('/images/generations')) response.end(JSON.stringify({ data: [{ b64_json: png }] })); else { response.statusCode = 404; response.end(); }
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('参数服务未启动');
  try {
    const name = '实际HTTP表单模型' + (delayedProgress ? ' 延迟进度' : '');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await openModels(page);
    const connections: Record<string, ModelProfile> = {};
    for (const role of ['text', 'image'] as const) {
      const parameters = role === 'text' ? { temperature: .25, max_tokens: 87 } : { size: '1024x1024', quality: 'high' };
      const original = await rpc<ModelProfile>(request, 'model.save', { model: {
        name: name + role, provider: 'openai-compatible', baseUrl, model: 'fixture-parameters', connectionType: role, capabilities: [role],
        parameters: { ...parameters, vendor_tag: 'round-trip' },
      } });
      const form = await reopen(page, original.name);
      const renamed = original.name + ' 已改名';
      await (await settingField(form, '连接名称')).fill(renamed);
      await form.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(form).toHaveCount(0);
      connections[role === 'text' ? 'script' : role] = await savedModel(request, renamed);
    }
    let project = await rpc<ProjectDocument>(request, 'project.create', { title: `参数真实请求验收${delayedProgress ? ' 延迟进度' : ''}` }); project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'parameters-shot', title: '原镜头', narration: '旁白', visualPrompt: '画面', durationUs: 2_000_000 }] } });
    await page.reload(); await page.getByRole('button', { name: '我的项目', exact: true }).click(); await page.locator('.project-card').filter({ hasText: project.title }).getByRole('button', { name: /继续创作/ }).click(); await page.getByRole('button', { name: 'AI 微调', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '镜头候选', exact: true });
    async function generateAndWait(kind: keyof typeof gates, previousCandidates: number) {
      await (await settingField(dialog, '生成内容')).selectOption(kind); await (await settingField(dialog, '生成模型')).selectOption(connections[kind].id);
      const generated = page.waitForResponse(response => {
        if (!response.url().endsWith('/__desktop_rpc') || response.request().method() !== 'POST') return false;
        const input = response.request().postDataJSON(); return input.method === 'shot.regenerate' && input.params.projectId === project.id && input.params.kind === kind;
      });
      await dialog.getByRole('button', { name: '生成候选', exact: true }).click(); await confirmAction(page, '确认生成');
      const response = await generated, started = await response.json(); expect(response.ok()).toBe(true); expect(started.error).toBeUndefined();
      // Both text and image generation are asynchronous. Keep the normal UI
      // assertion timeout separate from startup, generation and progress reads.
      await expect.poll(async () => (await rpc<RunSummary>(request, 'run.get', { runId: started.result.id })).status, { timeout: 30_000 }).toBe('succeeded');
      if (delayedProgress) { await gates[kind].observed; await expect(dialog.locator('.shot-regeneration__history-item')).toHaveCount(previousCandidates); gates[kind].release(); }
    }
    await generateAndWait('script', 0);
    await expect(dialog.locator('.shot-regeneration__comparison')).toContainText('真实参数候选'); await expect(dialog.getByRole('button', { name: '生成候选', exact: true })).toBeEnabled();
    await generateAndWait('image', 1);
    await expect(dialog.locator('.shot-regeneration__history-item')).toHaveCount(2);
    await expect(dialog.getByAltText('候选画面')).toBeVisible();
    expect(requests).toHaveLength(2); expect(requests[0].body).toMatchObject({ temperature: .25, max_tokens: 87, vendor_tag: 'round-trip' }); for (const key of ['quality', 'size', 'voice', 'speed']) expect(requests[0].body).not.toHaveProperty(key);
    expect(requests[1].body).toMatchObject({ size: '1024x1024', quality: 'high', vendor_tag: 'round-trip' }); for (const key of ['temperature', 'max_tokens', 'voice', 'speed']) expect(requests[1].body).not.toHaveProperty(key);
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project).toEqual(project); expect(errors).toEqual([]);
  } finally { gates.script.release(); gates.image.release(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
