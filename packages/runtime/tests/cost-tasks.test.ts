import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { costSummarySchema, costTaskDetailSchema, costTaskSchema, recordPageSchema, usageRecordSchema, type ModelProfile } from '@video-quickly/contracts';
import { createCostLedger } from '../src/costs';
import { DocumentStore, openDatabase } from '../src/database';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const model: ModelProfile = { id: 'model', name: '画面模型', provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'image-fixture', connectionType: 'image', capabilities: ['image'], parameters: {}, pricing: { currency: 'USD', perImage: .1 }, enabled: true, hasSecret: false, createdAt: '', updatedAt: '' };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-cost-tasks-')); directories.push(directory);
  const database = openDatabase(directory), store = new DocumentStore(database), ledger = createCostLedger({ database, store });
  function charge(runId: string, nodeId: string, projectId = 'project', selected = model, images?: number) {
    const first = ledger.begin({ runId, projectId, nodeId, shotId: 'shot', operationId: `${runId}:${nodeId}`, model: selected, capability: 'image', requestMetrics: { source: 'request', images } });
    return ledger.status(first.operationId, 'completed', images === undefined ? undefined : { source: 'provider', inputTokens: images * 100, outputTokens: images * 10, cachedInputTokens: 0, cachedOutputTokens: 0 })!;
  }
  return { database, store, ledger, charge, directory };
}

