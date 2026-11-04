import { useId, useState } from 'react';
import { ChevronDown, Download, FolderOpen, History, RefreshCw } from 'lucide-react';
import { activitySchema, recordPageSchema, runDiagnosticsSchema, runEventSchema, runInspectionSchema, runStepPayloadSchema, stepOutputVersionSchema, type RunInspection, type RunStepSummary, type RunSummary } from '@video-quickly/contracts';
import { Button, Dialog, Notice, Status, statusLabels } from '../components/Primitives';
import { nativeDesktop, revealFile } from '../components/PathPicker';
import { getAssetUrl, rpc } from '../lib/client';
import { useRecordPage } from '../lib/use-record-page';
import { useRuntimeRead } from '../lib/use-runtime-read';
import type { StepOutputSelection } from '../lib/types';
import RunActions from './RunActions';
import StepResultView from '../components/StepResultView';
import { stepGuidance } from '../lib/workflow-guidance';
import './run-inspector.css';

const versionsSchema = recordPageSchema(stepOutputVersionSchema);
const eventsSchema = recordPageSchema(runEventSchema);
const activitiesSchema = recordPageSchema(activitySchema);
const stepStates: Record<string, string> = { pending: '待执行', skipped: '未经过', not_recorded: '未记录' };
const date = (value: string) => new Date(value).toLocaleString('zh-CN');

