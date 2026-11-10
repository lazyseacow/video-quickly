import { confirmAction } from './confirmation-actions';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ProjectDocument, RecordPage, RunInspection, RunSummary, RunStepPayload, UsageRecord } from '@video-quickly/contracts';
import { openProjectFromList } from './workspace-navigation';
import { planningFixtureFields, storyboardFixtureResponse, storyboardOutlineRequest } from '../fixtures/planning-response';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok(), JSON.stringify(payload.error)).toBe(true); return payload.result;
}
async function fixture(request: APIRequestContext, protocol: 'chat-completions' | 'responses', options: { rejectSecondScript?: boolean; maasFormatFailure?: boolean; invalidFirstBrief?: boolean; scriptResponses?: Record<string, unknown>[]; shotCount?: number; failureBatch?: number; fixedSchema?: boolean; emptyFirstOutline?: boolean; rateLimitedBatch?: boolean } = {}) {
  const calls: { step: string; batch?: number; body: Record<string, unknown> }[] = [];
  const server = createServer({ keepAliveTimeout: 0 }, async (incoming, response) => {
    let text = ''; for await (const chunk of incoming) text += chunk.toString();
    const body = JSON.parse(text), prompt = (body.messages ?? body.input)[0].content as string;
    const step = storyboardOutlineRequest(prompt) ? 'outline' : prompt.includes('自动视频制作步骤：旁白与分镜') ? 'script' : prompt.includes('自动视频制作步骤：创意简报') ? 'brief' : 'style';
    const batch = step === 'script' ? Number(/分镜生成阶段：第 (\d+)\//.exec(prompt)?.[1]) : undefined;
    calls.push({ step, batch, body });
    const attempt = calls.filter(call => call.step === step && call.batch === batch).length;
    if (step === 'script' && attempt === 2 && (options.rejectSecondScript || options.maasFormatFailure)) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: options.maasFormatFailure ? { message: 'The request is invalid: the request was rejected by an internal MaaS component. Please check the request body, required fields, and request format.', type: 'invalid_request_error', param: '', code: '400001' } : { code: 'invalid_request_error', message: 'private-provider-detail' } })); return;
    }
    const failureBatch = batch === (options.failureBatch ?? 1);
    const failed = failureBatch && attempt === 1;
    if (failed && options.rateLimitedBatch) {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '90' });
      response.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'private-provider-detail' } }));
      return;
    }
    const shot = { title: '原文保留的镜头', narration: failed ? protocol === 'responses' ? '原始旁白内容' : { text: '原始旁白内容' } : '修正后的旁白', visualPrompt: '水彩办公桌 api_key=fixture-hidden-key', durationUs: 2_000_000 };
    const invalidBrief = options.invalidFirstBrief && attempt === 1;
    const shots = Array.from({ length: options.shotCount ?? 1 }, (_, index) => options.shotCount ? { ...shot, title: `镜头 ${index + 1}` } : shot);
    const output = step === 'brief' ? { ...planningFixtureFields('brief', '本次已完成的简报'), ...(invalidBrief ? { topic: 42 } : {}) }
      : step === 'style' ? planningFixtureFields('style', '本次已完成的水彩风格') : failed && protocol === 'responses' ? shot : { shots, entities: [] };
    const content = storyboardFixtureResponse(prompt, JSON.stringify(output));
    const override = options.emptyFirstOutline && step === 'outline' && attempt === 1 ? { status: 'incomplete', output: [], usage: { input_tokens: 16, output_tokens: 0 } }
      : failureBatch ? options.scriptResponses?.[attempt - 1] : undefined;
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(override ?? (protocol === 'responses' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }] } : { choices: [{ message: { content } }] })));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('夹具服务未启动');
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  try {
    const model = await rpc<{ id: string }>(request, 'model.save', { model: { name: `校验文本 ${randomUUID()}`, provider: 'openai-compatible', textProtocol: protocol, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', capabilities: ['text', 'structured-output'], connectionType: 'text',
      ...(options.fixedSchema ? { parameters: { text: { verbosity: 'low', format: { type: 'json_schema', name: 'video_storyboard', schema: { type: 'object' } } } } } : {}),
    } });
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `分镜校验 ${randomUUID().slice(0, 8)}`, brief: '生成办公故事' });
    const nodes = [{ id: 'brief', kind: 'brief', label: '创意简报', config: { modelBinding: 'default' } }, { id: 'style', kind: 'style', label: '风格与角色', config: { modelBinding: 'default' } }, { id: 'script', kind: 'script', label: '旁白与分镜', modelId: model.id }, { id: 'tail', kind: 'animation', label: '本地剪辑准备', config: { operation: 'prepare-edit' } }];
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, patch: { workflow: { id: 'native-video', name: '校验验收', version: 1, production: { mode: 'native-video', textModelId: model.id, referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes, edges: nodes.slice(1).map((node, i) => ({ id: `edge-${i}`, source: nodes[i].id, target: node.id })) } } });
    const run = await rpc<RunSummary>(request, 'run.start', { projectId: project.id });
    const inspect = () => rpc<RunInspection>(request, 'run.inspect', { runId: run.id });
    const expectedStatus = options.emptyFirstOutline ? 'succeeded' : options.scriptResponses?.length || options.rateLimitedBatch ? 'needs_attention' : 'failed';
    await expect.poll(async () => (await inspect()).run.status).toBe(expectedStatus);
    return { project, run, calls, inspect, close };
  } catch (error) { await close(); throw error; }
}

