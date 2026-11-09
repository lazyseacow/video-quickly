import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { modelSchema, projectReadinessSchema, workflowNodeSchema, type AssetRecord, type ProjectDocument, type WorkflowNode } from '@video-quickly/contracts';
import { createRuntime, type RuntimeOptions } from '../packages/runtime/src';
import { DocumentStore, openDatabase } from '../packages/runtime/src/database';

const fixtures: Array<{ directory: string; runtime: ReturnType<typeof createRuntime>; database: ReturnType<typeof openDatabase> }> = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) { await fixture.runtime.close(); fixture.database.close(); await rm(fixture.directory, { recursive: true, force: true }); } });
async function fixture(nodes: Array<Partial<WorkflowNode> & Pick<WorkflowNode, 'id' | 'kind'>>, options: Pick<RuntimeOptions, 'preflightActivity'> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-readiness-'));
  const getSecret = vi.fn(async () => 'must-not-be-read'), provider = vi.fn(async () => 'must-not-be-called'), execute = vi.fn(async () => ({ forbidden: true }));
  const runtime = createRuntime({ dataDirectory: directory, seed: false, secretStore: { persistent: true, get: getSecret, set: async () => {}, delete: async () => {} }, provider, executeActivity: execute, ...options });
  const database = openDatabase(directory), store = new DocumentStore(database); fixtures.push({ directory, runtime, database });
  const created = await runtime.dispatch('project.create', { title: '制作前只读检查' }) as ProjectDocument;
  const project = await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: {
    shots: [{ id: 'shot', title: '当前镜头', narration: '已写好的旁白', visualPrompt: '', durationUs: 1_000_000 }],
    workflow: { ...created.workflow, nodes: nodes.map(node => workflowNodeSchema.parse({ label: node.id, ...node })), edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, source: nodes[index].id, target: node.id })) },
  } }) as ProjectDocument;
  const check = (selection?: { nodeId: string; mode: 'node' | 'downstream' }) => runtime.dispatch('project.readiness', { projectId: project.id, selection }).then(value => projectReadinessSchema.parse(value));
  return { directory, runtime, database, store, project, check, getSecret, provider, execute };
}

it('inspects a saved local script without reading credentials or creating runs, activities or costs', async () => {
  const f = await fixture([{ id: 'script', kind: 'script' }]);
  const before = f.database.prepare('SELECT kind, id, body FROM documents ORDER BY kind, id').all();
  const events: unknown[] = []; const unsubscribe = f.runtime.subscribe(event => events.push(event));
  const result = await f.check(); unsubscribe();
  expect(result).toMatchObject({ projectId: f.project.id, projectRevision: f.project.revision, ready: true, serviceCheck: 'not_contacted', stepCount: 1, modelCount: 0, assetCount: 0 });
  expect(f.database.prepare('SELECT kind, id, body FROM documents ORDER BY kind, id').all()).toEqual(before);
  expect(events).toEqual([]); expect(f.getSecret).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
});

it('aggregates model blockers and only inspects the selected scope', async () => {
  const f = await fixture([{ id: 'script', kind: 'script', modelId: 'wrong-role' }, { id: 'image', kind: 'assets', modelId: 'missing' }]);
  f.store.put('model', 'wrong-role', modelSchema.parse({ id: 'wrong-role', name: '图片连接', provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'image-fixture', connectionType: 'image', capabilities: ['image'], enabled: true, createdAt: '', updatedAt: '' }));
  const all = await f.check(); expect(all.ready).toBe(false);
  expect(all.issues.filter(issue => issue.severity === 'error').map(issue => issue.nodeId)).toEqual(expect.arrayContaining(['script', 'image']));
  const scoped = await f.check({ nodeId: 'script', mode: 'node' }); expect(scoped.stepCount).toBe(1); expect(scoped.issues.some(issue => issue.nodeId === 'image')).toBe(false);
  expect(f.provider).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
});

