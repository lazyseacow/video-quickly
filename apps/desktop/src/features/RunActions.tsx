import type { RunInspection, RunSummary } from '@video-quickly/contracts';
import { Button } from '../components/Primitives';

export default function RunActions({ inspection, pending, disabled, onPerform, onRestart }: {
  inspection: RunInspection; pending: string; disabled?: boolean;
  onPerform: (method: string, params?: Record<string, unknown>) => void;
  onRestart: (run: RunSummary) => void;
}) {
  const blocked = Boolean(pending) || disabled;
  const { run, recovery } = inspection;
  // A pointer press stays bound to the checkpoint the user saw when it began.
  const reviewTarget = { expectedNodeId: run.currentNodeId, expectedUpdatedAt: run.updatedAt };
  return <>
    {recovery.review && <><Button key={JSON.stringify([run.id, run.currentNodeId, run.updatedAt, false])} static disabled={blocked} onClick={() => onPerform('run.review', { ...reviewTarget, approved: false })}>停止并修改</Button><Button key={JSON.stringify([run.id, run.currentNodeId, run.updatedAt, true])} static variant="primary" busy={pending === 'run.review'} disabled={blocked} onClick={() => onPerform('run.review', { ...reviewTarget, approved: true })}>通过审阅并继续</Button></>}
    {recovery.resume && <Button static aria-label="继续执行" variant="primary" busy={pending === 'run.resume'} disabled={blocked} onClick={() => onPerform('run.resume')}>继续</Button>}
    {recovery.cancel && <Button static aria-label="停止制作" disabled={blocked} onClick={() => onPerform('run.cancel')}>停止</Button>}
    {recovery.restart && <Button static disabled={blocked} onClick={() => { if (run.selection) onRestart(run); else onPerform('run.start', { projectId: run.projectId, parentRunId: run.id }); }}>重新制作</Button>}
  </>;
}
