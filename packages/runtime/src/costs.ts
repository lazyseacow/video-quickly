import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { costRequestMetricsSchema, costSummarySchema, tokenMetrics, getModelPlatform, costTaskDetailSchema, costTaskSchema, currencySchema, providerUsageSchema, requestModelParameters, usageRecordSchema, type CostRequestMetrics, type CostSummary, type ModelCapability, type ModelPricing, type ModelProfile, type ProjectDocument, type ProviderUsage, type UsageRecord, type TokenMetric, type WorkflowNode } from '@video-quickly/contracts';
import { DocumentStore } from './database.js';

type CurrencyMetric = 'estimatedAmount' | 'actualAmount' | 'estimatedRecords' | 'actualRecords';
type SummaryRow = { total: number; unknownEstimated: number | null; unknownActual: number | null; unknownSubmissions: number | null } & Record<`${ModelPricing['currency']}_${CurrencyMetric}`, number | null> & Record<TokenMetric | `${TokenMetric}Records`, number | null>;
type TaskRow = SummaryRow & { cursor: number; id: string; projectId: string; projectTitle: string; title: string; createdAt: string; updatedAt: string; status: string | null; projectRevision: number | null; workflowVersion: number | null; runAvailable: number };

const summaryColumns = `count(*) AS total,
  ${tokenMetrics.flatMap(key => [`sum(json_extract(u.body, '$.providerUsage.${key}')) AS ${key}`, `count(json_extract(u.body, '$.providerUsage.${key}')) AS ${key}Records`]).join(', ')},
  sum(json_extract(u.body, '$.estimatedAmount') IS NULL) AS unknownEstimated,
  sum(json_extract(u.body, '$.actualAmount') IS NULL) AS unknownActual,
  sum(json_extract(u.body, '$.status') IN ('submitted','unknown','canceled')) AS unknownSubmissions,
  ${currencySchema.options.flatMap(currency => [
    `sum(CASE WHEN json_extract(u.body, '$.pricing.currency') = '${currency}' THEN json_extract(u.body, '$.estimatedAmount') END) AS ${currency}_estimatedAmount`,
    `count(CASE WHEN json_extract(u.body, '$.pricing.currency') = '${currency}' THEN json_extract(u.body, '$.estimatedAmount') END) AS ${currency}_estimatedRecords`,
    `sum(CASE WHEN json_extract(u.body, '$.actualCurrency') = '${currency}' THEN json_extract(u.body, '$.actualAmount') END) AS ${currency}_actualAmount`,
    `count(CASE WHEN json_extract(u.body, '$.actualCurrency') = '${currency}' THEN json_extract(u.body, '$.actualAmount') END) AS ${currency}_actualRecords`,
  ]).join(', ')}`;

function summarize(row: SummaryRow): CostSummary {
  const currencies = currencySchema.options.flatMap(currency => {
    const estimatedRecords = row[`${currency}_estimatedRecords`] ?? 0, actualRecords = row[`${currency}_actualRecords`] ?? 0;
    return estimatedRecords || actualRecords ? [{ currency, estimatedRecords, actualRecords, estimatedAmount: row[`${currency}_estimatedAmount`] ?? undefined, actualAmount: row[`${currency}_actualAmount`] ?? undefined }] : [];
  });
  return costSummarySchema.parse({ total: row.total, unknownEstimated: row.unknownEstimated ?? 0, unknownActual: row.unknownActual ?? 0, unknownSubmissions: row.unknownSubmissions ?? 0, currencies, tokens: Object.fromEntries(tokenMetrics.flatMap(key => row[key] === null ? [] : [[key, row[key]]])), tokenRecords: Object.fromEntries(tokenMetrics.map(key => [key, row[`${key}Records`] ?? 0])) });
}

export interface CostStart {
  operationId: string; runId: string; nodeId: string; shotId?: string; projectId: string;
  model: ModelProfile; capability: ModelCapability; requestMetrics: CostRequestMetrics;
}

export function requestCostMetrics(project: ProjectDocument, node: WorkflowNode, model: ModelProfile): CostRequestMetrics {
  const base: CostRequestMetrics = { source: 'request', requestCount: 1 };
  if (node.config.operation === 'transcribe') return base;
  if (!['assets', 'voice', 'animation'].includes(node.kind)) return base;
  // Locked shots may reuse existing receipts or assets. Without submission evidence, do not count them as requests.
  if (project.shots.some(shot => shot.locked)) return { source: 'request' };
  const count = project.shots.length;
  if (node.kind === 'assets') return { source: 'request', requestCount: count, images: count };
  if (node.kind === 'voice') return { source: 'request', requestCount: count, characters: project.shots.reduce((total, shot) => total + Array.from(shot.narration).length, 0) };
  const parameters = requestModelParameters(model, 'video');
  const configured = model.provider === 'openai-compatible' ? parameters.seconds : model.provider === 'seedance' ? parameters.duration : undefined;
  let duration: number | undefined;
  if (model.provider !== 'custom-http' && model.provider !== 'comfyui') {
    if (configured !== undefined) { const seconds = Number(configured); if (Number.isFinite(seconds) && seconds > 0) duration = seconds * count; }
    else duration = project.shots.reduce((total, shot) => total + Math.max(1, Math.ceil(shot.durationUs / 1_000_000)), 0);
  }
  return { source: 'request', requestCount: count, ...(duration !== undefined ? { videoSeconds: duration } : {}) };
}

