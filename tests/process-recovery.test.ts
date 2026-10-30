import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectDocument, RunInspection, RunPlan, RunRecord, WorkspaceSnapshot } from '@video-quickly/contracts';
import { openDatabase, DocumentStore } from '../packages/runtime/src/database';

const directories: string[] = [];
const children: RpcProcess[] = [];
// OS scheduling, HTTP downloads and durable writes share the same bounded
// budget as child RPC, rather than expect.poll's one-second default.
const processTimeout = 15_000;
class RpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private counter = 0;
  private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  constructor(dataDirectory: string) {
    this.child = spawn(process.execPath, ['--import', 'tsx', resolve('packages/runtime/src/main.ts'), '--data-dir', dataDirectory], { cwd: resolve('.'), windowsHide: true });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message: unknown;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== 'object' || !('id' in message) || typeof message.id !== 'number') return;
      const pending = this.waiting.get(message.id);
      if (!pending) return;
      this.waiting.delete(message.id);
      if ('error' in message && message.error && typeof message.error === 'object' && 'message' in message.error) pending.reject(new Error(String(message.error.message)));
      else pending.resolve('result' in message ? message.result : undefined);
    });
    this.child.on('exit', () => { for (const pending of this.waiting.values()) pending.reject(new Error('执行进程已退出')); this.waiting.clear(); });
    // Drain stderr so a diagnostic burst cannot block the child process.
    this.child.stderr.resume();
    children.push(this);
  }
  request<T>(method: string, params: unknown = {}): Promise<T> {
    const id = ++this.counter;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => { this.waiting.delete(id); reject(new Error(`RPC 超时：${method}`)); }, processTimeout);
      this.waiting.set(id, { resolve: value => { clearTimeout(timeout); resolve(value as T); }, reject: error => { clearTimeout(timeout); reject(error); } });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async kill() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()));
    this.child.kill('SIGKILL');
    await exited;
  }
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(child => child.kill()));
  await Promise.all(directories.splice(0).map(path => {
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith('video-quickly-process-')) throw new Error('Unexpected process-test cleanup path');
    return rm(path, { recursive: true, force: true });
  }));
});

async function waitFor(process: RpcProcess, runId: string, status: string) {
  const deadline = Date.now() + processTimeout;
  do {
    const snapshot = await process.request<WorkspaceSnapshot>('workspace.snapshot');
    const run = snapshot.runs.find(run => run.id === runId);
    if (run?.status === status) return run;
    if (run?.status === 'failed') throw new Error(run.error ?? '运行失败');
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`未达到期望状态：${status}`);
}

