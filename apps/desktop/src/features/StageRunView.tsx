import { useRef, useState } from 'react';
import { FileCheck2, RefreshCw, Settings2 } from 'lucide-react';
import { runInspectionSchema, type RunSummary } from '@video-quickly/contracts';
import { Button, IconButton, Notice, Status } from '../components/Primitives';
import { rpc } from '../lib/client';
import { useRuntimeRead } from '../lib/use-runtime-read';
import { isConfigurationFailure } from '../lib/run-recovery';
import type { StepOutputSelection } from '../lib/types';
import type { PlanningControls } from '../lib/planning-edits';
import { StepDetail, StepStatus } from './RunInspector';
import './stage-run-view.css';

export interface StageRunViewProps {
  runId?: string;
  stageId?: string;
  nodeIds: string[];
  configurableNodeIds?: string[];
  initialNodeId?: string;
  version: number;
  onOpenOutput: (selection: StepOutputSelection) => void;
  onConfigure?: (nodeId: string) => void;
  onChanged?: () => void;
  onRestart?: (run: RunSummary) => void;
  planning?: PlanningControls;
}

export default function StageRunView(props: StageRunViewProps) {
  if (!props.runId) return <section className="stage-run-view stage-run-view--empty" aria-label="本次制作">
    <h3>本阶段尚未开始制作</h3><p>完成制作设置后，可从工作台开始制作。</p>
  </section>;
  return <RecordedStageRun key={`${props.runId}:${props.stageId ?? ''}:${props.nodeIds.join('\0')}`} {...props} runId={props.runId} />;
}