test('automatically retries an empty Responses outline and continues the same production', async ({ page, request }) => {
  const source = await fixture(request, 'responses', { emptyFirstOutline: true, failureBatch: 0, shotCount: 10 });
  try {
    expect(source.calls.map(call => call.step)).toEqual(['brief', 'style', 'outline', 'outline', 'script', 'script']);
    expect(source.calls[2].body).toHaveProperty('text.format.name', 'video_storyboard_outline');
    const { text: _automaticFormat, ...original } = source.calls[2].body;
    expect(source.calls[3].body).toEqual(original);
    for (const call of source.calls.slice(4)) expect(call.body).not.toHaveProperty('text');
    expect((await source.inspect()).steps.map(step => step.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    const result = await rpc<RunStepPayload>(request, 'run.step.payload', { runId: source.run.id, nodeId: 'script', kind: 'output' });
    expect(result.value).toMatchObject({ outline: '按镜头计划展开叙事。' });

    const usage = await rpc<RecordPage<UsageRecord>>(request, 'cost.list', { runId: source.run.id });
    const outlineUsage = usage.items.filter(item => item.operationId.includes(':storyboard:outline:')).reverse();
    expect(outlineUsage.map(item => item.operationId.split(':response:')[1])).toEqual(['1', '2']);
    expect(outlineUsage[0].providerUsage).toMatchObject({ inputTokens: 16, outputTokens: 0 });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/'); await openProjectFromList(page, source.project.title);
    await page.getByRole('button', { name: '打开阶段：策划与分镜', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '本次制作', exact: true });
    await expect(dialog.getByRole('region', { name: '分镜预览', exact: true }).getByRole('listitem')).toHaveCount(10);
  } finally { await source.close(); }
});

test('shows the saved first batch and resumes the failed batch from the workbench', async ({ page, request }, info) => {
  const source = await fixture(request, 'responses', { shotCount: 12, failureBatch: 2, fixedSchema: true, scriptResponses: [
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] },
  ] });
  try {
    await page.goto('/'); await openProjectFromList(page, source.project.title);
    await page.getByRole('button', { name: '打开阶段：策划与分镜', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '本次制作', exact: true });
    const draft = dialog.getByRole('region', { name: '已保存分镜', exact: true });
    await expect(draft.getByRole('heading', { name: '全片大纲', exact: true })).toBeVisible();
    await expect(draft.getByRole('region', { name: '分镜预览', exact: true }).getByRole('listitem')).toHaveCount(5);
    await expect(dialog.getByRole('region', { name: '步骤进度', exact: true })).toContainText('第 2/3 批分镜尚未完成');
    await expect(dialog.getByRole('region', { name: '步骤进度', exact: true })).toContainText('5 / 12 个镜头已完成');
    const retry = dialog.locator('.dialog__footer').getByRole('button', { name: '重试此批', exact: true });
    await expect(retry).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('storyboard-batch-retry.png') });
    await retry.click(); await confirmAction(page, '确认重试');
    await expect.poll(async () => (await source.inspect()).run.stepRetry?.status).toBe('completed');
    await expect(dialog.getByRole('region', { name: '分镜预览', exact: true }).getByRole('listitem')).toHaveCount(12);
    expect(source.calls.filter(call => call.step === 'outline')).toHaveLength(1);
    expect(source.calls.find(call => call.step === 'outline')?.body.text).toMatchObject({ verbosity: 'low', format: { name: 'video_storyboard_outline' } });
    expect(source.calls.filter(call => call.step === 'script').map(call => call.batch)).toEqual([1, 2, 2, 3]);
    expect(source.calls.at(-1)?.body.text).toMatchObject({ verbosity: 'low', format: { name: 'video_storyboard_batch', schema: { properties: { shots: { minItems: 2, maxItems: 2 } } } } });
  } finally { await source.close(); }
});

