import { lazy, Suspense, useRef, useState } from 'react';
import { ChevronDown, FolderOpen, History, ListTree, Play, RefreshCw, RotateCcw, Square, Trash2 } from 'lucide-react';
import { isRunActive, recordPageSchema, runStatusSchema, runSummarySchema, type RunSummary } from '@video-quickly/contracts';
import { useConfirmation } from '../components/ConfirmationDialog';
import { Button, EmptyState, Field, IconButton, Notice, Select, Status, statusLabels } from '../components/Primitives';
import { useRecordPage } from '../lib/use-record-page';
import type { Action, StepOutputSelection, WorkspaceView } from '../lib/types';
import './run-history.css';

const runsSchema = recordPageSchema(runSummarySchema);
const RunInspector = lazy(() => import('./RunInspector'));
const RunScopeDialog = lazy(() => import('../components/RunScopeDialog'));
type DateRange = { start: string; end: string };
function localDayBoundary(value: string, nextDay = false) {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return undefined;
  // Advance the local calendar date, including 23- and 25-hour DST days.
  if (nextDay) {
    date.setDate(date.getDate() + 1);
    // A skipped midnight can normalize to 01:00; the following day needs its own midnight.
    date.setHours(0, 0, 0, 0);
  }
  return date.getUTCFullYear() >= 0 && date.getUTCFullYear() <= 9999 ? date.toISOString() : undefined;
}
function dateRangeError(range: DateRange) {
  if (range.start && !localDayBoundary(range.start) || range.end && !localDayBoundary(range.end, true)) return '请输入有效日期。';
  return range.start && range.end && range.start > range.end ? '开始日期不能晚于结束日期。' : '';
}

