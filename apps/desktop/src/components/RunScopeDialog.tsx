import { useEffect, useRef, useState } from 'react';
import { GitBranch, Play, RefreshCw } from 'lucide-react';
import { runPlanSchema, runSchema, type RunRecord, type RunSelection } from '@video-quickly/contracts';
import { Button, Dialog, Notice } from './Primitives';
import { rpc } from '../lib/client';
import { useRuntimeRead } from '../lib/use-runtime-read';
import './run-scope.css';

export default function RunScopeDialog({ projectId, nodeId, initialMode = 'downstream', parentRunId, version, onClose, onStarted }: {
  projectId: string; nodeId: string; initialMode?: RunSelection['mode']; parentRunId?: string; version: number;
  onClose: () => void; onStarted: (run: RunRecord) => void;
}) {
  const [mode, setMode] = useState(initialMode), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const read = useRuntimeRead('run.plan', { projectId, selection: { nodeId, mode } }, version, runPlanSchema), plan = read.data;
  async function start() {
    if (!plan || busy || read.busy || read.error || plan.blockedReason) return;
    setBusy(true); setError('');
    try {
      const run = runSchema.parse(await rpc('run.start', { projectId, selection: { ...plan.selection, previewDigest: plan.digest }, ...(parentRunId ? { parentRunId } : {}) }));
      onStarted(run); if (mounted.current) onClose();
    } catch (error) {
      if (mounted.current) { setError(error instanceof Error ? error.message : String(error)); read.refresh(); }
    } finally { if (mounted.current) setBusy(false); }
  }
  return <Dialog title="执行范围" onClose={onClose} className="dialog--wide run-scope-dialog">
    <div className="dialog__body">
      {error && <Notice kind="error">{error}</Notice>}
      {read.error && <Notice kind="error">{read.error}</Notice>}
      <p className="run-scope-intro">基于已保存的项目创建新任务。步骤结果单独保存，可在制作记录中比较并应用。</p>
      {parentRunId ? <p className="run-scope-intro">沿用原任务范围：{mode === 'node' ? '仅此步骤' : '此步骤及后续'}。</p> : <fieldset className="run-scope-options" disabled={busy}>
        <legend>执行方式</legend>
        <label className="field-inline"><input type="radio" name="run-scope-mode" checked={mode === 'node'} onChange={() => setMode('node')} />仅此步骤</label>
        <label className="field-inline"><input type="radio" name="run-scope-mode" checked={mode === 'downstream'} onChange={() => setMode('downstream')} />此步骤及后续</label>
      </fieldset>}
      {read.busy && <p role="status" className="run-scope-intro">正在核对执行范围…</p>}
      {plan && <>
        <dl className="run-scope-summary"><div><dt>项目修订</dt><dd>{plan.projectRevision}</dd></div><div><dt>流程版本</dt><dd>{plan.workflowVersion}</dd></div><div><dt>涉及步骤</dt><dd>{plan.steps.length}</dd></div><div><dt>锁定镜头</dt><dd>{plan.lockedShotCount}</dd></div></dl>
        {plan.blockedReason && <Notice>{plan.blockedReason}</Notice>}
        {plan.hasConditions && <Notice>条件分支显示全部可能受影响的步骤，实际按条件执行。</Notice>}
        <ol className="run-scope-steps" aria-label="将执行的步骤">{plan.steps.map((step, index) => <li key={step.id}><span className="run-scope-index">{index + 1}</span><div><strong>{step.label}</strong><small>{step.modelName ?? '本地处理'}</small></div>{step.requiresReview && <span className="run-scope-tag">需审阅</span>}{step.kind === 'export' && <span className="run-scope-tag">导出文件</span>}</li>)}</ol>
        {plan.boundary.length > 0 && <details className="run-scope-boundary"><summary><GitBranch size={14} aria-hidden="true" />沿用已保存的上游内容</summary><p>这些上游步骤不重新执行，相关输入取自已保存的项目。</p><ul>{plan.boundary.map((edge, index) => <li key={index}>{edge.targetLabel} ← {edge.sourceLabel}</li>)}</ul></details>}
      </>}
    </div>
    <div className="dialog__footer"><Button onClick={onClose}>{busy ? '关闭' : '取消'}</Button><Button busy={read.busy} disabled={busy} onClick={read.refresh}><RefreshCw size={14} />重新预览</Button><Button variant="primary" busy={busy} disabled={!plan || read.busy || Boolean(read.error || plan.blockedReason)} onClick={() => void start()}><Play size={14} />确认执行</Button></div>
  </Dialog>;
}
