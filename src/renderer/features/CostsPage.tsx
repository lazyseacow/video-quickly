import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChartNoAxesCombined, ChevronRight, RefreshCw, ChevronDown, ArrowLeft } from 'lucide-react';
import { costSummarySchema, costTaskDetailSchema, costTaskSchema, modelPlatforms, recordPageSchema, tokenMetrics, usageRecordSchema, type CostSummary, type CostTaskDetail, type TokenMetric, type UsageRecord } from '@video-quickly/contracts';
import { Button, EmptyState, Field, Notice, Select, Status } from '../components/Primitives';
import { rpc } from '../lib/client';
import { useContentMotion } from '../lib/motion';
import { useRecordPage } from '../lib/use-record-page';
import type { WorkspaceView } from '../lib/types';
import './costs.css';

const recordsSchema = recordPageSchema(usageRecordSchema);
const tasksSchema = recordPageSchema(costTaskSchema);
const status = { submitted: 'waiting_external', completed: 'succeeded', unknown: 'needs_attention', failed: 'failed', canceled: 'canceled' } as const;
const labels: Record<TokenMetric, string> = { inputTokens: '输入 Token', outputTokens: '输出 Token', cachedInputTokens: '输入缓存 Token', cachedOutputTokens: '输出缓存 Token' };
const count = new Intl.NumberFormat('zh-CN');
const date = (value: string) => new Date(value).toLocaleString('zh-CN');

export default function CostsPage({ workspace }: { workspace: WorkspaceView }) {
  const [projectId, setProjectId] = useState('');
  const [runId, setRunId] = useState<string>();
  const tasks = useRecordPage('cost.tasks', { projectId: projectId || undefined, limit: 20 }, workspace.version, tasksSchema, undefined, { keepPreviousData: true });
  const [summary, setSummary] = useState<{ projectId: string; value: CostSummary }>();
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  useContentMotion(root, runId ?? 'archive', runId ? '.cost-task-detail' : '.cost-archive');
  const refresh = useCallback(() => { tasks.refresh(); setReload(value => value + 1); }, [tasks.refresh]);
  const updateTask = useCallback((task: CostTaskDetail) => tasks.replace(task), [tasks.replace]);
  useLayoutEffect(() => { if (!runId) returnFocus.current?.focus(); }, [runId]);
  useEffect(() => {
    let active = true;
    setSummaryLoading(true); setError('');
    void rpc('cost.summary', { projectId: projectId || undefined }).then(value => costSummarySchema.parse(value)).then(value => { if (active) { setSummary({ projectId, value }); setError(''); } }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); }).finally(() => { if (active) setSummaryLoading(false); });
    return () => { active = false; };
  }, [projectId, workspace.version, reload]);
  const summaryStale = summary?.projectId !== projectId;
  const summaryBusy = summaryLoading || (!error && summaryStale);
  const previousScope = summary?.projectId ? workspace.projects.find(project => project.id === summary.projectId)?.title ?? '上次筛选' : '所有项目';
  return <div ref={root} className="content-page cost-page">
    <div className="cost-archive" hidden={Boolean(runId)}>
      <div className="page-heading"><div><h1>Token 消耗</h1></div><Button aria-label="刷新用量" variant="ghost" busy={tasks.busy || summaryBusy} onClick={refresh}><RefreshCw size={15} />刷新</Button></div>
      {(tasks.error || error) && <Notice kind="error">{tasks.error || error}</Notice>}
      <section className="cost-overview" aria-label="Token 用量汇总" aria-busy={summaryBusy}><TokenTotals summary={summary && (!summaryStale || summaryBusy) ? summary.value : undefined} busy={summaryBusy} feedback={summaryBusy && summaryStale && summary ? `正在读取 · 暂存“${previousScope}”汇总` : undefined} /></section>
      <div className="cost-archive-toolbar"><h2>任务用量</h2><div className="cost-filter"><Field label="用量项目"><Select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">所有项目</option>{workspace.projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</Select></Field></div></div>
      <div className="cost-task-list" aria-label="任务用量归档" aria-busy={tasks.busy}>
        {tasks.stale && tasks.busy && <p className="cost-results-note" role="status">正在读取所选项目的任务，暂时显示上一次结果。</p>}
        {tasks.items.length > 0 && <table className="cost-task-table"><thead><tr><th scope="col">制作任务</th><th scope="col">开始时间</th>{tokenMetrics.map(metric => <th scope="col" key={metric}>{labels[metric]}</th>)}<th scope="col"><span className="cost-sr-only">操作</span></th></tr></thead><tbody>
          {tasks.items.map(task => <tr className="cost-task" key={task.id} data-task-id={task.id}>
            <td className="cost-task__name"><div className="cost-record__heading"><h3>{task.projectTitle}</h3>{task.status && <Status value={task.status} />}</div><p>{task.title} · {task.summary.total} 次调用</p></td>
            <td className="cost-task__date">{date(task.createdAt)}</td>
            {tokenMetrics.map(metric => <td className="cost-task__amount" key={metric} data-label={labels[metric]}><TokenAmount summary={task.summary} metric={metric} /></td>)}
            <td className="cost-task__action"><Button variant="ghost" disabled={tasks.stale} aria-label={`查看任务用量详情：${task.id}`} onClick={event => { returnFocus.current = event.currentTarget; setRunId(task.id); }}>详情<ChevronRight size={14} /></Button></td>
          </tr>)}
        </tbody></table>}
        {tasks.busy && !tasks.hasLoaded && !tasks.items.length && <p className="cost-loading" role="status">正在读取任务用量…</p>}
        {!tasks.items.length && tasks.hasLoaded && !tasks.error && <EmptyState icon={<ChartNoAxesCombined size={25} />} title="还没有 Token 用量" description="模型用量将按任务保存在这里。" />}
      </div>
      {tasks.nextCursor !== null && <Button aria-label="加载更多任务" busy={tasks.loadingMore} disabled={!tasks.canLoadMore} onClick={() => void tasks.loadMore()}><ChevronDown size={14} />加载更多</Button>}
    </div>
    {runId && <TaskUsage key={runId} runId={runId} version={workspace.version} onBack={() => setRunId(undefined)} onTaskUpdated={updateTask} />}
  </div>;
}