export function createCostLedger(options: { database: Database.Database; store: DocumentStore; onChanged?: () => void }) {
  const { database, store } = options;
  const idFor = (operationId: string) => `usage-${createHash('sha256').update(operationId).digest('hex')}`;
  function save(record: UsageRecord) { store.put('usage-record', record.id, usageRecordSchema.parse(record)); options.onChanged?.(); return record; }
  function get(operationId: string): UsageRecord | undefined {
    const value = store.get('usage-record', idFor(operationId));
    return value ? usageRecordSchema.parse(value) : undefined;
  }
  function status(operationId: string, next: UsageRecord['status'], usage?: ProviderUsage) {
    const current = get(operationId);
    if (!current || current.status === 'completed' && next !== 'completed') return current;
    const providerUsage = usage ? providerUsageSchema.parse(usage) : current.providerUsage;
    if (current.status === next && JSON.stringify(current.providerUsage) === JSON.stringify(providerUsage)) return current;
    return save({ ...current, providerUsage, status: next, revision: current.revision + 1, updatedAt: new Date().toISOString() });
  }

  // A prior process can no longer prove whether a submitted request reached its provider.
  const orphaned = database.prepare("SELECT body FROM documents WHERE kind = 'usage-record' AND json_extract(body, '$.status') = 'submitted'").all() as { body: string }[];
  for (const row of orphaned) { const record = usageRecordSchema.parse(JSON.parse(row.body)); status(record.operationId, 'unknown'); }

  function tasks(projectId?: string, runId?: string, before?: number, limit = 20) {
    // A task's first ledger row is a stable cursor. Filter after grouping so older pages retain every charge.
    return database.prepare(`WITH grouped AS (
      SELECT min(u.rowid) AS cursor, json_extract(u.body, '$.runId') AS id,
        min(json_extract(u.body, '$.projectId')) AS projectId,
        min(json_extract(u.body, '$.createdAt')) AS createdAt, max(json_extract(u.body, '$.updatedAt')) AS updatedAt,
        ${summaryColumns}
      FROM documents u WHERE u.kind = 'usage-record'
        AND (? IS NULL OR json_extract(u.body, '$.projectId') = ?)
        AND (? IS NULL OR json_extract(u.body, '$.runId') = ?)
      GROUP BY json_extract(u.body, '$.runId')
    ) SELECT g.*, coalesce(json_extract(s.body, '$.project.title'), json_extract(p.body, '$.title'), '项目制作') AS projectTitle,
      coalesce(CASE WHEN json_array_length(s.body, '$.nodes') = 1 THEN json_extract(s.body, '$.nodes[0].label') ELSE json_extract(s.body, '$.project.workflow.name') END, '制作任务') AS title,
      coalesce(json_extract(r.body, '$.createdAt'), g.createdAt) AS taskCreatedAt,
      json_extract(r.body, '$.status') AS status, json_extract(r.body, '$.projectRevision') AS projectRevision,
      json_extract(r.body, '$.workflowVersion') AS workflowVersion, r.id IS NOT NULL AS runAvailable
    FROM grouped g LEFT JOIN documents r ON r.kind = 'run' AND r.id = g.id
      LEFT JOIN documents s ON s.kind = 'run-snapshot' AND s.id = g.id
      LEFT JOIN documents p ON p.kind = 'project-summary' AND p.id = g.projectId
    WHERE (? IS NULL OR g.cursor < ?) ORDER BY g.cursor DESC LIMIT ?`).all(projectId ?? null, projectId ?? null, runId ?? null, runId ?? null, before ?? null, before ?? null, limit) as Array<TaskRow & { taskCreatedAt: string }>;
  }
  function taskSummary(row: TaskRow & { taskCreatedAt: string }) {
    return costTaskSchema.parse({ id: row.id, projectId: row.projectId, projectTitle: row.projectTitle, title: row.title, createdAt: row.taskCreatedAt, updatedAt: row.updatedAt, status: row.status ?? undefined, projectRevision: row.projectRevision ?? undefined, workflowVersion: row.workflowVersion ?? undefined, runAvailable: Boolean(row.runAvailable), summary: summarize(row) });
  }

  return {
    get,
    begin(input: CostStart) {
      const existing = get(input.operationId);
      if (existing) {
        if (existing.runId !== input.runId || existing.projectId !== input.projectId || existing.modelId !== input.model.id || existing.nodeId !== input.nodeId) throw new Error('费用记录与活动快照不一致。');
        return existing;
      }
      const timestamp = new Date().toISOString();
      const requestMetrics = costRequestMetricsSchema.parse(input.requestMetrics);
      return save({ id: idFor(input.operationId), revision: 1, operationId: input.operationId, runId: input.runId, nodeId: input.nodeId, shotId: input.shotId, projectId: input.projectId, modelId: input.model.id, modelName: input.model.name, platform: getModelPlatform(input.model).id, provider: input.model.provider, model: input.model.model, capability: input.capability, requestMetrics, status: 'submitted', note: '', createdAt: timestamp, updatedAt: timestamp });
    },
    status,
    cancelRun(runId: string) {
      const rows = database.prepare("SELECT body FROM documents WHERE kind = 'usage-record' AND json_extract(body, '$.runId') = ? AND json_extract(body, '$.status') IN ('submitted','unknown')").all(runId) as { body: string }[];
      for (const row of rows) { const record = usageRecordSchema.parse(JSON.parse(row.body)); status(record.operationId, 'canceled'); }
    },
    dispatch(method: string, params: unknown) {
      if (method === 'cost.tasks') {
        const input = z.object({ projectId: z.string().optional(), before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(20) }).parse(params);
        const rows = tasks(input.projectId, undefined, input.before, input.limit + 1);
        return { items: rows.slice(0, input.limit).map(taskSummary), nextCursor: rows.length > input.limit ? rows[input.limit - 1].cursor : null };
      }
      if (method === 'cost.task.get') {
        const input = z.object({ runId: z.string().min(1) }).parse(params);
        const [row] = tasks(undefined, input.runId, undefined, 1);
        if (!row) throw new Error('任务费用归档不存在。');
        const nodes = database.prepare("SELECT json_object('id', json_extract(n.value, '$.id'), 'label', json_extract(n.value, '$.label')) AS body FROM documents s, json_each(s.body, '$.nodes') n WHERE s.kind = 'run-snapshot' AND s.id = ?").all(input.runId) as { body: string }[];
        const shots = database.prepare("SELECT json_object('id', json_extract(n.value, '$.id'), 'title', json_extract(n.value, '$.title')) AS body FROM documents s, json_each(s.body, '$.project.shots') n WHERE s.kind = 'run-snapshot' AND s.id = ?").all(input.runId) as { body: string }[];
        const run = database.prepare("SELECT json_extract(body, '$.parentRunId') AS parentRunId FROM documents WHERE kind = 'run' AND id = ?").get(input.runId) as { parentRunId: string | null } | undefined;
        return costTaskDetailSchema.parse({ ...taskSummary(row), parentRunId: run?.parentRunId ?? undefined, nodes: nodes.map(value => JSON.parse(value.body)), shots: shots.map(value => JSON.parse(value.body)) });
      }
      if (method === 'cost.list') {
        const input = z.object({ projectId: z.string().optional(), runId: z.string().optional(), before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(20) }).parse(params);
        const rows = database.prepare("SELECT rowid AS cursor, body FROM documents WHERE kind = 'usage-record' AND (? IS NULL OR rowid < ?) AND (? IS NULL OR json_extract(body, '$.projectId') = ?) AND (? IS NULL OR json_extract(body, '$.runId') = ?) ORDER BY rowid DESC LIMIT ?").all(input.before ?? null, input.before ?? null, input.projectId ?? null, input.projectId ?? null, input.runId ?? null, input.runId ?? null, input.limit + 1) as { cursor: number; body: string }[];
        return { items: rows.slice(0, input.limit).map(row => usageRecordSchema.parse(JSON.parse(row.body))), nextCursor: rows.length > input.limit ? rows[input.limit - 1].cursor : null };
      }
      if (method === 'cost.update') {
        const input = z.object({ id: z.string().min(1), revision: z.number().int().positive(), actualAmount: z.number().nonnegative().nullable().optional(), actualCurrency: currencySchema.nullable().optional(), note: z.string().max(10_000).optional() }).parse(params);
        const stored = store.get('usage-record', input.id);
        if (!stored) throw new Error('费用记录不存在。');
        const current = usageRecordSchema.parse(stored);
        if (current.revision !== input.revision) throw new Error('费用记录已修改，请刷新后保存。');
        return save(usageRecordSchema.parse({ ...current, ...(input.actualAmount !== undefined ? { actualAmount: input.actualAmount ?? undefined } : {}), ...(input.actualCurrency !== undefined ? { actualCurrency: input.actualCurrency ?? undefined } : {}), ...(input.note !== undefined ? { note: input.note } : {}), revision: current.revision + 1, updatedAt: new Date().toISOString() }));
      }
      if (method === 'cost.summary') {
        const input = z.object({ projectId: z.string().optional(), runId: z.string().optional() }).parse(params);
        const filter = "FROM documents u WHERE u.kind = 'usage-record' AND (? IS NULL OR json_extract(u.body, '$.projectId') = ?) AND (? IS NULL OR json_extract(u.body, '$.runId') = ?)";
        const args = [input.projectId ?? null, input.projectId ?? null, input.runId ?? null, input.runId ?? null];
        return summarize(database.prepare(`SELECT ${summaryColumns} ${filter}`).get(...args) as SummaryRow);
      }
      throw new Error(`未知费用操作：${method}`);
    },
  };
}