function RecordedStageRun({ runId, stageId, nodeIds, configurableNodeIds = nodeIds, initialNodeId, version, onOpenOutput, onConfigure, onChanged, planning }: StageRunViewProps & { runId: string }) {
  const inspection = useRuntimeRead('run.inspect', { runId }, version, runInspectionSchema);
  const [selectedId, setSelectedId] = useState(initialNodeId ?? '');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const data = inspection.data;
  const frozenStage = stageId ? data?.stages?.find(stage => stage.id === stageId) : undefined;
  const assignedIds = new Set(data?.stages?.flatMap(stage => stage.nodeIds));
  const recordedNodeIds = stageId && data?.stages ? frozenStage?.nodeIds ?? nodeIds.filter(id => !assignedIds.has(id)) : nodeIds;
  const stageChanged = Boolean(frozenStage && (frozenStage.nodeIds.some(id => !nodeIds.includes(id)) || nodeIds.some(id => !frozenStage.nodeIds.includes(id))));
  const belongsToStage = (id: string) => recordedNodeIds.some(nodeId => id === nodeId || id.startsWith(`${nodeId}/subflow/`));
  const steps = data?.steps.filter(step => belongsToStage(step.id)) ?? [];
  const selected = steps.find(step => step.id === selectedId) ?? steps.find(step => step.id === data?.run.currentNodeId) ?? steps.find(step => step.error) ?? steps[0];
  const failed = steps.find(step => step.error || ['failed', 'needs_attention'].includes(step.status));
  const configurableIds = onConfigure ? nodeIds.filter(nodeId => configurableNodeIds.includes(nodeId)) : [];
  const configureId = selected ? configurableIds.find(nodeId => selected.id === nodeId || selected.id.startsWith(`${nodeId}/subflow/`)) : configurableIds[0];
  const failedConfigureId = failed ? configurableIds.find(nodeId => failed.id === nodeId || failed.id.startsWith(`${nodeId}/subflow/`)) : configureId;
  const repairNodeId = failed ? failedConfigureId : configureId;
  const configurationFailure = isConfigurationFailure(failed?.error || data?.run.error);
  const canResume = Boolean(data?.recovery.resume && !configurationFailure);
  const missingCount = data?.snapshotAvailable ? recordedNodeIds.filter(nodeId => !steps.some(step => step.id === nodeId || step.id.startsWith(`${nodeId}/subflow/`))).length : 0;
  const blocked = Boolean(pending || inspection.error);

  async function perform(method: 'run.resume' | 'run.cancel') {
    if (inFlight.current) return;
    inFlight.current = true; setPending(method); setError('');
    try { await rpc(method, { runId }); inspection.refresh(); onChanged?.(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); inspection.refresh(); }
    finally { inFlight.current = false; setPending(''); }
  }

  return <section className="stage-run-view" aria-label="本次制作">
    {inspection.error && <Notice kind="error">{inspection.error}<Button aria-label="重试读取阶段制作" onClick={inspection.refresh}>重试</Button></Notice>}
    {error && <Notice kind="error">{error}</Notice>}
    {!data && !inspection.error && <p role="status">正在读取本次制作…</p>}
    {data && <>
      <header className="stage-run-view__summary"><div><p className="stage-run-view__completion"><strong>{steps.filter(step => ['succeeded', 'skipped'].includes(step.status)).length}</strong><span>/ {steps.length} 项任务完成</span></p><time dateTime={data.run.createdAt}>{new Date(data.run.createdAt).toLocaleString('zh-CN')}</time></div><div className="stage-run-view__summary-actions"><Status value={data.run.status} /><IconButton label="刷新阶段制作" disabled={inspection.busy || Boolean(pending)} onClick={inspection.refresh}><RefreshCw size={16} className={inspection.busy ? 'spin' : undefined} /></IconButton></div></header>
      {!data.snapshotAvailable && <Notice>这次历史制作没有保存流程快照，无法确认本阶段的步骤与配置。</Notice>}
      {data.snapshotAvailable && !data.checkpointAvailable && <Notice>这次制作没有可验证的步骤进度，产物按实际保存情况展示。</Notice>}
      {stageChanged && <Notice>当前阶段设置已变更，这里按本次制作保存的阶段展示步骤。</Notice>}
      {data.recovery.reason && <Notice>{data.recovery.reason}</Notice>}
      {failed && <Notice kind="error"><div className="stage-run-view__failure"><div><strong>{failed.label}未完成</strong><p>{failed.error || failed.reason}</p>{!nodeIds.some(nodeId => failed.id === nodeId || failed.id.startsWith(`${nodeId}/subflow/`)) && <p>此步骤已移出当前阶段，请从顶部“制作设置”核对当前任务配置。</p>}</div>{failedConfigureId && <Button onClick={() => onConfigure?.(failedConfigureId)}><Settings2 size={16} />修复配置</Button>}</div></Notice>}
      {steps.length > 0 ? <>
        {missingCount > 0 && <p className="stage-run-view__hint">本阶段另有 {missingCount} 项任务未纳入这次制作。</p>}
        <div className="run-inspector__layout">
          <nav className="run-inspector__steps" aria-label="本阶段制作步骤">{steps.map((step, index) => <button type="button" key={step.id} aria-current={selected?.id === step.id ? 'step' : undefined} onClick={() => setSelectedId(step.id)}><span className="run-inspector__index">{String(index + 1).padStart(2, '0')}</span><span><strong>{step.label}</strong><StepStatus step={step} /></span>{step.outputAvailable && <FileCheck2 className="stage-run-view__saved" size={16} aria-label="已保存产物" />}</button>)}</nav>
          {selected && <StepDetail key={`${runId}:${selected.id}`} inspection={data} step={selected} version={version} onOpenOutput={onOpenOutput} defaultTab={selected.error ? 'status' : undefined} currentRun planning={planning} />}
        </div>
      </> : data.snapshotAvailable && <div className="stage-run-view__empty"><h3>这次制作未包含本阶段</h3><p>本阶段没有执行记录。</p>{configureId && <Button onClick={() => onConfigure?.(configureId)}>查看制作设置</Button>}</div>}
      {(canResume || data.recovery.cancel || repairNodeId && ['failed', 'needs_attention', 'canceled'].includes(data.run.status)) && <footer className="stage-run-view__footer">
        {canResume && <p className="stage-run-view__hint">继续原制作会沿用本次保存的配置与输入。修复后的配置用于重新制作。</p>}
        <div className="stage-run-view__actions">
          {canResume && <Button variant="primary" busy={pending === 'run.resume'} disabled={blocked} onClick={() => void perform('run.resume')}>继续原制作</Button>}
          {data.recovery.cancel && <Button busy={pending === 'run.cancel'} disabled={blocked} onClick={() => void perform('run.cancel')}>停止</Button>}
          {repairNodeId && ['failed', 'needs_attention', 'canceled'].includes(data.run.status) && <Button disabled={blocked} onClick={() => onConfigure?.(repairNodeId)}>调整设置并重新制作</Button>}
        </div>
      </footer>}
    </>}
  </section>;
}