test('distinguishes a failed Responses request from a token limit and retries only the storyboard', async ({ page, request }, info) => {
  const partial = '{"shots":[';
  const source = await fixture(request, 'responses', { scriptResponses: [
    { status: 'failed', error: { code: 'server_error', message: 'private-provider-error' }, output: [] },
    { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] },
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: partial }] }] },
  ] });
  try {
    await page.goto('/'); await openProjectFromList(page, source.project.title);
    await page.getByRole('button', { name: '打开阶段：策划与分镜', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '本次制作', exact: true });
    const record = dialog.getByRole('region', { name: '模型返回记录', exact: true });
    const retry = dialog.locator('.dialog__footer').getByRole('button', { name: '重试此批', exact: true });
    await expect(record).toContainText('模型服务返回生成失败');
    await expect(record).toContainText('模型未返回正文');
    await expect(dialog).not.toContainText(/最大输出 Token|private-provider-error|\$：/);
    await expect(dialog.getByText('查看模型原始返回', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '继续原制作', exact: true })).toHaveCount(0);
    await expect(retry).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('storyboard-response-failed.png') });
    await retry.click(); await confirmAction(page, '确认重试');
    await expect(record).toContainText('模型服务因内容限制中止生成');
    await expect(dialog).not.toContainText('最大输出 Token');
    await retry.click(); await confirmAction(page, '确认重试');
    await expect(record).toContainText('已达到 Token 上限');
    await expect(record).toContainText('请重试此批');
    await record.getByText('查看模型原始返回', { exact: true }).click();
    await expect(record.locator('pre')).toHaveText(partial);
    await page.screenshot({ path: info.outputPath('storyboard-token-limit.png') });
    await retry.click(); await confirmAction(page, '确认重试');
    await expect.poll(async () => (await source.inspect()).run.stepRetry?.status).toBe('completed');
    const inspection = await source.inspect();
    expect(inspection.steps.map(step => [step.id, step.status])).toEqual([['brief', 'succeeded'], ['style', 'succeeded'], ['script', 'succeeded'], ['tail', 'pending']]);
    expect(source.calls.map(call => call.step)).toEqual(['brief', 'style', 'outline', 'script', 'script', 'script', 'script']);
    expect(JSON.stringify(source.calls.at(-1)?.body)).not.toContain('返回的字段校验错误');
  } finally { await source.close(); }
});

test('explains a rate-limited batch and protects its retry deadline in the workbench', async ({ page, request }, info) => {
  const source = await fixture(request, 'responses', { shotCount: 12, failureBatch: 2, rateLimitedBatch: true });
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/'); await openProjectFromList(page, source.project.title);
    await page.getByRole('button', { name: '打开阶段：策划与分镜', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '本次制作', exact: true });
    const draft = dialog.getByRole('region', { name: '已保存分镜', exact: true });
    await expect(draft.getByRole('heading', { name: '全片大纲', exact: true })).toBeVisible();
    await expect(draft.getByRole('region', { name: '分镜预览', exact: true }).getByRole('listitem')).toHaveCount(5);
    await expect(dialog).toContainText(/请求频率或吞吐限制（HTTP 429）。请在 .* 后重试/);
    await expect(dialog).not.toContainText('private-provider-detail');
    await expect(dialog.getByRole('button', { name: '继续原制作', exact: true })).toHaveCount(0);
    const retry = dialog.locator('.dialog__footer').getByRole('button', { name: '重试此批', exact: true });
    await expect(retry).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('storyboard-rate-limit.png') });
    const blocked = page.waitForResponse(response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'run.step.retry');
    await retry.click(); await confirmAction(page, '确认重试');
    expect((await (await blocked).json()).error).toMatch(/HTTP 429.*后重试/);
    expect(source.calls.filter(call => call.step === 'script').map(call => call.batch)).toEqual([1, 2]);
    expect((await source.inspect()).run.stepRetry).toBeUndefined();
  } finally { await source.close(); }
});

