import { addModelConnection, settingField } from './settings';
import { createServer } from 'node:http';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ModelProfile, ProjectDocument, RunSummary, WorkspaceSnapshot } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }); const payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function savedModel(request: APIRequestContext, name: string) { return (await rpc<WorkspaceSnapshot>(request, 'workspace.snapshot')).models.find(model => model.name === name)!; }
async function openModels(page: Page) { await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await page.getByRole('button', { name: '模型连接', exact: true }).click(); }
async function newModel(page: Page, name: string, url = 'http://127.0.0.1:1/v1', type = '文本模型') {
  const dialog = await addModelConnection(page, type);
  await (await settingField(dialog, '连接名称')).fill(name); await (await settingField(dialog, '服务地址')).fill(url); await (await settingField(dialog, '模型 ID')).fill('fixture-parameters'); return dialog;
}
async function reopen(page: Page, name: string) { await page.getByRole('button', { name: `编辑“${name}”`, exact: true }).click(); return page.getByRole('dialog', { name: '编辑模型连接', exact: true }); }
async function legacyModel(page: Page, request: APIRequestContext, name: string, url = 'http://127.0.0.1:1/v1', capabilities = ['text', 'image', 'video', 'tts', 'asr']) {
  await rpc(request, 'model.save', { model: { name, provider: 'openai-compatible', baseUrl: url, model: 'fixture-parameters', capabilities } });
  return reopen(page, name);
}
async function advanced(dialog: Locator) { await dialog.getByRole('tab', { name: '高级设置', exact: true }).click(); return dialog.getByLabel('模型参数 JSON', { exact: true }); }
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
  await (await settingField(dialog, '模型 ID')).click();
  await expect(show).toBeVisible(); await expect(show).toBeEnabled();
  await key.click(); await show.click();
  await expect(key).toHaveAttribute('type', 'text'); await expect(key).toHaveValue('fixture-key-for-visibility');
  const hide = dialog.getByRole('button', { name: '隐藏密钥', exact: true });
  await expect(hide).toHaveAttribute('aria-pressed', 'true');
  await (await settingField(dialog, '模型 ID')).click(); await expect(hide).toBeVisible();
  await hide.focus(); await page.keyboard.press('Space');
  await expect(key).toHaveAttribute('type', 'password'); await expect(show).toHaveAttribute('aria-pressed', 'false');
  await show.focus(); await page.keyboard.press('Enter');
  await expect(key).toHaveAttribute('type', 'text');
  await hide.click(); await (await settingField(dialog, '模型 ID')).click();
  await expect(key).toHaveValue('fixture-key-for-visibility'); await expect(show).toBeInViewport();
  const button = await show.boundingBox(); expect(button!.width).toBeGreaterThanOrEqual(width < 650 ? 44 : 40);
  await page.screenshot({ path: info.outputPath('api-key-reveal-after-blur.png') });
  await expect(dialog).toBeVisible(); expect(saved).toEqual([]); expect(errors).toEqual([]);
});

test('offers branded platform presets and a persisted Gemini-compatible connection', async ({ page, request }) => {
  let checkedPath = '';
  const server = createServer((incoming, response) => { checkedPath = incoming.url ?? ''; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'fixture-gemini' }] })); });
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
    await (await settingField(dialog, '模型 ID')).fill('fixture-gemini');
    await (await settingField(dialog, '服务地址')).fill(`http://127.0.0.1:${address.port}/v1beta/openai`);
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

