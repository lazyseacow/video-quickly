import { useEffect, useRef, useState } from 'react';
import { Check, FolderSearch, RefreshCw, Square } from 'lucide-react';
import type { ProjectDocument } from '@video-quickly/contracts';
import { assetRecoveryJobSchema, assetRecoveryPageSchema, type AssetRecoveryItem, type AssetRecoveryJob, type AssetRecoveryPage } from '@video-quickly/contracts';
import { rpc } from '../lib/client';
import { useAssetAvailabilityKey } from '../lib/asset-availability';
import { pathExample } from '../lib/desktop';
import PathPicker from './PathPicker';
import { Button, Dialog, Field, Notice, Select } from './Primitives';
import './asset-recovery.css';

const resumed = new Map<string, string>();
const running = (job?: AssetRecoveryJob) => Boolean(job && ['checking', 'scanning', 'repairing'].includes(job.phase));
const phases: Record<AssetRecoveryJob['phase'], string> = { checking: '正在检查原文件', awaiting_directory: '检查完成', scanning: '正在扫描目录', awaiting_confirmation: '扫描完成，请确认匹配项', repairing: '正在校验并恢复', succeeded: '所选素材已恢复', failed: '恢复操作未完成', canceled: '操作已取消', interrupted: '上次操作已中断' };
const statuses: Record<AssetRecoveryItem['status'], string> = { pending: '检查中', available: '文件可用', missing: '文件缺失', content_mismatch: '原位置内容不同', unreadable: '无法读取', unsafe_path: '路径不可安全恢复', invalid_metadata: '缺少恢复信息', conflict: '记录冲突', restored: '已恢复' };
const sources = { asset: '素材记录', project: '当前项目', character: '角色引用', 'run-snapshot': '冻结制作快照', 'export-batch-snapshot': '批量导出快照', 'node-result': '步骤产物' };
const explain = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function AssetRecoveryDialog({ project, directory, onClose }: { project?: Pick<ProjectDocument, 'id' | 'title'>; directory: string; onClose: () => void }) {
  // Keep the shared event observer alive even when the workbench is not mounted.
  useAssetAvailabilityKey([]);
  const [scope, setScope] = useState(project?.id ?? '');
  const [source, setSource] = useState('');
  const [view, setView] = useState<{ page: AssetRecoveryPage; offset: number }>();
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const owner = useRef(0), request = useRef(0);
  const scopeKey = JSON.stringify([directory, scope]);
  const job = view?.page.job, active = running(job), items = view?.page.items ?? [];
  const count = Object.keys(selected).length;

  async function read(jobId: string, offset = 0, generation?: number) {
    const sequence = ++request.current, current = owner.current;
    try {
      const page = assetRecoveryPageSchema.parse(await rpc('asset.recovery.get', { jobId, offset, generation }));
      if (sequence !== request.current || current !== owner.current) return;
      if (page.job.id !== job?.id || page.job.generation !== job?.generation || page.job.phase === 'succeeded') setSelected({});
      if (page.job.generation !== job?.generation) setSource(page.job.directory ?? '');
      setView({ page, offset }); setError('');
      return page;
    } catch (error) { if (sequence === request.current && current === owner.current) setError(explain(error)); }
  }
  async function start(fresh = false) {
    const current = owner.current; request.current++; setBusy(true); setError(''); setSelected({});
    try {
      const previous = fresh ? undefined : resumed.get(scopeKey);
      if (previous) { const page = await read(previous); if (page && current === owner.current) setSource(page.job.directory ?? ''); }
      else {
        const started = assetRecoveryJobSchema.parse(await rpc('asset.recovery.start', scope ? { projectId: scope } : {}));
        resumed.set(scopeKey, started.id);
        if (current === owner.current) setView({ page: { job: started, items: [], nextOffset: null }, offset: 0 });
      }
    } catch (error) { if (current === owner.current) setError(explain(error)); }
    finally { if (current === owner.current) setBusy(false); }
  }
  useEffect(() => {
    owner.current++; setView(undefined); setSource(''); void start();
    return () => { owner.current++; request.current++; };
  }, [scopeKey]);
  useEffect(() => {
    if (!job || !active || busy) return;
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const page = await read(job!.id, view!.offset, job!.generation);
      if (live && page && running(page.job)) timer = setTimeout(() => void poll(), 400);
    }
    void poll();
    return () => { live = false; clearTimeout(timer); request.current++; };
  }, [job?.id, job?.generation, job?.phase, view?.offset, active, busy, retry]);

  async function perform(method: 'scan' | 'confirm' | 'cancel') {
    if (!job || busy) return;
    const current = owner.current; request.current++; setBusy(true); setError('');
    try {
      const input = method === 'scan' ? { directory: source } : method === 'confirm' ? { selections: Object.entries(selected).map(([itemId, candidateId]) => ({ itemId, candidateId })) } : {};
      const next = assetRecoveryJobSchema.parse(await rpc(`asset.recovery.${method}`, { jobId: job.id, ...input }));
      if (current !== owner.current) return;
      if (method === 'scan') setSelected({});
      setView(previous => ({ page: { job: next, items: method === 'scan' ? [] : previous?.page.items ?? [], nextOffset: method === 'scan' ? null : previous?.page.nextOffset ?? null }, offset: method === 'scan' ? 0 : previous?.offset ?? 0 }));
      if (!running(next)) await read(next.id, method === 'scan' ? 0 : view?.offset, next.generation);
    } catch (error) { if (current === owner.current) setError(explain(error)); }
    finally { if (current === owner.current) setBusy(false); }
  }
  async function selectAll() {
    if (!job || active || busy) return;
    const current = owner.current; setBusy(true); setError('');
    try {
      const selection: Record<string, string> = {};
      let offset: number | null = 0, selectedCount = 0;
      do {
        const page = assetRecoveryPageSchema.parse(await rpc('asset.recovery.get', { jobId: job.id, generation: job.generation, offset }));
        if (current !== owner.current) return;
        for (const item of page.items) if (item.status === 'missing' && item.candidates.length && selectedCount < 2000) { selection[item.id] = item.candidates[0].id; selectedCount++; }
        offset = page.nextOffset;
      } while (offset !== null && selectedCount < 2000);
      setSelected(selection);
    } catch (error) { if (current === owner.current) setError(explain(error)); }
    finally { if (current === owner.current) setBusy(false); }
  }

  return <Dialog title="恢复缺失素材" onClose={onClose} className="dialog--wide asset-recovery">
    <div className="dialog__body asset-recovery__body">
      <p className="asset-recovery__intro">查找相同内容，恢复到原素材位置。素材关联和历史制作快照继续有效。</p>
      <div className="asset-recovery__controls"><Field label="恢复范围"><Select value={scope} disabled={active || busy} onChange={event => setScope(event.target.value)}><option value="">整个工作区（含历史与回收站）</option>{project && <option value={project.id}>当前项目：{project.title}</option>}</Select></Field><Button aria-label="重新检查素材" disabled={active || busy} onClick={() => void start(true)}><RefreshCw size={16} />重新检查</Button></div>
      <form className="asset-recovery__directory" onSubmit={event => { event.preventDefault(); void perform('scan'); }}><Field label="查找目录" hint="按完整摘要和文件大小匹配，跳过符号链接。原位置的异内容文件会保留。"><PathPicker label="查找目录" mode="directory" value={source} onChange={setSource} required disabled={active || busy} placeholder={pathExample('backup')} /></Field><Button type="submit" disabled={!job || active || busy || !source.trim()}><FolderSearch size={16} />扫描目录</Button></form>
      {error && <Notice kind="error">{error}<Button onClick={() => { setError(''); if (job) void read(job.id).then(page => { if (page) setRetry(value => value + 1); }); else void start(true); }}>重新读取状态</Button></Notice>}
      {!job && !error && <p role="status">正在检查素材…</p>}
      {job && <>
        <div className="asset-recovery__progress" role="status"><strong>{phases[job.phase]}</strong><span>已检查 {job.progress.checked} / {job.progress.total} · 已扫描 {job.progress.scanned} 个文件 · 已校验 {job.progress.hashed} 个候选{job.progress.restored > 0 && ` · 已恢复 ${job.progress.restored} 个`}</span>{active && <progress aria-label="素材恢复进度" {...(job.phase === 'checking' ? { value: job.progress.checked, max: Math.max(1, job.progress.total) } : {})} />}</div>
        {job.error && <Notice kind="error">{job.error} 可检查目录与权限后重新扫描并继续。</Notice>}
        {job.phase === 'succeeded' && <Notice kind="success">所选素材已恢复，媒体将自动重新读取。还有缺失项时可继续扫描。</Notice>}
        {job.warningCount > 0 && <details className="asset-recovery__warnings"><summary>{job.warningCount} 条目录或回滚提示</summary><ul>{job.warnings.map((warning, index) => <li key={index}><code>{warning.path}</code><span>{warning.message}</span></li>)}</ul>{job.warningCount > job.warnings.length && <p>仅显示前 {job.warnings.length} 条，其他路径也已跳过。</p>}</details>}
        <div className="asset-recovery__list-heading"><h3>素材检查清单</h3><span>{job.progress.total} 条</span><Button disabled={active || busy || !['awaiting_confirmation', 'failed', 'canceled'].includes(job.phase)} onClick={() => void selectAll()}>选择全部匹配项</Button><Button disabled={active || busy || !count} onClick={() => setSelected({})}>清除选择</Button></div>
        <div className="asset-recovery__list" aria-label="素材恢复清单">{items.map(item => {
          const candidateId = selected[item.id], match = item.status === 'missing' && item.candidates.length > 0;
          return <article className="asset-recovery__item" key={item.id} data-asset-id={item.assetId} data-recovery-status={item.status}>
            <div className="asset-recovery__item-heading"><label><input type="checkbox" aria-label={`恢复“${item.name}”`} disabled={!match || active || busy || !candidateId && count >= 2000} checked={Boolean(candidateId)} onChange={event => setSelected(previous => { const next = { ...previous }; if (event.target.checked) next[item.id] = item.candidates[0].id; else delete next[item.id]; return next; })} /><strong>{item.name}</strong></label><span className={`asset-recovery__status asset-recovery__status--${item.status}`}>{statuses[item.status]}</span></div>
            {item.expected && <code className="asset-recovery__path">{item.expected.path}</code>}
            {item.detail && <p>{item.detail}</p>}
            <details className="asset-recovery__references"><summary>{item.sources.length} 处记录与引用</summary><ul>{item.sources.map((source, index) => <li key={index}>{sources[source.kind]} · <code>{source.id}</code>{source.active === false && ' · 已移除'}</li>)}</ul>{item.expected && <p>{item.expected.size.toLocaleString()} 字节 · SHA-256 <code>{item.expected.sha256}</code></p>}</details>
            {match && <Field label={`匹配文件：${item.name}`} hint={item.additionalCandidates ? `另有 ${item.additionalCandidates} 个相同内容文件，当前显示前 8 个。` : undefined}><Select disabled={active || busy || !candidateId && count >= 2000} value={candidateId ?? item.candidates[0].id} onChange={event => setSelected(previous => ({ ...previous, [item.id]: event.target.value }))}>{item.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.path}</option>)}</Select></Field>}
          </article>;
        })}{!items.length && !active && <p className="asset-recovery__empty">这个范围没有素材记录。</p>}</div>
        {view && <div className="asset-recovery__paging"><span>{items.length ? `${view.offset + 1}–${view.offset + items.length}` : '0'} / {job.progress.total}</span><Button aria-label="上一页素材清单" disabled={active || busy || view.offset === 0} onClick={() => void read(job.id, Math.max(0, view.offset - 100), job.generation)}>上一页</Button><Button aria-label="下一页素材清单" disabled={active || busy || view.page.nextOffset === null} onClick={() => void read(job.id, view.page.nextOffset!, job.generation)}>下一页</Button></div>}
      </>}
    </div>
    <div className="dialog__footer asset-recovery__footer"><span>{count} 个待恢复{count >= 2000 && ' · 单次最多 2000 个'}</span><Button onClick={onClose}>关闭</Button>{active ? <Button aria-label="取消素材恢复" busy={busy} onClick={() => void perform('cancel')}><Square size={14} />取消操作</Button> : <Button aria-label="确认恢复所选素材" variant="primary" busy={busy} disabled={!job || !count || !['awaiting_confirmation', 'failed', 'canceled'].includes(job.phase)} onClick={() => void perform('confirm')}><Check size={16} />确认恢复</Button>}</div>
  </Dialog>;
}
