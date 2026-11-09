import { useEffect, useState } from 'react';
import { Check, Circle, LoaderCircle, Pause, TriangleAlert } from 'lucide-react';
import type { RunStepProgress, RunStepSummary } from '@video-quickly/contracts';
import { progressPhaseLabel, runningStep, storyboardPartLabel } from '../lib/run-progress';
import './step-progress.css';

export function ProgressIcon({ status, size = 14 }: { status: string; size?: number }) {
  if (status === 'completed' || status === 'succeeded') return <Check size={size} aria-hidden="true" />;
  if (['failed', 'needs_attention', 'interrupted'].includes(status)) return <TriangleAlert size={size} aria-hidden="true" />;
  if (status === 'canceled') return <Pause size={size} aria-hidden="true" />;
  if (['pending', 'not_recorded', 'skipped'].includes(status)) return <Circle size={size} aria-hidden="true" />;
  return <LoaderCircle size={size} className="spin" aria-hidden="true" />;
}

function elapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
function WaitingTime({ progress, active, startedAt }: { progress?: RunStepProgress; active: boolean; startedAt?: string }) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const start = progress?.startedAt ?? startedAt;
  if (!start) return null;
  const end = active ? clock : Date.parse(progress?.endedAt ?? progress?.updatedAt ?? start);
  return <p className="step-progress__time" aria-live="off"><span>{active ? '已等待' : '本次用时'} {elapsed(end - Date.parse(start))}</span>
    {active && progress?.lastConfirmedAt && <span>最近反馈 {elapsed(clock - Date.parse(progress.lastConfirmedAt))} 前</span>}
  </p>;
}

export default function StepProgress({ step }: { step: RunStepSummary }) {
  const active = runningStep(step.status), progress = step.progress;
  if (!active && (!progress || step.outputAvailable)) return null;
  const count = progress?.total ? `${progress.completed ?? 0} / ${progress.total} ${step.kind === 'assets' ? '张图片' : '个镜头'}已完成` : '';
  const value = progress?.total ? (progress.completed ?? 0) / progress.total : progress?.fraction;
  const label = active ? step.status === 'retry_scheduled' ? '等待恢复' : progressPhaseLabel(progress, step.kind)
    : step.status === 'canceled' ? '制作已停止' : progress?.storyboard ? `${storyboardPartLabel(progress.storyboard)}尚未完成` : '本步骤尚未完成';
  return <section className="step-progress" aria-label="步骤进度" aria-busy={active}>
    <div className="step-progress__heading"><span role="status"><ProgressIcon status={active ? step.status : step.status === 'canceled' ? 'canceled' : 'interrupted'} />{label}</span>{count && <strong>{count}</strong>}{!count && value !== undefined && <strong>{Math.floor(value * 100)}%</strong>}</div>
    {(active || value !== undefined) && <div className="step-progress__bar" data-indeterminate={value === undefined || undefined} role="progressbar" aria-label={count ? '已完成镜头比例' : '步骤完成进度'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === undefined ? undefined : Math.floor(value * 100)}><span style={value === undefined ? undefined : { width: `${value * 100}%` }} /></div>}
    <WaitingTime progress={progress} active={active} startedAt={step.startedAt} />
  </section>;
}
