import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ClipboardList, RefreshCw, Settings2 } from 'lucide-react';
import { isModelGenerationNode, runInspectionSchema, type RunStepSummary, type WorkflowNode } from '@video-quickly/contracts';
import { Button, EmptyState, IconButton, Notice } from '../components/Primitives';
import { useChargeRpc } from '../components/ConfirmationDialog';
import { useRuntimeRead } from '../lib/use-runtime-read';
import { isConfigurationFailure } from '../lib/run-recovery';
import { runningStep, stepRetryLabel } from '../lib/run-progress';
import { generationLabel } from '../lib/workbench-stages';
import type { StepOutputSelection } from '../lib/types';
import type { PlanningControls } from '../lib/planning-edits';
import { CurrentStepResult, SavedOutputIcon, StepStatus } from './RunInspector';
import './stage-run-view.css';

export interface StageRunViewProps {
  runId?: string;
  stageId?: string;
  nodeIds: string[];
  configurableNodeIds?: string[];
  initialNodeId?: string;
  flat?: boolean;
  nodes?: WorkflowNode[];
  version: number;
  actionsTarget: HTMLDivElement | null;
  onNotice: (text: string) => void;
  onOpenOutput: (selection: StepOutputSelection) => void;
  onConfigure?: (nodeId: string) => void;
  onChanged?: () => void;
  planning?: PlanningControls;
}

export default function StageRunView(props: StageRunViewProps) {
  if (!props.runId) return <section className="stage-run-view stage-run-view--empty" aria-label="本次制作">
    <EmptyState icon={<ClipboardList size={24} />} title={props.flat ? '尚未开始制作' : '本阶段尚未开始制作'} description="完成制作设置后，可从工作台开始制作。" />
  </section>;
  return <RecordedStageRun key={`${props.runId}:${props.stageId ?? ''}:${props.nodeIds.join('\0')}`} {...props} runId={props.runId} />;
}