test('round-trips structured fields, common image sizes and custom dimensions while retaining advanced JSON', async ({ page, request }, info) => {
  const errors = observe(page), name = '表单与高级参数往返'; await openModels(page); let dialog = await legacyModel(page, request, name);
  await expect(dialog.locator('.capability-grid')).toHaveCount(0);
  expect(await (await settingField(dialog, '图片与视频尺寸')).count()).toBe(1);
  const json = await advanced(dialog); await (await advanced(dialog)).fill(JSON.stringify({ vendor_extension: { mode: 'keep-me' }, temperature: .1, size: '1280x720' }));
  await expect((await settingField(dialog, '文本温度'))).toHaveValue('0.1'); await (await settingField(dialog, '文本温度')).fill('0.35');
  await (await settingField(dialog, '最大输出 Token')).fill('93'); await (await settingField(dialog, '图片质量')).selectOption('high');
  await (await settingField(dialog, '视频时长（秒）')).fill('8'); await (await settingField(dialog, '配音音色')).fill('alloy'); await (await settingField(dialog, '配音语速')).fill('1.25');
  await (await settingField(dialog, '识别时间粒度')).selectOption('word'); await (await settingField(dialog, '识别返回格式')).selectOption('verbose_json'); await (await settingField(dialog, '识别语言')).fill('zh');
  const parameters = JSON.parse(await json.inputValue()); expect(parameters).toEqual({ vendor_extension: { mode: 'keep-me' }, temperature: .35, size: '1280x720', max_tokens: 93, quality: 'high', seconds: 8, voice: 'alloy', speed: 1.25, timestampGranularity: 'word', asrResponseFormat: 'verbose_json', language: 'zh' });
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(await savedModel(request, name)).toMatchObject({ parameters });
  expect((await savedModel(request, name)).pricing).toBeUndefined();
  await page.reload(); await page.getByRole('button', { name: '模型连接', exact: true }).click(); dialog = await reopen(page, name);
  await expect((await settingField(dialog, '文本温度'))).toHaveValue('0.35');
  await expect((await settingField(dialog, '图片与视频尺寸'))).toHaveValue('1280x720');
  await (await settingField(dialog, '图片与视频尺寸')).selectOption('1024x1024');
  const updatedJson = await advanced(dialog);
  expect(JSON.parse(await updatedJson.inputValue()).size).toBe('1024x1024');
  await (await settingField(dialog, '图片与视频尺寸')).selectOption('custom');
  await (await settingField(dialog, '自定义图片与视频尺寸')).fill('1920x1080');
  expect(JSON.parse(await updatedJson.inputValue()).vendor_extension).toEqual({ mode: 'keep-me' });
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect((await savedModel(request, name)).parameters).toEqual({ ...parameters, size: '1920x1080' });
  dialog = await reopen(page, name); await expect((await settingField(dialog, '自定义图片与视频尺寸'))).toHaveValue('1920x1080');
  await (await settingField(dialog, '配音音色')).scrollIntoViewIfNeeded(); await expect(dialog.getByRole('button', { name: '保存连接', exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('model-parameters-dark.png') });
  expect(errors).toEqual([]);
});

test('shows protocol-specific controls and rejects malformed values in both UI and model.save', async ({ page, request }, info) => {
  const errors = observe(page); await openModels(page); const dialog = await legacyModel(page, request, '协议参数边界', 'http://127.0.0.1:1/v1', ['text', 'tts', 'asr']);
  const json = await advanced(dialog); await (await advanced(dialog)).fill('{"temperature":3}'); await expect(dialog.getByRole('alert')).toContainText('文本温度'); await expect(dialog.getByRole('button', { name: '保存连接', exact: true })).toBeDisabled();
  await (await advanced(dialog)).fill('{"vendor_extension":"preserved"}'); await (await settingField(dialog, '模型平台')).selectOption('ollama'); await (await settingField(dialog, '文本温度')).fill('0.4'); await (await settingField(dialog, '最大输出 Token')).fill('61');
  expect(JSON.parse(await json.inputValue())).toEqual({ vendor_extension: 'preserved', options: { temperature: .4, num_predict: 61 } });
  await (await settingField(dialog, '模型平台')).selectOption('qwen-tts');
  await expect((await settingField(dialog, '配音语速'))).toHaveCount(0); await expect((await settingField(dialog, '配音语言'))).toBeVisible(); await (await settingField(dialog, '配音语言')).selectOption('English');
  await (await settingField(dialog, '模型平台')).selectOption('openai');
  await (await advanced(dialog)).fill('{"timestampGranularity":"word","asrResponseFormat":"diarized_json"}'); await expect(dialog.getByRole('alert')).toContainText('diarized_json 不支持逐词时间戳'); await expect(dialog.getByRole('button', { name: '保存连接', exact: true })).toBeDisabled();
  const response = await request.post('/__desktop_rpc', { data: { method: 'model.save', params: { model: { name: '非法参数不得保存', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'invalid', capabilities: ['tts'], parameters: { speed: -1 } } } } });
  expect(response.ok()).toBe(false); expect((await response.json()).error).toContain('配音语速'); expect(await savedModel(request, '非法参数不得保存')).toBeUndefined();
  await page.setViewportSize({ width: 600, height: 900 }); await (await advanced(dialog)).fill('{}'); await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1'); await (await settingField(dialog, '配音音色')).scrollIntoViewIfNeeded(); await expect(dialog.getByRole('button', { name: '保存连接', exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('model-parameters-600.png') }); expect(errors).toEqual([]);
});

for (const delayedProgress of [false, true]) test(`uses the saved structured controls in actual text and image HTTP requests without cross-capability leakage${delayedProgress ? ' with delayed terminal progress' : ''}`, async ({ page, request }) => {
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
  const server = createServer((incoming, response) => { void (async () => {
    let text = ''; for await (const chunk of incoming) text += chunk.toString(); const path = incoming.url ?? '', body = JSON.parse(text) as Record<string, unknown>; requests.push({ path, body });
    if (path.endsWith('/chat/completions')) response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ shots: [{ title: '真实参数候选', narration: '旁白', visualPrompt: '画面', durationUs: 2_000_000 }] }) } }] }));
    else if (path.endsWith('/images/generations')) response.end(JSON.stringify({ data: [{ b64_json: png }] })); else { response.statusCode = 404; response.end(); }
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('参数服务未启动');
  try {
    const name = `实际HTTP表单模型${delayedProgress ? ' 延迟进度' : ''}`; await openModels(page); const form = await legacyModel(page, request, name, `http://127.0.0.1:${address.port}/v1`, ['text', 'image', 'tts']);
    await (await settingField(form, '文本温度')).fill('0.25'); await (await settingField(form, '最大输出 Token')).fill('87'); await (await settingField(form, '图片尺寸')).selectOption('1024x1024'); await (await settingField(form, '图片质量')).selectOption('high'); await (await settingField(form, '配音音色')).fill('alloy'); await (await settingField(form, '配音语速')).fill('1.3');
    const json = await advanced(form); const values = JSON.parse(await json.inputValue()); await (await advanced(form)).fill(JSON.stringify({ ...values, vendor_tag: 'round-trip' })); await form.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(form).toHaveCount(0); const model = await savedModel(request, name);
    let project = await rpc<ProjectDocument>(request, 'project.create', { title: `参数真实请求验收${delayedProgress ? ' 延迟进度' : ''}` }); project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'parameters-shot', title: '原镜头', narration: '旁白', visualPrompt: '画面', durationUs: 2_000_000 }] } });
    await page.reload(); await page.getByRole('button', { name: '我的项目', exact: true }).click(); await page.locator('.project-card').filter({ hasText: project.title }).getByRole('button', { name: /继续创作/ }).click(); await page.getByRole('button', { name: 'AI 微调', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '镜头候选', exact: true });
    async function generateAndWait(kind: keyof typeof gates, previousCandidates: number) {
      await (await settingField(dialog, '生成内容')).selectOption(kind); await (await settingField(dialog, '生成模型')).selectOption(model.id);
      const generated = page.waitForResponse(response => {
        if (!response.url().endsWith('/__desktop_rpc') || response.request().method() !== 'POST') return false;
        const input = response.request().postDataJSON(); return input.method === 'shot.regenerate' && input.params.projectId === project.id && input.params.kind === kind;
      });
      await dialog.getByRole('button', { name: '生成候选', exact: true }).click();
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
