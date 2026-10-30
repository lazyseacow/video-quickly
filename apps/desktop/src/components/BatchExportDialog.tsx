import { useCallback, useEffect, useRef, useState } from 'react';
import { exportBatchSchema, exportTargetSchema, formatFrameRate, recordPageSchema, type ExportBatch, type ExportTarget, type ProjectDocument, type VideoProfile } from '@video-quickly/contracts';
import { Trash2, Plus, RefreshCw, FolderOpen, Square, Download, Layers, History } from 'lucide-react';
import type { Action } from '../lib/types';
import { rpc } from '../lib/client';
import { Button, Dialog, Field, IconButton, Notice, Select } from './Primitives';
import PathPicker, { nativeDesktop, revealFile } from './PathPicker';
import VideoSettings from './VideoSettings';
import SettingsSections from './SettingsSections';
import './batch-export-dialog.css';

const batchesSchema = recordPageSchema(exportBatchSchema);
const labels: Record<ExportBatch['status'], string> = { queued: '排队中', running: '导出中', interrupted: '执行已中断', succeeded: '全部完成', partial: '部分完成', failed: '导出失败', canceled: '已停止' };
const targetLabels = { queued: '等待导出', running: '正在导出', interrupted: '执行已中断', succeeded: '已完成', failed: '导出失败', canceled: '已停止' };
type DraftTarget = ExportTarget & { selected: boolean; shortSide: string; ratio: number };
const even = (value: number) => Math.round(value / 2) * 2;
function initialTargets(profile: VideoProfile): DraftTarget[] {
  const short = Math.min(profile.width, profile.height);
  return [['landscape', '横屏 16:9', 16 / 9], ['portrait', '竖屏 9:16', 9 / 16], ['square', '方形 1:1', 1]].map(([id, label, ratio]) => {
    const numericRatio = Number(ratio);
    return { id: String(id), label: String(label), selected: true, shortSide: String(short), ratio: numericRatio, profile: { ...structuredClone(profile), width: even(numericRatio >= 1 ? short * numericRatio : short), height: even(numericRatio >= 1 ? short : short / numericRatio) } };
  });
}
const batchKey = (projectId: string) => `vq-export-batch:${projectId}`;

