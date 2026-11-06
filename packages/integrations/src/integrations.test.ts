import { fixtureNativeVideo } from '../../../tests/fixtures/native-video';
import { createServer, type RequestListener, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, skillSchema, type ModelProfile, type ProjectDocument } from '@video-quickly/contracts';
import { createActivityExecutor, validateMediaActivity, type MediaActivityContext, type MediaDiagnosticEvent } from './index';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function contextFor(baseUrl: string): Promise<MediaActivityContext> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'video-quickly-media-'));
  temporaryDirectories.push(dataDirectory);
  const now = new Date().toISOString();
  const project: ProjectDocument = {
    id: 'project-example', title: '示例', brief: '检查素材恢复', revision: 1, templateId: 'history-handdrawn',
    profile: DEFAULT_VIDEO_PROFILE, claims: [], style: '手绘', createdAt: now, updatedAt: now, archived: false,
    workflow: createNativeVideoWorkflow(), shots: [{ id: 'shot-1', title: '镜头一', narration: '示例旁白', visualPrompt: '树木和纸张', durationUs: 1_000_000, claimIds: [], locked: false, animation: { panX: 0, panY: 0, zoom: 1, transition: 'cut' } }],
  };
  const model: ModelProfile = { id: 'model-1', name: '本地接口夹具', provider: 'openai-compatible', baseUrl, model: 'fixture-image', connectionType: 'image', capabilities: ['image'], parameters: {}, enabled: true, hasSecret: false, createdAt: now, updatedAt: now };
  return { project, node: { ...project.workflow.nodes.find(node => node.kind === 'assets')!, config: { operation: 'prepare-references', referenceMode: 'generate' } }, runId: 'run-1', operationId: 'run-1:assets', signal: new AbortController().signal, dataDirectory, assets: [], model, persistRemoteTask() {} };
}

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务地址无效');
  return `http://127.0.0.1:${address.port}`;
}

async function pollingContextFor(baseUrl: string) {
  const context = await contextFor(baseUrl);
  context.model = { ...context.model!, provider: 'custom-http', parameters: { requestPath: 'generate', requestTemplate: { prompt: '{{prompt}}' }, taskIdPath: 'id', pollPath: 'tasks/{{taskId}}', statusPath: 'status', resultUrlPath: 'url', pollTimeoutSeconds: 30 } };
  return context;
}