describe('actual sidecar process recovery', () => {
  it('retains a scoped version-two workflow after a hard exit while preserving later manual project edits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video-quickly-process-scope-')); directories.push(directory);
    const first = new RpcProcess(directory);
    const created = await first.request<ProjectDocument>('project.create', { title: '进程终止后的局部执行' });
    const project = await first.request<ProjectDocument>('project.update', { projectId: created.id, revision: created.revision, patch: { workflow: {
      id: 'scoped', name: '冻结的局部流程', version: 1,
      nodes: [{ id: 'outside', kind: 'brief', label: '保持不执行的上游' }, { id: 'selected', kind: 'brief', label: '等待审阅的选中步骤', requiresReview: true }, { id: 'tail', kind: 'brief', label: '范围内的后续步骤' }],
      edges: [{ id: 'os', source: 'outside', target: 'selected' }, { id: 'st', source: 'selected', target: 'tail' }],
    } } });
    const plan = await first.request<RunPlan>('run.plan', { projectId: project.id, selection: { nodeId: 'selected', mode: 'downstream' } });
    const run = await first.request<RunRecord>('run.start', { projectId: project.id, selection: { ...plan.selection, previewDigest: plan.digest } });
    const before = await waitFor(first, run.id, 'waiting_review'); expect(before.activities.map(activity => activity.id)).toEqual(['selected']);
    await first.request('workspace.snapshot'); await first.kill();
    const second = new RpcProcess(directory);
    const edited = await second.request<ProjectDocument>('project.update', { projectId: project.id, revision: project.revision, patch: { title: '恢复前的人工标题', workflow: { ...project.workflow, nodes: [...project.workflow.nodes, { ...project.workflow.nodes[0], id: 'new-outside', label: '新增的范围外步骤' }] } } });
    await second.request('run.review', { runId: run.id, approved: true });
    const after = await waitFor(second, run.id, 'succeeded'); expect(after.selection).toEqual(plan.selection); expect(after.activities.map(activity => activity.id)).toEqual(['selected', 'tail']);
    const inspection = await second.request<RunInspection>('run.inspect', { runId: run.id, nodeId: 'selected' }); expect(inspection.selected?.handlerVersion).toBe(2); expect(inspection.steps.map(step => step.id)).toEqual(['selected', 'tail']);
    expect((await second.request<{ project: ProjectDocument }>('project.get', { projectId: project.id })).project).toEqual(edited);
    expect(await second.request('run.replay', { runId: run.id })).toMatchObject({ externalCalls: 0, matchesSnapshot: true });
  }, 30000);

  it('continues a persisted human review after a hard process termination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video-quickly-process-'));
    directories.push(directory);
    const first = new RpcProcess(directory);
    const snapshot = await first.request<WorkspaceSnapshot>('workspace.snapshot');
    const project = snapshot.projects[0];
    const run = await first.request<RunRecord>('run.start', { projectId: project.id, nodeId: 'style' });
    const before = await waitFor(first, run.id, 'waiting_review');
    expect(before.activities).toHaveLength(1);
    // A second RPC proves the child returned from the original graph invocation.
    await first.request('workspace.snapshot');
    await first.kill();

    const second = new RpcProcess(directory);
    const restored = await second.request<WorkspaceSnapshot>('workspace.snapshot');
    expect(restored.runs.find(record => record.id === run.id)?.status).toBe('waiting_review');
    await second.request('run.review', { runId: run.id, approved: true });
    const after = await waitFor(second, run.id, 'succeeded');
    expect(after.activities).toHaveLength(1);
    expect(after.activities[0].result).toEqual(before.activities[0].result);
    const replay = await second.request<{ externalCalls: number; matchesSnapshot: boolean }>('run.replay', { runId: run.id });
    expect(replay.externalCalls).toBe(0);
    expect(replay.matchesSnapshot).toBe(true);
  }, 30000);
});


it('resumes a version-three subflow after a hard exit without approving its next child review', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-process-subflow-')); directories.push(directory);
  const first = new RpcProcess(directory), project = await first.request<ProjectDocument>('project.create', { title: '固定子流程进程恢复' });
  const definition = { id: 'fixed-template', version: 1, name: '双重审阅', inputs: [], outputs: [{ name: 'brief', type: 'string', nodeId: 'second', path: ['brief'] }], nodes: [{ id: 'first', kind: 'brief', label: '首次确认', requiresReview: true }, { id: 'second', kind: 'brief', label: '再次确认', requiresReview: true }], edges: [{ id: 'edge', source: 'first', target: 'second' }] };
  await first.request('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { id: 'parent', version: 1, name: 'parent', nodes: [{ id: 'call', kind: 'subflow', label: '固定流程', subflow: { id: definition.id, version: 1, inputs: {} } }], edges: [], subflows: [definition] } } });
  const run = await first.request<RunRecord>('run.start', { projectId: project.id }); await waitFor(first, run.id, 'waiting_review'); await first.kill();
  const second = new RpcProcess(directory); await second.request('run.review', { runId: run.id, approved: true });
  const review = await waitFor(second, run.id, 'waiting_review'); expect(review.currentNodeId).toBe('call/subflow/second');
  await second.request('run.review', { runId: run.id, approved: true }); await waitFor(second, run.id, 'succeeded');
  const inspection = await second.request<RunInspection>('run.inspect', { runId: run.id }); expect(inspection.steps.every(step => step.status === 'succeeded')).toBe(true); expect(inspection.steps).toHaveLength(3);
});

