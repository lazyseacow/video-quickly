import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { modelSchema, projectSchema, runSchema, workflowNodeSchema } from '@video-quickly/contracts';
import { createRuntime } from '../src/packages/runtime/src';

it('automatically chains tasks and rejects the removed review endpoint without scheduling more work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-review-identity-'));
  const provider = vi.fn(async () => JSON.stringify({ shots: [{ title: '分镜结果', narration: '已生成旁白', visualPrompt: '画面', durationUs: 1_000_000 }] }));
  const runtime = createRuntime({ dataDirectory: directory, seed: false, provider });
  try {
    const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '自动串接旧流程' }));
    const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '隔离文本连接', provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'fixture', connectionType: 'text', capabilities: ['text'] } }));
    await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, id: 'identity-custom-review',
      nodes: ['style', 'script'].map(kind => workflowNodeSchema.parse({ id: kind, kind, label: kind, modelId: model.id, requiresReview: true })),
      edges: [{ id: 'next', source: 'style', target: 'script' }],
    } } });
    const started = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id }));
    const current = async () => runSchema.parse(await runtime.dispatch('run.get', { runId: started.id }));
    await runtime.waitForIdle(); const completed = await current(), costs = await runtime.dispatch('cost.summary', { projectId: project.id });
    expect(completed).toMatchObject({ status: 'succeeded' }); expect(provider).toHaveBeenCalledTimes(2);
    const staleApproval = { runId: started.id, approved: true, expectedNodeId: 'style', expectedUpdatedAt: started.updatedAt };
    await expect(runtime.dispatch('run.review', staleApproval)).rejects.toThrow('未知操作');
    await expect(runtime.dispatch('run.review', { runId: started.id, approved: true })).rejects.toThrow('未知操作');
    await runtime.waitForIdle(); expect(await current()).toEqual(completed);
    expect(await runtime.dispatch('cost.summary', { projectId: project.id })).toEqual(costs); expect(provider).toHaveBeenCalledTimes(2);
    const events = await runtime.dispatch('run.events', { runId: started.id }) as { items: { type: string }[] };
    expect(events.items.some(event => event.type === 'review.waiting')).toBe(false);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