describe('media generation request receipts', () => {
  it('sends selected Skill instructions and frozen references in the real image request', async () => {
    let prompt = '';
    const baseUrl = await listen(async (request, response) => {
      let text = ''; for await (const chunk of request) text += chunk;
      prompt = JSON.parse(text).prompt;
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ b64_json: 'aW1hZ2UtZml4dHVyZQ==' }] }));
    });
    const context = await contextFor(baseUrl);
    const skill = skillSchema.parse({ id: 'image-method', name: 'image-method', description: '图片规范', source: 'fixture', version: 'frozen-version', enabled: true, instructions: '保持角色固定的蓝色外套。', resources: ['references/palette.md'], referenceContents: { 'references/palette.md': '冷色调与侧逆光。' }, contentHash: 'fixture', importedAt: new Date().toISOString() });
    context.node.skillIds = [skill.id]; context.skills = [skill];
    await createActivityExecutor()(context);
    expect(prompt).toContain('保持角色固定的蓝色外套');
    expect(prompt).toContain('references/palette.md'); expect(prompt).toContain('冷色调与侧逆光');
  });
  it.each([
    { width: 1920, height: 1080, expected: '2560x1440' },
    { width: 1080, height: 1920, expected: '1440x2560' },
    { width: 1080, height: 1080, expected: '1920x1920' },
    { width: 3840, height: 2160, expected: '3840x2160' },
    { width: 8192, height: 8192, expected: '4096x4096' },
  ])('uses a supported Seedream 5 canvas for $width × $height while preserving the export profile', async ({ width, height, expected }) => {
    let size: unknown;
    const baseUrl = await listen(async (request, response) => {
      let text = ''; for await (const chunk of request) text += chunk; size = JSON.parse(text).size;
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ b64_json: 'aW1hZ2UtZml4dHVyZQ==' }] }));
    });
    const context = await contextFor(baseUrl); context.model = { ...context.model!, model: 'doubao-seedream-5-0-lite-260128' }; context.project.profile = { ...context.project.profile, width, height };
    await createActivityExecutor()(context); expect(size).toBe(expected); expect(context.project.profile).toMatchObject({ width, height }); expect(context.model.parameters).toEqual({});
  });
  it('validates explicit Seedream 5 size before submission and respects a valid configured size', async () => {
    const sizes: unknown[] = [];
    const baseUrl = await listen(async (request, response) => {
      let text = ''; for await (const chunk of request) text += chunk; sizes.push(JSON.parse(text).size);
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ b64_json: 'aW1hZ2UtZml4dHVyZQ==' }] }));
    });
    const context = await contextFor(baseUrl); context.model = { ...context.model!, model: 'doubao-seedream-5-0-lite-260128', parameters: { size: '1920x1080' } };
    await expect(validateMediaActivity(context)).rejects.toThrow('size=1920x1080'); await expect(createActivityExecutor()(context)).rejects.toThrow('3,686,400'); expect(sizes).toEqual([]);
    context.model.parameters.size = '2048x2048'; await createActivityExecutor()(context); expect(sizes).toEqual(['2048x2048']);
  });
  it.each([400, 401, 429])('allows an explicit retry after HTTP %i rejection using a new attempt identity', async status => {
    const keys: (string | string[] | undefined)[] = [];
    const baseUrl = await listen((request, response) => {
      request.resume(); keys.push(request.headers['idempotency-key']);
      if (keys.length === 1) { response.writeHead(status).end(JSON.stringify({ error: { message: 'private provider detail' } })); return; }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ b64_json: 'aW1hZ2UtZml4dHVyZQ==' }] }));
    });
    const context = await contextFor(baseUrl);
    await expect(createActivityExecutor()(context)).rejects.toMatchObject({ name: 'MediaRequestRejectedError', status, message: expect.stringContaining(`HTTP ${status}`) });
    const activityPath = join(context.dataDirectory, 'projects', context.project.id, 'activities');
    const directory = join(activityPath, (await readdir(activityPath))[0]);
    const path = join(directory, (await readdir(directory)).find(name => name.endsWith('.receipt.json'))!);
    const rejected = await readFile(path, 'utf8');
    expect(JSON.parse(rejected)).toMatchObject({ state: 'rejected', attempt: 1, rejection: { status } });
    expect(rejected).not.toContain('private provider detail');
    await expect(validateMediaActivity(context)).resolves.toBeUndefined();
    await expect(createActivityExecutor()(context)).resolves.toMatchObject({ assets: [{ shotId: 'shot-1' }] });
    expect(keys).toEqual(['run-1:assets:shot-1', 'run-1:assets:shot-1:attempt:2']);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ state: 'completed', attempt: 2 });
    await createActivityExecutor()(context); expect(keys).toHaveLength(2);
  });
  it('prepares the local timeline and rejects a generation model on the editing step', async () => {
    const context = await contextFor('http://127.0.0.1:1');
    context.node = context.project.workflow.nodes.find(node => node.config.operation === 'prepare-edit')!;
    await expect(createActivityExecutor()(context)).rejects.toThrow('剪辑准备使用本地时间轴');
    context.model = undefined;
    await expect(createActivityExecutor()(context)).resolves.toMatchObject({ source: 'local', shots: 1 });
  });
  it.each(['openai-compatible', 'custom-http', 'comfyui'] as const)('passes the configured visual prompt to %s with the current shot output', async provider => {
    const requests: Record<string, unknown>[] = [];
    const baseUrl = await listen(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST') {
        let body = ''; for await (const chunk of request) body += chunk;
        requests.push(JSON.parse(body));
        response.end(JSON.stringify(provider === 'comfyui' ? { prompt_id: 'comfy-task' } : provider === 'custom-http' ? { image: 'aW1hZ2UtZml4dHVyZQ==' } : { data: [{ b64_json: 'aW1hZ2UtZml4dHVyZQ==' }] }));
      } else if (request.url === '/history/comfy-task') response.end(JSON.stringify({ 'comfy-task': { outputs: { output: { images: [{ filename: 'generated.png', subfolder: '', type: 'output' }] } } } }));
      else response.end('image-fixture');
    });
    const context = await contextFor(baseUrl); context.node = { ...context.node, prompt: '保留右上角留白。', config: { operation: 'regenerate', shotId: 'shot-1', instruction: '保留右上角留白。' } };
    context.model = { ...context.model!, provider, parameters: provider === 'custom-http' ? { requestPath: 'generate', requestTemplate: { prompt: '{{prompt}}', narration: '{{narration}}', instruction: '{{instruction}}' }, resultBase64Path: 'image' } : provider === 'comfyui' ? { workflow: { '6': { inputs: { text: '' } } }, inputMapping: { prompt: '6.text' } } : {} };
    await createActivityExecutor()(context);
    const prompt = provider === 'comfyui' ? (requests[0].prompt as { '6': { inputs: { text: string } } })['6'].inputs.text : requests[0].prompt;
    expect(prompt).toBe('手绘\n树木和纸张\n保留右上角留白。');
    if (provider === 'custom-http') expect(requests[0]).toMatchObject({ narration: '示例旁白', instruction: '保留右上角留白。' });
  });







  it('restores only the download after a generation request has completed', async () => {
    let submits = 0, downloads = 0;
    let baseUrl = '';
    baseUrl = await listen((request, response) => {
      if (request.url === '/images/generations') {
        submits++; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ url: `${baseUrl}/image.png` }], usage: { input_tokens: 90, output_tokens: 12, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { cached_tokens: 3 } } }));
      } else {
        downloads++;
        if (downloads === 1) { response.writeHead(503); response.end(); }
        else { response.setHeader('Content-Type', 'image/png'); response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')); }
      }
    });
    const context = await contextFor(baseUrl);
    await expect(createActivityExecutor()(context)).rejects.toThrow('下载失败');
    const result = await createActivityExecutor()(context);
    expect(submits).toBe(1);
    expect(downloads).toBe(2);
    expect(result).toMatchObject({ source: 'model', assets: [{ shotId: 'shot-1', kind: 'image' }], providerUsage: { inputTokens: 90, outputTokens: 12, cachedInputTokens: 40, cachedOutputTokens: 3 } });
    expect(await createActivityExecutor()(context)).toEqual(result);
    expect(submits).toBe(1);
    expect(downloads).toBe(2);
  });

  it('stops automatic resubmission when the original response is ambiguous', async () => {
    let submits = 0;
    const baseUrl = await listen((request, response) => { submits++; request.resume(); response.destroy(); });
    const context = await contextFor(baseUrl);
    await expect(createActivityExecutor()(context)).rejects.toThrow();
    await expect(createActivityExecutor()(context)).rejects.toThrow('提交结果不明确');
    expect(submits).toBe(1);
  });

  it('automatically recovers a video progress socket failure using the original task and downloads its result', async () => {
    let submits = 0, queries = 0, downloads = 0;
    const video = fixtureNativeVideo(), events: MediaDiagnosticEvent[] = [];
    const baseUrl = await listen((request, response) => {
      request.resume();
      if (request.method === 'POST') { submits++; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ id: 'original-video' })); }
      else if (request.url === '/videos/original-video') {
        if (++queries === 1) { response.destroy(); return; }
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ status: 'completed' }));
      } else if (request.url === '/videos/original-video/content') { downloads++; response.end(video); }
      else response.writeHead(404).end();
    });
    const context = await contextFor(baseUrl);
    context.node = context.project.workflow.nodes.find(node => node.id === 'video')!;
    context.model = { ...context.model!, model: 'fixture-video', capabilities: ['video'], connectionType: 'video' };
    context.onDiagnostic = event => events.push(event);
    await expect(createActivityExecutor()(context)).resolves.toMatchObject({ assets: [{ kind: 'video', shotId: 'shot-1' }] });
    expect({ submits, queries, downloads }).toEqual({ submits: 1, queries: 2, downloads: 1 });
    expect(events).toContainEqual(expect.objectContaining({ event: 'media.poll_retry_scheduled', phase: 'poll', retryCount: 1 }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'media.poll_recovered', phase: 'poll', retryCount: 1 }));
    expect(events.some(event => event.event === 'media.failed')).toBe(false);
  });

  it.each([429, 503])('automatically retries HTTP %i queries after Retry-After without submitting a replacement', async status => {
    let submits = 0, queries = 0, baseUrl = '';
    const queryTimes: number[] = [], events: MediaDiagnosticEvent[] = [];
    baseUrl = await listen((request, response) => {
      request.resume(); response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST') { submits++; response.end(JSON.stringify({ id: 'original-task' })); }
      else if (request.url === '/tasks/original-task') {
        queryTimes.push(performance.now());
        if (++queries === 1) response.writeHead(status, { 'Retry-After': status === 429 ? '2' : new Date(Date.now() + 3000).toUTCString() }).end();
        else response.end(JSON.stringify({ status: 'completed', url: `${baseUrl}/image.png` }));
      } else response.end('recovered-image');
    });
    const context = await pollingContextFor(baseUrl); context.onDiagnostic = event => events.push(event);
    await expect(createActivityExecutor()(context)).resolves.toMatchObject({ assets: [{ kind: 'image' }] });
    expect({ submits, queries }).toEqual({ submits: 1, queries: 2 });
    expect(queryTimes[1] - queryTimes[0]).toBeGreaterThanOrEqual(1900);
    const retry = events.find(event => event.event === 'media.poll_retry_scheduled');
    expect(retry).toMatchObject({ phase: 'poll', retryCount: 1, statusCode: status });
    expect(retry?.retryDelayMs).toBeGreaterThanOrEqual(1900); expect(retry?.retryDelayMs).toBeLessThanOrEqual(3000);
  });

  it('backs off consecutive query failures and resets the delay after a healthy running response', async () => {
    let submits = 0, queries = 0, baseUrl = '';
    const events: MediaDiagnosticEvent[] = [];
    baseUrl = await listen((request, response) => {
      request.resume(); response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST') { submits++; response.end(JSON.stringify({ id: 'original-task' })); }
      else if (request.url === '/tasks/original-task') {
        queries++;
        if ([1, 2, 4].includes(queries)) response.writeHead(503).end();
        else response.end(JSON.stringify(queries === 3 ? { status: 'running' } : { status: 'completed', url: `${baseUrl}/image.png` }));
      } else response.end('recovered-image');
    });
    const context = await pollingContextFor(baseUrl); context.onDiagnostic = event => events.push(event);
    await expect(createActivityExecutor()(context)).resolves.toMatchObject({ assets: [{ kind: 'image' }] });
    expect({ submits, queries }).toEqual({ submits: 1, queries: 5 });
    expect(events.filter(event => event.event === 'media.poll_retry_scheduled').map(event => event.retryDelayMs)).toEqual([1000, 2000, 1000]);
    expect(events.filter(event => event.event === 'media.poll_recovered').map(event => event.retryCount)).toEqual([2, 1]);
  });

  it.each(['401', '403', '404', 'invalid-json', 'task-failed'])('does not retry a permanent %s query failure', async failure => {
    let submits = 0, queries = 0;
    const events: MediaDiagnosticEvent[] = [];
    const baseUrl = await listen((request, response) => {
      request.resume(); response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST') { submits++; response.end(JSON.stringify({ id: 'original-task' })); }
      else {
        queries++;
        if (failure === 'invalid-json') response.end('{');
        else if (failure === 'task-failed') response.end(JSON.stringify({ status: 'failed' }));
        else response.writeHead(Number(failure)).end();
      }
    });
    const context = await pollingContextFor(baseUrl); context.onDiagnostic = event => events.push(event);
    await expect(createActivityExecutor()(context)).rejects.toThrow();
    expect({ submits, queries }).toEqual({ submits: 1, queries: 1 });
    expect(events.map(event => event.event)).not.toContain('media.poll_retry_scheduled');
  });

  it('cancels retry backoff immediately and preserves the original submitted task', async () => {
    let submits = 0, queries = 0;
    const controller = new AbortController();
    const baseUrl = await listen((request, response) => {
      request.resume(); response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST') { submits++; response.end(JSON.stringify({ id: 'original-task' })); }
      else { queries++; response.writeHead(503, { 'Retry-After': '30' }).end(); }
    });
    const context = await pollingContextFor(baseUrl); context.signal = controller.signal;
    context.onDiagnostic = event => { if (event.event === 'media.poll_retry_scheduled') controller.abort(); };
    await expect(createActivityExecutor()(context)).rejects.toMatchObject({ name: 'AbortError' });
    expect({ submits, queries }).toEqual({ submits: 1, queries: 1 });
    const directory = join(context.dataDirectory, 'projects', context.project.id, 'activities');
    const [activity] = await readdir(directory), activityPath = join(directory, activity);
    const receipt = (await readdir(activityPath)).find(name => name.endsWith('.receipt.json'))!;
    expect(JSON.parse(await readFile(join(activityPath, receipt), 'utf8'))).toMatchObject({ state: 'submitted', taskId: 'original-task' });
  });

  it('stops retrying at the original query deadline without submitting another task', async () => {
    let submits = 0, queries = 0, now = Date.now();
    const baseUrl = await listen((request, response) => {
      request.resume(); response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST') { submits++; response.end(JSON.stringify({ id: 'original-task' })); }
      else { queries++; now += 31_000; response.writeHead(503).end(); }
    });
    const context = await pollingContextFor(baseUrl), clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await expect(createActivityExecutor()(context)).rejects.toThrow('已超过本次查询时限');
      expect({ submits, queries }).toEqual({ submits: 1, queries: 1 });
    } finally { clock.mockRestore(); }
  });

  it('bounds an in-flight query by the shared window and keeps a timeout distinct from user cancellation', async () => {
    let submits = 0, queries = 0;
    const timeout = new AbortController(), originalTimeout = AbortSignal.timeout.bind(AbortSignal), windowTimeouts: number[] = [];
    const baseUrl = await listen((request, response) => {
      request.resume(); response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST') { submits++; response.end(JSON.stringify({ id: 'original-task' })); }
      else { queries++; timeout.abort(new DOMException('Fixture query deadline', 'TimeoutError')); }
    });
    const context = await pollingContextFor(baseUrl);
    const timer = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      if (milliseconds <= 30_000) { windowTimeouts.push(milliseconds); return timeout.signal; }
      return originalTimeout(milliseconds);
    });
    try {
      await expect(createActivityExecutor()(context)).rejects.toThrow('已超过本次查询时限');
      expect(context.signal.aborted).toBe(false);
      expect({ submits, queries }).toEqual({ submits: 1, queries: 1 });
      expect(windowTimeouts).toHaveLength(1); expect(windowTimeouts[0]).toBeGreaterThan(29_000); expect(windowTimeouts[0]).toBeLessThanOrEqual(30_000);
    } finally { timer.mockRestore(); }
  });

  it('renews an expired submitted query window without replacing the task or submitting again', async () => {
    let submits = 0, queries = 0, downloads = 0, baseUrl = '';
    baseUrl = await listen((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST') { submits++; request.resume(); response.end(JSON.stringify({ id: 'original-task' })); }
      else if (request.url === '/tasks/original-task') {
        queries++;
        if (queries === 1) response.writeHead(401).end();
        else response.end(JSON.stringify({ status: 'completed', url: `${baseUrl}/image.png` }));
      } else { downloads++; response.end('recovered-image'); }
    });
    const context = await contextFor(baseUrl);
    context.model = { ...context.model!, provider: 'custom-http', parameters: { requestPath: 'generate', requestTemplate: { prompt: '{{prompt}}' }, taskIdPath: 'id', pollPath: 'tasks/{{taskId}}', statusPath: 'status', resultUrlPath: 'url', pollTimeoutSeconds: 30 } };
    await expect(createActivityExecutor()(context)).rejects.toThrow('HTTP 401');
    const activities = join(context.dataDirectory, 'projects', context.project.id, 'activities');
    const [activity] = await readdir(activities), activityPath = join(activities, activity);
    const receiptPath = join(activityPath, (await readdir(activityPath)).find(name => name.endsWith('.receipt.json'))!);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    expect(receipt).toMatchObject({ state: 'submitted', taskId: 'original-task' });
    receipt.pollDeadlineAt = Date.now() - 1;
    await writeFile(receiptPath, JSON.stringify(receipt));
    context.signal = AbortSignal.abort(new Error('query canceled'));
    await expect(createActivityExecutor()(context)).rejects.toThrow('query canceled');
    expect(queries).toBe(1);
    context.signal = new AbortController().signal;
    const result = await createActivityExecutor()(context);
    expect(result).toMatchObject({ assets: [{ kind: 'image', shotId: 'shot-1' }] });
    expect({ submits, queries, downloads }).toEqual({ submits: 1, queries: 2, downloads: 1 });
    expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({ state: 'completed', taskId: 'original-task' });
  });

  it('keeps each query window bounded and starts a fresh budget only on a later invocation', async () => {
    let submits = 0, queries = 0, ready = false, now = Date.now(), baseUrl = '';
    baseUrl = await listen((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST') { submits++; request.resume(); response.end(JSON.stringify({ id: 'slow-task' })); }
      else if (request.url === '/tasks/slow-task') {
        queries++;
        if (ready) response.end(JSON.stringify({ status: 'completed', url: `${baseUrl}/image.png` }));
        else { now += 31_000; response.end(JSON.stringify({ status: 'running' })); }
      } else response.end('recovered-image');
    });
    const context = await contextFor(baseUrl);
    context.model = { ...context.model!, provider: 'custom-http', parameters: { requestPath: 'generate', requestTemplate: { prompt: '{{prompt}}' }, taskIdPath: 'id', pollPath: 'tasks/{{taskId}}', statusPath: 'status', resultUrlPath: 'url', pollTimeoutSeconds: 30 } };
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await expect(createActivityExecutor()(context)).rejects.toThrow('已超过本次查询时限');
      expect({ submits, queries }).toEqual({ submits: 1, queries: 1 });
      ready = true;
      await expect(createActivityExecutor()(context)).resolves.toMatchObject({ assets: [{ kind: 'image', shotId: 'shot-1' }] });
      expect({ submits, queries }).toEqual({ submits: 1, queries: 2 });
    } finally { clock.mockRestore(); }
  });

  it('hashes untrusted shot identities before constructing file paths', async () => {
    const baseUrl = await listen((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ b64_json: 'aW1hZ2UtZml4dHVyZQ==' }] })); });
    const context = await contextFor(baseUrl);
    context.project.shots[0].id = '../../outside-project';
    const result = await createActivityExecutor()(context) as { assets: Array<{ path: string; shotId: string }> };
    const asset = result.assets[0];
    expect(asset.shotId).toBe('../../outside-project');
    expect(basename(asset.path)).toMatch(/^[a-f0-9]{24}\.png$/);
    expect(relative(join(context.dataDirectory, 'projects', context.project.id, 'activities'), asset.path)).not.toMatch(/^\.\./);
  });

  it('rejects incompatible model capabilities before any external submission', async () => {
    let submissions = 0;
    const baseUrl = await listen((_request, response) => { submissions++; response.end('{}'); });
    const context = await contextFor(baseUrl);
    context.model!.capabilities = ['text'];
    await expect(createActivityExecutor()(context)).rejects.toThrow('不具备图片');
    expect(submissions).toBe(0);
  });

  it('downloads a completed compatible video through its authenticated content endpoint', async () => {
    let contentAuthorization: string | undefined;
    let contentType: string | undefined;
    let generationRequest = '';
    const baseUrl = await listen(async (request, response) => {
      if (request.url === '/videos' && request.method === 'POST') {
        contentType = request.headers['content-type']; for await (const chunk of request) generationRequest += chunk;
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ id: 'video-fixture', status: 'queued' }));
      } else if (request.url === '/videos/video-fixture') {
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ id: 'video-fixture', status: 'completed' }));
      } else if (request.url === '/videos/video-fixture/content') {
        contentAuthorization = request.headers.authorization; response.setHeader('Content-Type', 'video/mp4'); response.end(fixtureNativeVideo());
      } else { response.writeHead(404); response.end(); }
    });
    const context = await contextFor(baseUrl);
    context.node = { ...context.project.workflow.nodes.find(node => node.kind === 'animation')!, prompt: '镜头缓慢推进，保持人物一致。' };
    context.model!.capabilities = ['video']; context.model!.connectionType = 'video';
    context.apiKey = 'fixture-only-secret';
    const result = await createActivityExecutor()(context);
    expect(contentType).toMatch(/^multipart\/form-data;/);
    expect(generationRequest.replaceAll('\r\n', '\n')).toContain('手绘\n树木和纸张\n镜头缓慢推进，保持人物一致。');
    expect(contentAuthorization).toBe('Bearer fixture-only-secret');
    expect(result).toMatchObject({ assets: [{ kind: 'video', shotId: 'shot-1' }] });
  });

  it('rejects an oversized advertised download before buffering the response', async () => {
    let baseUrl = '';
    baseUrl = await listen((request, response) => {
      if (request.url === '/images/generations') {
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ url: `${baseUrl}/too-large` }] }));
      } else { response.setHeader('Content-Length', String(600 * 1024 * 1024)); response.write('small'); }
    });
    const context = await contextFor(baseUrl);
    await expect(createActivityExecutor()(context)).rejects.toThrow('超出单文件限制');
  });
});
