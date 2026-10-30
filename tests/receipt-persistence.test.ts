import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { modelSchema, projectDetailSchema, projectSchema, runInspectionSchema, runSchema } from '@video-quickly/contracts';
import { createActivityExecutor, validateMediaActivity } from '../packages/integrations/src/index';
import { createRuntime } from '../packages/runtime/src/index';

// Only the filesystem boundary is substituted: requests, journal/checkpoints,
// temporary files, successful renames and reopening all use the real runtime.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const nativeFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const directories: string[] = [], servers: Server[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
beforeEach(() => { vi.mocked(rename).mockReset().mockImplementation(nativeFs.rename); });
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(directories.splice(0).map(path => {
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith('vq-receipt-persistence-')) throw new Error('Unexpected receipt fixture cleanup path');
    return rm(path, { recursive: true, force: true });
  }));
});

function open(directory: string, executeActivity = createActivityExecutor()) {
  const runtime = createRuntime({ dataDirectory: directory, seed: false, preflightActivity: validateMediaActivity, executeActivity });
  runtimes.push(runtime); return runtime;
}
async function close(runtime: ReturnType<typeof createRuntime>) {
  await runtime.close(); runtimes.splice(runtimes.indexOf(runtime), 1);
}
async function fixture(executeActivity = createActivityExecutor()) {
  let posts = 0, downloads = 0, base = '';
  const server = createServer(async (request, response) => {
    if (request.method === 'POST') {
      for await (const _chunk of request) { /* Consume the actual local HTTP body. */ }
      posts++; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ url: `${base}/image.png`, usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } })); return;
    }
    downloads++; response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing receipt fixture address'); base = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'vq-receipt-persistence-')); directories.push(directory);
  const runtime = open(directory, executeActivity), created = projectSchema.parse(await runtime.dispatch('project.create', { title: '回执替换验收' }));
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '本地回执接口', provider: 'custom-http', baseUrl: base, model: 'fixture', capabilities: ['image'], parameters: { requestPath: 'generate', requestTemplate: { name: '{{narration}}' }, resultUrlPath: 'url' } } }));
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: { shots: [{ id: 'shot-0', title: '回执镜头', narration: 'shot-0', visualPrompt: '', durationUs: 1_000_000 }], workflow: { id: 'receipt', version: 1, name: '回执提交', nodes: [{ id: 'images', kind: 'assets', label: '画面', modelId: model.id, requiresReview: true }], edges: [], execution: { maxConcurrentShots: 2, modelLimits: { [model.id]: 2 } } } } }));
  return { directory, runtime, project, calls: () => ({ posts, downloads }) };
}
async function receipt(directory: string, projectId: string) {
  const root = join(directory, 'projects', projectId, 'activities'), folders = await readdir(root, { withFileTypes: true });
  const paths: string[] = [];
  for (const folder of folders.filter(value => value.isDirectory())) for (const name of await readdir(join(root, folder.name))) if (name.endsWith('.receipt.json')) paths.push(join(root, folder.name, name));
  expect(paths).toHaveLength(1);
  return { path: paths[0], value: JSON.parse(await readFile(paths[0], 'utf8')) };
}
const locked = (code: string) => Object.assign(new Error(`Fixture file replacement failed: ${code}`), { code });

it.each(['EPERM', 'EACCES', 'EBUSY'])('commits an external result after temporary %s without another POST, then reopens the original review', async code => {
  const { directory, runtime, project, calls } = await fixture();
  const replacements: string[] = [], priorStates: string[] = [];
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(to).endsWith('.receipt.json') && JSON.parse(await readFile(from, 'utf8')).state === 'download') {
      replacements.push(String(from));
      if (replacements.length <= 2) { priorStates.push(JSON.parse(await readFile(to, 'utf8')).state); throw locked(code); }
    }
    return nativeFs.rename(from, to);
  });
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await runtime.waitForIdle();
  const before = runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: run.id }));
  expect(before.run.status, before.run.error).toBe('waiting_review');
  expect(priorStates).toEqual(['prepared', 'prepared']); expect(replacements).toHaveLength(3); expect(new Set(replacements).size).toBe(1);
  const saved = await receipt(directory, project.id); expect(saved.value).toMatchObject({ state: 'completed', providerUsage: { source: 'provider', inputTokens: 3, outputTokens: 2, totalTokens: 5 } }); expect(calls()).toEqual({ posts: 1, downloads: 1 });
  await close(runtime);
  const recovered = open(directory); await recovered.dispatch('run.review', { runId: run.id, approved: true }); await recovered.waitForIdle();
  expect(runInspectionSchema.parse(await recovered.dispatch('run.inspect', { runId: run.id })).run.status).toBe('succeeded');
  expect(await readFile(saved.path, 'utf8')).toBe(JSON.stringify(saved.value)); expect(calls()).toEqual({ posts: 1, downloads: 1 });
});

