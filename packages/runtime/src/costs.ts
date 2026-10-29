import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { costRequestMetricsSchema, currencySchema, providerUsageSchema, requestModelParameters, usageRecordSchema, type CostRequestMetrics, type ModelCapability, type ModelPricing, type ModelProfile, type ProjectDocument, type ProviderUsage, type UsageRecord, type WorkflowNode } from '@video-quickly/contracts';
import { DocumentStore } from './database.js';

type Estimate = { estimatedAmount?: number; estimateBasis?: UsageRecord['estimateBasis'] };
type Metric = Exclude<keyof ProviderUsage, 'source'>;

/** Configured unit prices produce estimates, never provider invoices. */
export function estimateUsage(capability: ModelCapability, pricing: ModelPricing | null | undefined, request: CostRequestMetrics, usage?: ProviderUsage): Estimate {
  if (!pricing) return {};
  const sources = new Set<'provider' | 'request'>();
  function quantity(metric: Metric): number | undefined {
    if (usage?.[metric] !== undefined) { sources.add('provider'); return usage[metric]; }
    if (metric === 'images' || metric === 'videoSeconds' || metric === 'characters' || metric === 'audioSeconds') {
      if (request[metric] !== undefined) { sources.add('request'); return request[metric]; }
    }
    return undefined;
  }
  function tokenAmount(): number | undefined {
    const input = quantity('inputTokens'), output = quantity('outputTokens');
    if (input === undefined || output === undefined || pricing?.inputPerMillionTokens === undefined || pricing.outputPerMillionTokens === undefined) return;
    return (input * pricing.inputPerMillionTokens + output * pricing.outputPerMillionTokens) / 1_000_000;
  }
  let amount: number | undefined;
  if (capability === 'image') {
    const images = quantity('images');
    if (images !== undefined && pricing.perImage !== undefined) amount = images * pricing.perImage;
  } else if (capability === 'video') {
    const seconds = quantity('videoSeconds');
    if (seconds !== undefined && pricing.perVideoSecond !== undefined) amount = seconds * pricing.perVideoSecond;
  } else if (capability === 'tts') {
    if (pricing.perThousandCharacters !== undefined) {
      const characters = quantity('characters');
      if (characters !== undefined) amount = characters * pricing.perThousandCharacters / 1_000;
    } else if (pricing.perAudioMinute !== undefined) {
      const seconds = quantity('audioSeconds');
      if (seconds !== undefined) amount = seconds * pricing.perAudioMinute / 60;
    }
  } else if (capability === 'asr' && pricing.perAudioMinute !== undefined) {
    // Transcription request duration is unknown unless the provider measures it.
    if (usage?.audioSeconds !== undefined) { sources.add('provider'); amount = usage.audioSeconds * pricing.perAudioMinute / 60; }
  } else amount = tokenAmount();
  if (amount === undefined || !Number.isFinite(amount)) return {};
  return { estimatedAmount: Number(amount.toPrecision(15)), estimateBasis: sources.size > 1 ? 'mixed' : sources.has('provider') ? 'provider' : 'request' };
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
    const estimate = estimateUsage(current.capability, current.pricing, current.requestMetrics, providerUsage);
    if (current.status === next && JSON.stringify(current.providerUsage) === JSON.stringify(providerUsage)) return current;
    return save({ ...current, estimatedAmount: estimate.estimatedAmount, estimateBasis: estimate.estimateBasis, providerUsage, status: next, revision: current.revision + 1, updatedAt: new Date().toISOString() });
  }

  // A prior process can no longer prove whether a submitted request reached its provider.
  const orphaned = database.prepare("SELECT body FROM documents WHERE kind = 'usage-record' AND json_extract(body, '$.status') = 'submitted'").all() as { body: string }[];
  for (const row of orphaned) { const record = usageRecordSchema.parse(JSON.parse(row.body)); status(record.operationId, 'unknown'); }

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
      const pricing = structuredClone(input.model.pricing);
      return save({ id: idFor(input.operationId), revision: 1, operationId: input.operationId, runId: input.runId, nodeId: input.nodeId, shotId: input.shotId, projectId: input.projectId, modelId: input.model.id, modelName: input.model.name, provider: input.model.provider, model: input.model.model, capability: input.capability, requestMetrics, pricing, status: 'submitted', note: '', createdAt: timestamp, updatedAt: timestamp, ...estimateUsage(input.capability, pricing, requestMetrics) });
    },
    status,
    cancelRun(runId: string) {
      const rows = database.prepare("SELECT body FROM documents WHERE kind = 'usage-record' AND json_extract(body, '$.runId') = ? AND json_extract(body, '$.status') IN ('submitted','unknown')").all(runId) as { body: string }[];
      for (const row of rows) { const record = usageRecordSchema.parse(JSON.parse(row.body)); status(record.operationId, 'canceled'); }
    },
    dispatch(method: string, params: unknown) {
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
        const filter = "FROM documents WHERE kind = 'usage-record' AND (? IS NULL OR json_extract(body, '$.projectId') = ?) AND (? IS NULL OR json_extract(body, '$.runId') = ?)";
        const args = [input.projectId ?? null, input.projectId ?? null, input.runId ?? null, input.runId ?? null];
        const totals = database.prepare(`SELECT count(*) AS total, sum(json_extract(body, '$.estimatedAmount') IS NULL) AS unknownEstimated, sum(json_extract(body, '$.actualAmount') IS NULL) AS unknownActual, sum(json_extract(body, '$.status') IN ('submitted','unknown','canceled')) AS unknownSubmissions ${filter}`).get(...args) as { total: number; unknownEstimated: number | null; unknownActual: number | null; unknownSubmissions: number | null };
        const currencies = ['USD', 'CNY'].flatMap(currency => {
          const row = database.prepare(`SELECT sum(CASE WHEN json_extract(body, '$.pricing.currency') = ? THEN json_extract(body, '$.estimatedAmount') END) AS estimatedAmount, count(CASE WHEN json_extract(body, '$.pricing.currency') = ? THEN json_extract(body, '$.estimatedAmount') END) AS estimatedRecords, sum(CASE WHEN json_extract(body, '$.actualCurrency') = ? THEN json_extract(body, '$.actualAmount') END) AS actualAmount, count(CASE WHEN json_extract(body, '$.actualCurrency') = ? THEN json_extract(body, '$.actualAmount') END) AS actualRecords ${filter}`).get(currency, currency, currency, currency, ...args) as { estimatedAmount: number | null; actualAmount: number | null; estimatedRecords: number; actualRecords: number };
          return row.estimatedRecords || row.actualRecords ? [{ currency, ...row, estimatedAmount: row.estimatedAmount ?? undefined, actualAmount: row.actualAmount ?? undefined }] : [];
        });
        return { ...totals, unknownEstimated: totals.unknownEstimated ?? 0, unknownActual: totals.unknownActual ?? 0, unknownSubmissions: totals.unknownSubmissions ?? 0, currencies };
      }
      throw new Error(`未知费用操作：${method}`);
    },
  };
}
