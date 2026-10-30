import { useEffect, useState } from 'react';
import { ChevronDown, Download, FolderOpen, History, RefreshCw } from 'lucide-react';
import { activitySchema, assetSchema, recordPageSchema, runDiagnosticsSchema, runEventSchema, runInspectionSchema, runStepPayloadSchema, stepOutputVersionSchema, type JsonValue, type RunInspection, type RunStepSummary, type RunSummary } from '@video-quickly/contracts';
import { Button, Dialog, Notice, Status, statusLabels } from '../components/Primitives';
import { nativeDesktop, revealFile } from '../components/PathPicker';
import { getAssetUrl, rpc } from '../lib/client';
import { useRecordPage } from '../lib/use-record-page';
import { useRuntimeRead } from '../lib/use-runtime-read';
import type { StepOutputSelection } from '../lib/types';
import './run-inspector.css';

const versionsSchema = recordPageSchema(stepOutputVersionSchema);
const eventsSchema = recordPageSchema(runEventSchema);
const activitiesSchema = recordPageSchema(activitySchema);
const stepStates: Record<string, string> = { pending: '待执行', skipped: '未经过', not_recorded: '未记录' };
const date = (value: string) => new Date(value).toLocaleString('zh-CN');
const text = (value: JsonValue) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

export default function RunInspector({ runId, version, onClose, onChanged, onOpenOutput, onRestart }: {
  runId: string; version: number; onClose: () => void; onChanged: () => void;
  onOpenOutput: (selection: StepOutputSelection) => void;
  onRestart: (run: RunSummary) => void;
}) {
  const inspection = useRuntimeRead('run.inspect', { runId }, version, runInspectionSchema);
  const [selectedId, setSelectedId] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [diagnostic, setDiagnostic] = useState<ReturnType<typeof runDiagnosticsSchema.parse> & { url: string }>();
  const data = inspection.data;
  const selected = data?.steps.find(step => step.id === selectedId) ?? data?.steps.find(step => step.id === data.run.currentNodeId) ?? data?.steps[0];
  async function perform(method: string, params: Record<string, unknown> = {}) {
    setPending(method); setError('');
    try {
      const result = await rpc(method, { runId, ...params });
      if (method === 'run.diagnostics') { const saved = runDiagnosticsSchema.parse(result); setDiagnostic({ ...saved, url: await getAssetUrl(saved.path) }); }
      else { inspection.refresh(); onChanged(); }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(''); }
  }
  return <Dialog title="制作步骤详情" onClose={onClose} className="dialog--wide run-inspector">
    <div className="dialog__body run-inspector__body">
      {inspection.error && <Notice kind="error">{inspection.error}<Button onClick={inspection.refresh}>重试读取详情</Button></Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {!data && !inspection.error && <p role="status">正在读取制作步骤…</p>}
      {data && <>
        <header className="run-inspector__summary"><div><h3>{data.projectTitle}</h3><p>{date(data.run.createdAt)} · 修订 {data.run.projectRevision} · 流程 v{data.run.workflowVersion}</p><code>{data.run.id}</code></div><Status value={data.run.status} /></header>
        {data.recovery.reason && <Notice>{data.recovery.reason}</Notice>}
        {(!data.snapshotAvailable || !data.checkpointAvailable) && <Notice>{!data.snapshotAvailable ? '这次历史制作没有冻结流程，保留原始活动与日志供核对。' : '这次历史制作没有可验证的编排检查点；产物与日志按实际保存情况展示。'}</Notice>}
        {data.steps.length ? <div className="run-inspector__layout">
          <nav className="run-inspector__steps" aria-label="冻结流程步骤">{data.steps.map((step, index) => <button type="button" key={step.id} aria-current={selected?.id === step.id ? 'step' : undefined} onClick={() => setSelectedId(step.id)}><span className="run-inspector__index">{index + 1}</span><span><strong>{step.label}</strong><StepStatus step={step} /></span>{step.outputAvailable && <span className="run-inspector__output-mark" aria-label="已保存产物" />}</button>)}</nav>
          {selected && <StepDetail key={`${runId}:${selected.id}`} inspection={data} step={selected} version={version} onOpenOutput={onOpenOutput} />}
        </div> : <RunLog runId={runId} version={version} />}
      </>}
      {diagnostic && <div className="run-inspector__diagnostic" role="status"><span>诊断已导出 · {diagnostic.bytes.toLocaleString()} 字节</span><code>{diagnostic.path}</code>{nativeDesktop ? <Button onClick={() => void revealFile(diagnostic.path).catch(error => setError(String(error)))}><FolderOpen size={16} />打开所在文件夹</Button> : <a className="button" href={diagnostic.url} download>下载诊断文件</a>}</div>}
    </div>
    <div className="dialog__footer run-inspector__footer">
      <Button busy={pending === 'run.diagnostics'} disabled={Boolean(pending) || !data} onClick={() => void perform('run.diagnostics')}><Download size={16} />导出诊断</Button>
      <Button busy={inspection.busy} disabled={Boolean(pending)} onClick={inspection.refresh}><RefreshCw size={16} />刷新详情</Button>
      {data?.recovery.review && <><Button disabled={Boolean(pending)} onClick={() => void perform('run.review', { approved: false })}>停止并修改</Button><Button variant="primary" busy={pending === 'run.review'} disabled={Boolean(pending)} onClick={() => void perform('run.review', { approved: true })}>通过审阅并继续</Button></>}
      {data?.recovery.resume && <Button variant="primary" busy={pending === 'run.resume'} disabled={Boolean(pending)} onClick={() => void perform('run.resume')}>继续执行</Button>}
      {data?.recovery.cancel && <Button disabled={Boolean(pending)} onClick={() => void perform('run.cancel')}>停止制作</Button>}
      {data?.recovery.restart && <Button disabled={Boolean(pending)} onClick={() => { if (data.run.selection) onRestart(data.run); else void perform('run.start', { projectId: data.run.projectId, parentRunId: runId }); }}>重新制作</Button>}
      <Button onClick={onClose}>关闭</Button>
    </div>
  </Dialog>;
}

function StepStatus({ step }: { step: RunStepSummary }) {
  return stepStates[step.status] ? <span className="run-inspector__state">{stepStates[step.status]}</span> : <Status value={step.status} />;
}

function StepDetail({ inspection, step, version, onOpenOutput }: { inspection: RunInspection; step: RunStepSummary; version: number; onOpenOutput: (selection: StepOutputSelection) => void }) {
  const [tab, setTab] = useState<'status' | 'input' | 'output' | 'log'>('status');
  const selected = useRuntimeRead('run.inspect', { runId: inspection.run.id, nodeId: step.id }, version, runInspectionSchema);
  const detail = selected.data?.selected;
  const tabs = [{ id: 'status', label: '执行状态' }, { id: 'input', label: '执行输入' }, { id: 'output', label: '步骤产物' }, { id: 'log', label: '活动与日志' }] as const;
  return <section className="run-inspector__detail" aria-label={`步骤详情：${step.label}`}>
    <header className="run-inspector__step-heading"><div><h3>{step.label}</h3><p>{step.description || step.kind}</p></div><StepStatus step={step} /></header>
    <div className="run-inspector__tabs" role="tablist" aria-label="步骤详情视图">{tabs.map(item => <button key={item.id} id={`step-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls="step-detail-panel" tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => {
      const index = tabs.findIndex(item => item.id === tab);
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
      if (next === undefined) return;
      event.preventDefault(); setTab(tabs[next].id); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }}>{item.label}</button>)}</div>
    <div id="step-detail-panel" role="tabpanel" aria-labelledby={`step-tab-${tab}`} className="run-inspector__panel">
      {tab === 'status' && <><p className="run-inspector__reason" role={step.error ? 'alert' : 'status'}>{step.reason}</p>{selected.error && <Notice kind="error">{selected.error}<Button onClick={selected.refresh}>重试读取配置</Button></Notice>}
        <dl className="run-inspector__facts"><div><dt>步骤 ID</dt><dd>{step.id}</dd></div><div><dt>实际活动</dt><dd>{step.activityCount} 条</dd></div><div><dt>执行输入</dt><dd>{step.inputAvailable ? '已保存' : '尚未记录'}</dd></div><div><dt>步骤产物</dt><dd>{step.outputAvailable ? '已保存' : '尚未保存'}</dd></div>{step.startedAt && <div><dt>开始时间</dt><dd>{date(step.startedAt)}</dd></div>}{step.completedAt && <div><dt>完成时间</dt><dd>{date(step.completedAt)}</dd></div>}
          {detail && <><div><dt>模型快照</dt><dd>{detail.model ? `${detail.model.name} · ${detail.model.model}` : '未绑定模型'}</dd></div><div><dt>上游步骤</dt><dd>{detail.dependencies.map(id => inspection.steps.find(step => step.id === id)?.label ?? id).join('、') || '无'}</dd></div><div><dt>Skill 快照</dt><dd>{detail.skills.map(skill => `${skill.name} v${skill.version}${skill.enabled ? '' : '（停用）'}`).join('、') || '无'}</dd></div><div><dt>人工审阅</dt><dd>{detail.node.requiresReview ? '需要' : '无需'}</dd></div></>}
        </dl>{detail && <details className="run-inspector__raw"><summary>冻结步骤配置</summary><pre>{JSON.stringify(detail.node, null, 2)}</pre></details>}</>}
      {tab === 'input' && <StepInput runId={inspection.run.id} nodeId={step.id} version={version} />}
      {tab === 'output' && <StepOutputs inspection={inspection} step={step} version={version} onOpenOutput={onOpenOutput} />}
      {tab === 'log' && <RunLog runId={inspection.run.id} nodeId={step.id} version={version} />}
    </div>
  </section>;
}

function StepInput({ runId, nodeId, version }: { runId: string; nodeId: string; version: number }) {
  const input = useRuntimeRead('run.step.payload', { runId, nodeId, kind: 'input' }, version, runStepPayloadSchema);
  return <>{input.error && <Notice kind="error">{input.error}<Button onClick={input.refresh}>重试读取输入</Button></Notice>}{!input.data && !input.error && <p role="status">正在读取执行输入…</p>}{input.data && <>{!input.data.available ? <p>这个步骤尚未记录执行输入。</p> : <><p className="run-inspector__muted">这里保存步骤开始时的项目、模型与 Skill 上下文。{input.data.resolvedPromptRecorded ? '包含执行时记录的提示词。' : '这次记录没有保存最终提示词。'}</p>{input.data.inputHash && <p className="run-inspector__hash">输入摘要 <code>{input.data.inputHash}</code></p>}<pre className="run-inspector__json">{text(input.data.value)}</pre></>}</>}</>;
}

function StepOutputs({ inspection, step, version, onOpenOutput }: { inspection: RunInspection; step: RunStepSummary; version: number; onOpenOutput: (selection: StepOutputSelection) => void }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [comparisonId, setComparisonId] = useState('');
  const output = useRuntimeRead('run.step.payload', { runId: inspection.run.id, nodeId: step.id, kind: 'output' }, version, runStepPayloadSchema);
  const applicable = ['script', 'style', 'assets', 'voice', 'animation', 'research'].includes(step.kind);
  const open = (runId: string) => onOpenOutput({ projectId: inspection.run.projectId, runId, nodeId: step.id, kind: step.kind });
  return <>{output.error && <Notice kind="error">{output.error}<Button onClick={output.refresh}>重试读取产物</Button></Notice>}
    <div className="run-inspector__output-actions"><Button aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}><History size={16} />历史产物</Button>{output.data?.available && <Button variant="primary" onClick={() => open(inspection.run.id)}>{applicable ? '在项目中查看与应用' : '在项目中查看'}</Button>}</div>
    {historyOpen && <OutputVersions runId={inspection.run.id} nodeId={step.id} comparisonId={comparisonId} onCompare={setComparisonId} />}
    {!output.data && !output.error && <p role="status">正在读取步骤产物…</p>}
    {output.data && !output.data.available && <p>这个步骤尚未保存产物。</p>}
    <div className={`run-inspector__outputs${comparisonId ? ' run-inspector__outputs--compare' : ''}`}>
      {output.data?.available && <section aria-label="本次产物"><h4>本次产物</h4><PayloadView value={output.data.value} /></section>}
      {comparisonId && <HistoricalOutput key={comparisonId} runId={comparisonId} nodeId={step.id} applicable={applicable} onOpen={() => open(comparisonId)} onClose={() => setComparisonId('')} />}
    </div>
  </>;
}

function OutputVersions({ runId, nodeId, comparisonId, onCompare }: { runId: string; nodeId: string; comparisonId: string; onCompare: (id: string) => void }) {
  const history = useRecordPage('run.step.versions', { runId, nodeId, limit: 20 }, 0, versionsSchema);
  return <div className="run-inspector__versions" aria-label="历史产物版本">{history.error && <Notice kind="error">{history.error}<Button onClick={history.refresh}>重试读取版本</Button></Notice>}{history.items.filter(item => item.id !== runId).map(item => <button type="button" key={item.id} aria-pressed={comparisonId === item.id} onClick={() => onCompare(item.id)}><strong>{date(item.createdAt)}</strong><span>修订 {item.projectRevision} · 流程 v{item.workflowVersion} · {item.label}</span><span>来源制作：{statusLabels[item.status] ?? item.status}</span><code>{item.id}</code></button>)}{!history.busy && !history.error && !history.items.some(item => item.id !== runId) && <p>没有其他已保存的产物版本。</p>}{history.nextCursor !== null && <Button busy={history.busy} onClick={() => void history.loadMore()}><ChevronDown size={16} />加载更早版本</Button>}</div>;
}

function HistoricalOutput({ runId, nodeId, applicable, onOpen, onClose }: { runId: string; nodeId: string; applicable: boolean; onOpen: () => void; onClose: () => void }) {
  const output = useRuntimeRead('run.step.payload', { runId, nodeId, kind: 'output' }, 0, runStepPayloadSchema);
  return <section aria-label="历史产物"><h4>历史产物</h4><code className="run-inspector__muted">{runId}</code>{output.error && <Notice kind="error">{output.error}<Button onClick={output.refresh}>重试读取历史产物</Button></Notice>}{!output.data && !output.error && <p role="status">正在读取历史产物…</p>}{output.data?.available && <><PayloadView value={output.data.value} /><Button onClick={onOpen}>{applicable ? '在项目中查看与应用此版本' : '在项目中查看此版本'}</Button></>}<Button variant="ghost" onClick={onClose}>取消对比</Button></section>;
}

function PayloadView({ value }: { value: JsonValue }) {
  const [assetId, setAssetId] = useState('');
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  const assets = (object && Array.isArray(object.assets) ? object.assets : []).flatMap(value => { const asset = assetSchema.safeParse(value); return asset.success && ['image', 'audio', 'video'].includes(asset.data.kind) ? [asset.data] : []; });
  const asset = assets.find(asset => asset.id === assetId) ?? assets[0];
  const shots = object && Array.isArray(object.shots) ? object.shots : [];
  return <div className="run-inspector__payload">
    {typeof value === 'string' ? <pre>{value}</pre> : typeof object?.text === 'string' && <pre>{object.text}</pre>}
    {shots.map((shot, index) => shot && typeof shot === 'object' && !Array.isArray(shot) && <article className="run-inspector__shot" key={typeof shot.id === 'string' ? shot.id : index}><h4>{typeof shot.title === 'string' ? shot.title : `镜头 ${index + 1}`}</h4>{typeof shot.narration === 'string' && <p>{shot.narration}</p>}{typeof shot.visualPrompt === 'string' && <p className="run-inspector__muted">{shot.visualPrompt}</p>}</article>)}
    {asset && <div className="run-inspector__media"><div className="run-inspector__asset-list" aria-label="产物媒体">{assets.map(item => <Button key={item.id} aria-pressed={asset.id === item.id} onClick={() => setAssetId(item.id)}>{item.name}</Button>)}</div><OutputMedia key={`${asset.id}:${asset.version}:${asset.sha256}:${asset.path}`} asset={asset} /></div>}
    {typeof value !== 'string' && <details className="run-inspector__raw" open={!object || !('text' in object) && !shots.length && !asset}><summary>完整产物数据</summary><pre>{text(value)}</pre></details>}
  </div>;
}

function RunLog({ runId, nodeId, version }: { runId: string; nodeId?: string; version: number }) {
  const params = { runId, ...(nodeId ? { nodeId } : {}) };
  const events = useRecordPage('run.events', params, version, eventsSchema);
  const activities = useRecordPage('run.activities', params, version, activitiesSchema);
  return <div className="run-inspector__logs">{(events.error || activities.error) && <Notice kind="error">{events.error || activities.error}<Button onClick={() => { events.refresh(); activities.refresh(); }}>重试读取日志</Button></Notice>}
    {activities.items.map(activity => <article className="run-inspector__activity" key={activity.id}><code>{activity.id}</code><Status value={activity.status === 'completed' ? 'succeeded' : activity.status === 'prepared' ? 'queued' : activity.status === 'submitted' ? 'waiting_external' : activity.status === 'unknown' ? 'needs_attention' : activity.status} />{activity.remoteTaskId && <p>远端任务 {activity.remoteTaskId}</p>}{activity.error && <p role="alert">{activity.error}</p>}</article>)}
    {activities.nextCursor !== null && <Button busy={activities.busy} onClick={() => void activities.loadMore()}>加载更多活动</Button>}
    <pre className="run-inspector__json">{events.items.length ? events.items.toReversed().map(event => `${date(event.createdAt)}  ${event.message}`).join('\n') : events.busy ? '正在读取执行日志…' : '没有记录到执行日志。'}</pre>
    {events.nextCursor !== null && <Button busy={events.busy} onClick={() => void events.loadMore()}>加载更早日志</Button>}
  </div>;
}

function OutputMedia({ asset }: { asset: ReturnType<typeof assetSchema.parse> }) {
  const [source, setSource] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    let current = true;
    void getAssetUrl(asset.path).then(url => { if (current) setSource({ url }); }).catch(error => { if (current) setSource({ error: String(error) }); });
    return () => { current = false; };
  }, [asset.path]);
  if (source.error) return <Notice kind="error">{source.error}</Notice>;
  if (!source.url) return <p role="status">正在读取媒体…</p>;
  return asset.kind === 'image' ? <img src={source.url} alt={asset.name} loading="lazy" /> : asset.kind === 'video' ? <video src={source.url} controls preload="metadata" aria-label={asset.name} /> : <audio src={source.url} controls preload="metadata" aria-label={asset.name} />;
}
