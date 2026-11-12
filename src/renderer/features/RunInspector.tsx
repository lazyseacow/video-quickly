import { useEffect, useId, useRef, useState } from 'react';
import { Download, FolderOpen, RefreshCw } from 'lucide-react';
import { activitySchema, recordPageSchema, runDiagnosticsSchema, runEventSchema, runInspectionSchema, runStepPayloadSchema, type RunStepSummary } from '@video-quickly/contracts';
import { Button, Dialog, Notice, Status } from '../components/Primitives';
import { nativeDesktop, revealFile } from '../lib/desktop';
import { getAssetUrl } from '../lib/client';
import { useRecordPage } from '../lib/use-record-page';
import { useRuntimeRead } from '../lib/use-runtime-read';
import type { StepOutputSelection } from '../lib/types';
import { generationLabel } from '../lib/workbench-stages';
import { stepGuidance } from '../lib/workflow-guidance';
import { isPlanningSection } from '../lib/planning-edits';
import { ModelResponseDetails, SavedOutputIcon, StepOutputs, StepRetryAction, StepStatus, useRecordedStepOutput, type StepOutputsProps } from './RunStepOutput';
import { useRunInspectionOperations } from './use-run-operations';

const eventsSchema = recordPageSchema(runEventSchema);
const activitiesSchema = recordPageSchema(activitySchema);
const date = (value: string) => new Date(value).toLocaleString('zh-CN');

function historyStepLabel(step: RunStepSummary, workflowId?: string) {
  return workflowId === 'native-video' && step.modelGeneration && isPlanningSection(step.kind)
    ? generationLabel(step.label) : step.label;
}

export default function RunInspector({ runId, initialNodeId, version, onClose, onChanged, onOpenOutput }: {
  runId: string; initialNodeId?: string; version: number; onClose: () => void; onChanged: () => void;
  onOpenOutput: (selection: StepOutputSelection) => void;
}) {
  const [selectedId, setSelectedId] = useState(initialNodeId ?? '');
  const navigation = useRef<HTMLElement>(null);
  const [diagnostic, setDiagnostic] = useState<ReturnType<typeof runDiagnosticsSchema.parse> & { url: string }>();
  const { inspection, pending, error, setError, perform } = useRunInspectionOperations(runId, version, {
    onChanged,
    async onDiagnostic(result) {
      const saved = runDiagnosticsSchema.parse(result);
      setDiagnostic({ ...saved, url: await getAssetUrl(saved.path) });
    },
  });
  const data = inspection.data;
  const selected = data?.steps.find(step => step.id === selectedId) ?? data?.steps.find(step => step.id === data.run.currentNodeId) ?? data?.steps[0];
  useEffect(() => { navigation.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [selected?.id]);
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
          <nav ref={navigation} className="run-inspector__steps" aria-label="冻结流程步骤">
            {data.steps.map((step, index) => <button type="button" key={step.id} aria-current={selected?.id === step.id ? 'step' : undefined} onClick={() => setSelectedId(step.id)}>
              <span className="run-inspector__index">{String(index + 1).padStart(2, '0')}</span>
              <span><strong>{historyStepLabel(step, data.workflowId)}</strong><StepStatus step={step} overview /></span>
              {step.outputAvailable && <SavedOutputIcon />}
            </button>)}
          </nav>
          {selected && <StepDetail key={`${runId}:${selected.id}`} inspection={data} step={selected} version={version} onOpenOutput={onOpenOutput} retry={{ busy: pending === 'run.step.retry', disabled: Boolean(pending || inspection.error), onRetry: () => { setSelectedId(selected.id); void perform('run.step.retry', { nodeId: selected.id }); } }} />}
        </div> : <div className="run-inspector__history"><RunLog runId={runId} version={version} /></div>}
      </>}
      {diagnostic && <div className="run-inspector__diagnostic" role="status"><span>诊断已导出 · {diagnostic.bytes.toLocaleString()} 字节</span><code>{diagnostic.path}</code>{nativeDesktop ? <Button aria-label="打开文件夹" onClick={() => void revealFile(diagnostic.path).catch(error => setError(String(error)))}><FolderOpen size={16} />打开文件夹</Button> : <a className="button" href={diagnostic.url} download>下载诊断文件</a>}</div>}
    </div>
    <div className="dialog__footer run-inspector__footer">
      <details className="run-inspector__tools"><summary>更多选项</summary><div><Button static busy={pending === 'run.diagnostics'} disabled={Boolean(pending) || !data} onClick={() => void perform('run.diagnostics')}><Download size={16} />导出诊断</Button><Button static aria-label="刷新详情" busy={inspection.busy} disabled={Boolean(pending)} onClick={inspection.refresh}><RefreshCw size={16} />刷新</Button></div></details>
      {data?.recovery.resume && <Button static aria-label="继续执行" variant="primary" busy={pending === 'run.resume'} disabled={Boolean(pending)} onClick={() => void perform('run.resume')}>继续</Button>}
      {data?.recovery.cancel && <Button static aria-label="停止制作" disabled={Boolean(pending)} onClick={() => void perform('run.cancel')}>停止</Button>}
      <Button onClick={onClose}>关闭</Button>
    </div>
  </Dialog>;
}

