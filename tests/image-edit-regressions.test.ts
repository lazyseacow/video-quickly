import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { assetSchema, projectSchema, runSchema, shotSchema } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src/index';
import { createActivityExecutor, validateMediaActivity } from '../packages/integrations/src';

const directories: string[] = [], servers: Server[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); }));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const requests: string[] = [], editInputs: Array<{ source?: Buffer; mask?: Buffer }> = [];
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.headers['content-type']?.includes('multipart/form-data')) {
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': request.headers['content-type'] } }).formData();
      const source = form.get('image[]'), mask = form.get('mask');
      editInputs.push({ ...(source instanceof File ? { source: Buffer.from(await source.arrayBuffer()) } : {}), ...(mask instanceof File ? { mask: Buffer.from(await mask.arrayBuffer()) } : {}) });
    }
    requests.push(request.url ?? ''); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
  const directory = await mkdtemp(join(tmpdir(), 'vq-image-edit-regression-')); directories.push(directory);
  const ffmpegPath = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath, executeActivity: createActivityExecutor({ ffmpegPath }), preflightActivity: validateMediaActivity }); runtimes.push(runtime);
  const path = join(directory, 'source.png'); await writeFile(path, png);
  const source = assetSchema.parse(await runtime.dispatch('asset.import', { path, kind: 'image' }));
  const mask = assetSchema.parse(await runtime.dispatch('image.createMask', { assetId: source.id, rectangle: { x: 0, y: 0, width: 1, height: 1 } }));
  const model = await runtime.dispatch('model.save', { model: { name: '改图夹具', provider: 'openai-compatible', connectionType: 'image', capabilities: ['image'], model: 'fixture-image', baseUrl: `http://127.0.0.1:${address.port}` } }) as { id: string };
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '改图并发回归' }));
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: { shots: [shotSchema.parse({ id: 'one', title: '一', visualPrompt: '花园', narration: '', durationUs: 1_000_000, assetId: source.id })] } }));
  const input = { projectId: project.id, revision: project.revision, shotId: 'one', kind: 'image', modelId: model.id, instruction: '将选区改成蓝色', imageEdit: { sourceAssetId: source.id, maskAssetId: mask.id } };
  return { runtime, project, input, requests, editInputs };
}

it('claims at most one image-edit run when local input validation overlaps', async () => {
  const source = await fixture();
  const results = await Promise.allSettled([source.runtime.dispatch('shot.regenerate', source.input), source.runtime.dispatch('shot.regenerate', source.input)]);
  await source.runtime.waitForIdle();
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(source.requests).toHaveLength(1);
});

it('rechecks the project revision after asynchronous image-edit validation', async () => {
  const source = await fixture();
  const starting = source.runtime.dispatch('shot.regenerate', source.input);
  const rejected = expect(starting).rejects.toThrow(/修订|修改|刷新/);
  await source.runtime.dispatch('project.update', { projectId: source.project.id, revision: source.project.revision, patch: { title: '验证期间已修改' } });
  await rejected; await source.runtime.waitForIdle(); expect(source.requests).toHaveLength(0);
});

it('preserves the source and mask when explicitly remaking an image-edit run', async () => {
  const source = await fixture();
  const first = runSchema.parse(await source.runtime.dispatch('shot.regenerate', source.input)); await source.runtime.waitForIdle();
  expect(runSchema.parse(await source.runtime.dispatch('run.get', { runId: first.id })).status).toBe('succeeded');
  const next = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: source.project.id, parentRunId: first.id })); await source.runtime.waitForIdle();
  expect(runSchema.parse(await source.runtime.dispatch('run.get', { runId: next.id })).status).toBe('succeeded');
  expect(source.requests).toEqual(['/images/edits', '/images/edits']);
  expect(source.editInputs).toHaveLength(2); expect(source.editInputs[1]).toEqual(source.editInputs[0]); expect(source.editInputs[1].mask?.length).toBeGreaterThan(0);
});
