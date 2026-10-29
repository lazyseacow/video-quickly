import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_VIDEO_PROFILE, createHistoryWorkflow, projectSchema, workflowNodeSchema, type ModelProfile, type UsageRecord } from '@video-quickly/contracts';
import { createCostLedger, estimateUsage, requestCostMetrics } from '../src/costs';
import { DocumentStore, openDatabase } from '../src/database';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const request = { source: 'request' as const, requestCount: 1 };

it('requires complete token measurement and prices, retaining explicit zero values', () => {
  const pricing = { currency: 'USD' as const, inputPerMillionTokens: 2, outputPerMillionTokens: 8 };
  expect(estimateUsage('text', pricing, request)).toEqual({});
  expect(estimateUsage('text', pricing, request, { source: 'provider', inputTokens: 100 })).toEqual({});
  expect(estimateUsage('text', { currency: 'USD', inputPerMillionTokens: 2 }, request, { source: 'provider', inputTokens: 100, outputTokens: 20 })).toEqual({});
  expect(estimateUsage('text', pricing, request, { source: 'provider', inputTokens: 100, outputTokens: 20 })).toEqual({ estimatedAmount: .00036, estimateBasis: 'provider' });
  expect(estimateUsage('text', { currency: 'USD', inputPerMillionTokens: 0, outputPerMillionTokens: 0 }, request, { source: 'provider', inputTokens: 0, outputTokens: 0 })).toEqual({ estimatedAmount: 0, estimateBasis: 'provider' });
});

it('uses alternative TTS and ASR billing units with explicit priority instead of adding both', () => {
  const pricing = { currency: 'CNY' as const, perThousandCharacters: 2, perAudioMinute: 50, inputPerMillionTokens: 1, outputPerMillionTokens: 2 };
  expect(estimateUsage('tts', pricing, { ...request, characters: 2_000 }, { source: 'provider', audioSeconds: 120 })).toEqual({ estimatedAmount: 4, estimateBasis: 'request' });
  expect(estimateUsage('tts', pricing, request, { source: 'provider', audioSeconds: 120 })).toEqual({});
  expect(estimateUsage('asr', pricing, { ...request, audioSeconds: 60 })).toEqual({});
  expect(estimateUsage('asr', pricing, request, { source: 'provider', audioSeconds: 120 })).toEqual({ estimatedAmount: 100, estimateBasis: 'provider' });
  expect(estimateUsage('asr', pricing, request, { source: 'provider', inputTokens: 5, outputTokens: 3 })).toEqual({});
});

function model(provider: ModelProfile['provider'], parameters: ModelProfile['parameters'] = {}): ModelProfile {
  return { id: 'model', name: '模型', provider, baseUrl: 'http://localhost:1234/v1', model: 'fixture', capabilities: ['video', 'tts', 'image'], parameters, pricing: { currency: 'USD', perImage: .1 }, enabled: true, hasSecret: false, createdAt: 'now', updatedAt: 'now' };
}

it('derives media request units from actual adapter parameters, leaving custom protocols and locked reuse unknown', () => {
  const project = projectSchema.parse({ id: 'project', title: '计量', brief: '', profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), revision: 1, shots: [{ id: 'shot', title: '镜头', narration: '字🙂', visualPrompt: '', durationUs: 2_000_000 }], createdAt: 'now', updatedAt: 'now' });
  const video = workflowNodeSchema.parse({ id: 'video', kind: 'animation', label: '视频' });
  expect(requestCostMetrics(project, video, model('openai-compatible', { seconds: 6 })).videoSeconds).toBe(6);
  expect(requestCostMetrics(project, video, model('seedance', { duration: 8 })).videoSeconds).toBe(8);
  expect(requestCostMetrics(project, video, model('custom-http', { requestTemplate: { duration: '{{duration}}' } })).videoSeconds).toBeUndefined();
  const voice = workflowNodeSchema.parse({ id: 'voice', kind: 'voice', label: '配音' });
  expect(requestCostMetrics(project, voice, model('openai-compatible')).characters).toBe(2);
  expect(requestCostMetrics({ ...project, shots: project.shots.map(shot => ({ ...shot, locked: true })) }, video, model('openai-compatible'))).toEqual({ source: 'request' });
  expect(requestCostMetrics(project, { ...voice, config: { operation: 'transcribe' } }, model('openai-compatible')).audioSeconds).toBeUndefined();
});

it('keeps immutable pricing and stable IDs, separates actual payment, paginates and recovers orphan submissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-cost-ledger-')); directories.push(directory);
  const database = openDatabase(directory), store = new DocumentStore(database);
  try {
    const ledger = createCostLedger({ database, store });
    const selected = model('openai-compatible');
    const base = { operationId: 'run:node', runId: 'run', nodeId: 'node', projectId: 'project', model: selected, capability: 'image' as const, requestMetrics: { ...request, images: 2 } };
    const first = ledger.begin(base);
    selected.pricing = { currency: 'CNY', perImage: 100 };
    expect(ledger.begin(base)).toEqual(first); expect(first.pricing).toEqual({ currency: 'USD', perImage: .1 });
    const done = ledger.status(base.operationId, 'completed')!;
    expect(done).toMatchObject({ estimatedAmount: .2, estimateBasis: 'request', status: 'completed' });
    const paid = ledger.dispatch('cost.update', { id: done.id, revision: done.revision, actualAmount: 1.5, actualCurrency: 'CNY', note: '手工核对账单' }) as UsageRecord;
    expect(paid).toMatchObject({ estimatedAmount: .2, pricing: { currency: 'USD' }, actualAmount: 1.5, actualCurrency: 'CNY' });
    expect(() => ledger.dispatch('cost.update', { id: done.id, revision: done.revision, note: '旧修订' })).toThrow('已修改');
    const cleared = ledger.dispatch('cost.update', { id: paid.id, revision: paid.revision, actualAmount: null, actualCurrency: null }) as UsageRecord;
    expect(cleared.actualAmount).toBeUndefined(); expect(cleared.estimatedAmount).toBe(.2);
    ledger.begin({ ...base, operationId: 'run:other', requestMetrics: request });
    ledger.begin({ ...base, operationId: 'another:node', runId: 'another', projectId: 'another-project' });
    const page = ledger.dispatch('cost.list', { projectId: 'project', limit: 1 }) as { items: UsageRecord[]; nextCursor: number };
    expect(page.items[0].operationId).toBe('run:other');
    const next = ledger.dispatch('cost.list', { projectId: 'project', before: page.nextCursor, limit: 1 }) as { items: UsageRecord[]; nextCursor: null };
    expect(next.items[0].id).toBe(first.id); expect(next.nextCursor).toBeNull();
    const restarted = createCostLedger({ database, store });
    expect(restarted.get('run:other')?.status).toBe('unknown'); expect(restarted.get(base.operationId)?.status).toBe('completed');
    const summary = restarted.dispatch('cost.summary', { projectId: 'project' }) as { total: number; unknownEstimated: number; unknownActual: number; currencies: Array<{ currency: string; estimatedAmount?: number }> };
    expect(summary.total).toBe(2); expect(summary.unknownEstimated).toBe(1); expect(summary.unknownActual).toBe(2); expect(summary.currencies).toEqual([expect.objectContaining({ currency: 'USD', estimatedAmount: .2 })]);
  } finally { database.close(); }
});
