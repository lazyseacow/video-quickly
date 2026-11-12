import { z } from 'zod';
import { runInspectionSchema, type ProjectDocument, type RunRecord } from '@video-quickly/contracts';
import type { DocumentStore } from './database.js';
import type { createExportBatchManager } from './export-batches.js';
import type { createModelResponses } from './model-responses.js';
import type { RunSnapshot } from './run-snapshot.js';
import { canRevalidateStoryboardBatch, storyboardResponseId } from './storyboard-generation.js';

export const runIdInput = z.object({ runId: z.string().min(1) });
const retryStepInput = runIdInput.extend({ nodeId: z.string().min(1) }).strict();

interface RunControlOptions {
  store: DocumentStore;
  run(runId: string): RunRecord;
  project(projectId: string): ProjectDocument;
  isActive(runId: string): boolean;
  abortActive(runId: string): void;
  inspectRun(runId: string): Promise<unknown>;
  projectBusy(projectId: string, exceptBatchId?: string, exceptRunId?: string): boolean;
  batches: Pick<ReturnType<typeof createExportBatchManager>, 'blocked' | 'dispatch'>;
  modelResponses: ReturnType<typeof createModelResponses>;
  updateRun(runId: string, patch: Partial<RunRecord>): void;
  schedule(runId: string, resume: boolean): void;
  recordEvent(runId: string, type: string, message: string, nodeId?: string): void;
  cancelCosts(runId: string): void;
  hydrateRun(run: RunRecord): RunRecord;
}

export function createRunControl({
  store, run, project, isActive, abortActive, inspectRun, projectBusy, batches, modelResponses,
  updateRun, schedule, recordEvent, cancelCosts, hydrateRun,
}: RunControlOptions) {
  function pendingRetry(run: RunRecord, runId: string, nodeId: string) {
    if (!isActive(runId)) return undefined;
    if (run.stepRetry?.status === 'pending' && run.stepRetry.nodeId === nodeId) return hydrateRun(run);
    throw new Error('本次制作仍在执行，请等待当前步骤结束。');
  }

  async function retryStep(rawParams: unknown): Promise<RunRecord> {
    const { runId, nodeId } = retryStepInput.parse(rawParams);
    let value = run(runId);
    const currentRetry = pendingRetry(value, runId, nodeId);
    if (currentRetry) return currentRetry;
    const inspection = runInspectionSchema.parse(await inspectRun(runId));
    const step = inspection.steps.find(step => step.id === nodeId);
    if (!step?.retry?.allowed) throw new Error(step?.retry?.reason || '只能重试本次制作中选中的失败步骤。');
    value = run(runId);
    project(value.projectId);
    const concurrentRetry = pendingRetry(value, runId, nodeId);
    if (concurrentRetry) return concurrentRetry;
    if (value.updatedAt !== inspection.run.updatedAt || value.status !== inspection.run.status || value.currentNodeId !== nodeId) throw new Error('步骤状态已变化，请刷新后重试。');
    if (batches.blocked(value.projectId) || projectBusy(value.projectId, undefined, runId)) throw new Error('该项目已有其他未完成的运行，请先处理现有任务。');
    const previousRetry = value.stepRetry;
    const storyboard = step.progress?.storyboard;
    const responseId = storyboardResponseId(runId, nodeId, storyboard);
    const batchProject = storyboard?.kind === 'batch' ? store.get<ProjectDocument>('node-project', `${runId}:${nodeId}`) : undefined;
    const revalidate = batchProject && canRevalidateStoryboardBatch(batchProject, modelResponses, responseId);
    const restoreResponse = revalidate ? undefined : modelResponses.prepareRetry(responseId);
    updateRun(runId, { stepRetry: { nodeId, status: 'pending' } });
    try {
      updateRun(runId, { status: 'queued', error: undefined }); schedule(runId, true);
    } catch (error) {
      if (!isActive(runId)) { restoreResponse?.(); updateRun(runId, { stepRetry: previousRetry }); }
      throw error;
    }
    recordEvent(runId, 'run.step_retry_requested', `仅重试：${step.label}`, nodeId);
    return hydrateRun(run(runId));
  }

  async function resume(rawParams: unknown): Promise<RunRecord> {
    const { runId } = runIdInput.parse(rawParams); const value = run(runId);
    project(value.projectId);
    const saved = store.get<RunSnapshot>('run-snapshot', runId);
    if (saved?.exportBatch) { await batches.dispatch('render.batch.resume', { batchId: saved.exportBatch.batchId }); return hydrateRun(run(runId)); }
    if (batches.blocked(value.projectId)) throw new Error('请先继续或取消当前批量导出，再恢复其他运行。');
    if (['succeeded', 'canceled'].includes(value.status)) throw new Error('该运行已经结束，请创建新的运行。');
    if (projectBusy(value.projectId, undefined, runId)) throw new Error('该项目已有其他未完成的运行，请先处理现有任务。');
    schedule(runId, true); return hydrateRun(run(runId));
  }

  async function cancel(rawParams: unknown): Promise<RunRecord> {
    const { runId } = runIdInput.parse(rawParams); const value = run(runId);
    const saved = store.get<RunSnapshot>('run-snapshot', runId);
    if (saved?.exportBatch) { await batches.dispatch('render.batch.cancel', { batchId: saved.exportBatch.batchId }); return hydrateRun(run(runId)); }
    if (value.status === 'succeeded') return hydrateRun(value);
    updateRun(runId, { status: 'canceled' }); abortActive(runId);
    cancelCosts(runId);
    recordEvent(runId, 'run.canceled', '本地执行已停止；已提交的远端任务需按服务能力核对。');
    return hydrateRun(run(runId));
  }

  return { retryStep, resume, cancel };
}
