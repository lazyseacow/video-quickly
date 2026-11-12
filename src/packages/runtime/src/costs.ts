import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { costRequestMetricsSchema, costSummarySchema, tokenMetrics, getModelPlatform, costTaskDetailSchema, costTaskSchema, currencySchema, defaultVideoRequestSeconds, providerUsageSchema, requestModelParameters, usageRecordSchema, type CostRequestMetrics, type CostSummary, type ModelCapability, type ModelPricing, type ModelProfile, type ProjectDocument, type ProviderUsage, type UsageRecord, type TokenMetric, type WorkflowNode } from '@video-quickly/contracts';
import { groupsReferenceImages, imageSequenceMode, planReferenceImageSequences, type CharacterProfile } from '@video-quickly/contracts';
import { DocumentStore } from './database.js';

type CurrencyMetric = 'estimatedAmount' | 'actualAmount' | 'estimatedRecords' | 'actualRecords';
type SummaryRow = { total: number | null; unknownEstimated: number | null; unknownActual: number | null; unknownSubmissions: number | null } & Record<`${ModelPricing['currency']}_${CurrencyMetric}`, number | null> & Record<TokenMetric | `${TokenMetric}Records`, number | null>;
type TaskRow = SummaryRow & { cursor: number; id: string; projectId: string; projectTitle: string; title: string; createdAt: string; updatedAt: string; status: string | null; projectRevision: number | null; workflowVersion: number | null; runAvailable: number };

// Match the TEXT affinity of the task key so SQLite can seek on the expression index.
const usageRunId = "CAST(json_extract(u.body, '$.runId') AS TEXT)";
type AmountKey = `${ModelPricing['currency']}_${'estimatedAmount' | 'actualAmount'}`;
type IntegerKey = Exclude<keyof SummaryRow, AmountKey>;
type IntegerMetric = [name: IntegerKey, expression: string];
const usagePaths = {
  status: '$.status',
  estimatedAmount: '$.estimatedAmount',
  actualAmount: '$.actualAmount',
  estimatedCurrency: '$.pricing.currency',
  actualCurrency: '$.actualCurrency',
  ...Object.fromEntries(tokenMetrics.map(key => [key, `$.providerUsage.${key}`])) as Record<TokenMetric, string>,
};
type UsageField = keyof typeof usagePaths;
const amountMetrics = currencySchema.options.flatMap(currency => [
  { name: `${currency}_estimatedAmount` as const, records: `${currency}_estimatedRecords` as const, amount: 'estimatedAmount' as const, currencyField: 'estimatedCurrency' as const, currency },
  { name: `${currency}_actualAmount` as const, records: `${currency}_actualRecords` as const, amount: 'actualAmount' as const, currencyField: 'actualCurrency' as const, currency },
]);

function summaryMetrics(field: (key: UsageField) => string, rowCount: string, sumAmount: 'sum' | 'vq_cost_amount_sum') {
  const amounts = amountMetrics.map(({ name, records, amount, currencyField, currency }) => {
    const value = field(amount), filter = `FILTER (WHERE ${field(currencyField)} = '${currency}')`;
    return { name, records, sum: `${sumAmount}(${value}) ${filter}`, count: `count(${value}) ${filter}` };
  });
  const integers: IntegerMetric[] = [
    ['total', rowCount],
    ['unknownEstimated', `${rowCount} FILTER (WHERE ${field('estimatedAmount')} IS NULL)`],
    ['unknownActual', `${rowCount} FILTER (WHERE ${field('actualAmount')} IS NULL)`],
    ['unknownSubmissions', `${rowCount} FILTER (WHERE ${field('status')} IN ('submitted','unknown','canceled'))`],
    ...tokenMetrics.flatMap<IntegerMetric>(key => {
      const value = field(key);
      return [[key, `sum(${value})`], [`${key}Records`, `count(${value})`]];
    }),
    ...amounts.map<IntegerMetric>(({ records, count }) => [records, count]),
  ];
  return { integers, amounts: amounts.map(({ name, sum }) => [name, sum] as const) };
}