function TokenAmount({ summary, metric }: { summary: CostSummary; metric: TokenMetric }) {
  const value = summary.tokens[metric];
  const reported = summary.tokenRecords[metric];
  const detail = value === undefined ? '服务未返回此项用量' : `${reported} / ${summary.total} 次调用返回此项用量${reported < summary.total ? '，当前为已返回部分的合计' : ''}`;
  return <span className="token-amount" title={detail} aria-label={`${value === undefined ? '未返回' : count.format(value)}；${detail}`}>{value === undefined ? '—' : count.format(value)}{value !== undefined && reported < summary.total && <span className="token-partial" aria-hidden="true">*</span>}</span>;
}

function TokenTotals({ summary, busy = false, feedback }: { summary?: CostSummary; busy?: boolean; feedback?: string }) {
  return <><div className="cost-totals">{tokenMetrics.map(metric => <div className="cost-metric" key={metric} data-metric={metric}><h3>{labels[metric]}</h3>{summary ? <TokenAmount summary={summary} metric={metric} /> : <span className="token-amount token-amount--pending">{busy ? '…' : '未读取'}</span>}</div>)}</div><p className="token-legend" title={feedback} role={feedback || !summary ? 'status' : undefined}>{feedback ?? (summary ? '— 未返回 · * 部分返回' : busy ? '正在读取用量…' : '汇总未能读取')}</p></>;
}

