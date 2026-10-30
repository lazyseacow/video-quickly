import { recordPageSchema, runInspectionSchema, runSummarySchema } from '@video-quickly/contracts';

type Dispatch = (method: string, params: unknown) => Promise<unknown>;

/** Locate the committed run when its start response was lost before evidence was flushed. */
export async function committedPhaseRun(dispatch: Dispatch, projectId: string, phase: string, nodeId: string, revision: number) {
  const matches: string[] = []; let before: number | undefined;
  for (;;) {
    const page = recordPageSchema(runSummarySchema).parse(await dispatch('run.list', { projectId, before, limit: 100 }));
    for (const run of page.items) {
      if (run.projectId !== projectId || run.projectRevision !== revision) continue;
      const inspection = runInspectionSchema.parse(await dispatch('run.inspect', { runId: run.id, nodeId }));
      if (inspection.steps.length === 1 && inspection.steps[0].id === nodeId && (!phase.startsWith('asr:') || inspection.selected?.node.config.shotId === phase.slice(4))) matches.push(run.id);
    }
    if (matches.length > 1) throw new Error('发现多个原阶段运行，需人工核对，未重新提交。');
    if (page.nextCursor === null) return matches[0];
    if (page.nextCursor === before) throw new Error('运行分页游标未推进，未重新提交。');
    before = page.nextCursor;
  }
}

export async function resumePhaseRun(dispatch: Dispatch, id: string) {
  const run = runSummarySchema.parse(await dispatch('run.get', { runId: id }));
  if (run.status === 'succeeded' || run.status === 'running') return;
  const inspection = runInspectionSchema.parse(await dispatch('run.inspect', { runId: id }));
  if (inspection.steps.some(step => step.unknownSubmission) || !inspection.recovery.resume) throw new Error('原运行需要核对提交结果或人工审阅，未自动再次 POST。');
  await dispatch('run.resume', { runId: id });
}