export default function BatchExportDialog({ project, onClose, notify }: {
  project: ProjectDocument; action: Action; onClose: () => void; notify?: (message: string, error?: boolean) => void;
}) {
  // An open configuration always refers to this saved revision. External edits must conflict.
  const [baseline] = useState(() => ({ id: project.id, title: project.title, revision: project.revision, shotCount: project.shots.length }));
  const [targets, setTargets] = useState(() => initialTargets(project.profile));
  const [destination, setDestination] = useState('');
  const [section, setSection] = useState(() => localStorage.getItem(batchKey(project.id)) ? 'history' : 'targets');
  const [history, setHistory] = useState<ExportBatch[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [batch, setBatch] = useState<ExportBatch>();
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState('');
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'start' | 'cancel' | 'resume'>();
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true), listRequest = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const loadHistory = useCallback(async (before?: number) => {
    const request = ++listRequest.current; setListBusy(true); setListError('');
    try {
      const page = batchesSchema.parse(await rpc('render.batch.list', { projectId: baseline.id, limit: 20, ...(before ? { before } : {}) }));
      if (!alive.current || request !== listRequest.current) return;
      setHistory(current => before ? [...current, ...page.items.filter(item => !current.some(existing => existing.id === item.id))] : page.items); setNextCursor(page.nextCursor);
      setSelectedId(current => current ?? localStorage.getItem(batchKey(baseline.id)) ?? page.items[0]?.id);
    } catch (reason) { if (alive.current && request === listRequest.current) setListError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (alive.current && request === listRequest.current) setListBusy(false); }
  }, [baseline.id]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);
  useEffect(() => {
    if (!selectedId) return;
    localStorage.setItem(batchKey(baseline.id), selectedId);
    let active = true, timer: number | undefined;
    setReadError('');
    async function read() {
      try {
        const value = exportBatchSchema.parse(await rpc('render.batch.get', { projectId: baseline.id, batchId: selectedId }));
        if (value.projectId !== baseline.id) throw new Error('该批量导出记录不属于当前项目。');
        if (!active) return;
        setBatch(value); setReadError('');
        setHistory(current => current.map(item => item.id === value.id ? value : item));
        if (['queued', 'running'].includes(value.status)) timer = window.setTimeout(() => void read(), 700);
      } catch (reason) { if (active) setReadError(reason instanceof Error ? reason.message : String(reason)); }
    }
    void read();
    return () => { active = false; window.clearTimeout(timer); };
  }, [selectedId, baseline.id, refresh]);

  const current = batch?.id === selectedId ? batch : undefined;
  const running = Boolean(current && ['queued', 'running'].includes(current.status));
  const selected = targets.filter(target => target.selected);
  const invalid = selected.map(target => exportTargetSchema.safeParse(target)).find(result => !result.success);
  function updateProfile(id: string, profile: VideoProfile) {
    setTargets(values => values.map(target => target.id === id ? { ...target, profile, shortSide: String(Math.min(profile.width, profile.height)), ...(profile.width > 0 && profile.height > 0 ? { ratio: profile.width / profile.height } : {}) } : target));
  }
  function updateShortSide(id: string, raw: string) {
    setTargets(values => values.map(target => {
      if (target.id !== id) return target;
      const value = Number(raw), short = Number.isFinite(value) && value > 0 ? value : 0;
      return { ...target, shortSide: raw, profile: { ...target.profile, width: even(target.ratio >= 1 ? short * target.ratio : short), height: even(target.ratio >= 1 ? short : short / target.ratio) } };
    }));
  }
  async function mutate(operation: 'start' | 'cancel' | 'resume') {
    setBusy(operation); setError('');
    try {
      const value = exportBatchSchema.parse(await rpc(`render.batch.${operation}`, operation === 'start'
        ? { projectId: baseline.id, revision: baseline.revision, targets: selected.map(({ id, label, profile }) => ({ id, label, profile })), ...(destination.trim() ? { destinationDirectory: destination.trim() } : {}) }
        : { projectId: baseline.id, batchId: current?.id }));
      if (!alive.current) return;
      setBatch(value); setSelectedId(value.id); localStorage.setItem(batchKey(baseline.id), value.id); setRefresh(count => count + 1); void loadHistory();
      setSection('history');
      notify?.(operation === 'start' ? '批量导出已开始' : operation === 'cancel' ? '已请求停止批量导出' : '已继续校验与导出');
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (alive.current) setBusy(undefined); }
  }
  return <Dialog title="多比例批量导出" onClose={onClose} className="batch-export-dialog settings-dialog">
    <div className="dialog__body"><SettingsSections label="批量导出设置" value={section} onValueChange={setSection} intro={<p className="batch-export__intro">{baseline.title} · 保存的修订 {baseline.revision}。各规格独立导出，不改变项目画面规格，也不会调用生成模型。</p>} sections={[
      { id: 'targets', label: '导出规格', icon: Layers, content: <fieldset className="batch-export__configuration" disabled={Boolean(busy)}><legend>导出规格</legend>
        <div className="batch-export__targets">{targets.map((target, index) => <section className={`batch-export__target ${target.selected ? 'is-selected' : ''}`} key={target.id} aria-label={`导出规格 ${target.label}`}>
          <div className="batch-export__target-heading"><label className="field-inline"><input type="checkbox" checked={target.selected} onChange={event => setTargets(values => values.map(item => item.id === target.id ? { ...item, selected: event.target.checked } : item))} />{target.label}</label>{index >= 3 && <IconButton label={`删除规格 ${target.label}`} onClick={() => setTargets(values => values.filter(item => item.id !== target.id))}><Trash2 size={13} /></IconButton>}</div>
          {target.selected && <><Field label={`${target.label} 短边（像素）`}><input type="number" min="64" max="7680" step="2" value={target.shortSide} onChange={event => updateShortSide(target.id, event.target.value)} /></Field><p className="batch-export__spec">{target.profile.width} × {target.profile.height} · {formatFrameRate(target.profile.frameRate)} fps</p><details><summary>调整{target.label}规格</summary><Field label={`${target.label} 输出名称`}><input value={target.label} maxLength={100} onChange={event => setTargets(values => values.map(item => item.id === target.id ? { ...item, label: event.target.value } : item))} /></Field><VideoSettings compact profile={target.profile} onChange={profile => updateProfile(target.id, profile)} /></details></>}
        </section>)}</div>
        <Button aria-label="添加规格" variant="ghost" disabled={targets.length >= 8} onClick={() => setTargets(values => { const profile = structuredClone(values.find(target => target.selected)?.profile ?? project.profile); return [...values, { id: crypto.randomUUID(), label: `自定义 ${values.length + 1}`, profile, selected: true, shortSide: String(Math.min(profile.width, profile.height)), ratio: profile.width / profile.height }]; })}><Plus size={13} />添加规格</Button>
        {!selected.length && <p className="field-error">请至少勾选一个导出规格。</p>}{invalid && !invalid.success && <p role="alert" className="field-error">{invalid.error.issues[0]?.message}</p>}
      </fieldset> },
      { id: 'output', label: '输出设置', icon: FolderOpen, content: <fieldset className="batch-export__configuration" disabled={Boolean(busy)}><legend>输出设置</legend><Field label="批量输出目录" hint="留空使用项目输出目录；各批次和规格独立保存。"><PathPicker label="批量输出目录" mode="directory" value={destination} onChange={setDestination} placeholder="选择或填写文件夹路径" /></Field></fieldset> },
      { id: 'history', label: '导出记录', icon: History, content: <section className="batch-export__history" aria-label="批量导出进度"><div className="batch-export__history-heading"><h3>导出记录</h3><Button aria-label="刷新导出记录" variant="ghost" busy={listBusy} onClick={() => void loadHistory()}><RefreshCw size={13} />刷新</Button></div>
        {listError && <Notice kind="error">{listError}</Notice>}
        {(history.length > 0 || current) && <Field label="批量导出记录"><Select value={selectedId ?? ''} disabled={Boolean(busy)} onChange={event => { setSelectedId(event.target.value); setError(''); }}><option value="" disabled>选择批量导出记录</option>{current && !history.some(item => item.id === current.id) && <option value={current.id}>{new Date(current.createdAt).toLocaleString('zh-CN')} · 修订 {current.projectRevision} · {labels[current.status]}</option>}{history.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString('zh-CN')} · 修订 {item.projectRevision} · {labels[item.status]}</option>)}</Select></Field>}
        {nextCursor !== null && <Button aria-label="加载更多导出" busy={listBusy} onClick={() => void loadHistory(nextCursor)}>加载更多</Button>}
        {readError && <Notice kind="error">{readError}<Button aria-label="重试批量进度" onClick={() => setRefresh(count => count + 1)}>重试</Button></Notice>}
        {current ? <><div className="batch-export__summary" role="status"><span className={`status status--${current.status}`}><span />{labels[current.status]}</span><span>源修订 {current.projectRevision} · {current.targets.filter(target => target.status === 'succeeded').length}/{current.targets.length} 个规格完成</span><code>{current.id}</code></div>
          <p className="tiny-meta">{current.status === 'interrupted' ? '上次执行已中断，点击“继续未完成导出”后恢复。' : running ? '导出在后台继续；关闭窗口后可重新打开查看。' : '每个规格的文件与状态分别保留，继续执行会校验并复用完整产物。'}</p>
          {current.error && <Notice kind="error">{current.error}</Notice>}
          <div className="batch-export__results">{current.targets.map(target => <article key={target.id} className="batch-export__result" aria-label={`导出结果 ${target.label}`}><header><strong>{target.label}</strong><span className={`status status--${target.status}`}><span />{targetLabels[target.status]}</span></header><p className="tiny-meta">{target.profile.width} × {target.profile.height} · {formatFrameRate(target.profile.frameRate)} fps</p><progress aria-label={`${target.label} 导出进度`} value={target.progress} max={1} /><span className="batch-export__percent">{Math.round(target.progress * 100)}%</span>{target.error && <p role="alert" className="field-error">{target.error}</p>}{([['videoPath', 'MP4'], ['coverPath', '封面'], ['subtitlePath', '字幕'], ['timelinePath', '时间轴']] as const).map(([key, label]) => target[key] && <p className="batch-export__path" key={key}><span>{label}</span><code>{target[key]}</code></p>)}{target.videoPath && nativeDesktop && <Button aria-label="打开文件夹" variant="ghost" onClick={() => void revealFile(target.videoPath!).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))}><FolderOpen size={13} />打开文件夹</Button>}</article>)}</div>
        </> : <p className="tiny-meta">{selectedId ? '正在读取批量导出…' : listBusy ? '正在读取导出记录…' : '还没有批量导出记录。'}</p>}
      </section> },
    ]} notice={error && <Notice kind="error">{error}</Notice>} /></div>
    <div className="dialog__footer"><Button onClick={onClose}>关闭</Button>{current && running && <Button aria-label="停止批量导出" busy={busy === 'cancel'} disabled={Boolean(busy && busy !== 'cancel')} onClick={() => void mutate('cancel')}><Square size={13} />停止</Button>}{current && !running && <Button aria-label={current.status === 'succeeded' ? '校验并恢复导出' : '继续未完成导出'} busy={busy === 'resume'} disabled={Boolean(busy && busy !== 'resume')} onClick={() => void mutate('resume')}>{current.status === 'succeeded' ? "校验并恢复" : "继续"}</Button>}<Button aria-label="开始导出" variant="primary" busy={busy === 'start'} disabled={Boolean(busy && busy !== 'start') || running || !selected.length || Boolean(invalid) || !baseline.shotCount} onClick={() => void mutate('start')}><Download size={14} />开始导出</Button></div>
  </Dialog>;
}
