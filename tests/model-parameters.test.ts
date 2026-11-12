import { fixtureNativeVideo } from './fixtures/native-video';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assetSchema, createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, getModelParameterFields, modelSchema, projectSchema, requestModelParameters, validateModelParameters, withModelParameter, type AssetRecord, type CharacterProfile, type ModelProfile } from '@video-quickly/contracts';
import { createActivityExecutor, validateMediaActivity, type MediaActivityContext } from '../src/packages/integrations/src';

const directories: string[] = [], servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const shared = { provider: 'openai-compatible', connectionType: 'text', capabilities: ['text', 'image', 'video'] } as const;
function profile(parameters: ModelProfile['parameters'] = {}, provider: ModelProfile['provider'] = 'openai-compatible', capabilities: ModelProfile['capabilities'] = [...shared.capabilities]): ModelProfile {
  const now = new Date().toISOString();
  return modelSchema.parse({ id: 'fixture-model', name: '参数夹具', provider, connectionType: ((capabilities) as readonly string[]).includes('text') ? 'text' : ((capabilities) as readonly string[]).includes('video') ? 'video' : 'image', capabilities, model: 'fixture-model', baseUrl: 'http://127.0.0.1:1/v1', parameters, createdAt: now, updatedAt: now });
}





async function fixture(provider: ModelProfile['provider'], kind: 'assets' | 'animation', parameters: ModelProfile['parameters'] = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'vq-parameters-')); directories.push(dataDirectory);
  const now = new Date().toISOString();
  const project = projectSchema.parse({ id: 'project-parameters', title: '真实参数请求', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(), shots: [{ id: 'shot-1', title: '镜头', narration: '原文不可被人物描述改变。', visualPrompt: '场景构图', durationUs: 2_000_000 }], createdAt: now, updatedAt: now });
  const requests: Array<{ path: string; body: Record<string, unknown> | FormData }> = [];
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  let origin = '';
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), path = request.url ?? '';
    const body = request.headers['content-type']?.startsWith('multipart/') ? await new Request('http://fixture.local', { method: 'POST', headers: { 'content-type': request.headers['content-type'] }, body: bytes }).formData() : bytes.length ? JSON.parse(bytes.toString()) as Record<string, unknown> : {};
    requests.push({ path, body });


    if (path.endsWith('/images/generations') || path.endsWith('/images/edits')) { response.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] })); return; }
    if (request.method === 'POST' && (path.endsWith('/tasks') || path.endsWith('/videos'))) { response.end(JSON.stringify({ id: 'task-1' })); return; }
    if (path.endsWith('/task-1')) { response.end(JSON.stringify({ status: 'succeeded', content: { video_url: `${origin}/result` } })); return; }
    if (path.endsWith('/custom')) { response.end(JSON.stringify({ data: (kind === 'animation' ? fixtureNativeVideo() : Buffer.from('custom bytes')).toString('base64') })); return; }
    if (path === '/result') { response.end(kind === 'animation' ? fixtureNativeVideo() : Buffer.from('result bytes')); return; }
    response.statusCode = 404; response.end('unknown endpoint');
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('无测试端口'); origin = `http://127.0.0.1:${address.port}`;
  const model = { ...profile({ ...parameters }, provider, kind === 'animation' ? ['video'] : ['image']), baseUrl: `${origin}/v1` };
  const context: MediaActivityContext = { project, model, node: { ...project.workflow.nodes.find(node => node.kind === kind)!, kind, config: kind === 'assets' ? { operation: 'prepare-references', referenceMode: 'generate' } : { operation: 'generate-native-video' } }, runId: 'run', operationId: 'run:parameters', signal: new AbortController().signal, dataDirectory, assets: [], persistRemoteTask() {} };
  return { context, requests, image };
}