it('reports configured credentials as unverified without unlocking the secret store', async () => {
  const f = await fixture([{ id: 'script', kind: 'script', modelId: 'text' }]);
  f.store.put('model', 'text', modelSchema.parse({ id: 'text', name: '文本连接', provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'text-fixture', connectionType: 'text', capabilities: ['text'], enabled: true, hasSecret: true, credentialRef: 'fixture-only', createdAt: '', updatedAt: '' }));
  const result = await f.check(); expect(result.ready).toBe(true); expect(result.serviceCheck).toBe('not_contacted'); expect(result.modelCount).toBe(1);
  expect(JSON.stringify(result)).not.toContain('fixture-only'); expect(f.getSecret).not.toHaveBeenCalled();
});

it('detects missing and same-size changed media and gives a repair target without changing the project', async () => {
  const f = await fixture([{ id: 'export', kind: 'export' }]);
  const bytes = Buffer.from('original-media'), path = join(f.directory, 'assets', 'source.png'); await mkdir(join(f.directory, 'assets'));
  const asset: AssetRecord = { id: 'image', name: '镜头画面', projectId: f.project.id, shotId: 'shot', kind: 'image', path, mimeType: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: '', provenance: 'fixture', retained: false, active: true };
  f.store.put('asset', asset.id, asset);
  await f.runtime.dispatch('project.update', { projectId: f.project.id, revision: f.project.revision, patch: { shots: [{ ...f.project.shots[0], assetId: asset.id }] } });
  let result = await f.check(); expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ assetId: asset.id, severity: 'error', fix: 'assets' })]));
  await writeFile(path, bytes); result = await f.check(); expect(result.issues.some(issue => issue.assetId === asset.id && issue.severity === 'error')).toBe(false);
  await writeFile(path, Buffer.alloc(bytes.length, 120)); result = await f.check(); expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ assetId: asset.id, severity: 'error', fix: 'assets' })]));
  expect(f.store.get<ProjectDocument>('project', f.project.id)?.revision).toBe(f.project.revision + 1); expect(f.execute).not.toHaveBeenCalled();
});

it('explains unavailable steps and prevents archived projects from appearing ready', async () => {
  const f = await fixture([{ id: 'agent', kind: 'agent' }]);
  const result = await f.check(); expect(result.ready).toBe(false); expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'agent', severity: 'error', fix: 'step' })]));
  f.store.put('project', f.project.id, { ...f.project, archived: true, revision: f.project.revision + 1 });
  const archived = await f.check(); expect(archived.ready).toBe(false); expect(archived.issues).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'project', severity: 'error', fix: 'project' })]));
  await expect(f.check({ nodeId: 'removed', mode: 'node' })).rejects.toThrow('步骤');
});

function putModel(f: Awaited<ReturnType<typeof fixture>>, parameters: Record<string, unknown> = {}) {
  const model = modelSchema.parse({ id: 'model', name: '本地检查连接', provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'fixture', connectionType: 'image', capabilities: ['image'], createdAt: '', updatedAt: '', ...parameters });
  f.store.put('model', model.id, model); return model;
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

it('points invalid parameters to model settings and incompatible roles to the actual step', async () => {
  const f = await fixture([{ id: 'image', kind: 'assets', modelId: 'model' }]);
  putModel(f, { parameters: { size: 'invalid-size' } });
  let result = await f.check();
  expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'image', nodeLabel: 'image', modelId: 'model', modelName: '本地检查连接', fix: 'models', severity: 'error' })]));
  putModel(f, { connectionType: 'text', capabilities: ['text'] }); result = await f.check();
  expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'image', fix: 'step', severity: 'error' })]));
  putModel(f, { provider: 'ollama', connectionType: 'image', capabilities: ['image'] }); result = await f.check();
  expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'image', fix: 'step', message: expect.stringContaining('协议') })]));
});

it('reuses the local media preflight with its data directory and no submission identity or database writes', async () => {
  const preflight = vi.fn<NonNullable<RuntimeOptions['preflightActivity']>>();
  const f = await fixture([{ id: 'image', kind: 'assets', modelId: 'model' }], { preflightActivity: preflight });
  putModel(f);
  const before = f.database.prepare('SELECT kind, id, body FROM documents ORDER BY kind, id').all();
  const result = await f.check(); expect(result.ready).toBe(true);
  expect(preflight).toHaveBeenCalledTimes(1);
  const context = preflight.mock.calls[0][0];
  expect(context).toMatchObject({ dataDirectory: f.directory, project: { id: f.project.id }, node: { id: 'image' } });
  expect(context.operationId).toBeUndefined(); expect(context.signal.aborted).toBe(false);
  expect(f.database.prepare('SELECT kind, id, body FROM documents ORDER BY kind, id').all()).toEqual(before);
  expect(f.getSecret).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
});

