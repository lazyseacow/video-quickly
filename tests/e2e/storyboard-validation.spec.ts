import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ProjectDocument, RunInspection, RunSummary, RunStepPayload } from '@video-quickly/contracts';
import { openProjectFromList } from './workspace-navigation';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok(), JSON.stringify(payload.error)).toBe(true); return payload.result;
}
async function fixture(request: APIRequestContext, protocol: 'chat-completions' | 'responses', options: { rejectSecondScript?: boolean; maasFormatFailure?: boolean } = {}) {
  const calls: { step: string; body: Record<string, unknown> }[] = [];
  const server = createServer({ keepAliveTimeout: 0 }, async (incoming, response) => {
    let text = ''; for await (const chunk of incoming) text += chunk.toString();
    const body = JSON.parse(text), prompt = JSON.stringify(body);
    const step = prompt.includes('自动视频制作步骤：旁白与分镜') ? 'script' : prompt.includes('自动视频制作步骤：创意简报') ? 'brief' : 'style';
    calls.push({ step, body });
    if (step === 'script' && calls.filter(call => call.step === 'script').length === 2 && (options.rejectSecondScript || options.maasFormatFailure)) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: options.maasFormatFailure ? { message: 'The request is invalid: the request was rejected by an internal MaaS component. Please check the request body, required fields, and request format.', type: 'invalid_request_error', param: '', code: '400001' } : { code: 'invalid_request_error', message: 'private-provider-detail' } })); return;
    }
    const failed = calls.filter(call => call.step === 'script').length === 1;
    const shot = { title: '原文保留的镜头', narration: failed ? protocol === 'responses' ? '原始旁白内容' : { text: '原始旁白内容' } : '修正后的旁白', visualPrompt: '水彩办公桌 api_key=fixture-hidden-key', durationUs: 2_000_000 };
    const content = step === 'brief' ? '本次已完成的简报' : step === 'style' ? '本次已完成的水彩风格' : JSON.stringify(failed && protocol === 'responses' ? shot : { shots: [shot], entities: [] });
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(protocol === 'responses' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }] } : { choices: [{ message: { content } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('夹具服务未启动');
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  try {
    const model = await rpc<{ id: string }>(request, 'model.save', { model: { name: `校验文本 ${randomUUID()}`, provider: 'openai-compatible', textProtocol: protocol, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', capabilities: ['text'], connectionType: 'text' } });
    const created = await rpc<ProjectDocument>(request, 'project.create', { title: `分镜校验 ${randomUUID().slice(0, 8)}`, brief: '生成办公故事' });
    const nodes = [{ id: 'brief', kind: 'brief', label: '创意简报', modelId: model.id }, { id: 'style', kind: 'style', label: '风格与角色', modelId: model.id }, { id: 'script', kind: 'script', label: '旁白与分镜', modelId: model.id }, { id: 'tail', kind: 'animation', label: '本地剪辑准备', config: { operation: 'prepare-edit' } }];
    const project = await rpc<ProjectDocument>(request, 'workflow.save', { projectId: created.id, workflow: { id: 'native-video', name: '校验验收', version: 1, production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes, edges: nodes.slice(1).map((node, i) => ({ id: `edge-${i}`, source: nodes[i].id, target: node.id })) } });
    const run = await rpc<RunSummary>(request, 'run.start', { projectId: project.id });
    const inspect = () => rpc<RunInspection>(request, 'run.inspect', { runId: run.id });
    await expect.poll(async () => (await inspect()).run.status).toBe('failed');
    return { project, run, calls, inspect, close };
  } catch (error) { await close(); throw error; }
}

for (const width of [1536, 390]) {
  test(`keeps retry enabled after an explicit HTTP 400 and retains the prior raw response at ${width}px`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: 960 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    const source = await fixture(request, 'responses', { rejectSecondScript: true }), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      const upstream = await Promise.all(['brief', 'style'].map(nodeId => rpc<RunStepPayload>(request, 'run.step.payload', { runId: source.run.id, nodeId, kind: 'output' })));
      await page.goto('/'); await openProjectFromList(page, source.project.title);
      await page.getByRole('button', { name: '打开步骤：分镜生成', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '本次制作', exact: true }), retry = dialog.getByRole('button', { name: '重试此步骤', exact: true });
      await expect(retry).toBeEnabled(); await retry.click();
      await expect(dialog).toContainText('HTTP 400'); await expect(retry).toBeEnabled();
      await expect(dialog).not.toContainText('存在结果未确认的外部提交'); await expect(dialog).not.toContainText('private-provider-detail');
      expect((await source.inspect()).steps.find(step => step.id === 'script')).toMatchObject({ retry: { allowed: true }, unknownSubmission: false });
      const record = dialog.getByRole('region', { name: '模型返回记录', exact: true });
      await record.getByRole('combobox', { name: '模型返回版本' }).selectOption('1');
      await record.getByText('查看模型原始返回', { exact: true }).click(); await expect(record.locator('pre')).toContainText('原始旁白内容');
      await record.getByRole('combobox', { name: '模型返回版本' }).selectOption('');
      await page.screenshot({ path: info.outputPath('confirmed-http-400-retry-available.png') });
      await retry.click(); await expect.poll(async () => (await source.inspect()).run.stepRetry?.status).toBe('completed');
      expect(source.calls.map(call => call.step)).toEqual(['brief', 'style', 'script', 'script', 'script']);
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
      await page.getByRole('button', { name: '打开步骤：分镜生成', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '本次制作', exact: true });
      await dialog.getByRole('button', { name: '重试此步骤', exact: true }).click();
      await expect.poll(async () => (await source.inspect()).run.stepRetry?.status).toBe('completed');
      await expect(dialog).toContainText('后续步骤尚未执行');
      expect(source.calls.map(call => call.step)).toEqual(['brief', 'style', 'script', 'script', 'script']);
      expect(source.calls[3].body).toHaveProperty('text.format.type', 'json_schema'); expect(source.calls[4].body).not.toHaveProperty('text');
      const { text: _format, ...original } = source.calls[3].body; expect(source.calls[4].body).toEqual(original);
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
      if (surface === 'flat') { await openProjectFromList(page, source.project.title); await page.getByRole('button', { name: '打开步骤：分镜生成', exact: true }).click(); }
      else { await page.getByRole('button', { name: '制作记录', exact: true }).click(); await page.locator(`.run-card[data-run-id="${source.run.id}"]`).getByRole('button', { name: '查看步骤', exact: true }).click(); }
      const dialog = page.getByRole('dialog', { name: surface === 'flat' ? '本次制作' : '制作步骤详情', exact: true });
      const record = dialog.getByRole('region', { name: '模型返回记录', exact: true });
      await expect(record).toContainText('模型已返回，分镜校验未通过'); await expect(record).toContainText(field); await expect(record).toContainText(protocol === 'responses' ? '顶层必须是' : '应为字符串');
      await expect(dialog.getByRole('button', { name: '重试此步骤', exact: true })).toBeEnabled(); await expect(dialog).not.toContainText('存在结果未确认的外部提交');
      await record.getByText('查看模型原始返回', { exact: true }).click();
      await expect(record.locator('pre')).toContainText('原始旁白内容'); await expect(record.locator('pre')).not.toContainText('fixture-hidden-key'); await expect(record.locator('pre')).toContainText('[已隐藏]');
      await page.screenshot({ path: info.outputPath('field-error-and-raw-response.png') });
      await dialog.getByRole('button', { name: '重试此步骤', exact: true }).click();
      await expect.poll(async () => (await source.inspect()).run.stepRetry?.status).toBe('completed');
      await expect(dialog).toContainText('后续步骤尚未执行'); await expect(record.getByRole('alert')).toHaveCount(0);
      await record.getByRole('combobox', { name: '模型返回版本', exact: true }).selectOption('1');
      await expect(record).toContainText(field); await expect(record.locator('pre')).toContainText('原始旁白内容');
      await record.getByRole('combobox', { name: '模型返回版本', exact: true }).selectOption('');
      await expect(record.getByRole('alert')).toHaveCount(0);
      expect(source.calls.map(call => call.step)).toEqual(['brief', 'style', 'script', 'script']);
      if (protocol === 'responses') expect(source.calls[3].body.text).toMatchObject({ format: { type: 'json_schema', name: 'video_storyboard', schema: { required: ['shots', 'entities'], additionalProperties: false } } });
      else expect(source.calls[3].body.response_format).toEqual({ type: 'json_object' });
      expect(JSON.stringify(source.calls[3].body)).toContain('上次分镜返回的字段校验错误');
      expect((await source.inspect()).steps.map(step => [step.id, step.status])).toEqual([['brief', 'succeeded'], ['style', 'succeeded'], ['script', 'succeeded'], ['tail', 'pending']]);
      const payload = await rpc<RunStepPayload>(request, 'run.step.payload', { runId: source.run.id, nodeId: 'script', kind: 'output' });
      expect(payload.modelResponse?.attempt).toBe(2); expect(payload.available).toBe(true);
      expect(new URL(page.url()).origin).toBe(info.project.use.baseURL); expect(errors).toEqual([]);
      await expect(dialog.locator('.dialog__footer')).toBeInViewport({ ratio: 1 }); expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('script-only-retry-completed.png') });
    } finally { await source.close(); }
  });
}