it('bounds persistent replacement failures and keeps the prepared submission blocked after reopening', async () => {
  const { directory, runtime, project, calls } = await fixture();
  const attempts = { download: 0, unknown: 0 };
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(to).endsWith('.receipt.json')) {
      const value = JSON.parse(await readFile(from, 'utf8'));
      if (value.state === 'download' || value.state === 'unknown') { attempts[value.state as keyof typeof attempts]++; throw locked('EPERM'); }
    }
    return nativeFs.rename(from, to);
  });
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await runtime.waitForIdle();
  expect(runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: run.id })).run.status).toBe('failed');
  expect(attempts).toEqual({ download: 6, unknown: 6 }); expect(calls()).toEqual({ posts: 1, downloads: 0 });
  const saved = await receipt(directory, project.id); expect(saved.value).toEqual({ state: 'prepared' }); await close(runtime);
  vi.mocked(rename).mockImplementation(nativeFs.rename);
  const recovered = open(directory); await recovered.dispatch('run.resume', { runId: run.id }); await recovered.waitForIdle();
  expect(runInspectionSchema.parse(await recovered.dispatch('run.inspect', { runId: run.id })).run.status).toBe('failed');
  expect((await recovered.dispatch('run.inspect', { runId: run.id }) as { steps: { reason: string }[] }).steps[0].reason).toContain('核对');
  expect(await readFile(saved.path, 'utf8')).toBe(JSON.stringify(saved.value)); expect(calls()).toEqual({ posts: 1, downloads: 0 });
});

it('does not retry a non-locking file error or resubmit its prepared operation', async () => {
  const { directory, runtime, project, calls } = await fixture(); let failedReplacements = 0;
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(to).endsWith('.receipt.json') && JSON.parse(await readFile(from, 'utf8')).state !== 'prepared') { failedReplacements++; throw locked('ENOSPC'); }
    return nativeFs.rename(from, to);
  });
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await runtime.waitForIdle();
  expect(runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: run.id })).run.status).toBe('failed');
  expect(failedReplacements).toBe(2); expect((await receipt(directory, project.id)).value).toEqual({ state: 'prepared' });
  await close(runtime); vi.mocked(rename).mockImplementation(nativeFs.rename);
  const recovered = open(directory); await recovered.dispatch('run.resume', { runId: run.id }); await recovered.waitForIdle();
  expect(runInspectionSchema.parse(await recovered.dispatch('run.inspect', { runId: run.id })).run.status).toBe('failed'); expect(calls()).toEqual({ posts: 1, downloads: 0 });
});

it('keeps cancellation terminal while a known result is committing locally, without applying or resubmitting it', async () => {
  let settled!: () => void; const activitySettled = new Promise<void>(resolve => { settled = resolve; }), execute = createActivityExecutor();
  const { directory, runtime, project, calls } = await fixture(async context => { try { return await execute(context); } finally { settled(); } });
  let failed = false, observed!: () => void; const blocked = new Promise<void>(resolve => { observed = resolve; });
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (!failed && String(to).endsWith('.receipt.json') && JSON.parse(await readFile(from, 'utf8')).state === 'download') { failed = true; observed(); throw locked('EPERM'); }
    return nativeFs.rename(from, to);
  });
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await blocked;
  await runtime.dispatch('run.cancel', { runId: run.id }); await runtime.waitForIdle();
  // Native cancellation may finish its graph invocation before a local write
  // settles. Observe the real leaf before reading it or removing the fixture.
  await activitySettled;
  expect(runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: run.id })).run.status).toBe('canceled');
  expect(projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id })).project).toEqual(project);
  expect((await receipt(directory, project.id)).value.providerUsage).toMatchObject({ source: 'provider', inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  expect(calls().posts).toBe(1); await close(runtime);
  const recovered = open(directory); await expect(recovered.dispatch('run.resume', { runId: run.id })).rejects.toThrow('已经结束');
  expect(runInspectionSchema.parse(await recovered.dispatch('run.inspect', { runId: run.id })).run.status).toBe('canceled');
  expect(projectDetailSchema.parse(await recovered.dispatch('project.get', { projectId: project.id })).project).toEqual(project); expect(calls().posts).toBe(1);
});