it('owns cancellation by project and request ID and releases the same ID after aborting preflight', async () => {
  const entered = gate();
  const preflight: NonNullable<RuntimeOptions['preflightActivity']> = ({ signal }) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); entered.resolve();
  });
  const f = await fixture([{ id: 'image', kind: 'assets', modelId: 'model' }], { preflightActivity: preflight }); putModel(f);
  const requestId = crypto.randomUUID(), params = { projectId: f.project.id, requestId };
  const work = f.runtime.dispatch('project.readiness', params); const rejected = expect(work).rejects.toThrow();
  await entered.promise;
  await expect(f.runtime.dispatch('project.readiness', params)).rejects.toThrow('相同');
  expect(await f.runtime.dispatch('project.readiness.cancel', { ...params, projectId: 'other-project' })).toEqual({ canceled: false });
  expect(await f.runtime.dispatch('project.readiness.cancel', params)).toEqual({ canceled: true }); await rejected;
  expect(await f.runtime.dispatch('project.readiness.cancel', params)).toEqual({ canceled: false });
  const second = f.runtime.dispatch('project.readiness', params); const secondRejected = expect(second).rejects.toThrow();
  expect(await f.runtime.dispatch('project.readiness.cancel', params)).toEqual({ canceled: true }); await secondRejected;
  await f.runtime.waitForIdle();
});

it('aborts an in-flight local inspection before closing the runtime', async () => {
  const entered = gate(); let aborted = false;
  const f = await fixture([{ id: 'image', kind: 'assets', modelId: 'model' }], { preflightActivity: ({ signal }) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }); entered.resolve();
  }) }); putModel(f);
  const work = f.check(), rejected = expect(work).rejects.toThrow(); await entered.promise;
  await f.runtime.close(); await rejected; expect(aborted).toBe(true);
  fixtures.splice(fixtures.findIndex(value => value.runtime === f.runtime), 1);
  f.database.close(); await rm(f.directory, { recursive: true, force: true });
});

it('blocks exporting an empty saved project unless a valid selected upstream step can create shots', async () => {
  const f = await fixture([{ id: 'script', kind: 'script', modelId: 'model' }, { id: 'export', kind: 'export' }]);
  putModel(f, { connectionType: 'text', capabilities: ['text'] });
  await f.runtime.dispatch('project.update', { projectId: f.project.id, revision: f.project.revision, patch: { shots: [] } });
  const scoped = await f.check({ nodeId: 'export', mode: 'node' });
  expect(scoped.issues).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'export', category: 'workflow', severity: 'error' })]));
  const all = await f.check();
  expect(all.issues).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'export', category: 'workflow', severity: 'warning' })]));
  expect(all.issues.some(issue => issue.nodeId === 'export' && issue.category === 'workflow' && issue.severity === 'error')).toBe(false);
  putModel(f, { capabilities: ['image'] });
  const invalid = await f.check();
  expect(invalid.issues).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'script', category: 'model', severity: 'error' }), expect.objectContaining({ nodeId: 'export', category: 'workflow', severity: 'error' })]));
});

it('does not treat read-only Agent output as future shots for local script or export steps', async () => {
  const f = await fixture([{ id: 'agent', kind: 'agent', modelId: 'model' }, { id: 'local-script', kind: 'script' }, { id: 'export', kind: 'export' }]);
  putModel(f, { connectionType: 'text', capabilities: ['text', 'tools'] });
  await f.runtime.dispatch('project.update', { projectId: f.project.id, revision: f.project.revision, patch: { shots: [] } });
  const result = await f.check();
  expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'local-script', category: 'workflow', severity: 'error' }), expect.objectContaining({ nodeId: 'export', category: 'workflow', severity: 'error' })]));
  expect(f.provider).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
});