const compositionServers: Server[] = [];
const compositionReleases: (() => void)[] = [];
afterEach(async () => { for (const release of compositionReleases.splice(0)) release(); await Promise.all(compositionServers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
it('recovers parallel media receipts after SIGKILL while preserving completed siblings and original remote task IDs', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  let posts = 0, released = false, sawPending!: () => void; const pending = new Promise<void>(resolve => { sawPending = resolve; });
  const queries: string[] = [], downloads: string[] = [];
  let allowCompletedQuery!: () => void, sawCompletedQuery!: () => void;
  const completedQueryGate = new Promise<void>(resolve => { allowCompletedQuery = resolve; });
  const completedQuery = new Promise<void>(resolve => { sawCompletedQuery = resolve; });
  compositionReleases.push(allowCompletedQuery);
  let base = '';
  const server = createServer(async (request, response) => {
    if (request.method === 'POST') { posts++; let text = ''; for await (const chunk of request) text += chunk; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ id: JSON.parse(text).name })); return; }
    if (request.url?.startsWith('/tasks/')) {
      const id = request.url.slice('/tasks/'.length); response.setHeader('Content-Type', 'application/json');
      queries.push(id);
      if (id === 'shot-0') { sawCompletedQuery(); await completedQueryGate; }
      if (id === 'shot-1' && !released) { sawPending(); response.end(JSON.stringify({ status: 'running' })); }
      else response.end(JSON.stringify({ status: 'completed', url: `${base}/asset/${id}` })); return;
    }
    downloads.push(request.url ?? ''); response.end(png);
  });
  compositionServers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address'); base = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-process-parallel-')); directories.push(directory);
  const first = new RpcProcess(directory), project = await first.request<ProjectDocument>('project.create', { title: '真实并发进程恢复' });
  const model = await first.request<{ id: string }>('model.save', { model: { name: '本地真实HTTP夹具', provider: 'custom-http', baseUrl: base, model: 'fixture', capabilities: ['image'], parameters: { requestPath: 'generate', requestTemplate: { name: '{{narration}}' }, taskIdPath: 'id', pollPath: 'tasks/{{taskId}}', statusPath: 'status', resultUrlPath: 'url', pollTimeoutSeconds: 30 } } });
  await first.request('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [0, 1].map(index => ({ id: `shot-${index}`, title: `镜头${index}`, narration: `shot-${index}`, visualPrompt: '', durationUs: 1_000_000 })), workflow: { id: 'parallel', version: 1, name: 'parallel', nodes: [{ id: 'images', kind: 'assets', label: '图片', modelId: model.id }], edges: [], execution: { maxConcurrentShots: 2, modelLimits: { [model.id]: 2 } } } } });
  const run = await first.request<RunRecord>('run.start', { projectId: project.id }); await pending; await completedQuery;
  const receipt = join(directory, 'projects', project.id, 'activities', createHash('sha256').update(`${run.id}:images`).digest('hex').slice(0, 24), `${createHash('sha256').update('shot-0').digest('hex').slice(0, 24)}.receipt.json`);
  // The other shot beginning a poll does not complete this shot. Hold its
  // query at that legal submitted boundary, then explicitly let it finish.
  expect(JSON.parse(await readFile(receipt, 'utf8'))).toMatchObject({ state: 'submitted', taskId: 'shot-0' });
  allowCompletedQuery();
  await expect.poll(async () => { try { return JSON.parse(await readFile(receipt, 'utf8')).state; } catch { return ''; } }, { timeout: processTimeout }).toBe('completed');
  // A receipt proves the HTTP boundary; a native pending write separately
  // proves that LangGraph retained this successful sibling before SIGKILL.
  const observer = openDatabase(directory);
  try {
    expect(new DocumentStore(observer).get('run-snapshot', run.id)).toMatchObject({ handlerVersion: 3 });
    await expect.poll(() => (observer.prepare("SELECT count(*) AS n FROM writes WHERE thread_id = ? AND channel = 'outputs' AND checkpoint_id = (SELECT max(checkpoint_id) FROM checkpoints WHERE thread_id = ?)").get(`${run.id}:media:images`, `${run.id}:media:images`) as { n: number }).n, { timeout: processTimeout }).toBe(1);
    // The parent activity cannot commit while shot-1 is still unfinished,
    // even though shot-0's receipt and native output are already durable.
    expect(observer.prepare('SELECT status FROM activities WHERE run_id = ? AND activity_id = ?').get(run.id, 'images')).toEqual({ status: 'dispatched' });
    expect(new DocumentStore(observer).get('node-result', `${run.id}:images`)).toBeUndefined();
  } finally { observer.close(); }
  const waitingReceipt = join(dirname(receipt), `${createHash('sha256').update('shot-1').digest('hex').slice(0, 24)}.receipt.json`);
  expect(JSON.parse(await readFile(waitingReceipt, 'utf8'))).toMatchObject({ state: 'submitted', taskId: 'shot-1' });
  await first.kill(); expect(posts).toBe(2);
  const queriesBeforeRestart = queries.length; released = true;
  const second = new RpcProcess(directory); await second.request('run.resume', { runId: run.id }); await waitFor(second, run.id, 'succeeded'); expect(posts).toBe(2);
  expect(queries.slice(queriesBeforeRestart)).toEqual(['shot-1']);
  expect(downloads.filter(path => path === '/asset/shot-0')).toHaveLength(1);
  const output = await second.request<{ assets: { shotId: string }[] }>('node.result', { runId: run.id, nodeId: 'images' }); expect(output.assets.map(asset => asset.shotId)).toEqual(['shot-0', 'shot-1']);
});

