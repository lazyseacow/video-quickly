import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { costSummarySchema, getMediaAdapters, getModelPlatform, modelPlatforms, modelSchema, providerReportedUsage, sumProviderUsage } from '@video-quickly/contracts';
import { createCostLedger } from '../packages/runtime/src/costs';
import { DocumentStore, openDatabase } from '../packages/runtime/src/database';

it('records explicit input and output cache counters, retains zeroes and does not confuse cache creation with output cache', () => {
  expect(providerReportedUsage({ usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { cached_tokens: 5 } } })).toEqual({ source: 'provider', inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cachedOutputTokens: 5 });
  expect(providerReportedUsage({ usage: { prompt_tokens: 50, prompt_cache_hit_tokens: 30, cache_creation_input_tokens: 20 } })).toMatchObject({ inputTokens: 50, cachedInputTokens: 30 });
  expect(providerReportedUsage({ usage: { prompt_tokens: 50, cache_creation_input_tokens: 20 } })?.cachedOutputTokens).toBeUndefined();
  expect(providerReportedUsage({ usage: { prompt_tokens: -1, completion_tokens: '20', prompt_tokens_details: { cached_tokens: NaN } } })).toBeUndefined();
  expect(providerReportedUsage({ usage: {} })).toBeUndefined();
  expect(providerReportedUsage({ usage: { input_tokens: 7, output_tokens: 11, input_tokens_details: { cached_tokens: 2 } } })).toMatchObject({ inputTokens: 7, outputTokens: 11, cachedInputTokens: 2 });
  expect(providerReportedUsage({ usage: { input_tokens: 7, output_tokens: 11, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } })).toMatchObject({ inputTokens: 12, outputTokens: 11, cachedInputTokens: 2 });
  expect(providerReportedUsage({ usage: { input_tokens: 7, cache_read_input_tokens: 2 } })?.inputTokens).toBeUndefined();
});

it('does not invent media batch totals when only some calls reported a counter', () => {
  expect(sumProviderUsage([{ source: 'provider', inputTokens: 10, cachedInputTokens: 0 }, { source: 'provider', inputTokens: 20 }])).toMatchObject({ inputTokens: 30 });
  expect(sumProviderUsage([{ source: 'provider', inputTokens: 10, cachedInputTokens: 0 }, { source: 'provider', inputTokens: 20 }])?.cachedInputTokens).toBeUndefined();
  expect(sumProviderUsage([{ source: 'provider', inputTokens: 10 }, undefined])).toBeUndefined();
  expect(sumProviderUsage([])).toBeUndefined();
  expect(sumProviderUsage([{ source: 'provider', characters: 4 }, { source: 'provider', characters: 6 }])).toEqual({ source: 'provider', characters: 10 });
});

it('aggregates counters across every task record, keeps partial coverage and preserves counts through recovery without duplication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-token-ledger-'));
  const database = openDatabase(directory), store = new DocumentStore(database);
  try {
    const ledger = createCostLedger({ database, store });
    const model = modelSchema.parse({ id: 'model', name: '模型', provider: 'openai-compatible', platform: 'deepseek', baseUrl: 'http://localhost:1234', model: 'fixture', capabilities: ['text'], pricing: { currency: 'USD', inputPerMillionTokens: 9 }, createdAt: 'now', updatedAt: 'now' });
    const base = { runId: 'task', projectId: 'project', nodeId: 'brief', model, capability: 'text' as const, requestMetrics: { source: 'request' as const, requestCount: 1 } };
    const first = ledger.begin({ ...base, operationId: 'first' });
    const usage = { source: 'provider' as const, inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cachedOutputTokens: 5 };
    const completed = ledger.status('first', 'completed', usage)!;
    expect(ledger.status('first', 'completed', usage)).toEqual(completed);
    expect(ledger.begin({ ...base, operationId: 'first' }).id).toBe(first.id);
    ledger.begin({ ...base, operationId: 'second' });
    ledger.status('second', 'completed', { source: 'provider', inputTokens: 50 });
    ledger.begin({ ...base, runId: 'other-task', operationId: 'third' });
    const summary = costSummarySchema.parse(ledger.dispatch('cost.summary', { runId: 'task' }));
    expect(summary.tokens).toEqual({ inputTokens: 150, outputTokens: 20, cachedInputTokens: 0, cachedOutputTokens: 5 });
    expect(summary.tokenRecords).toEqual({ inputTokens: 2, outputTokens: 1, cachedInputTokens: 1, cachedOutputTokens: 1 });
    expect(summary.total).toBe(2); expect(summary.currencies).toEqual([]); expect(completed.estimatedAmount).toBeUndefined();
    expect(completed.platform).toBe('deepseek');
    const restored = createCostLedger({ database, store });
    expect(costSummarySchema.parse(restored.dispatch('cost.summary', { runId: 'task' }))).toEqual(summary);
    expect(costSummarySchema.parse(restored.dispatch('cost.summary', { projectId: 'missing' })).tokens).toEqual({});
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

it('infers legacy platform identities and keeps an explicit platform on a custom proxy', () => {
  expect(getModelPlatform({ provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com' }).id).toBe('deepseek');
  expect(getModelPlatform({ provider: 'openai-compatible', baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }).id).toBe('qwen');
  expect(getModelPlatform({ provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com.example.org' }).id).toBe('custom');
  expect(getModelPlatform({ platform: 'anthropic', provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' }).id).toBe('anthropic');
});

it('separates new platform defaults from stored protocols and filters adapters by all selected media capabilities', () => {
  const legacy = modelSchema.parse({ id: 'legacy', name: '旧连接', platform: 'anthropic', provider: 'openai-compatible', baseUrl: 'http://localhost/v1', model: 'fixture', capabilities: ['text'], createdAt: '', updatedAt: '' });
  expect(legacy.textProtocol).toBeUndefined(); expect(modelPlatforms.find(platform => platform.id === 'anthropic')?.textProtocol).toBe('messages');
  expect(modelSchema.safeParse({ ...legacy, textProtocol: 'unknown' }).success).toBe(false);
  expect(getMediaAdapters(['text', 'image', 'video']).map(adapter => adapter.id)).toEqual(['openai-compatible', 'comfyui', 'custom-http']);
  expect(getMediaAdapters(['asr']).map(adapter => adapter.id)).toEqual(['openai-compatible', 'volcengine-asr']); expect(getMediaAdapters(['text'])).toEqual([]);
});