export default function RunsPage({ workspace, action, onOpen, onOpenOutput }: { workspace: WorkspaceView; action: Action; onOpen: (id: string) => void; onOpenOutput: (selection: StepOutputSelection) => void }) {
  const confirm = useConfirmation();
  const [projectId, setProjectId] = useState(''), [status, setStatus] = useState(''), [purpose, setPurpose] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>({ start: '', end: '' }), [appliedDates, setAppliedDates] = useState<DateRange>({ start: '', end: '' });
  const dateError = dateRangeError(dateRange), hasOtherFilters = Boolean(purpose || status || dateRange.start || dateRange.end), hasFilters = Boolean(projectId || hasOtherFilters);
  const history = useRecordPage('run.list', { projectId: projectId || undefined, purpose: purpose || undefined, status: status || undefined, createdAfter: localDayBoundary(appliedDates.start), createdBefore: localDayBoundary(appliedDates.end, true) }, workspace.version, runsSchema);
  const runs = history.stale || dateError ? [] : history.items;
  function changeDate(field: keyof DateRange, value: string) {
    const next = { ...dateRange, [field]: value }; setDateRange(next);
    // Keep the previous query owned while an incomplete range is being corrected.
    if (!dateRangeError(next)) setAppliedDates(next);
  }
  function clearFilters() { setPurpose(''); setProjectId(''); setStatus(''); setDateRange({ start: '', end: '' }); setAppliedDates({ start: '', end: '' }); }
  const [inspectedRunId, setInspectedRunId] = useState<string>();
  const [restartRun, setRestartRun] = useState<RunSummary>();
  const [deletingRunId, setDeletingRunId] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  async function deleteRun(run: RunSummary, title: string, createdAt: string) {
    if (deletingRunId || !await confirm({ title: '删除制作记录？', description: `将从制作记录列表中删除“${title}”在 ${createdAt} 创建的记录。已生成的素材、视频和费用记录会保留。`, confirmLabel: '删除记录' })) return;
    setDeletingRunId(run.id);
    try {
      const result = await action('run.delete', { runId: run.id }, '制作记录已删除');
      if (result !== null && document.activeElement === document.body) heading.current?.focus({ preventScroll: true });
    } finally { setDeletingRunId(undefined); }
  }
  return <div className="content-page"><div className="page-heading"><h1 ref={heading} tabIndex={-1}>制作记录</h1><Button aria-label="刷新制作记录" busy={history.busy} onClick={history.refresh}><RefreshCw size={15} />刷新</Button></div>
    <div className="page-toolbar run-history-filters"><Field label="记录来源" className="run-history-filter"><Select value={purpose} onChange={event => setPurpose(event.target.value)}><option value="">全部记录</option><option value="production">正式制作</option><option value="prompt-trial">AI 草稿与提示词实验</option><option value="workflow-assistant">任务修改建议</option></Select></Field><Field label="制作项目" className="run-history-filter"><Select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">全部项目</option>{workspace.projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</Select></Field><Field label="制作状态" className="run-history-filter"><Select value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option>{runStatusSchema.options.map(value => <option key={value} value={value}>{statusLabels[value]}</option>)}</Select></Field><Field label="开始日期" className="run-history-filter"><input type="date" value={dateRange.start} aria-invalid={Boolean(dateError) || undefined} onChange={event => changeDate('start', event.target.value)} /></Field><Field label="结束日期（含当天）" className="run-history-filter"><input type="date" aria-label="结束日期" value={dateRange.end} aria-invalid={Boolean(dateError) || undefined} onChange={event => changeDate('end', event.target.value)} /></Field>{hasFilters && <Button variant="ghost" aria-label="清除制作记录筛选" onClick={clearFilters}>清除筛选</Button>}</div>
    {(dateError || history.error) && <Notice kind="error">{dateError || history.error}</Notice>}
    {!runs.length && !dateError && !history.error && (history.busy || !history.hasLoaded) && <p role="status" className="muted">正在读取制作记录…</p>}
    {runs.map(run => {
      const project = workspace.projects.find(item => item.id === run.projectId);
      const completed = run.completedNodeIds.length;
      const title = project?.title ?? '项目制作';
      const createdAt = new Date(run.createdAt).toLocaleString('zh-CN');
      const deletable = !isRunActive(run.status);
      return <article className="run-card" key={run.id} data-run-id={run.id}><div className="run-card__header"><History size={17} /><h3>{title}</h3><Status value={run.status} /></div><div className="run-card__meta"><span>{createdAt}</span><span>修订 {run.projectRevision} · 流程 v{run.workflowVersion}</span><span>{completed} 个步骤已完成</span>{run.productionQueueId && <span>分集生产队列</span>}{run.purpose === 'workflow-assistant' && <span>任务修改建议</span>}{run.purpose === 'prompt-trial' && <span>{run.promptSessionId ? `提示词实验 · 草稿 v${run.promptSessionRevision}` : 'AI 填写草稿'}</span>}{run.selection && (run.purpose !== 'prompt-trial' || run.promptSessionId) && <span>{run.selection.mode === 'node' ? '单步骤执行' : '所选步骤及后续'}</span>}</div>
        {run.error && <div className="run-error"><Notice kind="error">{run.error}</Notice></div>}<div className="progress-line"><span style={{ width: `${run.status === 'succeeded' ? 100 : Math.min(100, completed / Math.max(1, run.stepCount ?? project?.workflowNodeCount ?? 1) * 100)}%` }} /></div>
        <div className="run-card__actions">
          <IconButton label="查看步骤" onClick={() => setInspectedRunId(run.id)}><ListTree size={16} aria-hidden="true" /></IconButton>
          <IconButton label="打开项目" onClick={() => onOpen(run.projectId)}><FolderOpen size={16} aria-hidden="true" /></IconButton>
          {['failed', 'needs_attention', 'waiting_external', 'waiting_review', 'queued'].includes(run.status) && <IconButton label="继续执行" onClick={() => void action('run.resume', { runId: run.id }, '已请求继续执行')}><Play size={16} aria-hidden="true" /></IconButton>}
          {['running', 'queued', 'waiting_external', 'retry_scheduled'].includes(run.status) && <IconButton label="停止" onClick={() => void action('run.cancel', { runId: run.id }, '已请求停止')}><Square size={16} aria-hidden="true" /></IconButton>}
          {run.status === 'canceled' && (!run.purpose || run.purpose === 'production') && !run.productionQueueItemId && <IconButton label="重新制作" onClick={() => { if (run.selection) setRestartRun(run); else void action('run.start', { projectId: run.projectId, parentRunId: run.id }, '已请求重新制作'); }}><RotateCcw size={16} aria-hidden="true" /></IconButton>}
          <IconButton label="删除制作记录" title={deletable ? undefined : '请先停止制作并等待任务结束'} busy={deletingRunId === run.id} disabled={!deletable || Boolean(deletingRunId)} onClick={() => void deleteRun(run, title, createdAt)}><Trash2 size={16} aria-hidden="true" /></IconButton>
        </div>
      </article>;
    })}
    {!runs.length && history.hasLoaded && !history.busy && !history.error && !dateError && <EmptyState icon={<History size={25} />} title={hasOtherFilters ? '没有符合筛选条件的制作记录' : projectId ? '这个项目还没有制作记录' : '还没有制作记录'} description={hasFilters ? '调整或清除筛选，查看已有制作。' : '制作后可在这里查看产物或继续中断的任务。'} />}
    {!dateError && history.nextCursor !== null && <Button aria-label="加载更多制作记录" className="button-full" busy={history.loadingMore} disabled={!history.canLoadMore} onClick={() => void history.loadMore()}><ChevronDown size={15} />加载更多</Button>}
    {inspectedRunId && <Suspense fallback={<Notice>正在打开步骤详情…</Notice>}><RunInspector onRestart={run => { setInspectedRunId(undefined); setRestartRun(run); }} runId={inspectedRunId} version={workspace.version} onClose={() => setInspectedRunId(undefined)} onChanged={history.refresh} onOpenOutput={selection => { setInspectedRunId(undefined); onOpenOutput(selection); }} /></Suspense>}
    {restartRun?.selection && <Suspense fallback={<Notice>正在打开执行范围…</Notice>}><RunScopeDialog projectId={restartRun.projectId} selection={restartRun.selection} parentRunId={restartRun.id} version={workspace.version} onClose={() => setRestartRun(undefined)} onStarted={history.refresh} /></Suspense>}
  </div>;
}