it.each([
  { model: 'gpt-image-2.5-sunburst-2026-09-08', provider: 'openai-compatible', width: 1920, height: 1080, size: undefined, expected: 'auto' },
  { model: 'gpt-image-2.5-sunburst-2026-09-08', provider: 'openai-compatible', width: 640, height: 360, size: undefined, expected: 'auto' },
  { model: 'gpt-image-1.5', provider: 'openai-compatible', width: 1920, height: 1080, size: undefined, expected: 'auto' },
  { model: 'chatgpt-image-latest', provider: 'openai-compatible', width: 1920, height: 1080, size: undefined, expected: 'auto' },
  { model: 'gpt-image-2.5-sunburst-2026-09-08', provider: 'openai-compatible', width: 1920, height: 1080, size: '1536x864', expected: '1536x864' },
  { model: 'fixture-model', provider: 'openai-compatible', width: 1920, height: 1080, size: undefined, expected: '1920x1080' },
  { model: 'doubao-seedream-4-0-250828', provider: 'seedream', width: 1920, height: 1080, size: undefined, expected: '1920x1080' },
] as const)('sends $expected for $model at $width x $height and reuses its completed image receipt', async ({ model, provider, width, height, size, expected }) => {
  const { context, requests, image } = await fixture(provider, 'assets', size ? { size } : {});
  context.model = { ...context.model!, model, connectionType: 'image', capabilities: ['image'] }; context.project.profile = { ...context.project.profile, width, height };
  const execute = createActivityExecutor(), result = await execute(context);
  expect(requests).toHaveLength(1); expect(requests[0].path).toBe('/v1/images/generations'); expect(requests[0].body).toMatchObject({ model, size: expected });
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.assets)) throw new Error('Missing image assets');
  const asset = assetSchema.parse(result.assets[0]); expect(await readFile(asset.path)).toEqual(image);
  expect(await execute(context)).toEqual(result); expect(requests).toHaveLength(1);
});

it('keeps a custom image template and project dimensions even when its model name uses the GPT Image prefix', async () => {
  const { context, requests } = await fixture('custom-http', 'assets', { requestPath: 'custom', requestTemplate: { size: 'vendor-default', width: '{{width}}', height: '{{height}}' }, resultBase64Path: 'data' });
  context.model = { ...context.model!, model: 'gpt-image-2.5-sunburst-2026-09-08', connectionType: 'image', capabilities: ['image'] }; context.project.profile = { ...context.project.profile, width: 640, height: 360 };
  await createActivityExecutor()(context);
  expect(requests).toHaveLength(1); expect(requests[0].path).toBe('/v1/custom'); expect(requests[0].body).toEqual({ size: 'vendor-default', width: 640, height: 360 });
});
async function addCharacter(context: MediaActivityContext, count = 1) {
  const now = new Date().toISOString();
  const assets: AssetRecord[] = [];
  for (let index = 0; index < count; index++) {
    const bytes = Buffer.from(`reference image ${index}`), path = join(context.dataDirectory, `reference-${index}.png`); await writeFile(path, bytes);
    assets.push({ id: `reference-${index}`, name: `人物${index}`, kind: 'image', path, mimeType: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: now, provenance: 'fixture', active: true, retained: false });
  }
  const character: CharacterProfile = { id: 'character-1', name: '阿明', description: '蓝色外套', referenceAssetIds: assets.map(asset => asset.id), revision: 1, archived: false, createdAt: now, updatedAt: now };
  context.assets.push(...assets); context.characters = [character]; context.project.shots[0].characterIds = [character.id];
  return assets;
}

it('sends real image controls and the reference bytes through image edits, preserving source order and advanced fields', async () => {
  const { context, requests } = await fixture('openai-compatible', 'assets', { size: '1280x720', quality: 'high', temperature: .4,  vendor_flag: 'kept' });
  const assets = await addCharacter(context, 2);
  await validateMediaActivity(context); await createActivityExecutor()(context);
  expect(requests).toHaveLength(1); expect(requests[0].path).toBe('/v1/images/edits');
  const body = requests[0].body; expect(body).toMatchObject({ size: '1280x720', quality: 'high', vendor_flag: 'kept', images: await Promise.all(assets.map(async asset => ({ image_url: `data:image/png;base64,${(await readFile(asset.path)).toString('base64')}` }))) });
  expect(body).not.toHaveProperty('voice'); expect(body).not.toHaveProperty('temperature'); expect(body).toHaveProperty('prompt', expect.stringContaining('图片 1、图片 2'));
});



