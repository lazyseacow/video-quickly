import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { modelSchema, projectSchema, runSchema, workflowNodeSchema } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src';

it('rejects an approval for an older review without approving the next checkpoint or scheduling more work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-review-identity-'));
  const provider = vi.fn(async () => JSON.stringify({ shots: [{ title: '分镜结果', narration: '已生成旁白', visualPrompt: '画面', durationUs: 1_000_000 }] }));
  const runtime = createRuntime({ dataDirectory: directory, seed: false, provider });
  try {
    const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '按实际审阅版本批准' }));
    const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '隔离文本连接', provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'fixture', capabilities: ['text'] } }));
    await runtime.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow: { ...project.workflow,
      nodes: ['style', 'script'].map(kind => workflowNodeSchema.parse({ id: kind, kind, label: kind, modelId: model.id, requiresReview: true })),
      edges: [{ id: 'next', source: 'style', target: 'script' }],
    } });
    const started = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id }));
    const current = async () => runSchema.parse(await runtime.dispatch('run.get', { runId: started.id }));
    await runtime.waitForIdle(); const first = await current();
    expect(first).toMatchObject({ status: 'waiting_review', currentNodeId: 'style' }); expect(provider).toHaveBeenCalledTimes(1);
    const firstApproval = { runId: started.id, approved: true, expectedNodeId: first.currentNodeId, expectedUpdatedAt: first.updatedAt };
    await runtime.dispatch('run.review', firstApproval); await runtime.waitForIdle();
    const second = await current(), costs = await runtime.dispatch('cost.summary', { projectId: project.id });
    expect(second).toMatchObject({ status: 'waiting_review', currentNodeId: 'script' }); expect(provider).toHaveBeenCalledTimes(2);
    await expect(runtime.dispatch('run.review', firstApproval)).rejects.toThrow('制作进度已变化');
    await expect(runtime.dispatch('run.review', { ...firstApproval, expectedNodeId: second.currentNodeId, expectedUpdatedAt: 'older-review-version' })).rejects.toThrow('制作进度已变化');
    await runtime.waitForIdle(); expect(await current()).toEqual(second);
    expect(await runtime.dispatch('cost.summary', { projectId: project.id })).toEqual(costs); expect(provider).toHaveBeenCalledTimes(2);
    // Existing callers may still explicitly approve the current review without a version token.
    await runtime.dispatch('run.review', { runId: started.id, approved: true }); await runtime.waitForIdle();
    expect(await current()).toMatchObject({ status: 'succeeded' }); expect(provider).toHaveBeenCalledTimes(2);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