it('never repeats an unknown parallel submission after SIGKILL and reopening the same journal', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  let posts = 0, received!: () => void; const ambiguous = new Promise<void>(resolve => { received = resolve; }); let base = '';
  const submissions: { name: string; operationId: string | string[] | undefined }[] = [];
  const httpEvents: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'POST') {
      posts++; let text = ''; for await (const chunk of request) text += chunk; const name = JSON.parse(text).name;
      submissions.push({ name, operationId: request.headers['idempotency-key'] });
      response.on('finish', () => httpEvents.push(`${name}:finish`));
      response.on('close', () => httpEvents.push(`${name}:close:${response.writableFinished}`));
      if (name === 'shot-1') { received(); return; }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ url: `${base}/asset/${name}` })); return;
    }
    response.end(png);
  });
  compositionServers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address'); base = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-process-unknown-parallel-')); directories.push(directory);
  const first = new RpcProcess(directory), project = await first.request<ProjectDocument>('project.create', { title: '未知并行提交保护' });
  const model = await first.request<{ id: string }>('model.save', { model: { name: '未知提交夹具', provider: 'custom-http', baseUrl: base, model: 'fixture', capabilities: ['image'], parameters: { requestPath: 'generate', requestTemplate: { name: '{{narration}}' }, resultUrlPath: 'url' } } });
  await first.request('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [0, 1].map(index => ({ id: `shot-${index}`, title: `镜头${index}`, narration: `shot-${index}`, visualPrompt: '', durationUs: 1_000_000 })), workflow: { id: 'parallel', version: 1, name: 'parallel', nodes: [{ id: 'images', kind: 'assets', label: '图片', modelId: model.id }], edges: [], execution: { maxConcurrentShots: 2, modelLimits: { [model.id]: 2 } } } } });
  const run = await first.request<RunRecord>('run.start', { projectId: project.id }); await ambiguous;
  const receipt = join(directory, 'projects', project.id, 'activities', createHash('sha256').update(`${run.id}:images`).digest('hex').slice(0, 24), `${createHash('sha256').update('shot-0').digest('hex').slice(0, 24)}.receipt.json`);
  try {
    await expect.poll(async () => { try { return JSON.parse(await readFile(receipt, 'utf8')).state; } catch { return ''; } }, { timeout: processTimeout }).toBe('completed');
  } catch (error) {
    const value = JSON.parse(await readFile(receipt, 'utf8'));
    const observer = openDatabase(directory);
    try {
      const nativeErrors = observer.prepare("SELECT task_id, type, value FROM writes WHERE thread_id = ? AND channel = '__error__'").all(`${run.id}:media:images`).map(row => {
        const entry = row as { task_id: string; type: string; value: Buffer };
        return { taskId: entry.task_id, type: entry.type, error: entry.value.toString('utf8') };
      });
      throw new Error(`Completed sibling receipt failed: ${JSON.stringify({ submissions, httpEvents, receipt: { state: value.state, taskId: value.taskId, hasDownloadUrl: Boolean(value.downloadUrl), hasBase64: Boolean(value.base64), error: value.error }, nativeErrors })}`, { cause: error });
    } finally { observer.close(); }
  }
  await first.kill(); expect(posts).toBe(2);
  const second = new RpcProcess(directory); await second.request('run.resume', { runId: run.id });
  await expect.poll(async () => (await second.request<WorkspaceSnapshot>('workspace.snapshot')).runs.find(value => value.id === run.id)?.status, { timeout: processTimeout }).toBe('failed'); expect(posts).toBe(2);
  const inspection = await second.request<RunInspection>('run.inspect', { runId: run.id }); expect(inspection.steps[0].reason).toContain('核对');
});