function RecordedStageRun({ runId, stageId, nodeIds, configurableNodeIds = nodeIds, initialNodeId, flat = false, nodes = [], version, actionsTarget, onNotice, onOpenOutput, onConfigure, onChanged, planning }: StageRunViewProps & { runId: string }) {
  const inspection = useRuntimeRead('run.inspect', { runId }, version, runInspectionSchema);
  const [selectedId, setSelectedId] = useState(initialNodeId ?? '');
  const chargeRpc = useChargeRpc();
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const navigation = useRef<HTMLElement>(null);
  const retryDescriptionId = useId();
  const data = inspection.data;
  const frozenStage = stageId ? data?.stages?.find(stage => stage.id === stageId) : undefined;
  const assignedIds = new Set(data?.stages?.flatMap(stage => stage.nodeIds));
  const recordedNodeIds = stageId && data?.stages ? frozenStage?.nodeIds ?? nodeIds.filter(id => !assignedIds.has(id)) : nodeIds;
  const stageChanged = Boolean(frozenStage && (frozenStage.nodeIds.some(id => !nodeIds.includes(id)) || nodeIds.some(id => !frozenStage.nodeIds.includes(id))));
  const belongsToStage = (id: string) => recordedNodeIds.some(nodeId => id === nodeId || id.startsWith(`${nodeId}/subflow/`));
  const steps = data?.steps.filter(step => flat || belongsToStage(step.id)) ?? [];
  const entries: { id: string; label: string; step?: RunStepSummary }[] = flat && data?.run.selection
    ? nodes.map(node => { const step = steps.find(step => step.id === node.id), label = step?.label ?? node.label; return { id: node.id, label: (step?.modelGeneration ?? isModelGenerationNode(node)) ? generationLabel(label) : label, step }; })
    : steps.map(step => ({ id: step.id, label: flat && step.modelGeneration ? generationLabel(step.label) : step.label, step }));
  for (const step of steps) if (!entries.some(entry => entry.id === step.id)) entries.push({ id: step.id, label: flat && step.modelGeneration ? generationLabel(step.label) : step.label, step });
  const selectedEntry = entries.find(entry => entry.id === selectedId) ?? entries.find(entry => entry.id === data?.run.currentNodeId) ?? entries.find(entry => entry.step?.error) ?? entries[0];
  const selected = selectedEntry?.step;
  useEffect(() => {
    if (!flat) return;
    const list = navigation.current, item = list?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!list || !item) return;
    const bounds = list.getBoundingClientRect(), target = item.getBoundingClientRect();
    const left = bounds.left + list.clientLeft, right = left + list.clientWidth, top = bounds.top + list.clientTop, bottom = top + list.clientHeight;
    if (target.left < left) list.scrollLeft -= Math.ceil(left - target.left);
    else if (target.right > right) list.scrollLeft += Math.ceil(target.right - right);
    if (target.top < top) list.scrollTop -= Math.ceil(top - target.top);
    else if (target.bottom > bottom) list.scrollTop += Math.ceil(target.bottom - bottom);
  }, [flat, selectedEntry?.id]);
  const failed = steps.find(step => step.error || ['failed', 'needs_attention'].includes(step.status));
  const footerRetry = actionsTarget && selected?.retry?.allowed && (selected.responseAvailable || selected.progress?.storyboard) ? selected : undefined;
  const configurableIds = onConfigure ? nodeIds.filter(nodeId => configurableNodeIds.includes(nodeId)) : [];
  const configureId = selected ? configurableIds.find(nodeId => selected.id === nodeId || selected.id.startsWith(`${nodeId}/subflow/`)) : configurableIds[0];
  const failedConfigureId = failed ? configurableIds.find(nodeId => failed.id === nodeId || failed.id.startsWith(`${nodeId}/subflow/`)) : configureId;
  const repairNodeId = failed ? failedConfigureId : configureId;
  const configurationFailure = isConfigurationFailure(failed?.error || data?.run.error);
  const canResume = Boolean(data?.recovery.resume && !configurationFailure);
  const missingCount = data?.snapshotAvailable ? flat ? entries.filter(entry => !entry.step).length : recordedNodeIds.filter(nodeId => !steps.some(step => step.id === nodeId || step.id.startsWith(`${nodeId}/subflow/`))).length : 0;
  const blocked = Boolean(pending || inspection.error);
  const notice = data ? [
    !data.snapshotAvailable && (flat ? '这次历史制作没有保存流程快照，按已有步骤记录展示。' : '这次历史制作没有保存流程快照，无法确认本阶段的步骤与配置。'),
    data.snapshotAvailable && !data.checkpointAvailable && '这次制作没有可验证的步骤进度，产物按实际保存情况展示。',
    stageChanged && '当前阶段设置已变更，这里按本次制作保存的阶段展示步骤。',
    data.recovery.reason || (canResume ? '继续原制作会沿用本次配置与已完成产物。' : ''),
    missingCount > 0 && `${flat ? '另有' : '本阶段另有'} ${missingCount} 项任务未纳入这次制作。`,
  ].filter(Boolean).join(' ') : '';
  useEffect(() => { onNotice(notice); }, [notice, onNotice]);

  async function perform(method: 'run.resume' | 'run.cancel' | 'run.step.retry', params: Record<string, unknown> = {}) {
    if (inFlight.current) return;
    inFlight.current = true; setPending(method); setError('');
    try {
      if (await chargeRpc(method, { runId, ...params }) === null) return;
      inspection.refresh(); onChanged?.();
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); inspection.refresh(); }
    finally { inFlight.current = false; setPending(''); }
  }
  function retryStep(nodeId: string) {
    setSelectedId(nodeId);
    void perform('run.step.retry', { nodeId });
  }

  return <section className="stage-run-view" aria-label="本次制作">
    {inspection.error && <Notice kind="error">{inspection.error}<Button aria-label={flat ? '重试读取本次制作' : '重试读取阶段制作'} onClick={inspection.refresh}>重试</Button></Notice>}
    {error && <Notice kind="error">{error}</Notice>}
    {!data && !inspection.error && <p role="status">正在读取本次制作…</p>}
    {data && <>
      <header className="stage-run-view__summary">
        <div><p className="stage-run-view__completion"><strong>{steps.filter(step => ['succeeded', 'skipped'].includes(step.status)).length}</strong><span>/ {steps.length} 项任务完成</span></p><time dateTime={data.run.createdAt}>{new Date(data.run.createdAt).toLocaleString('zh-CN')}</time></div>
        <IconButton label={flat ? '刷新本次制作' : '刷新阶段制作'} disabled={inspection.busy || Boolean(pending)} onClick={inspection.refresh}><RefreshCw size={16} className={inspection.busy ? 'spin' : undefined} /></IconButton>
      </header>
      {failed && <Notice kind="error"><div className="stage-run-view__failure"><div><strong>{failed.label}未完成</strong><p>{failed.error || failed.reason}</p>{!nodeIds.some(nodeId => failed.id === nodeId || failed.id.startsWith(`${nodeId}/subflow/`)) && <p>此步骤已移出当前阶段，请从顶部“制作设置”核对当前任务配置。</p>}</div>{failedConfigureId && <Button onClick={() => onConfigure?.(failedConfigureId)}><Settings2 size={16} />修复配置</Button>}</div></Notice>}
      {steps.length > 0 ? <>
        <div className="run-inspector__layout">
          <nav ref={navigation} className="run-inspector__steps" aria-label={flat ? '本次制作步骤' : '本阶段制作步骤'}>{entries.map((entry, index) => {
            const isSelected = selectedEntry?.id === entry.id;
            const showStatus = !isSelected && (!entry.step || !runningStep(entry.step.status));
            return <button type="button" key={entry.id} aria-current={isSelected ? 'step' : undefined} onClick={() => setSelectedId(entry.id)}>
              <span className="run-inspector__index">{String(index + 1).padStart(2, '0')}</span>
              <span><strong>{entry.label}</strong>{showStatus && (entry.step ? <StepStatus step={entry.step} overview /> : <span className="run-inspector__state">未纳入本次制作</span>)}</span>
              {entry.step?.outputAvailable && <SavedOutputIcon />}
            </button>;
          })}</nav>
          {selected && <CurrentStepResult key={`${runId}:${selected.id}`} inspection={data} step={selected} version={version} onOpenOutput={onOpenOutput} planning={planning} retry={{ busy: pending === 'run.step.retry', disabled: blocked, onRetry: () => retryStep(selected.id), footerDescriptionId: footerRetry ? retryDescriptionId : undefined }} />}
          {!selected && selectedEntry && <div className="run-inspector__detail stage-run-view__empty"><h3>{selectedEntry.label}</h3><p>这次制作未包含此步骤。</p></div>}
        </div>
      </> : data.snapshotAvailable && <div className="stage-run-view__empty"><h3>{flat ? '这次制作没有步骤记录' : '这次制作未包含本阶段'}</h3><p>{flat ? '尚未保存可查看的执行记录。' : '本阶段没有执行记录。'}</p>{configureId && <Button onClick={() => onConfigure?.(configureId)}>查看制作设置</Button>}</div>}
      {actionsTarget && (canResume || data.recovery.cancel || footerRetry || repairNodeId && ['failed', 'needs_attention', 'canceled'].includes(data.run.status)) && createPortal(
        <div className="stage-run-view__actions" role="group" aria-label="本次制作操作">
          {data.recovery.cancel && <Button busy={pending === 'run.cancel'} disabled={blocked} onClick={() => void perform('run.cancel')}>停止</Button>}
          {repairNodeId && ['failed', 'needs_attention', 'canceled'].includes(data.run.status) && <Button disabled={blocked} onClick={() => onConfigure?.(repairNodeId)}>调整设置并重新制作</Button>}
          {footerRetry && <Button variant="primary" aria-describedby={retryDescriptionId} busy={pending === 'run.step.retry'} disabled={blocked} onClick={() => retryStep(footerRetry.id)}>{stepRetryLabel(footerRetry)}</Button>}
          {canResume && <Button variant="primary" title="沿用本次保存的配置与已完成产物，继续剩余制作" busy={pending === 'run.resume'} disabled={blocked} onClick={() => void perform('run.resume')}>继续原制作</Button>}
        </div>, actionsTarget,
      )}
    </>}
  </section>;
}