export function TaskUsage({ runId, version, onBack, onTaskUpdated, backLabel = '返回任务归档' }: { runId: string; version: number; onBack: () => void; onTaskUpdated: (task: CostTaskDetail) => void; backLabel?: string }) {
  const records = useRecordPage('cost.list', { runId, limit: 30 }, version, recordsSchema);
  const recordsHeading = useId();
  const [task, setTask] = useState<CostTaskDetail>();
  const [taskLoading, setTaskLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus(); }, []);
  useEffect(() => {
    let active = true;
    setTaskLoading(true); setError('');
    void rpc('cost.task.get', { runId }).then(value => costTaskDetailSchema.parse(value)).then(value => { if (active) { setTask(value); onTaskUpdated(value); setError(''); } }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); }).finally(() => { if (active) setTaskLoading(false); });
    return () => { active = false; };
  }, [runId, version, reload, onTaskUpdated]);
  function refresh() { records.refresh(); setReload(value => value + 1); }
  const refreshing = records.busy || taskLoading;
  return <div className="cost-task-detail">
    <header className="cost-task-toolbar">
      <Button ref={back} variant="ghost" className="cost-back" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />{backLabel}</Button>
      <h1>任务用量详情</h1>
      <Button aria-label="刷新详情" variant="ghost" busy={refreshing} onClick={refresh}>{!refreshing && <RefreshCw size={15} aria-hidden="true" />}刷新</Button>
    </header>
    {(records.error || error) && <Notice kind="error">{records.error || error}</Notice>}
    {task ? <section className="cost-task-overview" aria-label="任务 Token 汇总">
      <div className="cost-task-identity">
        <h2>{task.projectTitle}</h2>
        <span className="cost-task-kind">{task.title}</span>
        {task.status && <Status value={task.status} />}
      </div>
      <dl className="cost-task-meta">
        <div><dt>开始时间</dt><dd>{date(task.createdAt)}</dd></div>
        {task.projectRevision !== undefined && <div><dt>项目修订</dt><dd>{task.projectRevision}{task.workflowVersion !== undefined && ` · 流程 v${task.workflowVersion}`}</dd></div>}
        <div><dt>任务编号</dt><dd>{task.id}</dd></div>
        {task.parentRunId && <div><dt>来源任务</dt><dd>{task.parentRunId}</dd></div>}
      </dl>
      <TokenTotals summary={task.summary} />
      {!task.runAvailable && <Notice>原任务记录已不可用，已归档用量仍可查看。</Notice>}
    </section> : <p className="cost-task-feedback" role={taskLoading ? 'status' : undefined}>{taskLoading ? '正在读取任务用量…' : '任务用量未能读取'}</p>}
    <section aria-labelledby={recordsHeading}>
      <div className="cost-records-heading">
        <h2 id={recordsHeading}>调用明细</h2>
        {task && <span>{count.format(task.summary.total)} 次调用</span>}
      </div>
      <div className="cost-record-list" aria-busy={records.busy}>
        {!records.items.length && records.busy && <p className="cost-loading" role="status">正在读取调用明细…</p>}
        {!records.items.length && records.hasLoaded && !records.busy && !records.error && <EmptyState icon={<ChartNoAxesCombined size={25} />} title="还没有调用明细" description="此任务尚未记录模型调用。" />}
        {/* Preserve the table roles when narrow rows switch to CSS grid. */}
        {records.items.length > 0 && <table className="cost-record-table" role="table" aria-labelledby={recordsHeading}>
          <thead role="rowgroup"><tr role="row">
            <th role="columnheader" scope="col">步骤 / 模型</th>
            <th role="columnheader" scope="col" className="cost-call__status">状态</th>
            {tokenMetrics.map(metric => <th role="columnheader" scope="col" className="cost-call__amount" key={metric}>{labels[metric]}</th>)}
            <th role="columnheader" scope="col" className="cost-call__action"><span className="cost-sr-only">操作</span></th>
          </tr></thead>
          {records.items.map(record => <UsageRecordRow key={record.id} record={record} task={task} />)}
        </table>}
      </div>
      {records.nextCursor !== null && <Button className="cost-record-more" aria-label="加载更多明细" busy={records.loadingMore} disabled={!records.canLoadMore} onClick={() => void records.loadMore()}><ChevronDown size={14} />加载更多</Button>}
    </section>
  </div>;
}

function UsageRecordRow({ record, task }: { record: UsageRecord; task?: CostTaskDetail }) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  return <tbody className="cost-record" role="rowgroup">
    <tr className="cost-call" role="row">
      <th className="cost-call__identity" role="rowheader" scope="row">
        <h3>{task?.nodes.find(node => node.id === record.nodeId)?.label ?? record.nodeId}</h3>
        <p>{record.modelName} · {record.model}</p>
        {record.shotId && <p>镜头：{task?.shots.find(shot => shot.id === record.shotId)?.title ?? record.shotId}</p>}
      </th>
      <td className="cost-call__status" role="cell"><Status value={status[record.status]} /></td>
      {tokenMetrics.map(metric => {
        const value = record.providerUsage?.[metric];
        return <td className="cost-call__amount" role="cell" key={metric} data-metric={metric}>
          <span className="cost-call__label" aria-hidden="true">{labels[metric]}</span>
          <span className="token-amount" title={value === undefined ? '服务未返回此项用量' : undefined}>{value === undefined ? '—' : count.format(value)}</span>
        </td>;
      })}
      <td className="cost-call__action" role="cell">
        <Button variant="ghost" static aria-label="调用详情" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>详情<ChevronDown size={14} aria-hidden="true" /></Button>
      </td>
    </tr>
    <tr id={detailsId} className="cost-call-detail" role="row" hidden={!expanded}>
      <td role="cell" colSpan={tokenMetrics.length + 3}>
        {expanded && <dl className="cost-evidence">
          <div><dt>平台</dt><dd>{modelPlatforms.find(item => item.id === record.platform)?.label ?? record.provider}</dd></div>
          <div><dt>记录时间</dt><dd>{date(record.createdAt)}</dd></div>
          <div><dt>用量编号</dt><dd>{record.id}</dd></div>
          <div><dt>更新时间</dt><dd>{date(record.updatedAt)}</dd></div>
          <div><dt>操作编号</dt><dd>{record.operationId}</dd></div>
          <div><dt>步骤／镜头编号</dt><dd>{record.nodeId}{record.shotId ? ` / ${record.shotId}` : ''}</dd></div>
          {record.note && <div className="cost-evidence__note"><dt>备注</dt><dd>{record.note}</dd></div>}
        </dl>}
      </td>
    </tr>
  </tbody>;
}
