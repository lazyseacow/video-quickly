import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { modelSchema, shotSchema } from '@video-quickly/contracts';
import { createCostLedger } from '../src/costs.js';
import { createCreativePreviewRecommender, type CreativePreviewRecommendationSource } from '../src/creative-preview-recommender.js';
import { DocumentStore, openDatabase } from '../src/database.js';
import { createModelResponses } from '../src/model-responses.js';
import type { TextProvider } from '../src/providers.js';

let directory: string;
let database: ReturnType<typeof openDatabase> | undefined;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'vq-preview-recommendation-')); });
afterEach(async () => {
  database?.close();
  database = undefined;
  await rm(directory, { recursive: true, force: true });
});

const source: CreativePreviewRecommendationSource = {
  revision: 'storyboard-v1', projectId: 'episode', goal: '在雨夜车站寻找信件，重点预演线索出现。',
  model: modelSchema.parse({ id: 'text', name: 'Local text fixture', provider: 'openai-compatible', connectionType: 'text',
    baseUrl: 'http://127.0.0.1:1420/v1', model: 'fixture-text', capabilities: ['text', 'structured-output'], createdAt: '', updatedAt: '' }),
  shots: [
    shotSchema.parse({ id: 'entry', title: '进站', narration: '', visualPrompt: '车站连廊。', durationUs: 2_000_000 }),
    shotSchema.parse({ id: 'reveal', title: '发现湿漉漉的信封', narration: '信竟然还在。', visualPrompt: '旧灯照亮信封折痕。', durationUs: 5_000_000 }),
    shotSchema.parse({ id: 'exit', title: '离开车站', narration: '', visualPrompt: '雨伞转过街角。', durationUs: 3_000_000, locked: true }),
  ],
};
const proposed = { recommendations: [{ shotId: 'reveal', reason: '可确认线索从暗处露出的瞬间。' }] };
const input = () => ({ runId: 'storyboard-run', revision: source.revision, requestId: randomUUID() });

function open(provider: TextProvider, readSource = () => source) {
  database?.close();
  database = openDatabase(directory);
  const store = new DocumentStore(database);
  const costs = createCostLedger({ database, store });
  const recommender = createCreativePreviewRecommender({ store, costs, responses: createModelResponses(store), provider,
    readSource, resolveSecret: async () => undefined });
  return { recommender, costs };
}

it('recommends from the actual storyboard once, recovers the result and rejects a superseded version', async () => {
  const provider = vi.fn<TextProvider>(async () => JSON.stringify(proposed));
  const { recommender, costs } = open(provider);
  const request = input();
  expect(recommender.modelFor(request).id).toBe('text');
  const [result, duplicate] = await Promise.all([recommender.recommend(request), recommender.recommend(input())]);
  expect(duplicate).toEqual(result);
  expect(result).toEqual({ revision: request.revision, ...proposed });
  expect(provider).toHaveBeenCalledTimes(1);
  const [{ prompt, outputSchemaName, operationId }] = provider.mock.calls[0];
  expect(prompt).toContain(source.goal);
  expect(prompt).toContain(source.shots[1].title);
  expect(prompt).toContain(source.shots[1].visualPrompt);
  expect(prompt).toContain(source.shots[1].narration);
  expect(outputSchemaName).toBe('creative_preview_recommendation');
  expect(costs.get(operationId)).toMatchObject({ runId: request.runId, projectId: source.projectId, status: 'completed' });

  const reopened = open(provider).recommender;
  expect(reopened.get(request.runId, request.revision)).toEqual(result);
  expect(reopened.hasSubmission(input())).toBe(true);
  await expect(reopened.recommend(input())).resolves.toEqual(result);
  const edited = open(provider, () => ({ ...source, revision: 'storyboard-v2' })).recommender;
  expect(() => edited.recommend(input())).toThrow('分镜已变更');
  expect(edited.get(request.runId, 'storyboard-v2')).toBeUndefined();
  expect(provider).toHaveBeenCalledTimes(1);
});

it('records unsafe or duplicate model shot IDs as an invalid answer and allows an explicit retry', async () => {
  const provider = vi.fn<TextProvider>()
    .mockResolvedValueOnce(JSON.stringify({ recommendations: [
      { shotId: 'outside', reason: '不在分镜内。' }, { ...proposed.recommendations[0] }, { ...proposed.recommendations[0] },
    ] })).mockResolvedValueOnce(JSON.stringify(proposed));
  const { recommender } = open(provider);
  const original = input();
  await expect(recommender.recommend(original)).rejects.toThrow(/可选的镜头.*镜头不能重复/);
  expect(recommender.get(original.runId, original.revision)).toBeUndefined();
  expect(recommender.hasSubmission(original)).toBe(true);
  const retry = input();
  expect(recommender.hasSubmission(retry)).toBe(false);
  await expect(recommender.recommend(retry)).resolves.toEqual({ revision: retry.revision, ...proposed });
  expect(provider).toHaveBeenCalledTimes(2);
});

it('does not send a replacement for an unresolved recommendation after restart', async () => {
  const provider = vi.fn<TextProvider>().mockRejectedValue(new Error('provider disconnected'));
  const { recommender } = open(provider);
  await expect(recommender.recommend(input())).rejects.toThrow('provider disconnected');
  const reopened = open(provider);
  const retry = input();
  expect(reopened.recommender.hasSubmission(retry)).toBe(true);
  await expect(reopened.recommender.recommend(retry)).rejects.toThrow('尚未保存完整返回');
  expect(reopened.costs.get(provider.mock.calls[0][0].operationId)?.status).toBe('unknown');
  expect(provider).toHaveBeenCalledTimes(1);
});
