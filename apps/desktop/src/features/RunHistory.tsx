import { lazy, Suspense, useState } from 'react';
import { CheckCheck, ChevronDown, History, RefreshCw, RotateCcw, Square } from 'lucide-react';
import { recordPageSchema, runSummarySchema, type RunSummary } from '@video-quickly/contracts';
import { Button, Dialog, EmptyState, Notice, Status } from '../components/Primitives';
import { useRecordPage } from '../lib/use-record-page';
import type { Action, StepOutputSelection, WorkspaceView } from '../lib/types';

const runsSchema = recordPageSchema(runSummarySchema);
const RunInspector = lazy(() => import('./RunInspector'));
const RunScopeDialog = lazy(() => import('../components/RunScopeDialog'));

export default function RunsPage({ workspace, action, onOpen, onOpenOutput }: { workspace: WorkspaceView; action: Action; onOpen: (id: string) => void; onOpenOutput: (selection: StepOutputSelection) => void }) {
  const history = useRecordPage('run.list', {}, workspace.version, runsSchema);
  const [replay, setReplay] = useState<unknown | null>(null);
  const [inspectedRunId, setInspectedRunId] = useState<string>();
  const [restartRun, setRestartRun] = useState<RunSummary>();
  return <div className="content-page"><div className="page-heading"><div><h1>制作记录</h1><p>查看每一步的执行结果，审阅小样，或从中断处继续。</p></div><Button busy={history.busy} onClick={history.refresh}><RefreshCw size={15} />刷新</Button></div>
    {history.error && <Notice kind="error">{history.error}</Notice>}
    {history.items.map(run => {
      const project = workspace.projects.find(item => item.id === run.projectId);
      const completed = run.completedNodeIds.length;
      return <article className="run-card" key={run.id} data-run-id={run.id}><div className="run-card__header"><History size={17} /><h3>{project?.title ?? '项目制作'}</h3><Status value={run.status} /></div><div className="run-card__meta"><span>{new Date(run.createdAt).toLocaleString('zh-CN')}</span><span>修订 {run.projectRevision} · 流程 v{run.workflowVersion}</span><span>{completed} 个步骤已完成</span>{run.selection && <span>{run.selection.mode === 'node' ? '单步骤执行' : '所选步骤及后续'}</span>}</div>
        {run.error && <div className="run-error"><Notice kind="error">{run.error}</Notice></div>}<div className="progress-line"><span style={{ width: `${run.status === 'succeeded' ? 100 : Math.min(100, completed / Math.max(1, run.stepCount ?? project?.workflowNodeCount ?? 1) * 100)}%` }} /></div>
        <div className="run-card__actions">{run.status === 'waiting_review' && <><Button variant="primary" onClick={() => void action('run.review', { runId: run.id, approved: true }, '审阅已通过，继续制作')}><CheckCheck size={15} />通过审阅</Button><Button onClick={() => void action('run.review', { runId: run.id, approved: false }, '已保留当前结果')}><Square size={14} />停止并修改</Button></>}
          {['failed', 'needs_attention', 'waiting_external', 'queued'].includes(run.status) && <Button aria-label="继续执行" variant="primary" onClick={() => void action('run.resume', { runId: run.id }, '已请求继续执行')}><RotateCcw size={15} />继续</Button>}
          {['running', 'queued', 'waiting_external', 'retry_scheduled'].includes(run.status) && <Button onClick={() => void action('run.cancel', { runId: run.id }, '已请求停止')}><Square size={14} />停止</Button>}
          {run.status === 'canceled' && <Button onClick={() => { if (run.selection) setRestartRun(run); else void action('run.start', { projectId: run.projectId, parentRunId: run.id }, '已请求重新制作'); }}><RotateCcw size={15} />重新制作</Button>}
          <Button onClick={() => setInspectedRunId(run.id)}>查看步骤</Button><Button onClick={() => void action('run.replay', { runId: run.id }).then(result => { if (result !== null) setReplay(result); })}><History size={15} />重放检查</Button><Button variant="ghost" onClick={() => onOpen(run.projectId)}>打开项目</Button>
        </div>
      </article>;
    })}
    {!history.items.length && !history.busy && !history.error && <div className="section-card"><EmptyState icon={<History size={25} />} title="还没有制作记录" description="制作后可在此查看步骤、审阅和恢复任务。" /></div>}
    {history.nextCursor !== null && <Button aria-label="加载更多制作记录" className="button-full" busy={history.busy} onClick={() => void history.loadMore()}><ChevronDown size={15} />加载更多</Button>}
    {replay !== null && <Dialog title="重放检查结果" onClose={() => setReplay(null)} className="dialog--wide"><div className="dialog__body"><Notice>本次只读取历史记录，不提交生成或渲染任务。</Notice><pre className="run-log">{typeof replay === 'string' ? replay : JSON.stringify(replay, null, 2)}</pre></div><div className="dialog__footer"><Button onClick={() => setReplay(null)}>关闭</Button></div></Dialog>}
    {inspectedRunId && <Suspense fallback={<Notice>正在打开步骤详情…</Notice>}><RunInspector onRestart={run => { setInspectedRunId(undefined); setRestartRun(run); }} runId={inspectedRunId} version={workspace.version} onClose={() => setInspectedRunId(undefined)} onChanged={history.refresh} onOpenOutput={selection => { setInspectedRunId(undefined); onOpenOutput(selection); }} /></Suspense>}
    {restartRun?.selection && <Suspense fallback={<Notice>正在打开执行范围…</Notice>}><RunScopeDialog projectId={restartRun.projectId} nodeId={restartRun.selection.nodeId} initialMode={restartRun.selection.mode} parentRunId={restartRun.id} version={workspace.version} onClose={() => setRestartRun(undefined)} onStarted={history.refresh} /></Suspense>}
  </div>;
}