it('paginates whole task archives with stable cursors even when old tasks receive newer charges', async () => {
  const { database, ledger, charge } = await fixture();
  try {
    charge('old', 'first', 'project', model, 2);
    charge('new', 'first', 'project', model, 1);
    charge('old', 'second', 'project', model, 3);
    const pageSchema = recordPageSchema(costTaskSchema);
    const prepared = vi.spyOn(database, 'prepare');
    let first: ReturnType<typeof pageSchema.parse>, taskQuery: string;
    try {
      first = pageSchema.parse(ledger.dispatch('cost.tasks', { limit: 1 }));
      [taskQuery] = prepared.mock.calls[0];
    } finally { prepared.mockRestore(); }
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${taskQuery}`).all({ scope: 'all', limit: 2 }) as { detail: string }[];
    expect(plan.some(row => row.detail.includes('SEARCH cost_task_order USING PRIMARY KEY'))).toBe(true);
    expect(plan.some(row => row.detail.includes('SEARCH u USING INDEX documents_usage_run'))).toBe(true);
    expect(first.items.map(task => task.id)).toEqual(['new']); expect(first.nextCursor).not.toBeNull();
    charge('newest', 'first', 'other-project', model, 1);
    charge('old', 'third', 'project', model, 4);
    const older = pageSchema.parse(ledger.dispatch('cost.tasks', { limit: 1, before: first.nextCursor }));
    expect(older.items).toHaveLength(1); expect(older.items[0]).toMatchObject({ id: 'old', summary: { total: 3, tokens: { inputTokens: 900, outputTokens: 90, cachedInputTokens: 0, cachedOutputTokens: 0 }, currencies: [] } });
    expect(older.nextCursor).toBeNull();
    expect(pageSchema.parse(ledger.dispatch('cost.tasks', { projectId: 'other-project' })).items.map(task => task.id)).toEqual(['newest']);
    expect(pageSchema.parse(ledger.dispatch('cost.tasks', { projectId: 'missing' })).items).toEqual([]);
    expect(() => ledger.dispatch('cost.tasks', { limit: 101 })).toThrow();
  } finally { database.close(); }
});

it('keeps currency totals and unknown measurements separate, retaining confirmed zeroes', async () => {
  const { database, ledger, store, charge } = await fixture();
  try {
    const dollar = charge('task', 'usd', 'project', model, 2);
    const yuan = charge('task', 'cny', 'project', { ...model, pricing: { currency: 'CNY', perImage: 3 } }, 1);
    charge('task', 'unknown');
    const zero = charge('task', 'zero', 'project', { ...model, pricing: { currency: 'USD', perImage: 0 } }, 4);
    for (const [record, pricing, estimatedAmount] of [[dollar, model.pricing, .2], [yuan, { currency: 'CNY', perImage: 3 }, 3], [zero, { currency: 'USD', perImage: 0 }, 0]] as const) store.put('usage-record', record.id, { ...record, pricing, estimatedAmount });
    ledger.dispatch('cost.update', { id: dollar.id, revision: dollar.revision, actualAmount: 5, actualCurrency: 'CNY' });
    ledger.dispatch('cost.update', { id: zero.id, revision: zero.revision, actualAmount: 0, actualCurrency: 'USD' });
    const task = costTaskDetailSchema.parse(ledger.dispatch('cost.task.get', { runId: 'task' }));
    expect(task.summary).toMatchObject({ total: 4, unknownEstimated: 1, unknownActual: 2, unknownSubmissions: 0, currencies: [
      { currency: 'USD', estimatedAmount: .2, estimatedRecords: 2, actualAmount: 0, actualRecords: 1 },
      { currency: 'CNY', estimatedAmount: 3, estimatedRecords: 1, actualAmount: 5, actualRecords: 1 },
    ] });
    expect(costSummarySchema.parse(ledger.dispatch('cost.summary', { runId: 'task' }))).toEqual(task.summary);
    expect(costSummarySchema.parse(ledger.dispatch('cost.summary', {}))).toEqual(task.summary);
    expect(costSummarySchema.parse(ledger.dispatch('cost.summary', { projectId: 'missing' }))).toMatchObject({ total: 0, unknownEstimated: 0, currencies: [] });
  } finally { database.close(); }
});

it('refreshes only changed overview subtotals across connections and preserves small corrected totals', async () => {
  const { database, ledger, charge, directory } = await fixture();
  const writer = openDatabase(directory), writerStore = new DocumentStore(writer);
  try {
    const prepared = vi.spyOn(writer, 'prepare');
    let writerLedger: ReturnType<typeof createCostLedger>, cachedSql: string | undefined;
    try {
      writerLedger = createCostLedger({ database: writer, store: writerStore });
      cachedSql = prepared.mock.calls.find(([sql]) => sql.includes('cost-overview-summary'))?.[0];
    } finally { prepared.mockRestore(); }
    expect(cachedSql).toBeDefined();
    const cachedPlan = writer.prepare(`EXPLAIN QUERY PLAN ${cachedSql}`).all() as { detail: string }[];
    expect(cachedPlan.some(row => row.detail.includes('USING COVERING INDEX cost_task_overview_pending'))).toBe(true);
    const small = charge('small', 'first', 'project', model, 1), large = charge('large', 'first');
    ledger.dispatch('cost.update', { id: small.id, revision: small.revision, actualAmount: 0.01, actualCurrency: 'USD' });
    const paid = usageRecordSchema.parse(ledger.dispatch('cost.update', { id: large.id, revision: large.revision, actualAmount: 1e16, actualCurrency: 'USD' }));
    const overview = () => costSummarySchema.parse(ledger.dispatch('cost.summary', {}));
    const pending = () => database.prepare("SELECT run_id FROM cost_task_order WHERE scope = 'all' AND overview_pending = 1 ORDER BY run_id").pluck().all();
    const first = overview();
    expect(first).toMatchObject({ total: 2, tokens: { cachedInputTokens: 0 }, currencies: [{ currency: 'USD', actualRecords: 2 }] });
    expect(writerLedger.dispatch('cost.summary', {})).toEqual(first);
    expect(pending()).toEqual([]);

    const reads = vi.spyOn(database, 'prepare');
    let rebuildSql: string | undefined;
    try {
      expect(overview().total).toBe(2);
      expect(reads).not.toHaveBeenCalled();
      expect(database.inTransaction).toBe(false);

      writerLedger.dispatch('cost.update', { id: paid.id, revision: paid.revision, actualAmount: 0, actualCurrency: 'CNY' });
      expect(pending()).toEqual(['large']);
      reads.mockClear();
      expect(overview()).toEqual(ledger.dispatch('cost.summary', { projectId: 'project' }));
      expect(overview().currencies).toMatchObject([
        { currency: 'USD', actualAmount: 0.01, actualRecords: 1 },
        { currency: 'CNY', actualAmount: 0, actualRecords: 1 },
      ]);
      const overviewReads = reads.mock.calls.map(([sql]) => sql).filter(sql => sql.includes('FROM cost_task_order'));
      expect(overviewReads).toHaveLength(1);
      [rebuildSql] = overviewReads;
    } finally { reads.mockRestore(); }
    expect(rebuildSql).toBeDefined();
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${rebuildSql}`).all() as { detail: string }[];
    expect(plan.some(row => row.detail.includes('SEARCH p USING INDEX cost_task_overview_pending'))).toBe(true);
    expect(plan.some(row => row.detail.includes('SEARCH u USING INDEX documents_usage_run'))).toBe(true);
    expect(pending()).toEqual([]);

    expect(writer.transaction(() => {
      writerStore.delete('usage-record', small.id);
      throw new Error('roll back overview invalidation');
    })).toThrow('roll back overview invalidation');
    expect(pending()).toEqual([]);
    expect(overview().total).toBe(2);

    writerStore.delete('usage-record', small.id);
    expect(pending()).toEqual(['small']);
    const remaining = overview();
    expect(remaining).toMatchObject({ total: 1, currencies: [{ currency: 'CNY', actualAmount: 0, actualRecords: 1 }] });
    expect(remaining.tokens).toEqual({});
    expect(pending()).toEqual([]);

    const submission = ledger.begin({ runId: 'large', projectId: 'project', nodeId: 'second', operationId: 'large:second', model, capability: 'image', requestMetrics: { source: 'request' } });
    expect(pending()).toEqual(['large']);
    expect(overview().unknownSubmissions).toBe(1);
    ledger.status(submission.operationId, 'completed', { source: 'provider', inputTokens: 0 });
    expect(overview()).toMatchObject({ total: 2, unknownSubmissions: 0, tokens: { inputTokens: 0 }, tokenRecords: { inputTokens: 1 } });
  } finally { writer.close(); database.close(); }
});

