import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type Database from 'better-sqlite3';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { z } from 'zod';
import {
  jsonValueSchema, modelSchema, pageInputSchema, runInspectionSchema, runStepPayloadSchema, skillSchema, workflowNodeSchema,
  type JsonValue, type ModelProfile, type ProjectDocument, type RecordPage, type RunInspection, type RunRecord, type RunStepSummary, type SkillPackage, type StepOutputVersion, type WorkflowNode,
} from '@video-quickly/contracts';
import { DocumentStore } from './database.js';
import { activityNodeId, createReadModels } from './read-models.js';

const runInput = z.object({ runId: z.string().min(1) });
const stepInput = runInput.extend({ nodeId: z.string().min(1) });
const checkpointSchema = z.object({
  completed: z.array(z.string()).default([]), skipped: z.array(z.string()).default([]),
  currentNodeId: z.string().default(''), pendingReview: z.boolean().default(false),
});
const sensitiveKey = /^(?:authorization|(?:x[-_]?)?api[-_]?key|(?:x[-_]?)?token|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|credential(?:Ref)?|cookie|set[-_]?cookie)$/i;
const json = (value: unknown): JsonValue => jsonValueSchema.parse(JSON.parse(JSON.stringify(value)));

interface Snapshot {
  project: ProjectDocument; nodes: WorkflowNode[]; models: ModelProfile[]; skills: SkillPackage[]; handlerVersion: number;
  regeneration?: JsonValue; research?: JsonValue; exportBatch?: JsonValue;
}
interface SnapshotRow { title: string; nodes: string; models: string; skills: string; edges: string; handlerVersion: number }
interface ActivitySummaryRow {
  node_id: string; count: number; unknown_count: number; started_at: string; completed_at: string | null; error: string | null;
}
interface CapturedInput { inputHash: string; prompt?: string; recordedAt: string }

export function redactInspectionText(value: string, redactText: (text: string) => string): string {
    if (/^data:[^,]*;base64,/i.test(value)) return '[媒体内容使用原素材引用]';
    return redactText(value).replace(/(\b(?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|client[-_]?secret|token|secret|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1"[已隐藏]"').replace(/\bhttps?:\/\/[^\s<>"']+/gi, match => {
      try {
        const url = new URL(match);
        if (url.username || url.password) { url.username = ''; url.password = ''; }
        for (const name of [...url.searchParams.keys()]) if (sensitiveKey.test(name) || /^(?:key|sig|signature)$/i.test(name)) url.searchParams.set(name, '[已隐藏]');
        return url.href;
      } catch { return match; }
    });
}

export function redactInspectionValue(value: JsonValue, redactText: (text: string) => string): JsonValue {
  if (typeof value === 'string') return redactInspectionText(value, redactText);
  if (Array.isArray(value)) return value.map((item, index) => index > 0 && typeof value[index - 1] === 'string' && /^--?(?:api[-_]?key|token|secret|password|authorization)$/i.test(String(value[index - 1])) ? '[已隐藏]' : redactInspectionValue(item, redactText));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? '[已隐藏]' : redactInspectionValue(item, redactText)]));
  return value;
}