test('shows a brief schema error and retries only the brief before allowing later steps', async ({ page, request }, info) => {
  const source = await fixture(request, 'responses', { invalidFirstBrief: true });
  try {
    await page.goto('/'); await openProjectFromList(page, source.project.title);
    await page.getByRole('button', { name: '打开阶段：策划与分镜', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '本次制作', exact: true });
    const record = dialog.getByRole('region', { name: '模型返回记录', exact: true });
    await expect(record).toContainText('模型已返回，创意简报校验未通过');
    await expect(record).toContainText('topic：应为字符串');
    await record.getByText('查看模型原始返回', { exact: true }).click();
    await expect(record.locator('pre')).toContainText('"topic":42');
    expect(source.calls.map(call => call.step)).toEqual(['brief']);
    expect(source.calls[0].body.text).toMatchObject({ format: { name: 'video_brief', schema: { required: expect.arrayContaining(['topic', 'audience']), additionalProperties: false } } });
    await page.screenshot({ path: info.outputPath('brief-schema-error.png') });
    await dialog.getByRole('button', { name: '重试此步骤', exact: true }).click(); await confirmAction(page, '确认重试');
    await expect.poll(async () => (await source.inspect()).run.stepRetry?.status).toBe('completed');
    await expect(dialog).toContainText('后续步骤尚未执行');
    await expect(dialog).toContainText('本次已完成的简报');
    expect(source.calls.map(call => call.step)).toEqual(['brief', 'brief']);
  } finally { await source.close(); }
});

for (const width of [1536, 390]) {
  test(`keeps retry enabled after an explicit HTTP 400 and retains the prior raw response at ${width}px`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 960 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    const source = await fixture(request, 'responses', { rejectSecondScript: true }), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      const upstream = await Promise.all(['brief', 'style'].map(nodeId => rpc<RunStepPayload>(request, 'run.step.payload', { runId: source.run.id, nodeId, kind: 'output' })));
      await page.goto('/'); await openProjectFromList(page, source.project.title);
      await page.getByRole('button', { name: '打开阶段：策划与分镜', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '本次制作', exact: true }), retry = dialog.getByRole('button', { name: '重试此批', exact: true });
      await expect(retry).toBeEnabled(); await retry.click(); await confirmAction(page, '确认重试');
      await expect(dialog).toContainText('HTTP 400'); await expect(retry).toBeEnabled();
      await expect(dialog).not.toContainText('存在结果未确认的外部提交'); await expect(dialog).not.toContainText('private-provider-detail');
      expect((await source.inspect()).steps.find(step => step.id === 'script')).toMatchObject({ retry: { allowed: true }, unknownSubmission: false });
      const record = dialog.getByRole('region', { name: '模型返回记录', exact: true });
      await record.getByRole('combobox', { name: '模型返回版本' }).selectOption('1');
      await record.getByText('查看模型原始返回', { exact: true }).click(); await expect(record.locator('pre')).toContainText('原始旁白内容');
      await record.getByRole('combobox', { name: '模型返回版本' }).selectOption('');
      await page.screenshot({ path: info.outputPath('confirmed-http-400-retry-available.png') });
      await retry.click(); await confirmAction(page, '确认重试'); await expect.poll(async () => (await source.inspect()).run.stepRetry?.status).toBe('completed');
      expect(source.calls.map(call => call.step)).toEqual(['brief', 'style', 'outline', 'script', 'script', 'script']);
      expect((await source.inspect()).steps.map(step => [step.id, step.status])).toEqual([['brief', 'succeeded'], ['style', 'succeeded'], ['script', 'succeeded'], ['tail', 'pending']]);
      expect(await Promise.all(['brief', 'style'].map(nodeId => rpc<RunStepPayload>(request, 'run.step.payload', { runId: source.run.id, nodeId, kind: 'output' })))).toEqual(upstream);
      expect(errors).toEqual([]); await expect(dialog.locator('.dialog__footer')).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: info.outputPath('http-400-single-step-retry-completed.png') });
    } finally { await source.close(); }
  });
}

for (const width of [1536, 390]) {
  test(`completes only the retried script after the MaaS format rejection at ${width}px`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 960 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    const source = await fixture(request, 'responses', { maasFormatFailure: true }), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      const upstream = await Promise.all(['brief', 'style'].map(nodeId => rpc<RunStepPayload>(request, 'run.step.payload', { runId: source.run.id, nodeId, kind: 'output' })));
      await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await openProjectFromList(page, source.project.title);
      await page.getByRole('button', { name: '打开阶段：策划与分镜', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '本次制作', exact: true });
      await dialog.getByRole('button', { name: '重试此批', exact: true }).click(); await confirmAction(page, '确认重试');
      await expect.poll(async () => (await source.inspect()).run.stepRetry?.status).toBe('completed');
      await expect(dialog).toContainText('后续步骤尚未执行');
      expect(source.calls.map(call => call.step)).toEqual(['brief', 'style', 'outline', 'script', 'script', 'script']);
      expect(source.calls[4].body).toHaveProperty('text.format.type', 'json_schema'); expect(source.calls[5].body).not.toHaveProperty('text');
      const { text: _format, ...original } = source.calls[4].body; expect(source.calls[5].body).toEqual(original);
      expect((await source.inspect()).steps.map(step => [step.id, step.status])).toEqual([['brief', 'succeeded'], ['style', 'succeeded'], ['script', 'succeeded'], ['tail', 'pending']]);
      expect(await Promise.all(['brief', 'style'].map(nodeId => rpc<RunStepPayload>(request, 'run.step.payload', { runId: source.run.id, nodeId, kind: 'output' })))).toEqual(upstream);
      expect(errors).toEqual([]); await expect(dialog.locator('.dialog__footer')).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: info.outputPath('maas-format-script-only-completed.png') });
    } finally { await source.close(); }
  });
}

