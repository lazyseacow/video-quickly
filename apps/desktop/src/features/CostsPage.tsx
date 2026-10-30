import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Receipt, RefreshCw } from 'lucide-react';
import { costSummarySchema, costTaskDetailSchema, costTaskSchema, currencySchema, recordPageSchema, usageRecordSchema, type CostSummary, type CostTaskDetail, type UsageRecord } from '@video-quickly/contracts';
import { Button, Dialog, EmptyState, Field, Notice, Status } from '../components/Primitives';
import { rpc } from '../lib/client';
import { useContentMotion } from '../lib/motion';
import { useRecordPage } from '../lib/use-record-page';
import type { WorkspaceView } from '../lib/types';
import './costs.css';

const recordsSchema = recordPageSchema(usageRecordSchema);
const tasksSchema = recordPageSchema(costTaskSchema);
const status = { submitted: 'waiting_external', completed: 'succeeded', unknown: 'needs_attention', failed: 'failed', canceled: 'canceled' } as const;
const money = (amount: number, currency: string) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency, ...(amount > 0 && amount < .000001 ? { maximumSignificantDigits: 4 } : { minimumFractionDigits: 2, maximumFractionDigits: 6 }) }).format(amount);
const date = (value: string) => new Date(value).toLocaleString('zh-CN');
const priceLabels = [
  ['inputPerMillionTokens', '输入 / 百万 Token'], ['outputPerMillionTokens', '输出 / 百万 Token'], ['perImage', '每张图片'], ['perVideoSecond', '每秒视频'], ['perThousandCharacters', '每千字符'], ['perAudioMinute', '每分钟音频'],
] as const;