export function createRunInspector(options: {
  database: Database.Database; store: DocumentStore; dataDirectory: string;
  run: (id: string) => RunRecord;
  secrets: (models: readonly ModelProfile[]) => Promise<readonly string[]>;
  redactText: (text: string, models: ModelProfile[], secrets: readonly string[]) => string;
}) {
  const { database, store } = options, reads = createReadModels(database, store);
  function metadata(runId: string) {
    const row = database.prepare("SELECT json_extract(body, '$.project.title') AS title, json_extract(body, '$.nodes') AS nodes, json_extract(body, '$.models') AS models, json_extract(body, '$.skills') AS skills, json_extract(body, '$.project.workflow.edges') AS edges, json_extract(body, '$.handlerVersion') AS handlerVersion FROM documents WHERE kind = 'run-snapshot' AND id = ?").get(runId) as SnapshotRow | undefined;
    if (!row) return undefined;
    return { title: row.title, nodes: z.array(workflowNodeSchema).parse(JSON.parse(row.nodes)), models: z.array(modelSchema).parse(JSON.parse(row.models)), skills: z.array(skillSchema).parse(JSON.parse(row.skills)), edges: z.array(z.object({ source: z.string(), target: z.string() })).parse(JSON.parse(row.edges)), handlerVersion: row.handlerVersion };
  }
  async function nativeState(runId: string) {
    const tuple = await new SqliteSaver(database).getTuple({ configurable: { thread_id: runId } });
    return { available: !!tuple, values: checkpointSchema.parse(tuple?.checkpoint.channel_values ?? {}) };
  }
  async function redactor(models: ModelProfile[]) {
    const secrets = await options.secrets(models);
    return (value: JsonValue) => redactInspectionValue(value, text => options.redactText(text, models, secrets));
  }
  async function inspect(runId: string, nodeId?: string): Promise<RunInspection> {
    const run = options.run(runId), saved = metadata(runId), state = await nativeState(runId);
    if (nodeId && !saved?.nodes.some(node => node.id === nodeId)) throw new Error('该运行的冻结流程中没有这个步骤。');
    const nodes = saved?.nodes ?? [], ids = nodes.map(node => node.id), redact = await redactor(saved?.models ?? []);
    const rows = database.prepare(`WITH receipts AS (
      SELECT a.rowid AS cursor, a.*, coalesce((SELECT value FROM json_each(@nodes) WHERE a.activity_id = value OR substr(a.activity_id, 1, length(value) + 1) = value || ':' ORDER BY length(value) DESC LIMIT 1), substr(a.activity_id, 1, instr(a.activity_id || ':', ':') - 1)) AS node_id
      FROM activities a WHERE run_id = @runId
    ), grouped AS (
      SELECT node_id, count(*) AS count, sum(CASE WHEN status IN ('dispatched', 'unknown') AND safety = 'external' AND remote_id IS NULL THEN 1 ELSE 0 END) AS unknown_count,
        min(started_at) AS started_at, max(completed_at) AS completed_at, max(cursor) AS latest FROM receipts GROUP BY node_id
    ) SELECT g.*, a.error FROM grouped g JOIN activities a ON a.rowid = g.latest`).all({ runId, nodes: JSON.stringify(ids) }) as ActivitySummaryRow[];
    const byNode = new Map(rows.map(row => [row.node_id, row]));
    const keys = ids.map(id => `${runId}:${id}`);
    const documents = database.prepare("SELECT kind, id FROM documents WHERE kind IN ('node-project', 'node-result') AND id IN (SELECT value FROM json_each(?))").all(JSON.stringify(keys)) as { kind: string; id: string }[];
    const has = (kind: string, id: string) => documents.some(row => row.kind === kind && row.id === `${runId}:${id}`);
    const unknown = run.status !== 'running' && rows.some(row => row.unknown_count > 0);
    const resume = ['failed', 'needs_attention', 'waiting_external', 'retry_scheduled', 'queued'].includes(run.status) && !unknown;
    const steps: RunStepSummary[] = nodes.map(node => {
      const receipt = byNode.get(node.id), current = run.currentNodeId === node.id;
      let status: RunStepSummary['status'] = state.values.completed.includes(node.id) ? 'succeeded' : state.values.skipped.includes(node.id) ? 'skipped' : 'pending';
      if (current && !['succeeded', 'skipped'].includes(status)) status = run.status === 'succeeded' ? 'not_recorded' : run.status === 'queued' ? 'pending' : run.status;
      else if (!state.available && !['queued', 'running'].includes(run.status)) status = 'not_recorded';
      else if (run.status === 'canceled' && status === 'pending') status = 'canceled';
      const error = current && run.error ? run.error : receipt?.error ? String(redact(receipt.error)) : undefined;
      const reason = status === 'waiting_review' ? '等待审阅这个步骤的产物。'
        : unknown && receipt?.unknown_count ? '上次外部提交的结果尚未确认，请先核对服务端任务；这里不会重新提交。'
        : status === 'waiting_external' ? '等待已有外部任务的结果，继续时优先查询原任务。'
        : status === 'retry_scheduled' ? '执行已安排重试。'
        : status === 'failed' || status === 'needs_attention' ? error ?? '执行已中断，请核对活动记录后决定如何继续。'
        : status === 'skipped' ? '当前条件分支没有经过这个步骤。'
        : status === 'not_recorded' ? '历史记录没有保存可验证的步骤检查点。'
        : status === 'canceled' ? '这次制作已停止。'
        : status === 'succeeded' ? '步骤已完成。'
        : status === 'running' ? '正在执行这个步骤。'
        : has('node-result', node.id) ? '产物已保存，编排检查点尚未推进；继续执行时会先校验已有结果。'
        : '尚未执行；等待调度或上游步骤完成。';
      return { id: node.id, label: node.label, kind: node.kind, description: node.description, requiresReview: node.requiresReview, status, reason,
        inputAvailable: has('node-project', node.id), outputAvailable: has('node-result', node.id), activityCount: receipt?.count ?? 0,
        unknownSubmission: unknown && Boolean(receipt?.unknown_count), startedAt: receipt?.started_at, completedAt: status === 'succeeded' ? receipt?.completed_at ?? undefined : undefined, error };
    });
    const selectedNode = saved?.nodes.find(node => node.id === nodeId), model = selectedNode?.modelId ? saved?.models.find(value => value.id === selectedNode.modelId) : undefined;
    return runInspectionSchema.parse({ run: reads.runSummary(run), projectTitle: saved?.title ?? '历史制作', snapshotAvailable: !!saved, checkpointAvailable: state.available, steps,
      recovery: { review: run.status === 'waiting_review', resume, cancel: ['running', 'queued', 'waiting_external', 'retry_scheduled', 'needs_attention'].includes(run.status), restart: run.status === 'canceled', reason: unknown ? '存在结果未确认的外部提交，请先核对原任务。' : '' },
      selected: selectedNode && saved ? { node: redact(json(selectedNode)), dependencies: saved.edges.filter(edge => edge.target === nodeId).map(edge => edge.source),
        model: model ? { id: model.id, name: model.name, provider: model.provider, model: model.model } : undefined,
        skills: saved.skills.filter(skill => selectedNode.skillIds.includes(skill.id)).map(skill => ({ id: skill.id, name: skill.name, version: skill.version, enabled: skill.enabled })), handlerVersion: saved.handlerVersion } : undefined,
    });
  }
  function readPayload(runId: string, nodeId: string, kind: 'input' | 'output', saved: Snapshot, redact: (value: JsonValue) => JsonValue) {
    const node = saved.nodes.find(value => value.id === nodeId);
    if (!node) throw new Error('该运行的冻结流程中没有这个步骤。');
    const captured = store.get<CapturedInput>('node-inspection-input', `${runId}:${nodeId}`);
    const project = kind === 'input' ? store.get<ProjectDocument>('node-project', `${runId}:${nodeId}`) : undefined;
    const value = kind === 'output' ? store.get<JsonValue>('node-result', `${runId}:${nodeId}`) : project ? json({
      project, node, model: saved.models.find(model => model.id === node.modelId) ?? null,
      skills: saved.skills.filter(skill => node.skillIds.includes(skill.id)), handlerVersion: saved.handlerVersion,
      regeneration: saved.regeneration, research: saved.research, exportBatch: saved.exportBatch,
      resolvedPrompt: captured?.prompt,
    }) : undefined;
    return runStepPayloadSchema.parse({ runId, nodeId, kind, available: value !== undefined, value: value === undefined ? null : redact(value), inputHash: captured?.inputHash, resolvedPromptRecorded: kind === 'input' ? captured?.prompt !== undefined : undefined });
  }
  async function payload(runId: string, nodeId: string, kind: 'input' | 'output') {
    options.run(runId);
    const saved = store.get<Snapshot>('run-snapshot', runId);
    if (!saved) throw new Error('该运行没有保存冻结流程。');
    return readPayload(runId, nodeId, kind, saved, await redactor(saved.models));
  }
  function versions(runId: string, nodeId: string, before: number | undefined, limit: number): RecordPage<StepOutputVersion> {
    const run = options.run(runId), saved = metadata(runId), node = saved?.nodes.find(value => value.id === nodeId);
    if (!node) throw new Error('该运行的冻结流程中没有这个步骤。');
    const rows = database.prepare(`SELECT r.rowid AS cursor, r.id, json_extract(r.body, '$.createdAt') AS createdAt, json_extract(r.body, '$.status') AS status,
      json_extract(r.body, '$.projectRevision') AS projectRevision, json_extract(r.body, '$.workflowVersion') AS workflowVersion, json_extract(n.value, '$.label') AS label
      FROM documents r JOIN documents s ON s.kind = 'run-snapshot' AND s.id = r.id, json_each(s.body, '$.nodes') n
      WHERE r.kind = 'run' AND json_extract(r.body, '$.projectId') = @projectId AND (@before IS NULL OR r.rowid < @before)
      AND json_extract(n.value, '$.id') = @nodeId AND json_extract(n.value, '$.kind') = @kind
      AND EXISTS (SELECT 1 FROM documents result WHERE result.kind = 'node-result' AND result.id = r.id || ':' || @nodeId)
      ORDER BY r.rowid DESC LIMIT @limit`).all({ projectId: run.projectId, nodeId, kind: node.kind, before: before ?? null, limit: limit + 1 }) as (StepOutputVersion & { cursor: number })[];
    return { items: rows.slice(0, limit).map(({ cursor: _cursor, ...row }) => ({ ...row, nodeId })), nextCursor: rows.length > limit ? rows[limit - 1].cursor : null };
  }
  async function diagnostics(runId: string) {
    const startedAt = new Date().toISOString(), inspection = await inspect(runId), saved = store.get<Snapshot>('run-snapshot', runId), redact = await redactor(saved?.models ?? []), state = await nativeState(runId);
    const eventEnd = (database.prepare('SELECT max(sequence) AS value FROM execution_events WHERE run_id = ?').get(runId) as { value: number | null }).value ?? 0;
    const activityEnd = (database.prepare('SELECT max(rowid) AS value FROM activities WHERE run_id = ?').get(runId) as { value: number | null }).value ?? 0;
    const output = join(options.dataDirectory, 'diagnostics'); await mkdir(output, { recursive: true });
    const path = join(output, `run-${createHash('sha256').update(runId).digest('hex').slice(0, 12)}-${randomUUID()}.json.gz`);
    async function* content() {
      yield JSON.stringify(redact(json({ version: 1, captureStartedAt: startedAt, inspection, checkpoint: state, snapshot: saved ?? null }))).slice(0, -1) + ',"steps":[';
      for (const [index, step] of inspection.steps.entries()) {
        if (index) yield ',';
        if (saved) yield JSON.stringify({ nodeId: step.id, input: readPayload(runId, step.id, 'input', saved, redact), output: readPayload(runId, step.id, 'output', saved, redact) });
      }
      yield '],"events":[';
      let sequence = 0, first = true;
      while (sequence < eventEnd) {
        const row = database.prepare('SELECT sequence, type, body, created_at FROM execution_events WHERE run_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT 1').get(runId, sequence, eventEnd) as { sequence: number; type: string; body: string; created_at: string } | undefined;
        if (!row) break;
        if (!first) yield ','; first = false; sequence = row.sequence;
        yield JSON.stringify(redact(json({ ...row, body: JSON.parse(row.body) })));
      }
      yield '],"activities":[';
      let cursor = 0; first = true;
      while (cursor < activityEnd) {
        const row = database.prepare('SELECT rowid AS cursor, activity_id, input_hash, safety, status, remote_id, error, started_at, completed_at, result FROM activities WHERE run_id = ? AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 1').get(runId, cursor, activityEnd) as { cursor: number; activity_id: string; result: string | null } | undefined;
        if (!row) break;
        if (!first) yield ','; first = false; cursor = row.cursor;
        yield JSON.stringify(redact(json({ ...row, nodeId: activityNodeId(row.activity_id, saved?.nodes.map(node => node.id) ?? []), result: row.result ? JSON.parse(row.result) : null })));
      }
      yield `],"captureCompletedAt":${JSON.stringify(new Date().toISOString())}}`;
    }
    const file = await open(path, 'wx');
    try { await pipeline(Readable.from(content()), createGzip(), file.createWriteStream()); }
    catch (error) { await rm(path, { force: true }); throw error; }
    return { path, bytes: (await stat(path)).size, format: 'json.gz' };
  }
  function captureInput(runId: string, nodeId: string, input: CapturedInput) {
    const id = `${runId}:${nodeId}`;
    if (!store.get<CapturedInput>('node-inspection-input', id)) store.put('node-inspection-input', id, input);
  }
  return {
    captureInput,
    async dispatch(method: string, raw: unknown) {
      if (method === 'run.inspect') { const input = runInput.extend({ nodeId: z.string().min(1).optional() }).parse(raw); return inspect(input.runId, input.nodeId); }
      if (method === 'run.step.payload') { const input = stepInput.extend({ kind: z.enum(['input', 'output']) }).parse(raw); return payload(input.runId, input.nodeId, input.kind); }
      if (method === 'run.step.versions') { const input = stepInput.merge(pageInputSchema).parse(raw); return versions(input.runId, input.nodeId, input.before, input.limit); }
      if (method === 'run.diagnostics') return diagnostics(runInput.parse(raw).runId);
      throw new Error('未知的步骤详情操作。');
    },
  };
}
