import { createServer } from 'node:http';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ModelProfile, ProjectDocument, WorkspaceSnapshot } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } }); const payload = await response.json();
  expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function savedModel(request: APIRequestContext, name: string) { return (await rpc<WorkspaceSnapshot>(request, 'workspace.snapshot')).models.find(model => model.name === name)!; }
async function openModels(page: Page) { await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await page.getByRole('button', { name: '模型连接', exact: true }).click(); }
async function newModel(page: Page, name: string, url = 'http://127.0.0.1:1/v1') {
  await page.locator('.page-heading').getByRole('button', { name: '添加模型', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '添加模型连接', exact: true });
  await dialog.getByLabel('连接名称', { exact: true }).fill(name); await dialog.getByLabel('服务地址', { exact: true }).fill(url); await dialog.getByLabel('模型 ID', { exact: true }).fill('fixture-parameters'); return dialog;
}
async function reopen(page: Page, name: string) { await page.getByRole('button', { name: `编辑“${name}”`, exact: true }).click(); return page.getByRole('dialog', { name: '编辑模型连接', exact: true }); }
async function advanced(dialog: Locator) { await dialog.getByText('高级模型参数', { exact: true }).click(); return dialog.getByRole('textbox', { name: '模型参数 JSON', exact: true }); }
function observe(page: Page) { const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); return errors; }

test('round-trips structured fields and unknown advanced JSON, persists manual prices, and clears them explicitly', async ({ page, request }, info) => {
  const errors = observe(page), name = '表单与高级参数往返'; await openModels(page); let dialog = await newModel(page, name);
  for (const capability of ['图片', '视频', '配音', '语音识别']) await dialog.getByRole('checkbox', { name: capability, exact: true }).check();
  expect(await dialog.getByLabel('图片与视频尺寸', { exact: true }).count()).toBe(1);
  const json = await advanced(dialog); await json.fill(JSON.stringify({ vendor_extension: { mode: 'keep-me' }, temperature: .1, size: '1280x720' }));
  await expect(dialog.getByLabel('文本温度', { exact: true })).toHaveValue('0.1'); await dialog.getByLabel('文本温度', { exact: true }).fill('0.35');
  await dialog.getByLabel('最大输出 Token', { exact: true }).fill('93'); await dialog.getByLabel('图片质量', { exact: true }).selectOption('high');
  await dialog.getByLabel('视频时长（秒）', { exact: true }).fill('8'); await dialog.getByLabel('配音音色', { exact: true }).fill('alloy'); await dialog.getByLabel('配音语速', { exact: true }).fill('1.25');
  await dialog.getByLabel('识别时间粒度', { exact: true }).selectOption('word'); await dialog.getByLabel('识别返回格式', { exact: true }).selectOption('verbose_json'); await dialog.getByLabel('识别语言', { exact: true }).fill('zh');
  const parameters = JSON.parse(await json.inputValue()); expect(parameters).toEqual({ vendor_extension: { mode: 'keep-me' }, temperature: .35, size: '1280x720', max_tokens: 93, quality: 'high', seconds: 8, voice: 'alloy', speed: 1.25, timestampGranularity: 'word', asrResponseFormat: 'verbose_json', language: 'zh' });
  await dialog.getByRole('checkbox', { name: '设置手动价格', exact: true }).check(); await dialog.getByLabel('价格币种', { exact: true }).selectOption('CNY');
  await dialog.getByLabel('输入价格（每百万 Token）', { exact: true }).fill('2.5'); await dialog.getByLabel('每张图片价格', { exact: true }).fill('0.3');
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(await savedModel(request, name)).toMatchObject({ parameters, pricing: { currency: 'CNY', inputPerMillionTokens: 2.5, perImage: .3 } });
  await page.reload(); await page.getByRole('button', { name: '模型连接', exact: true }).click(); dialog = await reopen(page, name);
  await expect(dialog.getByLabel('文本温度', { exact: true })).toHaveValue('0.35'); await expect(dialog.getByLabel('每张图片价格', { exact: true })).toHaveValue('0.3');
  await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1'); await dialog.getByLabel('配音音色', { exact: true }).scrollIntoViewIfNeeded(); await expect(dialog.getByRole('button', { name: '保存连接', exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('model-parameters-dark.png') });
  await dialog.getByRole('button', { name: '清除价格', exact: true }).click(); await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect((await savedModel(request, name)).pricing).toBeNull(); await page.reload(); await page.getByRole('button', { name: '模型连接', exact: true }).click(); dialog = await reopen(page, name); await expect(dialog.getByRole('checkbox', { name: '设置手动价格', exact: true })).not.toBeChecked();
  expect((await savedModel(request, name)).parameters).toEqual(parameters); expect(errors).toEqual([]);
});