export default function CostsPage({ workspace }: { workspace: WorkspaceView }) {
  const [projectId, setProjectId] = useState('');
  const [runId, setRunId] = useState<string>();
  const tasks = useRecordPage('cost.tasks', { projectId: projectId || undefined, limit: 20 }, workspace.version, tasksSchema);
  const [summary, setSummary] = useState<CostSummary>();
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
    void rpc('cost.summary', { projectId: projectId || undefined }).then(value => costSummarySchema.parse(value)).then(value => { if (active) { setSummary(value); setError(''); } }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [projectId, workspace.version, reload]);
  return <div ref={root} className="content-page cost-page">
    <div className="cost-archive" hidden={Boolean(runId)}>
      <div className="page-heading"><div><h1>费用记录</h1><p>查看制作任务的用量与支付记录。</p></div><Button variant="ghost" busy={tasks.busy} onClick={refresh}><RefreshCw size={15} />刷新费用</Button></div>
      {(tasks.error || error) && <Notice kind="error">{tasks.error || error}</Notice>}
      {summary && <section className="cost-overview" aria-label="费用汇总"><CostTotals summary={summary} /></section>}
      <div className="cost-archive-toolbar"><h2>任务账目</h2><div className="cost-filter"><Field label="费用项目"><select value={projectId} onChange={event => { setProjectId(event.target.value); setSummary(undefined); }}><option value="">所有项目</option>{workspace.projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></Field></div></div>
      <div className="cost-task-list" aria-label="任务费用归档" aria-busy={tasks.busy}>
        {tasks.items.length > 0 && <table className="cost-task-table"><thead><tr><th scope="col">制作任务</th><th scope="col">开始时间</th><th scope="col">记录</th><th scope="col">已知估算</th><th scope="col">已登记实付</th><th scope="col"><span className="cost-sr-only">操作</span></th></tr></thead><tbody>
          {tasks.items.map(task => <tr className="cost-task" key={task.id} data-task-id={task.id}>
            <td className="cost-task__name"><div className="cost-record__heading"><h3>{task.projectTitle}</h3>{task.status ? <Status value={task.status} /> : <span className="tiny-meta">历史任务</span>}</div><p>{task.title} <span className="cost-task__id">{task.id.slice(-8)}</span></p></td>
            <td className="cost-task__date">{date(task.createdAt)}</td>
            <td className="cost-task__count">{task.summary.total} 条费用</td>
            <td className="cost-task__amount" data-label="已知估算"><SummaryAmount summary={task.summary} kind="estimated" empty="待核对" />{task.summary.unknownEstimated > 0 && <span className="cost-cell-hint">{task.summary.unknownEstimated} 条未知</span>}</td>
            <td className="cost-task__amount" data-label="已登记实付"><SummaryAmount summary={task.summary} kind="actual" empty="待登记" /></td>
            <td className="cost-task__action"><Button variant="ghost" aria-label={`查看任务费用详情：${task.id}`} onClick={event => { returnFocus.current = event.currentTarget; setRunId(task.id); }}>查看详情<ChevronRight size={14} /></Button></td>
          </tr>)}
        </tbody></table>}
        {tasks.busy && !tasks.items.length && <p className="cost-loading" role="status">正在读取任务费用…</p>}
      </div>
      {!tasks.items.length && !tasks.busy && !tasks.error && <EmptyState icon={<Receipt size={25} />} title="还没有任务费用" description="制作任务产生模型用量后，会按任务保存在这里。" />}
      {tasks.nextCursor !== null && <Button busy={tasks.busy} onClick={() => void tasks.loadMore()}><ChevronDown size={14} />加载更早任务</Button>}
    </div>
    {runId && <TaskCosts key={runId} runId={runId} version={workspace.version} onBack={() => setRunId(undefined)} onChanged={refresh} onTaskUpdated={updateTask} />}
  </div>;
}

function SummaryAmount({ summary, kind, empty }: { summary: CostSummary; kind: 'estimated' | 'actual'; empty: string }) {
  const values = summary.currencies.flatMap(row => {
    const amount = kind === 'estimated' ? row.estimatedAmount : row.actualAmount;
    const count = kind === 'estimated' ? row.estimatedRecords : row.actualRecords;
    return count > 0 && amount !== undefined ? [{ currency: row.currency, amount }] : [];
  });
  return <div className="cost-money-values">{values.length ? values.map(value => <span key={value.currency}><span className="cost-currency">{value.currency}</span>{money(value.amount, value.currency)}</span>) : <span className="cost-muted">{empty}</span>}</div>;
}

function CostTotals({ summary }: { summary: CostSummary }) {
  return <div className="cost-totals">
    <div className="cost-metric"><h3>已知估算</h3><SummaryAmount summary={summary} kind="estimated" empty={summary.total ? '待定价或计量' : '—'} /><p>按当次价格计算{summary.unknownEstimated > 0 ? ` · ${summary.unknownEstimated} 条未知` : ''}</p></div>
    <div className="cost-metric"><h3>已登记实付</h3><SummaryAmount summary={summary} kind="actual" empty={summary.total ? '待登记' : '—'} /><p>依据服务账单手动登记</p></div>
    <div className="cost-metric"><h3>费用记录</h3><div className="cost-metric__count">{summary.total}<span>条</span></div><p>{summary.unknownActual > 0 ? `${summary.unknownActual} 条待登记实付` : summary.total ? '实付已登记完整' : '暂无记录'}{summary.unknownSubmissions > 0 ? ` · ${summary.unknownSubmissions} 条提交结果待核对` : ''}</p></div>
  </div>;
}

function TaskCosts({ runId, version, onBack, onChanged, onTaskUpdated }: { runId: string; version: number; onBack: () => void; onChanged: () => void; onTaskUpdated: (task: CostTaskDetail) => void }) {
  const records = useRecordPage('cost.list', { runId, limit: 30 }, version, recordsSchema);
  const [task, setTask] = useState<CostTaskDetail>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<UsageRecord>();
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus(); }, []);
  useEffect(() => {
    let active = true;
    void rpc('cost.task.get', { runId }).then(value => costTaskDetailSchema.parse(value)).then(value => { if (active) { setTask(value); onTaskUpdated(value); setError(''); } }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [runId, version, reload, onTaskUpdated]);
  function refresh() { records.refresh(); setReload(value => value + 1); }
  return <div className="cost-task-detail">
    <button ref={back} type="button" className="button button--ghost cost-back" onClick={onBack}><ArrowLeft size={16} />返回任务归档</button>
    <div className="page-heading"><div><h1>任务费用详情</h1><p>{task ? task.title : '正在读取任务费用…'}</p></div><Button variant="ghost" busy={records.busy} onClick={refresh}><RefreshCw size={15} />刷新详情</Button></div>
    {(records.error || error) && <Notice kind="error">{records.error || error}</Notice>}
    {task && <section className="cost-task-overview" aria-label="任务费用汇总"><div className="cost-record__heading"><h2>{task.projectTitle}</h2>{task.status && <Status value={task.status} />}</div><dl className="cost-task-meta"><div><dt>任务编号</dt><dd>{task.id}</dd></div><div><dt>开始时间</dt><dd>{date(task.createdAt)}</dd></div>{task.projectRevision !== undefined && <div><dt>项目修订</dt><dd>{task.projectRevision} · 流程 v{task.workflowVersion}</dd></div>}{task.parentRunId && <div><dt>来源任务</dt><dd>{task.parentRunId}</dd></div>}</dl><CostTotals summary={task.summary} />{!task.runAvailable && <Notice>原任务记录已不可用，已归档的费用仍可查看与核对。</Notice>}</section>}
    <div className="cost-records-heading"><h2>费用明细</h2></div>
    <div className="cost-record-list" aria-label="任务费用明细" aria-busy={records.busy}>
      {records.items.map(record => <article className="cost-record" key={record.id}>
        <div className="cost-record__body"><div className="cost-record__heading"><h3>{task?.nodes.find(node => node.id === record.nodeId)?.label ?? record.nodeId}</h3><Status value={status[record.status]} /></div><p>{record.modelName}</p>{record.shotId && <p>镜头：{task?.shots.find(shot => shot.id === record.shotId)?.title ?? record.shotId}</p>}<p className="tiny-meta">{usageText(record)}</p><div className="cost-record__amounts"><span>估算 {record.estimatedAmount !== undefined && record.pricing ? money(record.estimatedAmount, record.pricing.currency) : '待核对'}{record.estimateBasis ? `（${{ request: '按请求量', provider: '按返回用量', mixed: '按返回及请求量' }[record.estimateBasis]}）` : ''}</span><span>实付 {record.actualAmount !== undefined && record.actualCurrency ? money(record.actualAmount, record.actualCurrency) : '待登记'}</span></div>{record.note && <p className="cost-record__note">{record.note}</p>}
          <details className="cost-evidence"><summary>用量与价格详情</summary><dl><dt>模型</dt><dd>{record.provider} / {record.model}</dd><dt>费用编号</dt><dd>{record.id}</dd><dt>操作编号</dt><dd>{record.operationId}</dd><dt>步骤／镜头编号</dt><dd>{record.nodeId}{record.shotId ? ` / ${record.shotId}` : ''}</dd><dt>记录时间</dt><dd>{date(record.createdAt)} · 更新于 {date(record.updatedAt)}</dd><dt>请求量</dt><dd>{metricText(record.requestMetrics) || '未记录'}</dd><dt>服务返回用量</dt><dd>{record.providerUsage ? metricText(record.providerUsage) || '服务未返回计量' : '服务未返回计量'}</dd><dt>当次价格</dt><dd><PriceSnapshot pricing={record.pricing} /></dd></dl></details>
        </div><div className="cost-record__actions"><Button variant="ghost" onClick={() => setEditing(record)}>核对费用</Button></div>
      </article>)}
    </div>
    {records.nextCursor !== null && <Button busy={records.busy} onClick={() => void records.loadMore()}><ChevronDown size={14} />加载更早明细</Button>}
    {editing && <CostEditor key={editing.id} record={editing} onClose={() => setEditing(undefined)} onSaved={record => { records.replace(record); setEditing(undefined); refresh(); onChanged(); }} />}
  </div>;
}

function PriceSnapshot({ pricing }: Pick<UsageRecord, 'pricing'>) {
  if (!pricing) return <>未配置价格</>;
  const prices = priceLabels.flatMap(([key, label]) => { const amount = pricing[key]; return amount === undefined ? [] : [<li key={key}>{label}：{money(amount, pricing.currency)}</li>]; });
  return prices.length ? <ul>{prices}</ul> : <>未配置单价</>;
}

function metricText(values: UsageRecord['requestMetrics'] | NonNullable<UsageRecord['providerUsage']>) {
  const labels = { requestCount: '次请求', inputTokens: '输入 Token', outputTokens: '输出 Token', totalTokens: '总 Token', cachedInputTokens: '缓存输入 Token', characters: '字符', audioSeconds: '秒音频', images: '张图片', videoSeconds: '秒视频' } as const;
  return Object.entries(values).flatMap(([key, value]) => typeof value === 'number' && key in labels ? [`${value} ${labels[key as keyof typeof labels]}`] : []).join(' · ');
}

function usageText(record: UsageRecord) {
  const provider = record.providerUsage;
  const values: string[] = [];
  if (provider?.inputTokens !== undefined) values.push(`输入 ${provider.inputTokens} Token`);
  if (provider?.outputTokens !== undefined) values.push(`输出 ${provider.outputTokens} Token`);
  if (provider?.audioSeconds !== undefined) values.push(`音频 ${provider.audioSeconds} 秒`);
  if (provider?.images !== undefined) values.push(`${provider.images} 张图片`);
  if (provider?.videoSeconds !== undefined) values.push(`视频 ${provider.videoSeconds} 秒`);
  if (provider?.characters !== undefined) values.push(`配音 ${provider.characters} 字符`);
  return values.length ? `服务返回用量：${values.join(' · ')}` : `请求量：${metricText(record.requestMetrics) || '未知'}；服务未返回完整计量`;
}

function CostEditor({ record, onClose, onSaved }: { record: UsageRecord; onClose: () => void; onSaved: (record: UsageRecord) => void }) {
  const [amount, setAmount] = useState(record.actualAmount === undefined ? '' : String(record.actualAmount));
  const [currency, setCurrency] = useState(record.actualCurrency ?? record.pricing?.currency ?? 'USD');
  const [note, setNote] = useState(record.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try { const saved = usageRecordSchema.parse(await rpc('cost.update', { id: record.id, revision: record.revision, actualAmount: amount.trim() ? Number(amount) : null, actualCurrency: amount.trim() ? currency : null, note })); onSaved(saved); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <Dialog title="核对费用" onClose={onClose} className="dialog--wide"><form onSubmit={event => { event.preventDefault(); void save(); }}><div className="dialog__body"><p>{record.modelName} · {record.nodeId}</p><Field label="实际支付金额" hint="依据服务账单手动登记；留空清除实付金额。"><input type="number" min="0" step="any" value={amount} disabled={busy} onChange={event => setAmount(event.target.value)} /></Field><Field label="实付币种"><select value={currency} disabled={busy} onChange={event => setCurrency(currencySchema.parse(event.target.value))}><option value="USD">USD</option><option value="CNY">CNY</option></select></Field><Field label="费用备注"><textarea maxLength={10000} rows={3} value={note} disabled={busy} onChange={event => setNote(event.target.value)} /></Field>{error && <Notice kind="error">{error}</Notice>}</div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" busy={busy}>保存实付记录</Button></div></form></Dialog>;
}
