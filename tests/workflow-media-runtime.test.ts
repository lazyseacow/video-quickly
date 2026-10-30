import { createServer, type Server, type RequestListener } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { projectSchema, workflowSchema, workflowNodeSchema, type ProjectDocument, type RunRecord, type RunInspection } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit } from '../packages/runtime/src/index';
import { createActivityExecutor } from '../packages/integrations/src/index';
import { openDatabase, DocumentStore } from '../packages/runtime/src/database';

const directories: string[] = [], servers: Server[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => { await Promise.allSettled(runtimes.splice(0).map(value => value.close())); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function service(handler: RequestListener) { const server = createServer(handler); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address'); return `http://127.0.0.1:${address.port}`; }
async function fixture(baseUrl: string, options: Partial<Parameters<typeof createRuntime>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-media-runtime-')); directories.push(directory); const runtime = createRuntime({ dataDirectory: directory, seed: false, executeActivity: createActivityExecutor(), ...options }); runtimes.push(runtime);
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '并发任务', brief: '' }));
  const model = await runtime.dispatch('model.save', { model: { name: 'HTTP夹具', provider: 'custom-http', model: 'fixture', baseUrl, capabilities: ['image'], parameters: { requestPath: 'generate', requestTemplate: { name: '{{narration}}' }, resultUrlPath: 'url' } } }) as { id: string };
  const saved = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [0, 1].map(index => ({ id: `shot-${index}`, title: `镜头${index}`, narration: `shot-${index}`, visualPrompt: '', durationUs: 1_000_000 })), workflow: workflowSchema.parse({ id: 'parallel', version: 1, name: 'parallel', nodes: [workflowNodeSchema.parse({ id: 'images', kind: 'assets', label: '画面', modelId: model.id })], edges: [], execution: { maxConcurrentShots: 2, modelLimits: { [model.id]: 2 } } }) } }));
  return { runtime, directory, project: saved };
}
async function body(request: Parameters<RequestListener>[0]) { let text = ''; for await (const chunk of request) text += chunk; return JSON.parse(text); }
function restart(directory: string) { const runtime = createRuntime({ dataDirectory: directory, seed: false, executeActivity: createActivityExecutor() }); runtimes.push(runtime); return runtime; }
it('stops native sibling requests queued behind a model limit before releasing a failed request slot', async () => {
  let posts = 0;
  const base = await service(async (request, response) => { if (request.method === 'POST') { posts++; await body(request); } response.writeHead(503).end(); });
  const { runtime, project } = await fixture(base); const modelId = project.workflow.nodes[0].modelId!;
  await runtime.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow: { ...project.workflow, execution: { maxConcurrentShots: 2, modelLimits: { [modelId]: 1 } } } });
  const run = await runtime.dispatch('run.start', { projectId: project.id }) as RunRecord; await runtime.waitForIdle();
  expect((await runtime.dispatch('run.inspect', { runId: run.id }) as RunInspection).run.status).toBe('failed'); expect(posts).toBe(1);
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

it('applies parameterized subflow ASR using its actual frozen node definition after reopening without resubmission', async () => {
  let posts = 0;
  const base = await service(async (request, response) => { posts++; const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); expect(Buffer.concat(chunks).includes(Buffer.from('WAVE'))).toBe(true); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ duration: 1, segments: [{ start: 0, end: 1, text: '真实时间戳候选' }] })); });
  const directory = await mkdtemp(join(tmpdir(), 'vq-subflow-asr-')); directories.push(directory); const runtime = createRuntime({ dataDirectory: directory, seed: false, executeActivity: createActivityExecutor() }); runtimes.push(runtime);
  let project = projectSchema.parse(await runtime.dispatch('project.create', { title: '参数化识别', brief: '' })); project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'target-shot', title: '目标镜头', narration: '', visualPrompt: '', durationUs: 1_000_000 }] } }));
  const wav = Buffer.alloc(16044); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40); const path = join(directory, 'voice.wav'); await writeFile(path, wav);
  await runtime.dispatch('asset.import', { projectId: project.id, shotId: 'target-shot', kind: 'audio', path }); project = (await runtime.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project;
  const model = await runtime.dispatch('model.save', { model: { name: '识别HTTP夹具', provider: 'openai-compatible', model: 'timestamps', baseUrl: base, capabilities: ['asr'] } }) as { id: string };
  const definition = { id: 'asr-template', version: 1, name: '参数化识别', inputs: [{ name: 'target', type: 'string', required: true }], outputs: [{ name: 'captions', type: 'json', nodeId: 'transcribe', path: ['captionTrack'] }], nodes: [{ id: 'transcribe', kind: 'voice', label: '实际语音识别', modelId: model.id, config: { operation: 'transcribe', shotId: '{{input.target}}' } }], edges: [] };
  project = projectSchema.parse(await runtime.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow: { id: 'parent', version: 1, name: 'parent', nodes: [{ id: 'call', kind: 'subflow', label: '识别模板', subflow: { id: definition.id, version: 1, inputs: { target: { literal: 'target-shot' } } } }], edges: [], subflows: [definition] } }));
  const run = await runtime.dispatch('run.start', { projectId: project.id }) as RunRecord; await runtime.waitForIdle(); const inspection = await runtime.dispatch('run.inspect', { runId: run.id }) as RunInspection; expect(inspection.run.status, inspection.run.error).toBe('succeeded'); await runtime.close();
  const recovered = restart(directory), nodeId = 'call/subflow/transcribe'; const payload = await recovered.dispatch('run.step.payload', { runId: run.id, nodeId, kind: 'input' }) as { value: unknown }; expect(payload.value).toMatchObject({ node: { config: { shotId: 'target-shot' } } });
  const applied = projectSchema.parse(await recovered.dispatch('node.apply', { runId: run.id, nodeId, revision: project.revision, applicationId: `${run.id}:${nodeId}` })); expect(applied.shots[0].captionTrack?.cues[0].text).toBe('真实时间戳候选'); expect(posts).toBe(1);
});