const scopedMetrics = summaryMetrics(key => `json_extract(u.body, '${usagePaths[key]}')`, 'count(u.rowid)', 'sum');
const summaryColumns = [...scopedMetrics.integers, ...scopedMetrics.amounts].map(([name, expression]) => `${expression} AS ${name}`).join(', ');
const exactMetrics = summaryMetrics(key => key, 'count(*)', 'vq_cost_amount_sum');
const overviewMetrics = [...exactMetrics.integers, ...exactMetrics.amounts];
const overviewKeys = overviewMetrics.map(([name]) => name);

const usageColumns = Object.entries(usagePaths).map(([key, path]) => {
  const value = key === 'estimatedAmount' || key === 'actualAmount'
    ? `NULLIF(u.body -> '${path}', 'null')`
    : `json_extract(u.body, '${path}')`;
  return `${value} AS ${key}`;
}).join(', ');
const subtotalFields = overviewMetrics.map(([name, expression]) => `'${name}', CAST(${expression} AS TEXT)`).join(', ');
// Materialize only the needed fields once per charge. JSON MergePatch omits missing measurements.
const exactRunSubtotal = `WITH charges AS MATERIALIZED (
  SELECT ${usageColumns} FROM documents u WHERE u.kind = 'usage-record' AND ${usageRunId} = p.run_id
) SELECT json_patch('{}', json_object(${subtotalFields})) FROM charges`;

function summarize(row: SummaryRow): CostSummary {
  const currencies = currencySchema.options.flatMap(currency => {
    const estimatedRecords = row[`${currency}_estimatedRecords`] ?? 0, actualRecords = row[`${currency}_actualRecords`] ?? 0;
    return estimatedRecords || actualRecords ? [{ currency, estimatedRecords, actualRecords, estimatedAmount: row[`${currency}_estimatedAmount`] ?? undefined, actualAmount: row[`${currency}_actualAmount`] ?? undefined }] : [];
  });
  return costSummarySchema.parse({ total: row.total ?? 0, unknownEstimated: row.unknownEstimated ?? 0, unknownActual: row.unknownActual ?? 0, unknownSubmissions: row.unknownSubmissions ?? 0, currencies, tokens: Object.fromEntries(tokenMetrics.flatMap(key => row[key] === null ? [] : [[key, row[key]]])), tokenRecords: Object.fromEntries(tokenMetrics.map(key => [key, row[`${key}Records`] ?? 0])) });
}

type DecimalAmount = { coefficient: bigint; exponent: number };
const zeroAmount: DecimalAmount = { coefficient: 0n, exponent: 0 };

function parseAmount(text: string): DecimalAmount {
  const [significand, power = '0'] = text.split(/[eE]/);
  const [whole, fraction = ''] = significand.split('.');
  return { coefficient: BigInt(whole + fraction), exponent: Number(power) - fraction.length };
}

function adjustAmount(total: DecimalAmount, amount: DecimalAmount, sign: 1n | -1n): DecimalAmount {
  if (amount.coefficient === 0n) return total;
  if (total.coefficient === 0n) return { coefficient: sign * amount.coefficient, exponent: amount.exponent };
  const exponent = Math.min(total.exponent, amount.exponent);
  const previous = total.coefficient * 10n ** BigInt(total.exponent - exponent);
  const change = amount.coefficient * 10n ** BigInt(amount.exponent - exponent);
  return { coefficient: previous + sign * change, exponent };
}

function formatAmount(amount: DecimalAmount): string {
  if (amount.coefficient === 0n) return '0';
  const digits = amount.coefficient.toString(), significant = digits.replace(/0+$/, '');
  return `${significant}e${amount.exponent + digits.length - significant.length}`;
}

type OverviewSnapshot = Partial<Record<keyof SummaryRow, string>>;
type OverviewTotals = { integers: Map<IntegerKey, bigint>; amounts: Map<AmountKey, DecimalAmount> };
type OverviewChange = { run_id: string; previous: string | null; subtotal: string };

function applyOverviewChange(totals: OverviewTotals, metrics: string, sign: 1n | -1n) {
  const snapshot = JSON.parse(metrics) as OverviewSnapshot;
  for (const [key] of exactMetrics.integers) {
    const value = snapshot[key];
    if (value !== undefined) totals.integers.set(key, (totals.integers.get(key) ?? 0n) + sign * BigInt(value));
  }
  for (const { name } of amountMetrics) {
    const value = snapshot[name];
    if (value !== undefined) totals.amounts.set(name, adjustAmount(totals.amounts.get(name) ?? zeroAmount, parseAmount(value), sign));
  }
}

