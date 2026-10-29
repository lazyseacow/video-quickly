import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Receipt, RefreshCw } from 'lucide-react';
import { z } from 'zod';
import { currencySchema, recordPageSchema, usageRecordSchema, type UsageRecord } from '@video-quickly/contracts';
import { Button, Dialog, EmptyState, Field, Notice, Status } from '../components/Primitives';
import { rpc } from '../lib/client';
import { useRecordPage } from '../lib/use-record-page';
import type { WorkspaceView } from '../lib/types';
import './costs.css';

const recordsSchema = recordPageSchema(usageRecordSchema);
const summarySchema = z.object({ currencies: z.array(z.object({ currency: currencySchema, estimatedAmount: z.number().optional(), actualAmount: z.number().optional(), estimatedRecords: z.number(), actualRecords: z.number() })), total: z.number(), unknownEstimated: z.number(), unknownActual: z.number(), unknownSubmissions: z.number() });
const status = { submitted: 'waiting_external', completed: 'succeeded', unknown: 'needs_attention', failed: 'failed', canceled: 'canceled' } as const;
const money = (amount: number, currency: string) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(amount);

export default function CostsPage({ workspace }: { workspace: WorkspaceView }) {
  const [projectId, setProjectId] = useState('');
  const records = useRecordPage('cost.list', { projectId: projectId || undefined, limit: 30 }, workspace.version, recordsSchema);
  const [summary, setSummary] = useState<z.infer<typeof summarySchema>>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<UsageRecord>();
  const refresh = useCallback(() => { records.refresh(); setReload(value => value + 1); }, [records.refresh]);
  useEffect(() => {
    let active = true;
    void rpc('cost.summary', { projectId: projectId || undefined }).then(value => summarySchema.parse(value)).then(value => { if (active) { setSummary(value); setError(''); } }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [projectId, workspace.version, reload]);
  return <div className="content-page"><div className="page-heading"><div><h1>费用记录</h1><p>按运行保存模型用量、价格快照和实付登记。</p></div><Button busy={records.busy} onClick={refresh}><RefreshCw size={15} />刷新费用</Button></div>
    <div className="cost-filter"><Field label="费用项目"><select value={projectId} onChange={event => { setProjectId(event.target.value); setSummary(undefined); }}><option value="">所有项目</option>{workspace.projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></Field></div>
    {(records.error || error) && <Notice kind="error">{records.error || error}</Notice>}
    {summary && <div className="section-card cost-summary"><table><thead><tr><th>币种</th><th>已知估算</th><th>已登记实付</th></tr></thead><tbody>{summary.currencies.map(row => <tr key={row.currency}><th>{row.currency}</th><td>{row.estimatedRecords && row.estimatedAmount !== undefined ? money(row.estimatedAmount, row.currency) : '待定价或计量'}</td><td>{row.actualRecords && row.actualAmount !== undefined ? money(row.actualAmount, row.currency) : '待登记'}</td></tr>)}</tbody></table><p className="tiny-meta">共 {summary.total} 条 · {summary.unknownEstimated} 条估算未知 · {summary.unknownActual} 条待登记实付{summary.unknownSubmissions > 0 ? ` · ${summary.unknownSubmissions} 条提交结果待核对` : ''}</p><p className="tiny-meta">估算使用当次保存的价格，币种分别汇总；实际扣费以服务账单和实付登记为准。</p></div>}
    {records.items.map(record => <article className="list-card cost-record" key={record.id}><div className="list-card__icon"><Receipt size={18} /></div><div className="list-card__body"><div className="cost-record__heading"><h3>{record.modelName}</h3><Status value={status[record.status]} /></div><p>{workspace.projects.find(project => project.id === record.projectId)?.title ?? '项目制作'} · {record.nodeId}{record.shotId ? ` · 镜头 ${record.shotId}` : ''}</p><p className="tiny-meta">{new Date(record.createdAt).toLocaleString('zh-CN')} · {record.provider} / {record.model}</p><p className="tiny-meta">{usageText(record)}</p><div className="cost-record__amounts"><span>估算 {record.estimatedAmount !== undefined && record.pricing ? money(record.estimatedAmount, record.pricing.currency) : '待核对'}{record.estimateBasis === 'request' ? '（按请求量）' : record.estimateBasis === 'provider' ? '（按返回用量）' : ''}</span><span>实付 {record.actualAmount !== undefined && record.actualCurrency ? money(record.actualAmount, record.actualCurrency) : '待登记'}</span></div>{record.note && <p className="cost-record__note">{record.note}</p>}</div><div className="list-card__actions"><Button onClick={() => setEditing(record)}>核对费用</Button></div></article>)}
    {!records.items.length && !records.busy && !records.error && <EmptyState icon={<Receipt size={25} />} title="还没有费用记录" description="执行配置了模型的生成步骤后，记录会保存在这里。缺少用量或价格时会保留待核对状态。" />}
    {records.nextCursor !== null && <Button busy={records.busy} onClick={() => void records.loadMore()}><ChevronDown size={14} />加载更早费用</Button>}
    {editing && <CostEditor key={editing.id} record={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); refresh(); }} />}
  </div>;
}

function usageText(record: UsageRecord) {
  const provider = record.providerUsage;
  const values: string[] = [];
  if (provider?.inputTokens !== undefined) values.push(`输入 ${provider.inputTokens} Token`);
  if (provider?.outputTokens !== undefined) values.push(`输出 ${provider.outputTokens} Token`);
  if (provider?.audioSeconds !== undefined) values.push(`音频 ${provider.audioSeconds} 秒`);
  if (provider?.images !== undefined) values.push(`${provider.images} 张图片`);
  if (provider?.videoSeconds !== undefined) values.push(`视频 ${provider.videoSeconds} 秒`);
  if (values.length) return `服务返回用量：${values.join(' · ')}`;
  const request = record.requestMetrics;
  if (request.images !== undefined) values.push(`${request.images} 张图片`);
  if (request.videoSeconds !== undefined) values.push(`视频 ${request.videoSeconds} 秒`);
  if (request.characters !== undefined) values.push(`配音 ${request.characters} 字符`);
  if (request.audioSeconds !== undefined) values.push(`音频 ${request.audioSeconds} 秒`);
  return values.length ? `请求量：${values.join(' · ')}；服务未返回完整计量` : '服务未返回用量，费用待核对';
}

function CostEditor({ record, onClose, onSaved }: { record: UsageRecord; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState(record.actualAmount === undefined ? '' : String(record.actualAmount));
  const [currency, setCurrency] = useState(record.actualCurrency ?? record.pricing?.currency ?? 'USD');
  const [note, setNote] = useState(record.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try { await rpc('cost.update', { id: record.id, revision: record.revision, actualAmount: amount.trim() ? Number(amount) : null, actualCurrency: amount.trim() ? currency : null, note }); onSaved(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <Dialog title="核对费用" onClose={onClose} className="dialog--wide"><form onSubmit={event => { event.preventDefault(); void save(); }}><div className="dialog__body"><p>{record.modelName} · {record.nodeId}</p><p className="tiny-meta">{usageText(record)}</p><Field label="实际支付金额" hint="依据服务账单手动登记；留空清除实付金额。"><input type="number" min="0" step="any" value={amount} disabled={busy} onChange={event => setAmount(event.target.value)} /></Field><Field label="实付币种"><select value={currency} disabled={busy} onChange={event => setCurrency(currencySchema.parse(event.target.value))}><option value="USD">USD</option><option value="CNY">CNY</option></select></Field><Field label="费用备注"><textarea maxLength={10000} rows={3} value={note} disabled={busy} onChange={event => setNote(event.target.value)} /></Field><details><summary>运行与计价依据</summary><dl className="cost-evidence"><dt>运行</dt><dd>{record.runId}</dd><dt>操作</dt><dd>{record.operationId}</dd><dt>当次定价</dt><dd><pre>{record.pricing ? JSON.stringify(record.pricing, null, 2) : '未配置价格'}</pre></dd></dl></details>{error && <Notice kind="error">{error}</Notice>}</div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" busy={busy}>保存实付记录</Button></div></form></Dialog>;
}
