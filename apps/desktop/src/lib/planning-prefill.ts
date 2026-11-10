import { jsonValueSchema, runInspectionSchema, runSummarySchema, type PromptDraft } from '@video-quickly/contracts';
import { rpc } from './client';

const active = new Set(['queued', 'running', 'waiting_external', 'retry_scheduled']);

export async function readPlanningPrefill(draft: PromptDraft, requestId: string, current: () => boolean, settled: () => void, submit: (method: string, params: unknown) => Promise<unknown>) {
  const started = await submit('planning.prefill.start', { ...draft, requestId });
  if (started === null) return undefined;
  let run = runSummarySchema.parse(started);
  if (current() && draft.node.kind === 'script' && ['failed', 'needs_attention'].includes(run.status)) {
    const inspection = runInspectionSchema.parse(await rpc('run.inspect', { runId: run.id }));
    const step = inspection.steps.find(step => step.id === draft.node.id);
    if (current() && step?.progress?.storyboard && step.retry?.allowed) {
      if (await submit('run.step.retry', { runId: run.id, nodeId: step.id }) === null) return undefined;
      run = runSummarySchema.parse(await rpc('run.get', { runId: run.id }));
    }
  }
  while (current() && active.has(run.status) && !(run.status === 'queued' && run.error)) {
    await new Promise(resolve => setTimeout(resolve, 400));
    if (current()) run = runSummarySchema.parse(await rpc('run.get', { runId: run.id }));
  }
  if (!current()) return undefined;
  if (run.status !== 'succeeded') {
    const inspection = runInspectionSchema.parse(await rpc('run.inspect', { runId: run.id }));
    if (!inspection.steps.some(step => step.unknownSubmission || step.progress?.storyboard && step.retry?.allowed) && !active.has(run.status)) settled();
    throw new Error(run.error ?? 'AI 填写未完成，请查看制作记录。');
  }
  const output = jsonValueSchema.parse(await rpc('node.result', { runId: run.id, nodeId: draft.node.id }));
  settled();
  return output;
}