it('keeps cancellation terminal across a hard exit with a pending parallel download', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  let posts = 0, pending!: () => void; const downloading = new Promise<void>(resolve => { pending = resolve; }); let base = '';
  const server = createServer(async (request, response) => {
    if (request.method === 'POST') { posts++; let text = ''; for await (const chunk of request) text += chunk; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ url: `${base}/${JSON.parse(text).name}` })); return; }
    if (request.url === '/shot-1') { pending(); return; } response.end(png);
  });
  compositionServers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address'); base = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-process-canceled-parallel-')); directories.push(directory);
  const first = new RpcProcess(directory), project = await first.request<ProjectDocument>('project.create', { title: '并行下载取消' });
  const model = await first.request<{ id: string }>('model.save', { model: { name: '取消夹具', provider: 'custom-http', baseUrl: base, model: 'fixture', capabilities: ['image'], parameters: { requestPath: 'generate', requestTemplate: { name: '{{narration}}' }, resultUrlPath: 'url' } } });
  await first.request('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [0, 1].map(index => ({ id: `shot-${index}`, title: `镜头${index}`, narration: `shot-${index}`, visualPrompt: '', durationUs: 1_000_000 })), workflow: { id: 'parallel', version: 1, name: 'parallel', nodes: [{ id: 'images', kind: 'assets', label: '图片', modelId: model.id }], edges: [], execution: { maxConcurrentShots: 2, modelLimits: { [model.id]: 2 } } } } });
  const run = await first.request<RunRecord>('run.start', { projectId: project.id }); await downloading; await first.request('run.cancel', { runId: run.id });
  await expect.poll(async () => (await first.request<WorkspaceSnapshot>('workspace.snapshot')).runs.find(value => value.id === run.id)?.activities[0]?.status, { timeout: processTimeout }).toBe('unknown'); await first.kill();
  const second = new RpcProcess(directory); await expect(second.request('run.resume', { runId: run.id })).rejects.toThrow('已经结束'); expect((await second.request<WorkspaceSnapshot>('workspace.snapshot')).runs.find(value => value.id === run.id)?.status).toBe('canceled'); expect(posts).toBe(2);
});