test('shows protocol-specific controls and rejects malformed values in both UI and model.save', async ({ page, request }, info) => {
  const errors = observe(page); await openModels(page); const dialog = await newModel(page, '协议参数边界');
  const json = await advanced(dialog); await json.fill('{"temperature":3}'); await expect(dialog.getByRole('alert')).toContainText('文本温度'); await expect(dialog.getByRole('button', { name: '保存连接', exact: true })).toBeDisabled();
  await json.fill('{"vendor_extension":"preserved"}'); await dialog.getByLabel('服务协议', { exact: true }).selectOption('ollama'); await dialog.getByLabel('文本温度', { exact: true }).fill('0.4'); await dialog.getByLabel('最大输出 Token', { exact: true }).fill('61');
  expect(JSON.parse(await json.inputValue())).toEqual({ vendor_extension: 'preserved', options: { temperature: .4, num_predict: 61 } });
  await dialog.getByLabel('服务协议', { exact: true }).selectOption('qwen-tts'); await dialog.getByRole('checkbox', { name: '文本', exact: true }).uncheck(); await dialog.getByRole('checkbox', { name: '配音', exact: true }).check();
  await expect(dialog.getByLabel('配音语速', { exact: true })).toHaveCount(0); await expect(dialog.getByLabel('配音语言', { exact: true })).toBeVisible(); await dialog.getByLabel('配音语言', { exact: true }).selectOption('English');
  await dialog.getByLabel('服务协议', { exact: true }).selectOption('openai-compatible'); await dialog.getByRole('checkbox', { name: '语音识别', exact: true }).check();
  await json.fill('{"timestampGranularity":"word","asrResponseFormat":"diarized_json"}'); await expect(dialog.getByRole('alert')).toContainText('diarized_json 不支持逐词时间戳'); await expect(dialog.getByRole('button', { name: '保存连接', exact: true })).toBeDisabled();
  const response = await request.post('/__desktop_rpc', { data: { method: 'model.save', params: { model: { name: '非法参数不得保存', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'invalid', capabilities: ['tts'], parameters: { speed: -1 } } } } });
  expect(response.ok()).toBe(false); expect((await response.json()).error).toContain('配音语速'); expect(await savedModel(request, '非法参数不得保存')).toBeUndefined();
  await page.setViewportSize({ width: 600, height: 900 }); await json.fill('{}'); await expect(dialog.locator('.dialog__surface')).toHaveCSS('opacity', '1'); await dialog.getByLabel('配音音色', { exact: true }).scrollIntoViewIfNeeded(); await expect(dialog.getByRole('button', { name: '保存连接', exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('model-parameters-600.png') }); expect(errors).toEqual([]);
});

test('uses the saved structured controls in actual text and image HTTP requests without cross-capability leakage', async ({ page, request }) => {
  const errors = observe(page), requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const server = createServer((incoming, response) => { void (async () => {
    let text = ''; for await (const chunk of incoming) text += chunk.toString(); const path = incoming.url ?? '', body = JSON.parse(text) as Record<string, unknown>; requests.push({ path, body });
    if (path.endsWith('/chat/completions')) response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ shots: [{ title: '真实参数候选', narration: '旁白', visualPrompt: '画面', durationUs: 2_000_000 }] }) } }] }));
    else if (path.endsWith('/images/generations')) response.end(JSON.stringify({ data: [{ b64_json: png }] })); else { response.statusCode = 404; response.end(); }
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('参数服务未启动');
  try {
    const name = '实际HTTP表单模型'; await openModels(page); const form = await newModel(page, name, `http://127.0.0.1:${address.port}/v1`);
    await form.getByRole('checkbox', { name: '图片', exact: true }).check(); await form.getByRole('checkbox', { name: '配音', exact: true }).check(); await form.getByLabel('文本温度', { exact: true }).fill('0.25'); await form.getByLabel('最大输出 Token', { exact: true }).fill('87'); await form.getByLabel('图片尺寸', { exact: true }).fill('1024x1024'); await form.getByLabel('图片质量', { exact: true }).selectOption('high'); await form.getByLabel('配音音色', { exact: true }).fill('alloy'); await form.getByLabel('配音语速', { exact: true }).fill('1.3');
    const json = await advanced(form); const values = JSON.parse(await json.inputValue()); await json.fill(JSON.stringify({ ...values, vendor_tag: 'round-trip' })); await form.getByRole('button', { name: '保存连接', exact: true }).click(); await expect(form).toHaveCount(0); const model = await savedModel(request, name);
    let project = await rpc<ProjectDocument>(request, 'project.create', { title: '参数真实请求验收' }); project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'parameters-shot', title: '原镜头', narration: '旁白', visualPrompt: '画面', durationUs: 2_000_000 }] } });
    await page.reload(); await page.getByRole('button', { name: '我的项目', exact: true }).click(); await page.locator('.project-card').filter({ hasText: project.title }).getByRole('button', { name: /继续创作/ }).click(); await page.getByRole('button', { name: 'AI 微调', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '镜头候选', exact: true }); await dialog.getByLabel('生成模型', { exact: true }).selectOption(model.id); await dialog.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(dialog.locator('.shot-regeneration__comparison')).toContainText('真实参数候选'); await expect(dialog.getByRole('button', { name: '生成候选', exact: true })).toBeEnabled();
    await dialog.getByLabel('生成内容', { exact: true }).selectOption('image'); await dialog.getByLabel('生成模型', { exact: true }).selectOption(model.id); await dialog.getByRole('button', { name: '生成候选', exact: true }).click(); await expect(dialog.locator('.shot-regeneration__history-item')).toHaveCount(2);
    expect(requests).toHaveLength(2); expect(requests[0].body).toMatchObject({ temperature: .25, max_tokens: 87, vendor_tag: 'round-trip' }); for (const key of ['quality', 'size', 'voice', 'speed']) expect(requests[0].body).not.toHaveProperty(key);
    expect(requests[1].body).toMatchObject({ size: '1024x1024', quality: 'high', vendor_tag: 'round-trip' }); for (const key of ['temperature', 'max_tokens', 'voice', 'speed']) expect(requests[1].body).not.toHaveProperty(key);
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project).toEqual(project); expect(errors).toEqual([]);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
