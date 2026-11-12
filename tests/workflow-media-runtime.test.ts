import { createServer, type Server, type RequestListener } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { projectSchema, workflowSchema, workflowNodeSchema, type AssetRecord, type ModelProfile, type ProjectDocument, type RunRecord, type RunInspection, type WorkspaceSnapshot } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit } from '../src/packages/runtime/src/index';
import { createActivityExecutor, validateMediaActivity, type MediaActivityContext } from '../src/packages/integrations/src/index';
import { openDatabase, DocumentStore } from '../src/packages/runtime/src/database';
import { fixtureNativeVideo } from './fixtures/native-video';

const directories: string[] = [], servers: Server[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => { await Promise.allSettled(runtimes.splice(0).map(value => value.close())); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function service(handler: RequestListener) { const server = createServer(handler); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address'); return `http://127.0.0.1:${address.port}`; }
async function fixture(baseUrl: string, options: Partial<Parameters<typeof createRuntime>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-media-runtime-')); directories.push(directory); const runtime = createRuntime({ dataDirectory: directory, seed: false, preflightActivity: validateMediaActivity, executeActivity: createActivityExecutor(), ...options }); runtimes.push(runtime);
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '媒体生成任务', brief: '' }));
  const model = await runtime.dispatch('model.save', { model: { name: 'HTTP夹具', provider: 'custom-http', model: 'fixture', baseUrl, connectionType: 'image', capabilities: ['image'], parameters: { requestPath: 'generate', requestTemplate: { name: '{{narration}}' }, resultUrlPath: 'url' } } }) as ModelProfile;
  const saved = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [0, 1].map(index => ({ id: `shot-${index}`, title: `镜头${index}`, narration: `shot-${index}`, visualPrompt: '', durationUs: 1_000_000 })), workflow: workflowSchema.parse({ id: 'media', version: 1, name: 'media', production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [workflowNodeSchema.parse({ id: 'images', kind: 'assets', label: '画面', modelId: model.id })], edges: [] }) } }));
  return { runtime, directory, project: saved, model };
}
async function body(request: Parameters<RequestListener>[0]) { let text = ''; for await (const chunk of request) text += chunk; return JSON.parse(text); }
function restart(directory: string) { const runtime = createRuntime({ dataDirectory: directory, seed: false, preflightActivity: validateMediaActivity, executeActivity: createActivityExecutor() }); runtimes.push(runtime); return runtime; }
it('recovers a rejected image in the same run and retains the completed sibling after a restart', async () => {
  const posts: { shot: string; key: string | string[] | undefined }[] = [];
  const base = await service(async (request, response) => {
    if (request.method === 'POST') {
      const shot = (await body(request)).name; posts.push({ shot, key: request.headers['idempotency-key'] });
      if (posts.length === 2) { response.writeHead(400).end(); return; }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ url: `${base}/${shot}` })); return;
    }
    response.end(Buffer.from(png, 'base64'));
  });
  const { runtime, directory, project } = await fixture(base);
  const run = await runtime.dispatch('run.start', { projectId: project.id }) as RunRecord; await runtime.waitForIdle();
  const failed = await runtime.dispatch('run.inspect', { runId: run.id }) as RunInspection;
  expect(failed.run.error).toContain('HTTP 400'); expect(failed.steps[0]).toMatchObject({ status: 'needs_attention', unknownSubmission: false, retry: { allowed: true } });
  await runtime.close();
  const recovered = restart(directory); await recovered.dispatch('run.step.retry', { runId: run.id, nodeId: 'images' }); await recovered.waitForIdle();
  const completed = await recovered.dispatch('run.inspect', { runId: run.id }) as RunInspection;
  expect(completed.run.status).toBe('succeeded'); expect(completed.steps[0].status).toBe('succeeded');
  expect(posts).toEqual([{ shot: 'shot-0', key: `${run.id}:images:shot-0` }, { shot: 'shot-1', key: `${run.id}:images:shot-1` }, { shot: 'shot-1', key: `${run.id}:images:shot-1:attempt:2` }]);
});
it('retries only the rejected short Seedance video with the corrected request duration', async () => {
  const clip = fixtureNativeVideo();
  const posts: { key: string | string[] | undefined; seconds: number }[] = [];
  const baseUrl = await service(async (request, response) => {
    if (request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const form = await new Request('http://fixture.local', { method: 'POST', headers: { 'content-type': request.headers['content-type']! }, body: Buffer.concat(chunks) }).formData();
      const seconds = Number(form.get('seconds'));
      posts.push({ key: request.headers['idempotency-key'], seconds });
      if (seconds < 4) { response.writeHead(400).end(); return; }
      response.end(JSON.stringify({ id: 'video-task' }));
    } else if (request.url === '/videos/video-task/content') {
      response.writeHead(200, { 'content-type': 'video/mp4' }).end(clip);
    } else response.end(JSON.stringify({ status: 'completed' }));
  });
  const directory = await mkdtemp(join(tmpdir(), 'vq-video-duration-')); directories.push(directory);
  const execute = createActivityExecutor();
  const runtime = createRuntime({ dataDirectory: directory, seed: false, preflightActivity: validateMediaActivity,
    executeActivity: context => {
      // Use the generic duration rule to reproduce the previous adapter's requests.
      if (context.model) return execute({ ...context, model: { ...context.model, model: 'seedance-fixture' } });
      return execute(context);
    },
  });
  runtimes.push(runtime);
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '补拍短镜头', profile: { width: 160, height: 90, frameRate: { numerator: 30, denominator: 1 } } }));
  const model = await runtime.dispatch('model.save', { model: { name: 'Seedance 兼容网关', provider: 'openai-compatible', model: 'doubao-seedance-2-0-260128', baseUrl, connectionType: 'video', capabilities: ['video'] } }) as ModelProfile;
  const video = project.workflow.nodes.find(node => node.id === 'video')!;
  await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: {
    shots: [
      { id: 'shot-1', title: '已生成镜头', narration: '', visualPrompt: '主角缓步走近', durationUs: 4_000_000 },
      { id: 'shot-7', title: '主角错愕反应', narration: '', visualPrompt: '主角错愕地抬头', durationUs: 3_000_000 },
    ],
    workflow: { ...project.workflow, id: 'video-retry', production: { ...project.workflow.production, videoModelId: model.id }, stages: undefined, nodes: [video], edges: [] },
  } });
  const run = await runtime.dispatch('run.start', { projectId: project.id }) as RunRecord;
  await runtime.waitForIdle();
  await runtime.dispatch('run.step.retry', { runId: run.id, nodeId: 'video' });
  await runtime.waitForIdle();
  const failed = await runtime.dispatch('run.inspect', { runId: run.id }) as RunInspection;
  expect(failed.run).toMatchObject({ status: 'needs_attention', error: expect.stringContaining('HTTP 400') });
  const { assets: before } = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(before).toEqual([expect.objectContaining({ shotId: 'shot-1', kind: 'video' })]);
  await runtime.close();

  const recovered = restart(directory);
  await recovered.dispatch('run.step.retry', { runId: run.id, nodeId: 'video' });
  await recovered.waitForIdle();
  const completed = await recovered.dispatch('run.inspect', { runId: run.id }) as RunInspection;
  expect(completed.run.status, completed.run.error).toBe('succeeded');
  const { value: { assets } } = await recovered.dispatch('run.step.payload', { runId: run.id, nodeId: 'video', kind: 'output' }) as { value: { assets: AssetRecord[] } };
  expect(assets).toEqual([before[0], expect.objectContaining({ shotId: 'shot-7', kind: 'video' })]);
  expect(posts).toEqual([
    { key: `${run.id}:video:shot-1`, seconds: 4 },
    { key: `${run.id}:video:shot-7`, seconds: 3 },
    { key: `${run.id}:video:shot-7:attempt:2`, seconds: 3 },
    { key: `${run.id}:video:shot-7:attempt:3`, seconds: 4 },
  ]);
});
it('checks the whole batch before any fresh sibling POST when another shot has a prepared or unknown receipt', async () => {
  const posts: string[] = []; let release!: () => void, submitted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), received = new Promise<void>(resolve => { submitted = resolve; });
  const base = await service(async (request, response) => { if (request.method === 'POST') { posts.push((await body(request)).name); submitted(); await gate; } response.writeHead(503).end(); });
  const { directory, project, model } = await fixture(base);
  const context: MediaActivityContext = { project, node: project.workflow.nodes[0], model, runId: 'receipt-preflight', operationId: 'receipt-preflight:images', dataDirectory: directory, assets: [], signal: new AbortController().signal, persistRemoteTask() {} };
  const first = expect(createActivityExecutor()({ ...context, project: { ...project, shots: [project.shots[1]] } })).rejects.toThrow('HTTP 503');
  try {
    await received;
    await expect(validateMediaActivity({ ...context, operationId: undefined, dataDirectory: undefined })).resolves.toBeUndefined();
    await expect(validateMediaActivity(context)).rejects.toThrow('核对'); expect(posts).toEqual(['shot-1']);
  }
  finally { release(); await first; }
  // A fresh executor has no in-memory scheduling state. Its first shot is the
  // still-unsubmitted sibling, so only a full-batch receipt check can stop it.
  await expect(createActivityExecutor()(context)).rejects.toThrow('核对'); expect(posts).toEqual(['shot-1']);
});
it.each([408, 409, 503])('stops native sibling requests on HTTP %i and preserves the original receipt across restart', async status => {
  const posts: string[] = [];
  const base = await service(async (request, response) => {
    if (request.method === 'POST') posts.push((await body(request)).name);
    response.writeHead(status, { 'Retry-After': '1' }).end();
  });
  const { runtime, directory, project } = await fixture(base);
  const run = await runtime.dispatch('run.start', { projectId: project.id }) as RunRecord; await runtime.waitForIdle();
  expect(posts).toHaveLength(1); const unknownShot = posts[0]; expect(project.shots.map(shot => shot.id)).toContain(unknownShot);
  const failed = (await runtime.dispatch('run.inspect', { runId: run.id }) as RunInspection).run;
  expect(failed.status).toBe('failed'); expect(failed.error).toContain('核对'); expect(posts).toEqual([unknownShot]);
  const receiptPath = join(directory, 'projects', project.id, 'activities', createHash('sha256').update(`${run.id}:images`).digest('hex').slice(0, 24), `${createHash('sha256').update(unknownShot).digest('hex').slice(0, 24)}.receipt.json`);
  const receipt = await readFile(receiptPath, 'utf8'); expect(JSON.parse(receipt)).toMatchObject({ state: 'unknown' });
  await runtime.close();
  const recovered = restart(directory); await recovered.dispatch('run.resume', { runId: run.id }); await recovered.waitForIdle();
  const restored = (await recovered.dispatch('run.inspect', { runId: run.id }) as RunInspection).run;
  expect(restored.status).toBe('failed'); expect(restored.error).toContain('核对'); expect(posts).toEqual([unknownShot]); expect(await readFile(receiptPath, 'utf8')).toBe(receipt);
});
it('validates native cached assets before committing the parent activity and never resubmits corrupted completed shots', async () => {
  let posts = 0, downloads = 0;
  const base = await service(async (request, response) => {
    if (request.method === 'POST') { posts++; const input = await body(request); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ url: `${base}/${input.name}` })); return; }
    downloads++; response.end(Buffer.from(png, 'base64'));
  });
  const { runtime, directory, project } = await fixture(base, { failpoint(point) { if (point === 'after-result') throw new SimulatedProcessExit(); } });
  const run = await runtime.dispatch('run.start', { projectId: project.id }) as RunRecord; await runtime.waitForIdle(); await runtime.close();
  const receiptPath = join(directory, 'projects', project.id, 'activities', createHash('sha256').update(`${run.id}:images`).digest('hex').slice(0, 24), `${createHash('sha256').update('shot-0').digest('hex').slice(0, 24)}.receipt.json`);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { asset: { path: string; size: number } }; await writeFile(receipt.asset.path, Buffer.alloc(receipt.asset.size));
  const recovered = restart(directory); await recovered.dispatch('run.resume', { runId: run.id }); await recovered.waitForIdle();
  const inspection = await recovered.dispatch('run.inspect', { runId: run.id }) as RunInspection; expect(inspection.run.status).toBe('failed'); const db = openDatabase(directory); try { expect(db.prepare('SELECT status FROM activities WHERE run_id = ?').get(run.id)).toEqual({ status: 'unknown' }); } finally { db.close(); } expect(posts).toBe(2); expect(downloads).toBe(2);
});
it('resumes one failed download through the real journal after reopening while reusing its completed sibling', async () => {
  let posts = 0, downloads = 0, fail = true;
  const base = await service(async (request, response) => {
    if (request.method === 'POST') { posts++; const input = await body(request); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ url: `${base}/${input.name}` })); return; }
    downloads++; if (request.url === '/shot-1' && fail) response.writeHead(503).end(); else response.end(Buffer.from(png, 'base64'));
  });
  const { runtime, directory, project } = await fixture(base), run = await runtime.dispatch('run.start', { projectId: project.id }) as RunRecord; await runtime.waitForIdle();
  expect((await runtime.dispatch('run.inspect', { runId: run.id }) as RunInspection).run.status).toBe('failed'); expect(posts).toBe(2); await runtime.close();
  fail = false; const recovered = restart(directory); await recovered.dispatch('run.resume', { runId: run.id }); await recovered.waitForIdle();
  expect((await recovered.dispatch('run.inspect', { runId: run.id }) as RunInspection).run.status).toBe('succeeded'); expect(posts).toBe(2); expect(downloads).toBe(3);
  const output = await recovered.dispatch('node.result', { runId: run.id, nodeId: 'images' }) as { assets: { shotId: string }[] }; expect(output.assets.map(asset => asset.shotId)).toEqual(['shot-0', 'shot-1']);
  const applied = await recovered.dispatch('node.apply', { runId: run.id, nodeId: 'images', revision: project.revision, applicationId: `${run.id}:images` }) as ProjectDocument;
  expect(applied.shots.every(shot => Boolean(shot.assetId))).toBe(true);
});
it('does not POST an ambiguous shot again after a real process close and journal resume', async () => {
  let posts = 0;
  const base = await service(async (request, response) => {
    if (request.method === 'POST') { posts++; const input = await body(request); if (input.name === 'shot-1') { request.socket.destroy(); return; } response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ url: `${base}/${input.name}` })); return; }
    response.end(Buffer.from(png, 'base64'));
  });
  const { runtime, directory, project } = await fixture(base), run = await runtime.dispatch('run.start', { projectId: project.id }) as RunRecord; await runtime.waitForIdle(); await runtime.close();
  expect(posts).toBe(2); const recovered = restart(directory); await recovered.dispatch('run.resume', { runId: run.id }); await recovered.waitForIdle();
  expect((await recovered.dispatch('run.inspect', { runId: run.id }) as RunInspection).run.status).toBe('failed'); expect(posts).toBe(2);
});
it('cancels pending work terminally and never creates replacement submissions', async () => {
  let posts = 0, resumed = false, ready!: () => void; const waiting = new Promise<void>(resolve => { ready = resolve; });
  const base = await service(async (request, response) => {
    if (request.method === 'POST') { posts++; const input = await body(request); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ url: `${base}/${input.name}` })); return; }
    if (request.url === '/shot-1' && !resumed) { ready(); return; } response.end(Buffer.from(png, 'base64'));
  });
  const { runtime, directory, project } = await fixture(base), run = await runtime.dispatch('run.start', { projectId: project.id }) as RunRecord; await waiting; await runtime.dispatch('run.cancel', { runId: run.id }); await runtime.waitForIdle(); await runtime.close();
  resumed = true; const recovered = restart(directory); await expect(recovered.dispatch('run.resume', { runId: run.id })).rejects.toThrow('已经结束');
  expect((await recovered.dispatch('run.inspect', { runId: run.id }) as RunInspection).run.status).toBe('canceled'); expect(posts).toBe(2);
  const db = openDatabase(directory); try { const rows = db.prepare('SELECT * FROM activities WHERE run_id = ?').all(run.id); expect(rows).toHaveLength(1); expect(new DocumentStore(db).get('run-snapshot', run.id)).toBeDefined(); } finally { db.close(); }
});
