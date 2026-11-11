import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { assetSchema, characterProfileSchema, projectSchema, runSchema, shotSchema, type ShotCandidate } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src/index';
import { createActivityExecutor, validateMediaActivity } from '../packages/integrations/src';
import { createEditMask, validateEditMask } from '../packages/video/src/image-tools';
import { seedLegacyGridAsset } from './fixtures/legacy-grid-asset';

const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
const directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [], servers: Server[] = [];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function sourceImage(width = 5, height = 3) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index++) { rgba[index * 4] = index * 13; rgba[index * 4 + 1] = index * 7; rgba[index * 4 + 2] = index * 3; rgba[index * 4 + 3] = 255; }
  const png = execFileSync(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${width}x${height}`, '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { input: rgba, windowsHide: true });
  return { png, width, height };
}
function pixels(bytes: Buffer) { return execFileSync(ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { input: bytes, windowsHide: true }); }
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); }));
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })));
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-image-tools-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: ffmpeg, executeActivity: createActivityExecutor({ ffmpegPath: ffmpeg }), preflightActivity: validateMediaActivity }); runtimes.push(runtime);
  const source = sourceImage(), path = join(directory, 'source.png'); await writeFile(path, source.png);
  const asset = assetSchema.parse(await runtime.dispatch('asset.import', { path }));
  return { runtime, directory, source, asset };
}
it('creates a same-size alpha mask and rejects out-of-bounds or opaque masks', async () => {
  const { runtime, asset, source } = await setup(), rectangle = { x: 1, y: 1, width: 3, height: 1 };
  const mask = assetSchema.parse(await runtime.dispatch('image.createMask', { assetId: asset.id, rectangle }));
  const bytes = await readFile(mask.path); await validateEditMask(bytes, source);
  expect(mask.derivation).toMatchObject({ kind: 'edit-mask', sourceSha256: asset.sha256, rectangle });
  const rgba = pixels(bytes); for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) expect(rgba[(y * source.width + x) * 4 + 3]).toBe(y === 1 && x >= 1 && x < 4 ? 0 : 255);
  await expect(createEditMask(source.png, { x: 4, y: 0, width: 2, height: 1 })).rejects.toThrow('超出');
  await expect(validateEditMask(source.png, source)).rejects.toThrow('透明');
  await expect(validateEditMask(bytes, { width: 6, height: 3 })).rejects.toThrow('尺寸');
});
it('reuses a valid mask and restores a missing mask under concurrent requests', async () => {
  const { runtime, asset } = await setup();
  const input = { assetId: asset.id, rectangle: { x: 1, y: 1, width: 2, height: 1 } };
  const original = assetSchema.parse(await runtime.dispatch('image.createMask', input));
  expect(await runtime.dispatch('image.createMask', input)).toEqual(original);
  await runtime.dispatch('asset.delete', { assetId: original.id });
  await rm(original.path);
  const [first, concurrent] = await Promise.all([runtime.dispatch('image.createMask', input), runtime.dispatch('image.createMask', input)]);
  const restored = assetSchema.parse(first);
  expect(concurrent).toEqual(restored);
  expect(restored).toEqual(original);
  expect(sha(await readFile(restored.path))).toBe(original.sha256);
  await writeFile(asset.path, 'corrupted');
  await expect(runtime.dispatch('image.createMask', input)).rejects.toThrow();
});
it('exports grid lineage and its source image using format 8', async () => {
  const { runtime, asset, directory } = await setup();
  const tile = await seedLegacyGridAsset(directory, asset);
  const character = characterProfileSchema.parse(await runtime.dispatch('character.save', { character: { name: '已有角色', description: '', referenceAssetIds: [tile.id] } }));
  expect(await runtime.dispatch('character.references', { characterId: character.id })).toEqual([tile]);
  await expect(runtime.dispatch('asset.delete', { assetId: asset.id })).rejects.toThrow('正在使用');
  let project = projectSchema.parse(await runtime.dispatch('project.create', { title: '切图备份' }));
  project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [shotSchema.parse({ id: 'one', title: '一', visualPrompt: '画面', narration: '', durationUs: 1000000, assetId: tile.id })] } }));
  const destination = join(directory, 'backup'); await runtime.dispatch('project.backup', { projectId: project.id, destination });
  const backup = JSON.parse(await readFile(join(destination, 'project.json'), 'utf8')); expect(backup.schemaVersion).toBe(8); expect(backup.assets).toHaveLength(2);
  expect(projectSchema.parse(backup.project).shots[0].assetId).toBe(tile.id);
  const exported = assetSchema.array().parse(backup.assets);
  expect(exported.find(item => item.id === tile.id)?.derivation?.sourceAssetId).toBe(asset.id);
  expect(exported.some(item => item.id === asset.id)).toBe(true);
});
it('submits source first with its transparent mask, retains a candidate, and never overwrites the current image', async () => {
  const { runtime, source, asset } = await setup();
  const requests: FormData[] = [];
  const server = createServer((request, response) => { void (async () => {
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    expect(request.url).toBe('/images/edits');
    requests.push(await new Response(Buffer.concat(chunks), { headers: { 'content-type': request.headers['content-type'] ?? '' } }).formData());
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ b64_json: source.png.toString('base64') }] }));
  })().catch(error => response.destroy(error)); }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture');
  const model = await runtime.dispatch('model.save', { model: { name: '图像编辑', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}`, connectionType: 'image', capabilities: ['image'], model: 'fixture-image' } }) as { id: string };
  let project = projectSchema.parse(await runtime.dispatch('project.create', { title: '局部改图' }));
  project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [shotSchema.parse({ id: 'one', title: '一', visualPrompt: '画面', narration: '', durationUs: 1000000, assetId: asset.id })] } }));
  const mask = assetSchema.parse(await runtime.dispatch('image.createMask', { assetId: asset.id, rectangle: { x: 1, y: 1, width: 2, height: 1 } }));
  const input = { projectId: project.id, revision: project.revision, shotId: 'one', kind: 'image', modelId: model.id, instruction: '把选区中的物体改成蓝色', imageEdit: { sourceAssetId: asset.id, maskAssetId: mask.id } };
  const run = runSchema.parse(await runtime.dispatch('shot.regenerate', input)); await runtime.waitForIdle();
  const done = runSchema.parse(await runtime.dispatch('run.get', { runId: run.id })); expect(done.status, done.error).toBe('succeeded'); expect(requests).toHaveLength(1);
  const originals = requests[0].getAll('image[]'); expect(originals).toHaveLength(1); expect(sha(Buffer.from(await (originals[0] as File).arrayBuffer()))).toBe(asset.sha256);
  const postedMask = requests[0].get('mask') as File; expect(sha(Buffer.from(await postedMask.arrayBuffer()))).toBe(mask.sha256);
  expect(requests[0].get('prompt')).toContain('图片 1');
  expect((await runtime.dispatch('project.get', { projectId: project.id }) as { project: unknown }).project).toEqual(project);
  const candidates = await runtime.dispatch('shot.candidates', { projectId: project.id, shotId: 'one' }) as { items: ShotCandidate[] }; expect(candidates.items).toHaveLength(1);
  const applied = projectSchema.parse(await runtime.dispatch('shot.candidate.apply', { projectId: project.id, revision: project.revision, candidateId: candidates.items[0].id })); expect(applied.shots[0].assetId).not.toBe(asset.id); expect(await readFile(asset.path)).toEqual(source.png);
  await runtime.dispatch('run.resume', { runId: run.id }).catch(() => undefined); await runtime.waitForIdle(); expect(requests).toHaveLength(1);
  await writeFile(mask.path, 'broken');
  await expect(runtime.dispatch('shot.regenerate', { ...input, revision: applied.revision, imageEdit: { sourceAssetId: applied.shots[0].assetId, maskAssetId: mask.id } })).rejects.toThrow(); expect(requests).toHaveLength(1);
});
