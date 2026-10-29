import { createServer, type RequestListener, type Server } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHistoryWorkflow, DEFAULT_VIDEO_PROFILE, type ModelProfile, type ProjectDocument } from '@video-quickly/contracts';
import { createActivityExecutor, type MediaActivityContext } from './index';

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
    workflow: createHistoryWorkflow(), shots: [{ id: 'shot-1', title: '镜头一', narration: '示例旁白', visualPrompt: '树木和纸张', durationUs: 1_000_000, claimIds: [], locked: false, animation: { panX: 0, panY: 0, zoom: 1, transition: 'cut' } }],
  };
  const model: ModelProfile = { id: 'model-1', name: '本地接口夹具', provider: 'openai-compatible', baseUrl, model: 'fixture-image', capabilities: ['image'], parameters: {}, enabled: true, hasSecret: false, createdAt: now, updatedAt: now };
  return { project, node: project.workflow.nodes.find(node => node.kind === 'assets')!, runId: 'run-1', operationId: 'run-1:assets', signal: new AbortController().signal, dataDirectory, assets: [], model, persistRemoteTask() {} };
}

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务地址无效');
  return `http://127.0.0.1:${address.port}`;
}

describe('media generation request receipts', () => {
  it('restores only the download after a generation request has completed', async () => {
    let submits = 0, downloads = 0;
    let baseUrl = '';
    baseUrl = await listen((request, response) => {
      if (request.url === '/images/generations') {
        submits++; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ url: `${baseUrl}/image.png` }] }));
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
    expect(result).toMatchObject({ source: 'model', assets: [{ shotId: 'shot-1', kind: 'image' }] });
    await createActivityExecutor()(context);
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
    const baseUrl = await listen((request, response) => {
      if (request.url === '/videos' && request.method === 'POST') {
        contentType = request.headers['content-type']; request.resume();
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ id: 'video-fixture', status: 'queued' }));
      } else if (request.url === '/videos/video-fixture') {
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ id: 'video-fixture', status: 'completed' }));
      } else if (request.url === '/videos/video-fixture/content') {
        contentAuthorization = request.headers.authorization; response.setHeader('Content-Type', 'video/mp4'); response.end('media-contract-fixture');
      } else { response.writeHead(404); response.end(); }
    });
    const context = await contextFor(baseUrl);
    context.node = context.project.workflow.nodes.find(node => node.kind === 'animation')!;
    context.model!.capabilities = ['video'];
    context.apiKey = 'fixture-only-secret';
    const result = await createActivityExecutor()(context);
    expect(contentType).toMatch(/^multipart\/form-data;/);
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