it('follows fixed subflow dependencies rather than their stored node order without rewriting the workflow', async () => {
  const f = await fixture([{ id: 'export', kind: 'export' }]); putModel(f);
  const asset: AssetRecord = { id: 'old-image', name: '待生成画面', kind: 'image', path: join(f.directory, 'old.png'), mimeType: 'image/png', projectId: f.project.id, shotId: 'shot', size: 1, sha256: createHash('sha256').update('x').digest('hex'), version: 1, createdAt: '', provenance: 'fixture', retained: false, active: true };
  f.store.put('asset', asset.id, asset);
  const children = [workflowNodeSchema.parse({ id: 'export', kind: 'export', label: '子流程导出' }), workflowNodeSchema.parse({ id: 'image', kind: 'assets', label: '子流程图片', modelId: 'model' })];
  const workflow = { ...f.project.workflow, nodes: [workflowNodeSchema.parse({ id: 'call', kind: 'subflow', label: '固定子流程', subflow: { id: 'template', version: 1, inputs: {} } })], edges: [], subflows: [{ id: 'template', name: '生成后导出', version: 1, inputs: [], outputs: [], nodes: children, edges: [{ id: 'generate-first', source: 'image', target: 'export' }] }] };
  await f.runtime.dispatch('project.update', { projectId: f.project.id, revision: f.project.revision, patch: { workflow, shots: [{ ...f.project.shots[0], assetId: asset.id }] } });
  const result = await f.check();
  expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'call/subflow/export', assetId: asset.id, severity: 'warning' })]));
  expect(result.issues.some(issue => issue.assetId === asset.id && issue.severity === 'error')).toBe(false);
  expect(f.store.get<ProjectDocument>('project', f.project.id)?.workflow.subflows?.[0].nodes.map(node => node.id)).toEqual(['export', 'image']);
});

it('locates a busy project in its run history rather than generic project settings', async () => {
  const f = await fixture([{ id: 'script', kind: 'script' }]);
  f.store.put('run', 'unfinished', { id: 'unfinished', projectId: f.project.id, projectRevision: f.project.revision, workflowVersion: 1, status: 'waiting_review', snapshotDigest: 'fixture', createdAt: '', updatedAt: '', events: [], activities: [] });
  const result = await f.check();
  expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'project', severity: 'error', fix: 'runs' })]));
});

it('locates an out-of-scope subflow binding at its owning step', async () => {
  const f = await fixture([{ id: 'source', kind: 'brief' }]);
  const call = workflowNodeSchema.parse({ id: 'call', kind: 'subflow', label: '需要上游输入的子流程', subflow: { id: 'template', version: 1, inputs: { topic: { nodeId: 'source', path: ['brief'] } } } });
  await f.runtime.dispatch('project.update', { projectId: f.project.id, revision: f.project.revision, patch: { workflow: { ...f.project.workflow, nodes: [...f.project.workflow.nodes, call], edges: [{ id: 'upstream', source: 'source', target: 'call' }], subflows: [{ id: 'template', version: 1, name: '固定子流程', inputs: [{ name: 'topic', type: 'string', required: true }], outputs: [], nodes: [workflowNodeSchema.parse({ id: 'child', kind: 'brief', label: '子步骤' })], edges: [] }] } } });
  const result = await f.check({ nodeId: 'call', mode: 'node' });
  expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'call', category: 'workflow', severity: 'error', fix: 'step' })]));
});

it('redacts credentials in unexpected local preflight failures without unlocking credentials', async () => {
  const f = await fixture([{ id: 'image', kind: 'assets', modelId: 'model' }], { preflightActivity: () => { throw new Error('local input Bearer sk-fixture-only-token https://user:fixture-password@example.invalid/input?api_key=fixture-query-key'); } }); putModel(f);
  const result = await f.check(), serialized = JSON.stringify(result);
  expect(result.ready).toBe(false);
  for (const secret of ['sk-fixture-only-token', 'fixture-password', 'fixture-query-key']) expect(serialized).not.toContain(secret);
  expect(f.getSecret).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
});