it('uses configured Seedance duration and references a shared character and scene image once', async () => {
  const { context, requests } = await fixture('seedance', 'animation', { duration: 8, resolution: '720p', ratio: '9:16', characterReferenceMode: 'reference_image' });
  const assets = await addCharacter(context, 2); context.project.shots[0].assetId = assets[1].id; context.project.workflow.production.referenceMode = 'existing';
  await validateMediaActivity(context); await createActivityExecutor()(context);
  const body = requests[0].body; expect(body).toMatchObject({ duration: 8, resolution: '720p', ratio: '9:16', content: [{ type: 'text', text: expect.stringContaining('图片 2 为当前场景构图参考') }, ...[0, 1].map(index => ({ type: 'image_url', role: 'reference_image', image_url: { url: expect.stringContaining(Buffer.from(`reference image ${index}`).toString('base64')) } }))] });
  expect(body).not.toHaveProperty('characterReferenceMode');
});

it.each([
  { model: 'doubao-seedance-2-0-260128', width: 5040, height: 2160, ratio: '21:9', resolution: '4k', duration: 4, firstFrame: false },
  { model: 'doubao-seedance-2-0-fast-260128', width: 864, height: 1080, ratio: 'adaptive', resolution: '720p', duration: 4, firstFrame: false },
  { model: 'doubao-seedance-2-5-260628', width: 2560, height: 1440, ratio: 'adaptive', resolution: '1080p', shotSeconds: 5, duration: 5, firstFrame: true },
  { model: 'ep-fixture', width: 1920, height: 1080, ratio: '16:9', resolution: undefined, duration: 2, firstFrame: false },
])('derives Seedance request parameters for $model', async ({ model, width, height, ratio, resolution, shotSeconds = 2, duration, firstFrame }) => {
  const { context, requests } = await fixture('seedance', 'animation');
  context.model = { ...context.model!, model };
  context.project.profile = { ...context.project.profile, width, height };
  context.project.shots[0].durationUs = shotSeconds * 1_000_000;
  if (firstFrame) await addCharacter(context);
  await validateMediaActivity(context);
  await createActivityExecutor()(context);
  expect(requests[0].body).toMatchObject({ ratio, duration });
  if (resolution) expect(requests[0].body).toHaveProperty('resolution', resolution);
  else expect(requests[0].body).not.toHaveProperty('resolution');
});

it('rejects unsupported reference combinations before any journal receipt, then explicitly maps a custom request', async () => {
  const { context, requests } = await fixture('openai-compatible', 'animation');
  const [first, second] = await addCharacter(context, 2);
  const character = context.characters![0];
  context.characters = [{ ...character, referenceAssetIds: [first.id] }, { ...character, id: 'character-2', name: '阿诚', referenceAssetIds: [second.id] }];
  context.project.shots[0].characterIds = context.characters.map(profile => profile.id);
  await expect(validateMediaActivity(context)).rejects.toThrow('每镜头接收一张图'); await expect(createActivityExecutor()(context)).rejects.toThrow('每镜头接收一张图'); expect(requests).toEqual([]); expect(await readdir(context.dataDirectory)).toEqual(['reference-0.png', 'reference-1.png']);
  context.model = { ...context.model!, provider: 'custom-http', parameters: { requestPath: 'custom', requestTemplate: { prompt: '{{prompt}}' }, resultBase64Path: 'data' } };
  await expect(validateMediaActivity(context)).rejects.toThrow('{{character_images}}'); expect(requests).toEqual([]);
  context.model.parameters.requestTemplate = { prompt: '{{prompt}}', reference_images: '{{character_images}}' };
  await validateMediaActivity(context); await createActivityExecutor()(context);
  expect(requests[0].body).toHaveProperty('reference_images', [expect.stringContaining('data:image/png;base64,'), expect.stringContaining('data:image/png;base64,')]);
  expect(requests[0].body).toHaveProperty('prompt', expect.stringContaining('蓝色外套'));
});
