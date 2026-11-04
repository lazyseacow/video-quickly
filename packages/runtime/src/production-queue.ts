import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { pageInputSchema, productionQueueItemSchema, productionQueueSchema, type ProductionQueue, type ProductionQueueItem, type ProjectDocument, type RunRecord, type StoryWork } from '@video-quickly/contracts';
import { fingerprint } from './activities.js';
import { DocumentStore } from './database.js';

const terminal = new Set(['succeeded', 'canceled', 'skipped']);
const timestamp = () => new Date().toISOString();
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1500);
export function createProductionQueue({ database, store, project, work, busy, createRun, resumeRun, cancelRun, runConflict, changed }: {
  database: Database.Database; store: DocumentStore; project(id: string): ProjectDocument; work(id: string): StoryWork;
  busy(projectId: string, exceptItemId?: string): boolean; createRun(item: ProductionQueueItem): Promise<RunRecord>;
  resumeRun(runId: string): void; cancelRun(runId: string): Promise<unknown>; runConflict(runId: string): boolean; changed(): void;
}) {
  let stopped = false, dirty = false, task: Promise<void> | undefined;
  function get(id: string): ProductionQueue {
    const value = store.get('production-queue', id); if (!value) throw new Error('生产队列不存在。');
    return productionQueueSchema.parse(value);
  }
  function item(id: string): ProductionQueueItem {
    const value = store.get('production-queue-item', id); if (!value) throw new Error('排队项不存在。');
    return productionQueueItemSchema.parse(value);
  }
  function items(queueId: string): ProductionQueueItem[] {
    return (database.prepare("SELECT body FROM documents WHERE kind = 'production-queue-item' AND json_extract(body, '$.queueId') = ? ORDER BY json_extract(body, '$.position'), id").all(queueId) as { body: string }[]).map(row => productionQueueItemSchema.parse(JSON.parse(row.body)));
  }
  function running() {
    const row = database.prepare("SELECT body FROM documents WHERE kind = 'production-queue-item' AND json_extract(body, '$.status') = 'running' LIMIT 1").get() as { body: string } | undefined;
    return row ? productionQueueItemSchema.parse(JSON.parse(row.body)) : undefined;
  }
  function updateQueue(value: ProductionQueue, patch: Partial<ProductionQueue>) {
    if (fingerprint({ ...value, ...patch }) === fingerprint(value)) return value;
    const next = productionQueueSchema.parse({ ...value, ...patch, revision: value.revision + 1, updatedAt: timestamp() });
    store.put('production-queue', next.id, next); changed(); return next;
  }
  function updateItem(value: ProductionQueueItem, patch: Partial<ProductionQueueItem>) {
    const next = productionQueueItemSchema.parse({ ...value, ...patch, revision: value.revision + 1, updatedAt: timestamp() });
    store.put('production-queue-item', next.id, next); changed(); return next;
  }
  function requireRevision(value: { revision: number }, revision: number) { if (value.revision !== revision) throw new Error('生产队列已变化，请刷新后重试。'); }
  function block(value: ProductionQueueItem, error: string, status: 'needs_attention' | 'failed' | 'canceled' = 'needs_attention') {
    database.transaction(() => {
      updateItem(value, { status, error });
      const queue = get(value.queueId);
      if (queue.status !== 'canceled') updateQueue(queue, { status: 'needs_attention', error });
    })();
  }
  function reconcile() {
    const value = running(); if (!value) return;
    const run = value.runId ? store.get<RunRecord>('run', value.runId) : undefined;
    if (!run) { block(value, '关联运行缺失，请核对制作记录；不会自动创建替代运行。'); return; }
    if (run.status === 'succeeded') {
      if (runConflict(run.id)) { block(value, '项目在制作期间已修改，产物已保留。请查看步骤产物后处理此项。'); return; }
      updateItem(value, { status: 'succeeded', error: undefined }); return;
    }
    if (run.status === 'canceled') { block(value, '当前制作已停止，后续分集等待操作。', 'canceled'); return; }
    if (['failed', 'needs_attention', 'waiting_review'].includes(run.status) || run.status === 'queued' && run.error) block(value, run.error ?? '关联运行需要处理，请查看制作记录。', run.status === 'failed' ? 'failed' : 'needs_attention');
  }
  async function tick() {
    reconcile();
    if (running() || stopped) return;
    const queues = (database.prepare("SELECT body FROM documents WHERE kind = 'production-queue' AND json_extract(body, '$.status') IN ('running','paused') ORDER BY rowid").all() as { body: string }[]).map(row => productionQueueSchema.parse(JSON.parse(row.body)));
    for (const queue of queues) {
      const next = items(queue.id).find(value => !terminal.has(value.status));
      if (!next) { updateQueue(queue, { status: 'succeeded', error: undefined }); continue; }
      if (queue.status === 'paused') continue;
      if (next.status !== 'queued') { updateQueue(queue, { status: 'needs_attention', error: next.error ?? '请先处理当前排队项。' }); continue; }
      try {
        const current = project(next.projectId);
        if (work(queue.workId).archived || current.archived || current.episode?.workId !== queue.workId) throw new Error('作品或分集不可用，请恢复并核对分集关联。');
        if (current.revision !== next.projectRevision) throw new Error('排队后项目已修改，请核对并刷新此项输入。');
        await createRun(next);
      } catch (error) { block(item(next.id), reason(error)); }
      return;
    }
  }
  function notify() {
    if (stopped) return;
    dirty = true;
    if (task) return;
    task = Promise.resolve().then(async () => { while (dirty && !stopped) { dirty = false; await tick(); } }).finally(() => { task = undefined; if (dirty && !stopped) notify(); });
  }
  function activeForProject(projectId: string, exceptItemId = '') {
    const row = database.prepare("SELECT body FROM documents WHERE kind = 'production-queue-item' AND json_extract(body, '$.projectId') = ? AND json_extract(body, '$.status') IN ('queued','running','needs_attention','failed') AND id <> ? LIMIT 1").get(projectId, exceptItemId) as { body: string } | undefined;
    return row ? productionQueueItemSchema.parse(JSON.parse(row.body)) : undefined;
  }
  function claim(expected: ProductionQueueItem, runId: string) {
    const value = item(expected.id), queue = get(value.queueId); requireRevision(value, expected.revision);
    const current = project(value.projectId);
    if (queue.status !== 'running' || value.status !== 'queued' || value.runId || running() || items(queue.id).find(value => !terminal.has(value.status))?.id !== value.id) throw new Error('排队项已变化或暂停，未创建新的制作。');
    if (current.revision !== value.projectRevision || current.archived || current.episode?.workId !== queue.workId || work(queue.workId).archived) throw new Error('分集输入已变化，请重新核对排队项。');
    updateItem(value, { status: 'running', runId, error: undefined });
  }
  async function resumeItem(value: ProductionQueueItem) {
    const run = value.runId ? store.get<RunRecord>('run', value.runId) : undefined;
    if (!run || !['queued', 'failed', 'needs_attention', 'waiting_external', 'retry_scheduled'].includes(run.status)) throw new Error('请核对原运行；此项不会自动创建新运行。');
    database.transaction(() => {
      const latest = item(value.id); requireRevision(latest, value.revision);
      if (get(latest.queueId).status === 'canceled' || terminal.has(latest.status) || running() && running()!.id !== latest.id) throw new Error('队列已取消或另一个分集正在制作，请稍后处理。');
      if (busy(latest.projectId, latest.id) && !['queued','waiting_external','retry_scheduled'].includes(run.status)) throw new Error('项目存在其他未完成制作，请先处理。');
      updateItem(latest, { status: 'running', error: undefined });
      updateQueue(get(latest.queueId), { status: 'running', error: undefined });
    })();
    resumeRun(run.id); notify(); return get(value.queueId);
  }
  notify();
  return {
    notify, claim, activeForProject,
    async waitForIdle() { while (task) await task; },
    hasPending() { return Boolean(task || dirty); },
    close() { stopped = true; dirty = false; },
    async resumeOwnedRun(runId: string) {
      const row = database.prepare("SELECT body FROM documents WHERE kind = 'production-queue-item' AND json_extract(body, '$.runId') = ?").get(runId) as { body: string } | undefined;
      if (!row) throw new Error('排队项关联已丢失，请核对制作记录。');
      await resumeItem(productionQueueItemSchema.parse(JSON.parse(row.body))); return store.get<RunRecord>('run', runId);
    },
    async dispatch(method: string, params: unknown) {
      if (method === 'productionQueue.list') {
        const input = pageInputSchema.extend({ workId: z.string().optional() }).parse(params);
        const rows = database.prepare("SELECT rowid AS cursor, body FROM documents WHERE kind = 'production-queue' AND (? IS NULL OR json_extract(body, '$.workId') = ?) AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?").all(input.workId ?? null, input.workId ?? null, input.before ?? null, input.before ?? null, input.limit + 1) as { cursor: number; body: string }[];
        return { items: rows.slice(0, input.limit).map(row => productionQueueSchema.parse(JSON.parse(row.body))), nextCursor: rows.length > input.limit ? rows[input.limit - 1].cursor : null };
      }
      if (method === 'productionQueue.get') { const input = z.object({ queueId: z.string() }).parse(params); return { queue: get(input.queueId), items: items(input.queueId) }; }
      if (method === 'productionQueue.enqueue') {
        const input = z.object({ workId: z.string(), workRevision: z.number().int().positive(), requestId: z.string().uuid(), projects: z.array(z.object({ projectId: z.string(), revision: z.number().int().positive() })).min(1).max(100) }).parse(params);
        const receipt = database.transaction(() => {
          const previous = store.get<{ inputHash: string; queueId?: string; itemIds: string[]; reusedIds: string[] }>('production-queue-request', input.requestId);
          if (previous) { if (previous.inputHash !== fingerprint(input)) throw new Error('入队标识已用于不同输入，请使用新的标识。'); return previous; }
          const currentWork = work(input.workId); requireRevision(currentWork, input.workRevision);
          if (currentWork.archived) throw new Error('请先恢复作品。');
          if (new Set(input.projects.map(value => value.projectId)).size !== input.projects.length) throw new Error('入队项目不能重复。');
          const reused: ProductionQueueItem[] = [], projects: ProjectDocument[] = [];
          for (const reference of input.projects) {
            const value = project(reference.projectId), existing = activeForProject(value.id);
            if (value.episode?.workId !== currentWork.id || value.archived) throw new Error('请选择此作品的有效分集。');
            if (existing) { reused.push(existing); continue; }
            if (value.revision !== reference.revision) throw new Error('分集项目已修改，请刷新后再入队。');
            if (busy(value.id)) throw new Error('分集已有未完成运行，请先完成或停止现有运行。');
            projects.push(value);
          }
          const created = timestamp(), queueId = projects.length ? randomUUID() : undefined;
          if (queueId) store.put('production-queue', queueId, productionQueueSchema.parse({ id: queueId, workId: currentWork.id, revision: 1, status: 'paused', createdAt: created, updatedAt: created }));
          const queued = projects.map((value, position) => productionQueueItemSchema.parse({ id: randomUUID(), queueId, projectId: value.id, projectRevision: value.revision, revision: 1, position, episodeNumber: value.episode!.number, title: value.title, status: 'queued', createdAt: created, updatedAt: created }));
          for (const value of queued) store.put('production-queue-item', value.id, value);
          const receipt = { inputHash: fingerprint(input), queueId, itemIds: queued.map(value => value.id), reusedIds: reused.map(value => value.id) };
          store.put('production-queue-request', input.requestId, receipt); return receipt;
        })(); changed();
        return { queue: receipt.queueId ? get(receipt.queueId) : null, items: receipt.itemIds.map(item), reused: receipt.reusedIds.map(item) };
      }
      if (['productionQueue.start', 'productionQueue.pause', 'productionQueue.cancel'].includes(method)) {
        const input = z.object({ queueId: z.string(), revision: z.number().int().positive() }).parse(params);
        const result = database.transaction(() => {
          const value = get(input.queueId); requireRevision(value, input.revision);
          if (['canceled','succeeded'].includes(value.status)) throw new Error('队列已结束，请创建新的队列。');
          if (method === 'productionQueue.start') {
            if (items(value.id).some(value => ['needs_attention','failed'].includes(value.status))) throw new Error('请先处理需要核对的排队项。');
            return updateQueue(value, { status: 'running', error: undefined });
          }
          if (method === 'productionQueue.cancel') for (const pending of items(value.id).filter(value => !terminal.has(value.status) && value.status !== 'running')) updateItem(pending, { status: 'canceled' });
          return updateQueue(value, { status: method === 'productionQueue.pause' ? 'paused' : 'canceled', error: undefined });
        })(); notify(); return result;
      }
      const input = z.object({ itemId: z.string(), revision: z.number().int().positive(), projectRevision: z.number().int().positive().optional() }).parse(params), value = item(input.itemId); requireRevision(value, input.revision);
      if (method === 'productionQueue.stopCurrent') {
        if (!value.runId || value.status !== 'running') throw new Error('此项当前没有正在执行的制作。');
        return cancelRun(value.runId);
      }
      if (method === 'productionQueue.resumeItem') return resumeItem(value);
      if (method === 'productionQueue.refreshItem' || method === 'productionQueue.skipItem') {
        const result = database.transaction(() => {
          const queue = get(value.queueId);
          if (terminal.has(value.status) || value.status === 'running' || queue.status === 'canceled') throw new Error('此排队项已经结束或仍在运行。');
          if (method === 'productionQueue.skipItem') updateItem(value, { status: 'skipped', error: undefined });
          else {
            if (value.runId) throw new Error('此项已有关联运行，请继续原运行或跳过；刷新不会重建已提交任务。');
            const current = project(value.projectId);
            if (current.revision !== input.projectRevision || current.archived || current.episode?.workId !== queue.workId) throw new Error('请读取当前分集修订后再刷新输入。');
            updateItem(value, { projectRevision: current.revision, title: current.title, episodeNumber: current.episode.number, status: 'queued', error: undefined });
          }
          updateQueue(queue, { status: 'paused', error: undefined }); return item(value.id);
        })(); notify(); return result;
      }
      throw new Error('未知生产队列操作。');
    },
  };
}
