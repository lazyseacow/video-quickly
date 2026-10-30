import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChartNoAxesCombined, ChevronRight, RefreshCw, ChevronDown, ArrowLeft } from 'lucide-react';
import { costSummarySchema, costTaskDetailSchema, costTaskSchema, modelPlatforms, recordPageSchema, tokenMetrics, usageRecordSchema, type CostSummary, type CostTaskDetail, type TokenMetric } from '@video-quickly/contracts';
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
const emptySummary = costSummarySchema.parse({ currencies: [], total: 0, unknownEstimated: 0, unknownActual: 0, unknownSubmissions: 0 });

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
    void rpc('cost.summary', { projectId: projectId || undefined }).then(value => costSummarySchema.parse(value)).then(value => { if (active) { setSummary({ projectId, value }); setError(''); } }).catch(error => { if (active) { setSummary({ projectId, value: emptySummary }); setError(error instanceof Error ? error.message : String(error)); } }).finally(() => { if (active) setSummaryLoading(false); });
    return () => { active = false; };
  }, [projectId, workspace.version, reload]);
  return <div ref={root} className="content-page cost-page">
    <div className="cost-archive" hidden={Boolean(runId)}>
      <div className="page-heading"><div><h1>Token 消耗</h1><p>按任务查看模型用量。</p></div><Button aria-label="刷新用量" variant="ghost" busy={tasks.busy} onClick={refresh}><RefreshCw size={15} />刷新</Button></div>
      {(tasks.error || error) && <Notice kind="error">{tasks.error || error}</Notice>}
      <section className="cost-overview" aria-label="Token 用量汇总" aria-busy={summaryLoading || summary?.projectId !== projectId}><TokenTotals summary={summary?.value ?? emptySummary} /></section>
      <div className="cost-archive-toolbar"><h2>任务用量</h2><div className="cost-filter"><Field label="用量项目"><Select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">所有项目</option>{workspace.projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</Select></Field></div></div>
      <div className="cost-task-list" aria-label="任务用量归档" aria-busy={tasks.busy}>
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
      {tasks.nextCursor !== null && <Button aria-label="加载更多任务" busy={tasks.busy} onClick={() => void tasks.loadMore()}><ChevronDown size={14} />加载更多</Button>}
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

function TokenTotals({ summary }: { summary: CostSummary }) {
  return <><div className="cost-totals">{tokenMetrics.map(metric => <div className="cost-metric" key={metric} data-metric={metric}><h3>{labels[metric]}</h3><TokenAmount summary={summary} metric={metric} /></div>)}</div><p className="token-legend">— 未返回；* 部分返回。缓存用量单独统计。</p></>;
}

function TaskUsage({ runId, version, onBack, onTaskUpdated }: { runId: string; version: number; onBack: () => void; onTaskUpdated: (task: CostTaskDetail) => void }) {
  const records = useRecordPage('cost.list', { runId, limit: 30 }, version, recordsSchema);
  const [task, setTask] = useState<CostTaskDetail>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus(); }, []);
  useEffect(() => {
    let active = true;
    void rpc('cost.task.get', { runId }).then(value => costTaskDetailSchema.parse(value)).then(value => { if (active) { setTask(value); onTaskUpdated(value); setError(''); } }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [runId, version, reload, onTaskUpdated]);
  function refresh() { records.refresh(); setReload(value => value + 1); }
  return <div className="cost-task-detail">
    <button aria-label="返回任务归档" ref={back} type="button" className="button button--ghost cost-back" onClick={onBack}><ArrowLeft size={16} />返回</button>
    <div className="page-heading"><div><h1>任务用量详情</h1><p>{task ? task.title : '正在读取任务用量…'}</p></div><Button aria-label="刷新详情" variant="ghost" busy={records.busy} onClick={refresh}><RefreshCw size={15} />刷新</Button></div>
    {(records.error || error) && <Notice kind="error">{records.error || error}</Notice>}
    {task && <section className="cost-task-overview" aria-label="任务 Token 汇总"><div className="cost-record__heading"><h2>{task.projectTitle}</h2>{task.status && <Status value={task.status} />}</div><dl className="cost-task-meta"><div><dt>任务编号</dt><dd>{task.id}</dd></div><div><dt>开始时间</dt><dd>{date(task.createdAt)}</dd></div>{task.projectRevision !== undefined && <div><dt>项目修订</dt><dd>{task.projectRevision} · 流程 v{task.workflowVersion}</dd></div>}{task.parentRunId && <div><dt>来源任务</dt><dd>{task.parentRunId}</dd></div>}</dl><TokenTotals summary={task.summary} />{!task.runAvailable && <Notice>原任务记录已不可用，已归档用量仍可查看。</Notice>}</section>}
    <div className="cost-records-heading"><h2>调用明细</h2></div>
    <div className="cost-record-list" aria-label="任务调用明细" aria-busy={records.busy}>
      {records.items.map(record => <article className="cost-record" key={record.id}>
        <div className="cost-record__body"><div className="cost-record__heading"><h3>{task?.nodes.find(node => node.id === record.nodeId)?.label ?? record.nodeId}</h3><Status value={status[record.status]} /></div><p>{record.modelName} · {record.model}</p>{record.shotId && <p>镜头：{task?.shots.find(shot => shot.id === record.shotId)?.title ?? record.shotId}</p>}
          <dl className="token-record-grid">{tokenMetrics.map(metric => <div key={metric} data-metric={metric}><dt>{labels[metric]}</dt><dd>{record.providerUsage?.[metric] === undefined ? '—' : count.format(record.providerUsage[metric])}</dd></div>)}</dl>
          {record.note && <p className="cost-record__note">{record.note}</p>}
          <details className="cost-evidence"><summary>调用详情</summary><dl><dt>平台</dt><dd>{modelPlatforms.find(item => item.id === record.platform)?.label ?? record.provider}</dd><dt>用量编号</dt><dd>{record.id}</dd><dt>操作编号</dt><dd>{record.operationId}</dd><dt>步骤／镜头编号</dt><dd>{record.nodeId}{record.shotId ? ` / ${record.shotId}` : ''}</dd><dt>记录时间</dt><dd>{date(record.createdAt)} · 更新于 {date(record.updatedAt)}</dd></dl></details>
        </div>
      </article>)}
    </div>
    {records.nextCursor !== null && <Button aria-label="加载更多明细" busy={records.busy} onClick={() => void records.loadMore()}><ChevronDown size={14} />加载更多</Button>}
  </div>;
}