export default function RunInspector({ runId, initialNodeId, version, onClose, onChanged, onOpenOutput, onRestart }: {
  runId: string; initialNodeId?: string; version: number; onClose: () => void; onChanged: () => void;
  onOpenOutput: (selection: StepOutputSelection) => void;
  onRestart: (run: RunSummary) => void;
}) {
  const inspection = useRuntimeRead('run.inspect', { runId }, version, runInspectionSchema);
  const [selectedId, setSelectedId] = useState(initialNodeId ?? '');
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
      {inspection.error && <Notice kind="error">{inspection.error}<Button aria-label="重试读取详情" onClick={inspection.refresh}>重试</Button></Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {!data && !inspection.error && <p role="status">正在读取制作步骤…</p>}
      {data && <>
        <header className="run-inspector__summary"><div><h3>{data.projectTitle}</h3><p>{date(data.run.createdAt)}</p></div><Status value={data.run.status} /></header>
        {data.recovery.reason && <Notice>{data.recovery.reason}</Notice>}
        {(!data.snapshotAvailable || !data.checkpointAvailable) && <Notice>{!data.snapshotAvailable ? '这次历史制作没有冻结流程，保留原始活动与日志供核对。' : '这次历史制作没有可验证的编排检查点；产物与日志按实际保存情况展示。'}</Notice>}
        {data.steps.length ? <div className="run-inspector__layout">
          <nav className="run-inspector__steps" aria-label="冻结流程步骤">{data.steps.map((step, index) => <button type="button" key={step.id} aria-current={selected?.id === step.id ? 'step' : undefined} onClick={() => setSelectedId(step.id)}><span className="run-inspector__index">{index + 1}</span><span><strong>{step.label}</strong><StepStatus step={step} /></span>{step.outputAvailable && <span className="run-inspector__output-mark" aria-label="已保存产物" />}</button>)}</nav>
          {selected && <StepDetail key={`${runId}:${selected.id}`} inspection={data} step={selected} version={version} onOpenOutput={onOpenOutput} />}
        </div> : <RunLog runId={runId} version={version} />}
      </>}
      {diagnostic && <div className="run-inspector__diagnostic" role="status"><span>诊断已导出 · {diagnostic.bytes.toLocaleString()} 字节</span><code>{diagnostic.path}</code>{nativeDesktop ? <Button aria-label="打开文件夹" onClick={() => void revealFile(diagnostic.path).catch(error => setError(String(error)))}><FolderOpen size={16} />打开文件夹</Button> : <a className="button" href={diagnostic.url} download>下载诊断文件</a>}</div>}
    </div>
    <div className="dialog__footer run-inspector__footer">
      <details className="run-inspector__tools"><summary>更多选项</summary><div><Button static busy={pending === 'run.diagnostics'} disabled={Boolean(pending) || !data} onClick={() => void perform('run.diagnostics')}><Download size={16} />导出诊断</Button><Button static aria-label="刷新详情" busy={inspection.busy} disabled={Boolean(pending)} onClick={inspection.refresh}><RefreshCw size={16} />刷新</Button></div></details>
      {data && <RunActions inspection={data} pending={pending} onPerform={(method, params) => void perform(method, params)} onRestart={onRestart} />}
      <Button onClick={onClose}>关闭</Button>
    </div>
  </Dialog>;
}

export function StepStatus({ step }: { step: RunStepSummary }) {
  return stepStates[step.status] ? <span className="run-inspector__state">{stepStates[step.status]}</span> : <Status value={step.status} />;
}

export function StepDetail({ inspection, step, version, onOpenOutput, defaultTab, currentRun = false }: { inspection: RunInspection; step: RunStepSummary; version: number; onOpenOutput: (selection: StepOutputSelection) => void; defaultTab?: 'output' | 'status'; currentRun?: boolean }) {
  const [tab, setTab] = useState<'output' | 'status'>(defaultTab ?? (step.outputAvailable ? 'output' : 'status'));
  const [logOpen, setLogOpen] = useState(false);
  const id = useId();
  const selected = useRuntimeRead('run.inspect', { runId: inspection.run.id, nodeId: step.id }, version, runInspectionSchema);
  const detail = selected.data?.selected;
  const help = stepGuidance(detail?.node ?? { kind: step.kind, config: {} });
  const tabs = [{ id: 'output', label: '步骤产物' }, { id: 'status', label: '制作信息' }] as const;
  return <section className="run-inspector__detail" aria-label={`步骤详情：${step.label}`}>
    <header className="run-inspector__step-heading"><div><h3>{step.label}</h3>{tab === 'status' && <p>{step.description || help.purpose}</p>}</div>{tab === 'status' && <StepStatus step={step} />}</header>
    <div className="run-inspector__tabs" role="tablist" aria-label="步骤详情视图">{tabs.map(item => <button key={item.id} id={`${id}-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`${id}-panel`} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => {
      const index = tabs.findIndex(item => item.id === tab);
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
      if (next === undefined) return;
      event.preventDefault(); setTab(tabs[next].id); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }}>{item.label}</button>)}</div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className="run-inspector__panel">
      {tab === 'output' && <StepOutputs inspection={inspection} step={step} version={version} onOpenOutput={onOpenOutput} />}
      {tab === 'status' && <><p className="run-inspector__reason" role={step.error ? 'alert' : 'status'}>{step.reason}</p>{selected.error && <Notice kind="error">{selected.error}<Button aria-label="重试读取配置" onClick={selected.refresh}>重试</Button></Notice>}
        <dl className="run-inspector__facts"><div><dt>本步产出</dt><dd>{help.result}</dd></div>{detail && <><div><dt>{currentRun ? step.activityCount > 0 ? '本次使用的模型' : '本次配置的模型' : '制作模型'}</dt><dd>{detail.model ? `${detail.model.name} · ${detail.model.model}` : detail.node.modelId ? `所选模型不可用 · ${detail.node.modelId}` : help.local}</dd></div><div><dt>前置步骤</dt><dd>{detail.dependencies.map(id => inspection.steps.find(step => step.id === id)?.label ?? id).join('、') || '从项目内容开始'}</dd></div>{detail.skills.length > 0 && <div><dt>采用的规范</dt><dd>{detail.skills.map(skill => skill.name).join('、')}</dd></div>}</>}{step.startedAt && <div><dt>开始时间</dt><dd>{date(step.startedAt)}</dd></div>}{step.completedAt && <div><dt>完成时间</dt><dd>{date(step.completedAt)}</dd></div>}</dl>
        {currentRun && <StepExecutionPrompt runId={inspection.run.id} step={step} version={version} configuredPrompt={detail?.node.prompt} />}
        <details className="run-inspector__logs-toggle" onToggle={event => setLogOpen(event.currentTarget.open)}><summary>活动与日志</summary>{logOpen && <RunLog runId={inspection.run.id} nodeId={step.id} version={version} />}</details>
      </>}
    </div>
  </section>;
}

function StepExecutionPrompt({ runId, step, version, configuredPrompt }: { runId: string; step: RunStepSummary; version: number; configuredPrompt?: string }) {
  const input = useRuntimeRead('run.step.payload', { runId, nodeId: step.id, kind: 'input' }, version, runStepPayloadSchema);
  const value = input.data?.value;
  const resolvedPrompt = value && typeof value === 'object' && !Array.isArray(value) && typeof value.resolvedPrompt === 'string' ? value.resolvedPrompt : undefined;
  return <section className="run-inspector__execution-prompt" aria-label="本次提示词记录">
    <h4>{resolvedPrompt !== undefined ? '本次使用的提示词' : '本次冻结的提示词与补充要求'}</h4>
    {input.error && <Notice kind="error">{input.error}<Button aria-label="重试读取本次提示词" onClick={input.refresh}>重试</Button></Notice>}
    {!input.data && !input.error && <p role="status">正在读取本次提示词…</p>}
    {input.data && <>
      {resolvedPrompt !== undefined ? <pre className="run-inspector__json">{resolvedPrompt || '本步骤没有记录提示词内容。'}</pre> : configuredPrompt ? <pre className="run-inspector__json">{configuredPrompt}</pre> : <p>本步骤没有补充提示词。</p>}
      <p className="run-inspector__muted">{!step.inputAvailable ? '尚未执行，未记录实际使用的提示词。' : resolvedPrompt !== undefined ? '执行时记录的提示词，只读。配置修改会用于新的制作。' : '这里显示本次保存的步骤配置，未记录完整执行提示词。'}</p>
    </>}
  </section>;
}

function StepOutputs({ inspection, step, version, onOpenOutput }: { inspection: RunInspection; step: RunStepSummary; version: number; onOpenOutput: (selection: StepOutputSelection) => void }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [comparisonId, setComparisonId] = useState('');
  const output = useRuntimeRead('run.step.payload', { runId: inspection.run.id, nodeId: step.id, kind: 'output' }, version, runStepPayloadSchema);
  const applicable = inspection.run.purpose !== 'workflow-assistant' && ['script', 'style', 'assets', 'animation', 'research'].includes(step.kind);
  const open = (runId: string) => onOpenOutput({ projectId: inspection.run.projectId, runId, nodeId: step.id, kind: step.kind });
  return <>{output.error && <Notice kind="error">{output.error}<Button aria-label="重试读取产物" onClick={output.refresh}>重试</Button></Notice>}
    {historyOpen && <OutputVersions runId={inspection.run.id} nodeId={step.id} comparisonId={comparisonId} onCompare={setComparisonId} />}
    {!output.data && !output.error && <p role="status">正在读取步骤产物…</p>}
    {output.data && !output.data.available && <p>这个步骤尚未保存产物。</p>}
    <div className={`run-inspector__outputs${comparisonId ? ' run-inspector__outputs--compare' : ''}`}>
      {output.data?.available && <section aria-label="本次产物">{comparisonId && <h4>本次产物</h4>}<StepResultView value={output.data.value} kind={step.kind} /></section>}
      {comparisonId && <HistoricalOutput key={comparisonId} runId={comparisonId} nodeId={step.id} kind={step.kind} applicable={applicable} onOpen={() => open(comparisonId)} onClose={() => setComparisonId('')} />}
    </div>
    <div className="run-inspector__output-actions"><Button variant="ghost" aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}><History size={16} />历史产物</Button>{applicable && output.data?.available && <Button aria-label="在项目中查看与应用" onClick={() => open(inspection.run.id)}>在工作台使用</Button>}</div>
  </>;
}

function OutputVersions({ runId, nodeId, comparisonId, onCompare }: { runId: string; nodeId: string; comparisonId: string; onCompare: (id: string) => void }) {
  const history = useRecordPage('run.step.versions', { runId, nodeId, limit: 20 }, 0, versionsSchema);
  return <div className="run-inspector__versions" aria-label="历史产物版本">{history.error && <Notice kind="error">{history.error}<Button aria-label="重试读取版本" onClick={history.refresh}>重试</Button></Notice>}{history.items.filter(item => item.id !== runId).map(item => <button type="button" key={item.id} data-run-id={item.id} aria-pressed={comparisonId === item.id} onClick={() => onCompare(item.id)}><strong>{date(item.createdAt)}</strong><span>{item.label}</span><span>来源制作：{statusLabels[item.status] ?? item.status}</span></button>)}{!history.busy && !history.error && !history.items.some(item => item.id !== runId) && <p>没有其他已保存的产物版本。</p>}{history.nextCursor !== null && <Button aria-label="加载更多版本" busy={history.loadingMore} disabled={!history.canLoadMore} onClick={() => void history.loadMore()}><ChevronDown size={16} />加载更多</Button>}</div>;
}

function HistoricalOutput({ runId, nodeId, kind, applicable, onOpen, onClose }: { runId: string; nodeId: string; kind: RunStepSummary['kind']; applicable: boolean; onOpen: () => void; onClose: () => void }) {
  const output = useRuntimeRead('run.step.payload', { runId, nodeId, kind: 'output' }, 0, runStepPayloadSchema);
  return <section aria-label="历史产物"><h4>历史产物</h4>{output.error && <Notice kind="error">{output.error}<Button aria-label="重试读取历史产物" onClick={output.refresh}>重试</Button></Notice>}{!output.data && !output.error && <p role="status">正在读取历史产物…</p>}{output.data?.available && <><StepResultView value={output.data.value} kind={kind} />{applicable && <Button aria-label="在项目中查看与应用此版本" onClick={onOpen}>使用此版本</Button>}</>}<Button variant="ghost" onClick={onClose}>取消对比</Button></section>;
}

function RunLog({ runId, nodeId, version }: { runId: string; nodeId?: string; version: number }) {
  const params = { runId, ...(nodeId ? { nodeId } : {}) };
  const events = useRecordPage('run.events', params, version, eventsSchema);
  const activities = useRecordPage('run.activities', params, version, activitiesSchema);
  return <div className="run-inspector__logs">{(events.error || activities.error) && <Notice kind="error">{events.error || activities.error}<Button aria-label="重试读取日志" onClick={() => { events.refresh(); activities.refresh(); }}>重试</Button></Notice>}
    {activities.items.map(activity => <article className="run-inspector__activity" key={activity.id}><code>{activity.id}</code><Status value={activity.status === 'completed' ? 'succeeded' : activity.status === 'prepared' ? 'queued' : activity.status === 'submitted' ? 'waiting_external' : activity.status === 'unknown' ? 'needs_attention' : activity.status} />{activity.remoteTaskId && <p>远端任务 {activity.remoteTaskId}</p>}{activity.error && <p role="alert">{activity.error}</p>}</article>)}
    {activities.nextCursor !== null && <Button aria-label="加载更多活动" busy={activities.loadingMore} disabled={!activities.canLoadMore} onClick={() => void activities.loadMore()}>加载更多</Button>}
    <pre className="run-inspector__json">{events.items.length ? events.items.toReversed().map(event => `${date(event.createdAt)}  ${event.message}`).join('\n') : events.busy ? '正在读取执行日志…' : '没有记录到执行日志。'}</pre>
    {events.nextCursor !== null && <Button aria-label="加载更多日志" busy={events.loadingMore} disabled={!events.canLoadMore} onClick={() => void events.loadMore()}>加载更多</Button>}
  </div>;
}
