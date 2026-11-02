import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordPageSchema, runSummarySchema, type RunRecord } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src';
import { DocumentStore, openDatabase } from '../packages/runtime/src/database';
import { seedLargeWorkspace } from './fixtures/large-workspace';

const fixtures: Array<{ directory: string; database: ReturnType<typeof openDatabase>; runtime: ReturnType<typeof createRuntime> }> = [];
afterEach(async () => {
  for (const { directory, database, runtime } of fixtures.splice(0)) { await runtime.close(); database.close(); await rm(directory, { recursive: true, force: true }); }
});
const pageSchema = recordPageSchema(runSummarySchema);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-run-history-filters-')), database = openDatabase(directory), store = new DocumentStore(database);
  const first = seedLargeWorkspace(store, 10, { assets: 0, runs: 0, eventsPerRun: 0 }), other = seedLargeWorkspace(store, 11, { assets: 0, runs: 0, eventsPerRun: 0 });
  function put(id: string, createdAt: string, status: RunRecord['status'] = 'failed', projectId = first.id) {
    const run: RunRecord = { id, projectId, projectRevision: 1, workflowVersion: 1, snapshotDigest: 'history-filter-fixture', status, createdAt, updatedAt: createdAt, events: [], activities: [] };
    store.put('run', id, run); return run;
  }
  put('before-start', '2026-03-08T04:59:59.999Z');
  put('at-start', '2026-03-08T05:00:00.000Z');
  put('inside-without-milliseconds', '2026-03-08T17:30:00Z');
  put('at-end', '2026-03-09T04:00:00.000Z');
  put('different-status', '2026-03-08T17:30:00.000Z', 'succeeded');
  put('different-project', '2026-03-08T17:30:00.000Z', 'failed', other.id);
  const runtime = createRuntime({ dataDirectory: directory, seed: false }); fixtures.push({ directory, database, runtime });
  return { database, store, runtime, first, other, put };
}

describe('run-history filters', () => {
  it('combines project, status and half-open UTC dates before cursor pagination', async () => {
    const { runtime, first, put } = await fixture();
    const filter = { projectId: first.id, status: 'failed', createdAfter: '2026-03-08T05:00:00Z', createdBefore: '2026-03-09T04:00:00Z', limit: 1 };
    const page = pageSchema.parse(await runtime.dispatch('run.list', filter));
    expect(page.items.map(run => run.id)).toEqual(['inside-without-milliseconds']); expect(page.nextCursor).not.toBeNull();
    put('newer-insert', '2026-03-08T20:00:00.000Z');
    const next = pageSchema.parse(await runtime.dispatch('run.list', { ...filter, before: page.nextCursor }));
    expect(next.items.map(run => run.id)).toEqual(['at-start']); expect(next.nextCursor).toBeNull();
    const refreshed = pageSchema.parse(await runtime.dispatch('run.list', { ...filter, limit: 100 }));
    expect(refreshed.items.map(run => run.id)).toEqual(['newer-insert', 'inside-without-milliseconds', 'at-start']);
  });

  it('preserves unfiltered calls and supports either date bound and empty results', async () => {
    const { runtime, first } = await fixture();
    expect(pageSchema.parse(await runtime.dispatch('run.list', {})).items).toHaveLength(6);
    expect(pageSchema.parse(await runtime.dispatch('run.list', { projectId: first.id })).items).toHaveLength(5);
    expect(pageSchema.parse(await runtime.dispatch('run.list', { status: 'succeeded' })).items.map(run => run.id)).toEqual(['different-status']);
    expect(pageSchema.parse(await runtime.dispatch('run.list', { createdBefore: '2026-03-08T05:00:00Z' })).items.map(run => run.id)).toEqual(['before-start']);
    expect(pageSchema.parse(await runtime.dispatch('run.list', { createdAfter: '2026-03-09T04:00:00Z' })).items.map(run => run.id)).toEqual(['at-end']);
    expect(pageSchema.parse(await runtime.dispatch('run.list', { projectId: first.id, status: 'canceled' }))).toEqual({ items: [], nextCursor: null });
    for (const createdAfter of ['2026-03-08T05:00:00Z', '2026-03-08T05:00:00.0Z', '2026-03-08T05:00:00.00Z', '2026-03-08T05:00:00.000Z']) {
      const page = pageSchema.parse(await runtime.dispatch('run.list', { projectId: first.id, status: 'failed', createdAfter, createdBefore: '2026-03-09T04:00:00Z' }));
      expect(page.items.map(run => run.id)).toEqual(['inside-without-milliseconds', 'at-start']);
    }
    expect(pageSchema.parse(await runtime.dispatch('run.list', { projectId: first.id, status: 'failed', createdAfter: '2026-03-08T05:00:00.001Z', createdBefore: '2026-03-08T17:30:00Z' })).items).toEqual([]);
  });

  it('rejects invalid statuses, non-UTC instants and empty or reversed intervals before reading', async () => {
    const { runtime } = await fixture();
    for (const input of [
      { status: "failed' OR 1=1--" }, { createdAfter: 'not-a-date' }, { createdAfter: '2026-02-30T00:00:00Z' },
      { createdAfter: '2026-03-08T05:00Z' },
      { createdAfter: '2026-03-08T05:00:00.0001Z' }, { createdBefore: '2026-03-09T04:00:00.0000Z' },
      { createdBefore: '2026-03-08T06:00:00+01:00' },
      { createdAfter: '2026-03-08T05:00:00Z', createdBefore: '2026-03-08T05:00:00.000Z' },
      { createdAfter: '2026-03-09T04:00:00Z', createdBefore: '2026-03-08T05:00:00Z' },
    ]) await expect(runtime.dispatch('run.list', input)).rejects.toThrow();
  });

  it('uses the existing project index for the actual filtered query and binds opaque project IDs', async () => {
    const { runtime, database, first } = await fixture();
    const prepared = vi.spyOn(Object.getPrototypeOf(database) as Pick<typeof database, 'prepare'>, 'prepare');
    const executions = vi.spyOn(Object.getPrototypeOf(database.prepare('SELECT 1')) as ReturnType<typeof database.prepare>, 'all');
    let sql: string;
    let bindings: unknown[];
    try {
      await runtime.dispatch('run.list', { projectId: first.id, status: 'failed' });
      const queries = prepared.mock.calls.map(([query]) => query).filter(query => query.startsWith('SELECT rowid AS cursor, body FROM documents'));
      expect(queries).toHaveLength(1); sql = queries[0];
      const calls = executions.mock.calls.filter((_args, index) => executions.mock.contexts[index]?.source === sql);
      expect(calls).toHaveLength(1); bindings = calls[0];
    } finally { executions.mockRestore(); prepared.mockRestore(); }
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as { detail: string }[];
    expect(plan.some(row => row.detail.includes('documents_project') && row.detail.includes('<expr>=?'))).toBe(true);
    expect(plan.some(row => /USE TEMP B-TREE|SCAN documents/.test(row.detail))).toBe(false);
    expect(pageSchema.parse(await runtime.dispatch('run.list', { projectId: "' OR 1=1--", status: 'failed' }))).toEqual({ items: [], nextCursor: null });
  });
});
