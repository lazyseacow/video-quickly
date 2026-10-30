import type { RunInspection, RunSummary } from '@video-quickly/contracts';
import { Button } from '../components/Primitives';

export default function RunActions({ inspection, pending, disabled, onPerform, onRestart }: {
  inspection: RunInspection; pending: string; disabled?: boolean;
  onPerform: (method: string, params?: Record<string, unknown>) => void;
  onRestart: (run: RunSummary) => void;
}) {
  const blocked = Boolean(pending) || disabled;
  const { run, recovery } = inspection;
  return <>
    {recovery.review && <><Button static disabled={blocked} onClick={() => onPerform('run.review', { approved: false })}>停止并修改</Button><Button static variant="primary" busy={pending === 'run.review'} disabled={blocked} onClick={() => onPerform('run.review', { approved: true })}>通过审阅并继续</Button></>}
    {recovery.resume && <Button static aria-label="继续执行" variant="primary" busy={pending === 'run.resume'} disabled={blocked} onClick={() => onPerform('run.resume')}>继续</Button>}
    {recovery.cancel && <Button static aria-label="停止制作" disabled={blocked} onClick={() => onPerform('run.cancel')}>停止</Button>}
    {recovery.restart && <Button static disabled={blocked} onClick={() => { if (run.selection) onRestart(run); else onPerform('run.start', { projectId: run.projectId, parentRunId: run.id }); }}>重新制作</Button>}
  </>;
}