function StepDetail({ inspection, step, version, onOpenOutput, retry }: StepOutputsProps) {
  const [tab, setTab] = useState<'output' | 'status'>(step.outputAvailable ? 'output' : 'status');
  const [promptOpen, setPromptOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const id = useId();
  const selected = useRuntimeRead('run.inspect', { runId: inspection.run.id, nodeId: step.id }, version, runInspectionSchema);
  const output = useRecordedStepOutput(inspection.run.id, step, version, tab === 'output');
  const detail = selected.data?.selected;
  const label = historyStepLabel(step, inspection.workflowId);
  const dependencyLabels = detail?.dependencies.map(id => {
    const dependency = inspection.steps.find(item => item.id === id);
    return dependency ? historyStepLabel(dependency, inspection.workflowId) : id;
  }).join('、');
  const help = stepGuidance(detail?.node ?? { kind: step.kind, config: {} });
  const tabs = [{ id: 'output', label: '步骤产物' }, { id: 'status', label: '制作信息' }] as const;
  return <section className="run-inspector__detail" aria-label={`步骤详情：${label}`}>
    <header className="run-inspector__step-heading"><div><h3>{label}</h3>{tab === 'status' && <p>{step.description || help.purpose}</p>}</div>{tab === 'status' && <StepStatus step={step} />}</header>
    <StepRetryAction step={step} controls={retry} />
    <div className="run-inspector__tabs" role="tablist" aria-label="步骤详情视图">{tabs.map(item => <button key={item.id} id={`${id}-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`${id}-panel`} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => {
      const index = tabs.findIndex(item => item.id === tab);
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
      if (next === undefined) return;
      event.preventDefault(); setTab(tabs[next].id); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }}>{item.label}</button>)}</div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className="run-inspector__panel">
      <ModelResponseDetails runId={inspection.run.id} step={step} version={version} />
      {tab === 'output' && <StepOutputs inspection={inspection} step={step} version={version} onOpenOutput={onOpenOutput} output={output} />}
      {tab === 'status' && <><p className="run-inspector__reason" role={step.error ? 'alert' : 'status'}>{step.reason}</p>{selected.error && <Notice kind="error">{selected.error}<Button aria-label="重试读取配置" onClick={selected.refresh}>重试</Button></Notice>}
        <dl className="run-inspector__facts"><div><dt>本步产出</dt><dd>{help.result}</dd></div>{detail && <><div><dt>制作模型</dt><dd>{detail.model ? `${detail.model.name} · ${detail.model.model}` : detail.node.modelId ? `所选模型不可用 · ${detail.node.modelId}` : help.local}</dd></div><div><dt>前置步骤</dt><dd>{dependencyLabels || '从项目内容开始'}</dd></div>{detail.skills.length > 0 && <div><dt>采用的规范</dt><dd>{detail.skills.map(skill => skill.name).join('、')}</dd></div>}</>}{step.startedAt && <div><dt>开始时间</dt><dd>{date(step.startedAt)}</dd></div>}{step.completedAt && <div><dt>完成时间</dt><dd>{date(step.completedAt)}</dd></div>}</dl>
        <details className="run-inspector__prompt-toggle" onToggle={event => setPromptOpen(event.currentTarget.open)}><summary>提示词记录</summary>{promptOpen && <StepExecutionPrompt runId={inspection.run.id} step={step} version={version} configuredPrompt={detail?.node.prompt} />}</details>
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
