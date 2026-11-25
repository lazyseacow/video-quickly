import { useEffect, useRef, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { runInspectionSchema, type ResolvedWorkflowStage, type RunStepSummary, type RunSummary, type WorkflowDefinition, type WorkflowNode, type WorkflowStage } from '@video-quickly/contracts';
import { Button, IconButton, statusLabels } from '../components/Primitives';
import { useRuntimeRead } from '../lib/use-runtime-read';
import type { Action } from '../lib/types';
import { stepGuidance } from '../lib/workflow-guidance';
import { generationLabel, nativeWorkbenchStages, resolveWorkbenchStages, stageTaskId } from '../lib/workbench-stages';
import { isConfigurationFailure } from '../lib/run-recovery';
import WorkbenchStepCard from './WorkbenchStepCard';
import { stepProgressText } from '../lib/run-progress';
import './workbench-guide.css';
import './workbench-production.css';

interface ProgressTask { id: string; label: string; description: string; node?: WorkflowNode; step?: RunStepSummary; }
interface StageProgress { key: string; label: string; description: string; tasks: ProgressTask[]; }
export interface StageViewOptions { tab?: 'settings' | 'run'; nodeId?: string; flatRecords?: boolean; recordStages?: WorkflowStage[]; }
const taskCompleted = (task: ProgressTask) => task.step?.status === 'succeeded' || task.step?.status === 'skipped';
function progressLabel(status: RunStepSummary['status'] | RunSummary['status']) {
  return statusLabels[status] ?? (status === 'skipped' ? '已跳过' : status === 'not_recorded' ? '未记录' : '待执行');
}
function groupProgress(stages: WorkflowStage[] | undefined, steps: ProgressTask[], native: boolean): StageProgress[] | undefined {
  if (!stages?.length) return;
  const groups: StageProgress[] = stages.map(stage => ({ key: `stage:${stage.id}`, label: stage.label, description: stage.description, tasks: [] }));
  for (const task of steps) {
    const rootId = task.id.split('/subflow/')[0];
    let index = stages.findIndex(stage => stage.nodeIds.includes(rootId));
    const kind = task.step?.kind ?? task.node?.kind;
    if (index === -1 && kind && native) {
      const role = stageTaskId(kind, task.node?.config.operation === 'prepare-edit' || task.step?.modelGeneration === false);
      index = stages.findIndex(stage => stage.nodeIds.includes(role));
    }
    if (index >= 0) groups[index].tasks.push(task);
    else if (!native) groups.push({ key: `task:${task.id}`, label: task.label, description: task.description, tasks: [task] });
  }
  return native ? groups : groups.filter(group => group.tasks.length);
}

export default function WorkbenchProduction({ workflow, run, version, action, notify, onPausePreview, onConfigureStage }: {
  workflow: WorkflowDefinition; run: RunSummary; version: number; action: Action;
  notify: (message: string, error?: boolean) => void;
  onPausePreview: () => void;
  onConfigureStage: (stage: ResolvedWorkflowStage, options?: StageViewOptions) => void;
}) {
  const inspection = useRuntimeRead('run.inspect', { runId: run.id }, version, runInspectionSchema);
  const [pending, setPending] = useState('');
  const inFlight = useRef(false);
  const progressList = useRef<HTMLOListElement>(null);
  const data = inspection.data?.run.id === run.id ? inspection.data : undefined;
  useEffect(() => { if (inspection.error) notify(inspection.error, true); }, [inspection.error, notify]);
  const synchronized = Boolean(!inspection.error && data && data.run.id === run.id && data.run.status === run.status && data.run.updatedAt === run.updatedAt && data.run.currentNodeId === run.currentNodeId);
  const steps = data?.steps ?? [];
  const native = (data?.workflowId ?? workflow.id) === 'native-video';
  const recorded = new Map(steps.map(step => [step.id, step]));
  // A scoped run supplies statuses; it must not hide the rest of the workflow.
  const tasks: ProgressTask[] = native && data?.snapshotAvailable && !run.selection
    ? steps.map(step => ({ id: step.id, label: step.label, description: step.description, node: workflow.nodes.find(node => node.id === step.id), step }))
    : workflow.nodes.map(node => ({ id: node.id, label: recorded.get(node.id)?.label ?? node.label, description: node.description || stepGuidance(node).result, node, step: recorded.get(node.id) }));
  const configured = new Set(tasks.map(task => task.id));
  for (const step of steps) if (!configured.has(step.id)) tasks.push({ ...step, step });
  const current = steps.find(step => step.id === run.currentNodeId);
  const configurationFailure = isConfigurationFailure(run.error ?? current?.error);
  const isCurrent = (task: ProgressTask) => task.id === run.currentNodeId && !taskCompleted(task) && !['succeeded', 'canceled'].includes(run.status);
  const stageDefinitions = native && !workflow.production.novelAdaptation ? nativeWorkbenchStages : data?.stages ?? resolveWorkbenchStages(workflow);
  const stages = groupProgress(stageDefinitions, tasks, native);
  const groups = stages ?? tasks.map(task => ({ key: `task:${task.id}`, label: native && task.step?.modelGeneration ? generationLabel(task.label) : task.label, description: task.description, tasks: [task] }));
  // Completion clears the execution pointer; keep the last executed item selected.
  const displayedTasks = groups.flatMap(group => group.tasks);
  const latestStep = displayedTasks.reduce<RunStepSummary | undefined>((latest, task) => {
    const step = task.step;
    if (!step) return latest;
    if (!step.startedAt && !step.outputAvailable && step.status !== 'succeeded') return latest;
    const timestamp = step.completedAt ?? step.startedAt, previous = latest?.completedAt ?? latest?.startedAt;
    return !latest || !timestamp || !previous || timestamp >= previous ? step : latest;
  }, undefined);
  const highlightedStepId = displayedTasks.some(task => task.id === run.currentNodeId) ? run.currentNodeId : latestStep?.id ?? displayedTasks[0]?.id;
  const visibleGroup = synchronized ? groups.findIndex(group => group.tasks.some(task => task.id === highlightedStepId)) : -1;
  useEffect(() => {
    const list = progressList.current, item = visibleGroup >= 0 ? list?.children.item(visibleGroup) : undefined;
    if (!list || !item || list.scrollWidth <= list.clientWidth) return;
    const bounds = list.getBoundingClientRect(), target = item.getBoundingClientRect();
    if (target.left < bounds.left) list.scrollLeft -= bounds.left - target.left;
    else if (target.right > bounds.right) list.scrollLeft += target.right - bounds.right;
  }, [visibleGroup]);
  // A completed matching inspection stays actionable during a background read.
  const blocked = !synchronized;
  function openStage(group: StageProgress) {
    onPausePreview();
    const selectedId = native ? (group.tasks.find(isCurrent) ?? group.tasks.find(task => task.step?.error) ?? group.tasks.find(task => task.id === latestStep?.id) ?? group.tasks.findLast(taskCompleted) ?? group.tasks[0])?.id : undefined;
    const frozenStage = selectedId ? data?.stages?.find(stage => stage.nodeIds.includes(selectedId)) : undefined;
    const stage = frozenStage ? { ...frozenStage, nodes: workflow.nodes.filter(node => frozenStage.nodeIds.includes(node.id)) } : resolveWorkbenchStages(workflow)?.find(stage => `stage:${stage.id}` === group.key || selectedId && stage.nodeIds.includes(selectedId))
      ?? { id: group.key.startsWith('stage:') ? group.key.slice(6) : group.key, label: group.label, description: group.description, nodeIds: group.tasks.map(task => task.id), nodes: group.tasks.flatMap(task => task.node ? [task.node] : []) };
    const recordStages = !native && data?.stages ? [...data.stages, ...groups.filter(entry => entry.key.startsWith('task:')).map(entry => ({
      id: entry.key, label: entry.label, description: entry.description, nodeIds: entry.tasks.map(task => task.id),
    }))] : undefined;
    onConfigureStage(stage, { tab: 'run', nodeId: selectedId, flatRecords: native, recordStages });
  }
  async function perform(method: string, params: Record<string, unknown> = {}) {
    if (inFlight.current || blocked) return;
    inFlight.current = true; setPending(method);
    try {
      await action(method, { runId: run.id, ...params }, method === 'run.cancel' ? '已请求停止制作' : '已请求继续制作');
      inspection.refresh();
    } finally { inFlight.current = false; setPending(''); }
  }
  return <section className="workbench-production" aria-label="当前制作">
    <div className="workbench-production__progress">
      <ol ref={progressList} role="list" className={`workbench-guide__steps${stages ? ' workbench-guide__steps--stages' : ''}${native ? ' workbench-guide__steps--sequence' : ''} workbench-production__stage-steps`} aria-label={stages ? '制作阶段进度' : '制作步骤进度'}>{groups.map((stage, index) => {
        const active = synchronized && stage.tasks.some(isCurrent);
        const highlighted = index === visibleGroup;
        const applicable = run.selection ? stage.tasks.filter(task => task.step) : stage.tasks;
        const finished = synchronized && !active && applicable.length > 0 && applicable.every(taskCompleted);
        const task = stage.tasks.find(task => active && isCurrent(task)) ?? stage.tasks.find(task => task.step && ['failed', 'needs_attention', 'waiting_review', 'running', 'waiting_external', 'retry_scheduled'].includes(task.step.status)) ?? stage.tasks.find(task => !taskCompleted(task)) ?? stage.tasks.at(-1);
        const status = !synchronized ? 'pending' : active ? run.status : finished ? applicable.every(task => task.step?.status === 'skipped') ? 'skipped' : 'succeeded' : task?.step?.status ?? 'pending';
        const state = synchronized ? status === 'running' && task?.step ? stepProgressText(task.step) : progressLabel(status) : inspection.error ? '进度读取失败' : '正在同步进度';
        const summary = stages && task ? active ? `${task.label} · ${state}` : `${stage.tasks.filter(taskCompleted).length} / ${stage.tasks.length} 任务 · ${state}` : state;
        const description = native ? undefined : stage.key.startsWith('stage:') ? stage.description : stage.tasks[0]?.node?.description ?? stage.tasks[0]?.step?.description;
        return <WorkbenchStepCard key={stage.key} index={status === 'succeeded' ? <Check size={12} aria-hidden="true" /> : index + 1} label={stage.label} description={description} actionLabel={`打开${stages ? '阶段' : '步骤'}：${stage.label}`} current={highlighted} status={status} onClick={() => openStage(stage)}>{summary}</WorkbenchStepCard>;
      })}</ol>
      {inspection.error && <IconButton label="重试读取制作进度" disabled={inspection.busy} onClick={inspection.refresh}><RefreshCw size={16} className={inspection.busy ? 'spin' : undefined} /></IconButton>}
    </div>
    {data?.recovery.resume && !configurationFailure && <div className="workbench-production__actions">
      <div className="workbench-production__buttons">
        <Button static variant="primary" busy={pending === 'run.resume'} disabled={blocked || Boolean(pending)} onClick={() => void perform('run.resume')}>继续原制作</Button>
      </div>
    </div>}
  </section>;
}