it('keeps decimal estimates and actual amounts exact through repeated currency corrections', async () => {
  const { database, ledger, store, charge } = await fixture();
  try {
    const first = charge('first', 'charge'), second = charge('second', 'charge');
    store.put('usage-record', first.id, { ...first, pricing: { currency: 'USD' }, estimatedAmount: 1e-7, actualAmount: 0.1, actualCurrency: 'USD' });
    let current = usageRecordSchema.parse({ ...second, pricing: { currency: 'USD' }, estimatedAmount: 2e-7, actualAmount: 0.2, actualCurrency: 'USD' });
    store.put('usage-record', second.id, current);
    const currencies = () => costSummarySchema.parse(ledger.dispatch('cost.summary', {})).currencies;
    expect(currencies()).toEqual([{ currency: 'USD', estimatedAmount: 3e-7, estimatedRecords: 2, actualAmount: 0.3, actualRecords: 2 }]);

    for (let index = 0; index < 3; index++) {
      current = usageRecordSchema.parse(ledger.dispatch('cost.update', { id: current.id, revision: current.revision, actualAmount: 1.23456789e-10, actualCurrency: 'CNY' }));
      expect(currencies()).toMatchObject([
        { currency: 'USD', estimatedAmount: 3e-7, actualAmount: 0.1, actualRecords: 1 },
        { currency: 'CNY', estimatedRecords: 0, actualAmount: 1.23456789e-10, actualRecords: 1 },
      ]);
      current = usageRecordSchema.parse(ledger.dispatch('cost.update', { id: current.id, revision: current.revision, actualAmount: 0.2, actualCurrency: 'USD' }));
      expect(currencies()).toEqual([{ currency: 'USD', estimatedAmount: 3e-7, estimatedRecords: 2, actualAmount: 0.3, actualRecords: 2 }]);
    }
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
