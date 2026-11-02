import { lazy, Suspense, useRef, useState } from 'react';
import { Check, ChevronRight, RefreshCw } from 'lucide-react';
import { runInspectionSchema, type RunSummary } from '@video-quickly/contracts';
import { Button, Notice, Status, statusLabels } from '../components/Primitives';
import { useRuntimeRead } from '../lib/use-runtime-read';
import type { Action, StepOutputSelection } from '../lib/types';
import { stepGuidance } from '../lib/workflow-guidance';
import RunActions from './RunActions';
import './workbench-production.css';

const RunInspector = lazy(() => import('./RunInspector'));
const RunScopeDialog = lazy(() => import('../components/RunScopeDialog'));

export default function WorkbenchProduction({ run, version, action, onOpenOutput, onPausePreview }: {
  run: RunSummary; version: number; action: Action;
  onOpenOutput: (selection: StepOutputSelection) => void; onPausePreview: () => void;
}) {
  const inspection = useRuntimeRead('run.inspect', { runId: run.id }, version, runInspectionSchema);
  const [inspectedStep, setInspectedStep] = useState<string | null>(null);
  const [restart, setRestart] = useState<RunSummary>();
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const data = inspection.data;
  const steps = data?.steps ?? [];
  const current = steps.find(step => step.id === run.currentNodeId);
  const usefulOutput = steps.findLast(step => step.outputAvailable && ['script', 'style', 'assets', 'voice', 'animation', 'research', 'export'].includes(step.kind));
  const output = current?.outputAvailable && !['review', 'brief', 'condition', 'join'].includes(current.kind) ? current : usefulOutput ?? steps.findLast(step => step.outputAvailable);
  const reviewHint = current?.kind === 'voice' ? '核对音频、文字内容和时间对齐。' : current ? stepGuidance({ kind: current.kind, config: {} }).review : '核对本步产物是否符合创作要求。';
  const completed = steps.filter(step => step.status === 'succeeded' || step.status === 'skipped').length;
  const synchronized = Boolean(data && data.run.status === run.status && data.run.updatedAt === run.updatedAt && data.run.currentNodeId === run.currentNodeId);
  // A completed matching inspection stays actionable during a background read.
  const blocked = Boolean(inspection.error) || !synchronized;
  function inspect(nodeId = run.currentNodeId ?? '') { onPausePreview(); setInspectedStep(nodeId); }
  async function perform(method: string, params: Record<string, unknown> = {}) {
    if (inFlight.current || blocked) return;
    inFlight.current = true; setPending(method); setError('');
    try {
      const result = await action(method, { runId: run.id, ...params }, method === 'run.review'
        ? params.approved ? '审阅已通过，继续制作' : '已保留当前结果，可在工作台继续修改'
        : method === 'run.cancel' ? '已请求停止制作' : '已请求继续制作');
      if (result === null) setError('操作未完成，请核对提示后重试。');
      inspection.refresh();
    } finally { inFlight.current = false; setPending(''); }
  }
  return <section className="workbench-production" aria-label="当前制作">
    <div className="workbench-production__summary">
      <div className="workbench-production__heading"><span>当前制作</span><strong>{current?.label ?? (run.status === 'succeeded' ? '本次制作已完成' : '项目制作')}</strong><Status value={run.status} />{steps.length > 0 && <span className="workbench-production__count">{completed} / {steps.length} 步</span>}</div>
      <Button static variant="ghost" onClick={() => inspect()}>制作详情<ChevronRight size={14} /></Button>
    </div>
    {steps.length > 0 && <ol className="workbench-production__steps" aria-label="制作步骤进度">{steps.map((step, index) => {
      const state = step.id === run.currentNodeId && run.status === 'waiting_review' ? '等待审阅' : statusLabels[step.status] ?? (step.status === 'skipped' ? '已跳过' : step.status === 'not_recorded' ? '未记录' : '待执行');
      return <li key={step.id}><button type="button" aria-current={step.id === run.currentNodeId ? 'step' : undefined} data-state={step.status} onClick={() => inspect(step.id)}><span>{step.status === 'succeeded' ? <Check size={12} aria-hidden="true" /> : index + 1}</span><span className="workbench-production__step-copy"><strong>{step.label}</strong><small>{state}</small></span></button></li>;
    })}</ol>}
    {(run.error || data?.recovery.reason) && <p className="workbench-production__reason">{run.error || data?.recovery.reason}</p>}
    {inspection.error && <Notice kind="error">{inspection.error}<Button static onClick={inspection.refresh}><RefreshCw size={14} />重试读取制作进度</Button></Notice>}
    {error && <Notice kind="error">{error}</Notice>}
    <div className="workbench-production__actions">
      <span className="workbench-production__hint">{run.status === 'waiting_review' ? `审阅重点：${reviewHint}` : run.status === 'canceled' ? '下一步：调整镜头或流程后重新制作。' : run.status === 'succeeded' ? output?.kind === 'export' ? '成片已生成，查看产物确认输出文件。' : output ? '下一步：查看并应用所需产物，再导出成片。' : '本次制作已完成，可在制作详情中核对结果。' : ['failed', 'needs_attention'].includes(run.status) ? '下一步：查看制作详情，核对问题后继续或调整配置。' : '当前步骤完成后会保留产物，进度将自动更新。'}</span>
      <div className="workbench-production__buttons">
        {output && <Button static disabled={blocked || Boolean(pending)} onClick={() => { onPausePreview(); onOpenOutput({ projectId: run.projectId, runId: run.id, nodeId: output.id, kind: output.kind }); }}>查看产物</Button>}
        {data && <RunActions inspection={data} pending={pending} disabled={blocked} onPerform={(method, params) => void perform(method, params)} onRestart={value => { onPausePreview(); setRestart(value); }} />}
      </div>
    </div>
    {run.status === 'waiting_review' && <p className="workbench-production__hint workbench-production__apply-hint">通过审阅会继续流程；产物中的“应用”才会更新当前项目。</p>}
    {inspectedStep !== null && <Suspense fallback={<p role="status">正在打开制作详情…</p>}><RunInspector runId={run.id} initialNodeId={inspectedStep || undefined} version={version} onClose={() => setInspectedStep(null)} onChanged={inspection.refresh} onOpenOutput={selection => { setInspectedStep(null); onOpenOutput(selection); }} onRestart={value => { setInspectedStep(null); setRestart(value); }} /></Suspense>}
    {restart?.selection && <Suspense fallback={<p role="status">正在打开执行范围…</p>}><RunScopeDialog projectId={restart.projectId} nodeId={restart.selection.nodeId} initialMode={restart.selection.mode} parentRunId={restart.id} version={version} onClose={() => setRestart(undefined)} onStarted={() => setRestart(undefined)} /></Suspense>}
  </section>;
}