for (const protocol of ['chat-completions', 'responses'] as const) for (const surface of ['flat', 'history'] as const) for (const viewport of [{ width: 1536, height: 960, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
  test(`shows field errors and raw response, then retries only script via ${protocol} in ${surface} at ${viewport.width}px`, async ({ page, request }, info) => {
    await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(theme => localStorage.setItem('vq-theme', theme), viewport.theme);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const source = await fixture(request, protocol), field = protocol === 'responses' ? 'shots' : 'shots[0].narration';
    try {
      await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/); await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
      if (surface === 'flat') { await openProjectFromList(page, source.project.title); await page.getByRole('button', { name: '打开阶段：策划与分镜', exact: true }).click(); }
      else { await page.getByRole('button', { name: '制作记录', exact: true }).click(); await page.locator(`.run-card[data-run-id="${source.run.id}"]`).getByRole('button', { name: '查看步骤', exact: true }).click(); }
      const dialog = page.getByRole('dialog', { name: surface === 'flat' ? '本次制作' : '制作步骤详情', exact: true });
      const record = dialog.getByRole('region', { name: '模型返回记录', exact: true });
      await expect(record).toContainText('模型已返回，分镜校验未通过'); await expect(record).toContainText(field); await expect(record).toContainText(protocol === 'responses' ? '应为数组' : '应为字符串');
      await expect(dialog.getByRole('button', { name: '重试此批', exact: true })).toBeEnabled(); await expect(dialog).not.toContainText('存在结果未确认的外部提交');
      await record.getByText('查看模型原始返回', { exact: true }).click();
      await expect(record.locator('pre')).toContainText('原始旁白内容'); await expect(record.locator('pre')).not.toContainText('fixture-hidden-key'); await expect(record.locator('pre')).toContainText('[已隐藏]');
      await page.screenshot({ path: info.outputPath('field-error-and-raw-response.png') });
      await dialog.getByRole('button', { name: '重试此批', exact: true }).click(); await confirmAction(page, '确认重试');
      await expect.poll(async () => (await source.inspect()).run.stepRetry?.status).toBe('completed');
      await expect(dialog).toContainText('后续步骤尚未执行'); await expect(record.getByRole('alert')).toHaveCount(0);
      await record.getByRole('combobox', { name: '模型返回版本', exact: true }).selectOption('1');
      await expect(record).toContainText(field); await expect(record.locator('pre')).toContainText('原始旁白内容');
      await record.getByRole('combobox', { name: '模型返回版本', exact: true }).selectOption('');
      await expect(record.getByRole('alert')).toHaveCount(0);
      expect(source.calls.map(call => call.step)).toEqual(['brief', 'style', 'outline', 'script', 'script']);
      if (protocol === 'responses') expect(source.calls[4].body.text).toMatchObject({ format: { type: 'json_schema', name: 'video_storyboard_batch', schema: { required: ['shots'], properties: { shots: { minItems: 1, maxItems: 1 } }, additionalProperties: false } } });
      else expect(source.calls[4].body.response_format).toEqual({ type: 'json_object' });
      expect(JSON.stringify(source.calls[4].body)).toContain('上次第 1/1 批分镜返回的字段校验错误');
      expect((await source.inspect()).steps.map(step => [step.id, step.status])).toEqual([['brief', 'succeeded'], ['style', 'succeeded'], ['script', 'succeeded'], ['tail', 'pending']]);
      const payload = await rpc<RunStepPayload>(request, 'run.step.payload', { runId: source.run.id, nodeId: 'script', kind: 'output' });
      expect(payload.modelResponse?.attempt).toBe(2); expect(payload.available).toBe(true);
      expect(new URL(page.url()).origin).toBe(info.project.use.baseURL); expect(errors).toEqual([]);
      await expect(dialog.locator('.dialog__footer')).toBeInViewport({ ratio: 1 }); expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('script-only-retry-completed.png') });
    } finally { await source.close(); }
  });
}