function summarizeOverview(snapshot: OverviewSnapshot): CostSummary {
  const row = Object.fromEntries(overviewKeys.map(key => [key, snapshot[key] === undefined ? null : Number(snapshot[key])])) as SummaryRow;
  for (const key of tokenMetrics) if (!row[`${key}Records`]) row[key] = null;
  for (const { name, records } of amountMetrics) if (!row[records]) row[name] = null;
  return summarize(row);
}

function createCostOverview(database: Database.Database) {
  // Read the original JSON number text. Keep decimal totals exact until converting to the public number fields.
  database.aggregate<DecimalAmount | null>('vq_cost_amount_sum', {
    start: null, directOnly: true,
    step(total, value: unknown) {
      if (value === null) return total;
      if (typeof value !== 'string') throw new TypeError('费用金额须为十进制数值。');
      return adjustAmount(total ?? zeroAmount, parseAmount(value), 1n);
    },
    result: total => total === null ? null : formatAmount(total),
  });
  const cached = database.prepare<[], { value: string }>(`SELECT value FROM runtime_metadata
    WHERE key = 'cost-overview-summary' AND NOT EXISTS (
      SELECT 1 FROM cost_task_order WHERE scope = 'all' AND overview_pending = 1
    )`);
  function readCached() {
    const row = cached.get();
    return row && summarizeOverview(JSON.parse(row.value) as OverviewSnapshot);
  }
  const rebuild = database.transaction(() => {
    const current = readCached();
    if (current) return current;
    const totals: OverviewTotals = { integers: new Map(), amounts: new Map() };
    const saved = database.prepare<[], { value: string }>("SELECT value FROM runtime_metadata WHERE key = 'cost-overview-summary'").get();
    if (!saved) {
      // With no global snapshot, rebuild all subtotals, including any that were previously clean.
      const subtotals = database.prepare<[], { overview_metrics: string }>(`UPDATE cost_task_order AS p
        SET overview_metrics = (${exactRunSubtotal}), overview_pending = 0
        WHERE p.scope = 'all'
        RETURNING overview_metrics`).all();
      for (const subtotal of subtotals) applyOverviewChange(totals, subtotal.overview_metrics, 1n);
    } else {
      applyOverviewChange(totals, saved.value, 1n);
      const changed = database.prepare<[], OverviewChange>(`SELECT p.run_id, p.overview_metrics AS previous, (${exactRunSubtotal}) AS subtotal
        FROM cost_task_order p INDEXED BY cost_task_overview_pending
        WHERE p.scope = 'all' AND p.overview_pending = 1`).all();
      const saveSubtotal = database.prepare("UPDATE cost_task_order SET overview_metrics = ?, overview_pending = 0 WHERE scope = 'all' AND run_id = ?");
      for (const change of changed) {
        if (change.previous) applyOverviewChange(totals, change.previous, -1n);
        applyOverviewChange(totals, change.subtotal, 1n);
        saveSubtotal.run(change.subtotal, change.run_id);
      }
    }
    const snapshot: OverviewSnapshot = {
      ...Object.fromEntries([...totals.integers].map(([key, value]) => [key, value.toString()])),
      ...Object.fromEntries([...totals.amounts].map(([key, value]) => [key, formatAmount(value)])),
    };
    const result = summarizeOverview(snapshot);
    database.prepare("INSERT INTO runtime_metadata(key, value) VALUES ('cost-overview-summary', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(snapshot));
    return result;
  });
  return () => readCached() ?? rebuild.immediate();
}

function usageFilter({ projectId, runId }: { projectId?: string; runId?: string }) {
  const conditions = ["u.kind = 'usage-record'"], args: (string | number)[] = [];
  if (projectId !== undefined) { conditions.push("json_extract(u.body, '$.projectId') = ?"); args.push(projectId); }
  if (runId !== undefined) { conditions.push(`${usageRunId} = ?`); args.push(runId); }
  return { conditions, args };
}

export interface CostStart {
  operationId: string; runId: string; nodeId: string; shotId?: string; projectId: string;
  model: ModelProfile; capability: ModelCapability; requestMetrics: CostRequestMetrics;
}

export function requestCostMetrics(project: ProjectDocument, node: WorkflowNode, model: ModelProfile, characters?: CharacterProfile[]): CostRequestMetrics {
  const base: CostRequestMetrics = { source: 'request', requestCount: 1 };
  if (!['assets', 'animation'].includes(node.kind)) return base;
  if (node.config.useFirstShotReference === true && groupsReferenceImages(node)) {
    const count = project.shots.filter(shot => !shot.locked).length;
    return { source: 'request', requestCount: count, images: count };
  }
  // Locked shots may reuse existing receipts or assets. Without submission evidence, do not count them as requests.
  if (project.shots.some(shot => shot.locked)) return { source: 'request' };
  const count = project.shots.length;
  if (node.kind === 'assets') {
    if (count > 1 && groupsReferenceImages(node) && imageSequenceMode(model) === 'seedream') {
      const sequences = characters || !project.shots.some(shot => shot.characterIds?.length) ? planReferenceImageSequences({ project, node, model, characters }) : undefined;
      return { source: 'request', requestCount: sequences?.reduce((total, sequence) => total + sequence.batches.length, 0), images: count };
    }
    return { source: 'request', requestCount: count, images: count };
  }
  const parameters = requestModelParameters(model, 'video');
  const configured = model.provider === 'openai-compatible' ? parameters.seconds : model.provider === 'seedance' ? parameters.duration : undefined;
  let duration: number | undefined;
  if (model.provider !== 'custom-http' && model.provider !== 'comfyui') {
    if (configured !== undefined) { const seconds = Number(configured); if (Number.isFinite(seconds) && seconds > 0) duration = seconds * count; }
    else duration = project.shots.reduce((total, shot) => total + defaultVideoRequestSeconds(model.model, shot.durationUs), 0);
  }
  return { source: 'request', requestCount: count, ...(duration !== undefined ? { videoSeconds: duration } : {}) };
}

export function createCostLedger(options: { database: Database.Database; store: DocumentStore; onChanged?: () => void }) {
  const { database, store } = options;
  const overview = createCostOverview(database);
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

  function tasks({ projectId, runId, before, limit }: { projectId?: string; runId?: string; before?: number; limit: number }) {
    const conditions = ['scope = @scope'], params: Record<string, string | number> = { scope: projectId === undefined ? 'all' : `project:${projectId}`, limit };
    if (runId !== undefined) { conditions.push('run_id = @runId'); params.runId = runId; }
    if (before !== undefined) { conditions.push('cursor < @before'); params.before = before; }
    const projectFilter = projectId === undefined ? '' : "AND json_extract(u.body, '$.projectId') = @projectId";
    if (projectId !== undefined) params.projectId = projectId;
    // Page by the stable task cursor, then seek all charges belonging to those tasks.
    return database.prepare(`WITH page AS MATERIALIZED (
      SELECT cursor, run_id FROM cost_task_order
      WHERE ${conditions.join(' AND ')} ORDER BY cursor DESC LIMIT @limit
    ), grouped AS (
      SELECT page.cursor, page.run_id AS id,
        min(json_extract(u.body, '$.projectId')) AS projectId,
        min(json_extract(u.body, '$.createdAt')) AS createdAt, max(json_extract(u.body, '$.updatedAt')) AS updatedAt,
        ${summaryColumns}
      FROM page CROSS JOIN documents u
      WHERE u.kind = 'usage-record' AND ${usageRunId} = page.run_id ${projectFilter}
      GROUP BY page.cursor, page.run_id
    ) SELECT g.*, coalesce(json_extract(s.body, '$.project.title'), json_extract(p.body, '$.title'), '项目制作') AS projectTitle,
      CASE WHEN json_extract(r.body, '$.purpose') = 'prompt-trial' THEN CASE WHEN json_type(r.body, '$.promptSessionId') IS NULL THEN 'AI 填写 · ' ELSE '提示词实验 · ' END WHEN json_extract(r.body, '$.purpose') = 'workflow-assistant' THEN '任务修改建议 · ' ELSE '' END || coalesce(CASE WHEN json_array_length(s.body, '$.nodes') = 1 THEN json_extract(s.body, '$.nodes[0].label') ELSE json_extract(s.body, '$.project.workflow.name') END, '制作任务') AS title,
      coalesce(json_extract(r.body, '$.createdAt'), g.createdAt) AS taskCreatedAt,
      json_extract(r.body, '$.status') AS status, json_extract(r.body, '$.projectRevision') AS projectRevision,
      json_extract(r.body, '$.workflowVersion') AS workflowVersion, r.id IS NOT NULL AS runAvailable
    FROM grouped g LEFT JOIN documents r ON r.kind = 'run' AND r.id = g.id
      LEFT JOIN documents s ON s.kind = 'run-snapshot' AND s.id = g.id
      LEFT JOIN documents p ON p.kind = 'project-summary' AND p.id = g.projectId
    ORDER BY g.cursor DESC`).all(params) as Array<TaskRow & { taskCreatedAt: string }>;
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
      const rows = database.prepare(`SELECT u.body FROM documents u WHERE u.kind = 'usage-record' AND ${usageRunId} = ? AND json_extract(u.body, '$.status') IN ('submitted','unknown')`).all(runId) as { body: string }[];
      for (const row of rows) { const record = usageRecordSchema.parse(JSON.parse(row.body)); status(record.operationId, 'canceled'); }
    },
    dispatch(method: string, params: unknown) {
      if (method === 'cost.tasks') {
        const input = z.object({ projectId: z.string().optional(), before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(20) }).parse(params);
        const rows = tasks({ ...input, limit: input.limit + 1 });
        return { items: rows.slice(0, input.limit).map(taskSummary), nextCursor: rows.length > input.limit ? rows[input.limit - 1].cursor : null };
      }
      if (method === 'cost.task.get') {
        const input = z.object({ runId: z.string().min(1) }).parse(params);
        const [row] = tasks({ runId: input.runId, limit: 1 });
        if (!row) throw new Error('任务费用归档不存在。');
        const nodes = database.prepare("SELECT json_object('id', json_extract(n.value, '$.id'), 'label', json_extract(n.value, '$.label')) AS body FROM documents s, json_each(s.body, '$.nodes') n WHERE s.kind = 'run-snapshot' AND s.id = ?").all(input.runId) as { body: string }[];
        const shots = database.prepare("SELECT json_object('id', json_extract(n.value, '$.id'), 'title', json_extract(n.value, '$.title')) AS body FROM documents s, json_each(s.body, '$.project.shots') n WHERE s.kind = 'run-snapshot' AND s.id = ?").all(input.runId) as { body: string }[];
        const run = database.prepare("SELECT json_extract(body, '$.parentRunId') AS parentRunId FROM documents WHERE kind = 'run' AND id = ?").get(input.runId) as { parentRunId: string | null } | undefined;
        return costTaskDetailSchema.parse({ ...taskSummary(row), parentRunId: run?.parentRunId ?? undefined, nodes: nodes.map(value => JSON.parse(value.body)), shots: shots.map(value => JSON.parse(value.body)) });
      }
      if (method === 'cost.list') {
        const input = z.object({ projectId: z.string().optional(), runId: z.string().optional(), before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(20) }).parse(params);
        const { conditions, args } = usageFilter(input);
        if (input.before !== undefined) { conditions.push('u.rowid < ?'); args.push(input.before); }
        const rows = database.prepare(`SELECT u.rowid AS cursor, u.body FROM documents u WHERE ${conditions.join(' AND ')} ORDER BY u.rowid DESC LIMIT ?`).all(...args, input.limit + 1) as { cursor: number; body: string }[];
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
        if (input.projectId === undefined && input.runId === undefined) return overview();
        const { conditions, args } = usageFilter(input);
        return summarize(database.prepare(`SELECT ${summaryColumns} FROM documents u WHERE ${conditions.join(' AND ')}`).get(...args) as SummaryRow);
      }
      throw new Error(`未知费用操作：${method}`);
    },
  };
}
