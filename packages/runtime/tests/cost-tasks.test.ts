import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { costSummarySchema, costTaskDetailSchema, costTaskSchema, recordPageSchema, type ModelProfile, type UsageRecord } from '@video-quickly/contracts';
import { createCostLedger } from '../src/costs';
import { DocumentStore, openDatabase } from '../src/database';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const model: ModelProfile = { id: 'model', name: '画面模型', provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'image-fixture', capabilities: ['image'], parameters: {}, pricing: { currency: 'USD', perImage: .1 }, enabled: true, hasSecret: false, createdAt: '', updatedAt: '' };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-cost-tasks-')); directories.push(directory);
  const database = openDatabase(directory), store = new DocumentStore(database), ledger = createCostLedger({ database, store });
  function charge(runId: string, nodeId: string, projectId = 'project', selected = model, images?: number) {
    const first = ledger.begin({ runId, projectId, nodeId, shotId: 'shot', operationId: `${runId}:${nodeId}`, model: selected, capability: 'image', requestMetrics: { source: 'request', images } });
    return ledger.status(first.operationId, 'completed')!;
  }
  return { database, store, ledger, charge };
}

it('paginates whole task archives with stable cursors even when old tasks receive newer charges', async () => {
  const { database, ledger, charge } = await fixture();
  try {
    charge('old', 'first', 'project', model, 2);
    charge('new', 'first', 'project', model, 1);
    charge('old', 'second', 'project', model, 3);
    const pageSchema = recordPageSchema(costTaskSchema);
    const first = pageSchema.parse(ledger.dispatch('cost.tasks', { limit: 1 }));
    expect(first.items.map(task => task.id)).toEqual(['new']); expect(first.nextCursor).not.toBeNull();
    charge('newest', 'first', 'other-project', model, 1);
    charge('old', 'third', 'project', model, 4);
    const older = pageSchema.parse(ledger.dispatch('cost.tasks', { limit: 1, before: first.nextCursor }));
    expect(older.items).toHaveLength(1); expect(older.items[0]).toMatchObject({ id: 'old', summary: { total: 3, currencies: [{ currency: 'USD', estimatedAmount: .9, estimatedRecords: 3 }] } });
    expect(older.nextCursor).toBeNull();
    expect(pageSchema.parse(ledger.dispatch('cost.tasks', { projectId: 'other-project' })).items.map(task => task.id)).toEqual(['newest']);
    expect(pageSchema.parse(ledger.dispatch('cost.tasks', { projectId: 'missing' })).items).toEqual([]);
    expect(() => ledger.dispatch('cost.tasks', { limit: 101 })).toThrow();
  } finally { database.close(); }
});

it('keeps currency totals and unknown measurements separate, retaining confirmed zeroes', async () => {
  const { database, ledger, charge } = await fixture();
  try {
    const dollar = charge('task', 'usd', 'project', model, 2);
    charge('task', 'cny', 'project', { ...model, pricing: { currency: 'CNY', perImage: 3 } }, 1);
    charge('task', 'unknown');
    const zero = charge('task', 'zero', 'project', { ...model, pricing: { currency: 'USD', perImage: 0 } }, 4);
    ledger.dispatch('cost.update', { id: dollar.id, revision: dollar.revision, actualAmount: 5, actualCurrency: 'CNY' });
    ledger.dispatch('cost.update', { id: zero.id, revision: zero.revision, actualAmount: 0, actualCurrency: 'USD' });
    const task = costTaskDetailSchema.parse(ledger.dispatch('cost.task.get', { runId: 'task' }));
    expect(task.summary).toEqual({ total: 4, unknownEstimated: 1, unknownActual: 2, unknownSubmissions: 0, currencies: [
      { currency: 'USD', estimatedAmount: .2, estimatedRecords: 2, actualAmount: 0, actualRecords: 1 },
      { currency: 'CNY', estimatedAmount: 3, estimatedRecords: 1, actualAmount: 5, actualRecords: 1 },
    ] });
    expect(costSummarySchema.parse(ledger.dispatch('cost.summary', { runId: 'task' }))).toEqual(task.summary);
    expect(costSummarySchema.parse(ledger.dispatch('cost.summary', { projectId: 'missing' }))).toMatchObject({ total: 0, unknownEstimated: 0, currencies: [] });
  } finally { database.close(); }
});

it('reads frozen task, step and shot identities without exposing prompts or model secrets', async () => {
  const { database, ledger, store, charge } = await fixture();
  try {
    charge('task', 'regenerate', 'project', model, 1);
    store.put('run', 'task', { id: 'task', projectId: 'project', projectRevision: 7, workflowVersion: 3, status: 'succeeded', createdAt: '2026-10-30T00:00:00Z', parentRunId: 'original' });
    store.put('run-snapshot', 'task', { project: { title: '生成时的项目', workflow: { name: '制作流程' }, shots: [{ id: 'shot', title: '生成时的镜头', narration: 'private-captured-content' }] }, nodes: [{ id: 'regenerate', label: '镜头画面再生成', prompt: 'private-captured-content' }], models: [{ parameters: { token: 'private-captured-content' } }] });
    store.put('project-summary', 'project', { title: '改名后的项目' });
    const task = costTaskDetailSchema.parse(ledger.dispatch('cost.task.get', { runId: 'task' }));
    expect(task).toMatchObject({ id: 'task', projectTitle: '生成时的项目', title: '镜头画面再生成', status: 'succeeded', projectRevision: 7, workflowVersion: 3, parentRunId: 'original', nodes: [{ id: 'regenerate', label: '镜头画面再生成' }], shots: [{ id: 'shot', title: '生成时的镜头' }] });
    expect(JSON.stringify(task)).not.toContain('private-captured-content');
    store.delete('run', 'task'); store.delete('run-snapshot', 'task');
    const retained = costTaskDetailSchema.parse(ledger.dispatch('cost.task.get', { runId: 'task' }));
    expect(retained.runAvailable).toBe(false); expect(retained.summary.total).toBe(1); expect(retained.nodes).toEqual([]);
    expect(() => ledger.dispatch('cost.task.get', { runId: 'not-a-task' })).toThrow('不存在');
  } finally { database.close(); }
});
