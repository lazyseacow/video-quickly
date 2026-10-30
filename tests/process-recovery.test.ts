import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectDocument, RunInspection, RunPlan, RunRecord, WorkspaceSnapshot } from '@video-quickly/contracts';

const directories: string[] = [];
const children: RpcProcess[] = [];
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
      const timeout = setTimeout(() => { this.waiting.delete(id); reject(new Error(`RPC 超时：${method}`)); }, 15000);
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
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = await process.request<WorkspaceSnapshot>('workspace.snapshot');
    const run = snapshot.runs.find(run => run.id === runId);
    if (run?.status === status) return run;
    if (run?.status === 'failed') throw new Error(run.error ?? '运行失败');
    await delay(25);
  }
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
