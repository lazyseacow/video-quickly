import { useEffect, useRef, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { runInspectionSchema, type ResolvedWorkflowStage, type RunStepSummary, type RunSummary, type WorkflowDefinition, type WorkflowNode, type WorkflowStage } from '@video-quickly/contracts';
import { Button, Notice, statusLabels } from '../components/Primitives';
import { useRuntimeRead } from '../lib/use-runtime-read';
import type { Action, StepOutputSelection } from '../lib/types';
import { stepGuidance } from '../lib/workflow-guidance';
import { resolveWorkbenchStages } from '../lib/workbench-stages';
import { isConfigurationFailure } from '../lib/run-recovery';
import WorkbenchStepCard from './WorkbenchStepCard';
import './workbench-guide.css';
import './workbench-production.css';

interface ProgressTask { id: string; label: string; description: string; node?: WorkflowNode; step?: RunStepSummary; }
interface StageProgress { key: string; label: string; description: string; tasks: ProgressTask[]; }
const taskCompleted = (task: ProgressTask) => task.step?.status === 'succeeded' || task.step?.status === 'skipped';
function progressLabel(status: RunStepSummary['status'] | RunSummary['status']) {
  return statusLabels[status] ?? (status === 'skipped' ? '已跳过' : status === 'not_recorded' ? '未记录' : '待执行');
}
function groupProgress(stages: WorkflowStage[] | undefined, steps: ProgressTask[]): StageProgress[] | undefined {
  if (!stages?.length) return;
  const assigned = new Set<string>();
  const groups: StageProgress[] = [];
  for (const stage of stages) {
    const tasks = steps.filter(step => stage.nodeIds.includes(step.id) && !assigned.has(step.id));
    if (!tasks.length) continue;
    tasks.forEach(task => assigned.add(task.id));
    groups.push({ key: `stage:${stage.id}`, label: stage.label, description: stage.description, tasks });
  }
  if (!groups.length) return;
  for (const task of steps) if (!assigned.has(task.id)) groups.push({ key: `task:${task.id}`, label: task.label, description: task.description, tasks: [task] });
  return groups;
}

export default function WorkbenchProduction({ workflow, run, version, action, onOpenOutput, onPausePreview, onConfigureStage }: {
  workflow: WorkflowDefinition; run: RunSummary; version: number; action: Action;
  onOpenOutput: (selection: StepOutputSelection) => void; onPausePreview: () => void;
  onConfigureStage: (stage: ResolvedWorkflowStage, options?: { tab?: 'settings' | 'run'; nodeId?: string }) => void;
}) {
  const inspection = useRuntimeRead('run.inspect', { runId: run.id }, version, runInspectionSchema);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const progressList = useRef<HTMLOListElement>(null);
  const data = inspection.data;
  const synchronized = Boolean(!inspection.error && data && data.run.id === run.id && data.run.status === run.status && data.run.updatedAt === run.updatedAt && data.run.currentNodeId === run.currentNodeId);
  const steps = data?.steps ?? [];
  const recorded = new Map(steps.map(step => [step.id, step]));
  // A scoped run supplies statuses; it must not hide the rest of the workflow.
  const tasks: ProgressTask[] = workflow.nodes.map(node => ({ id: node.id, label: node.label, description: node.description || stepGuidance(node).result, node, step: recorded.get(node.id) }));
  const configured = new Set(tasks.map(task => task.id));
  for (const step of steps) if (!configured.has(step.id)) tasks.push({ ...step, step });
  const current = steps.find(step => step.id === run.currentNodeId);
  const configurationFailure = isConfigurationFailure(run.error ?? current?.error);
  const isCurrent = (step: { id: string }) => step.id === run.currentNodeId && !['succeeded', 'canceled'].includes(run.status);
  const stages = groupProgress(data?.stages ?? resolveWorkbenchStages(workflow), tasks);
  const groups = stages ?? tasks.map(task => ({ key: `task:${task.id}`, label: task.step?.label ?? task.label, description: task.description, tasks: [task] }));
  const usefulOutput = steps.findLast(step => step.outputAvailable && ['script', 'style', 'assets', 'animation', 'research', 'export'].includes(step.kind));
  const output = current?.outputAvailable && !['review', 'brief', 'condition', 'join'].includes(current.kind) ? current : usefulOutput ?? steps.findLast(step => step.outputAvailable);
  // Completion clears the execution pointer, but the last stage stays selected.
  const latestStep = steps.reduce<RunStepSummary | undefined>((latest, step) => {
    if (!step.startedAt && !step.outputAvailable && step.status !== 'succeeded') return latest;
    const timestamp = step.completedAt ?? step.startedAt, previous = latest?.completedAt ?? latest?.startedAt;
    return !latest || !timestamp || !previous || timestamp >= previous ? step : latest;
  }, undefined);
  const highlightedStepId = run.currentNodeId ?? latestStep?.id ?? steps[0]?.id;
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
  function openStage(group: StageProgress, nodeId?: string) {
    onPausePreview();
    const stage = resolveWorkbenchStages(workflow)?.find(stage => `stage:${stage.id}` === group.key)
      ?? { id: group.key.startsWith('stage:') ? group.key.slice(6) : group.key, label: group.label, description: group.description, nodeIds: group.tasks.map(task => task.id), nodes: group.tasks.flatMap(task => task.node ? [task.node] : []) };
    onConfigureStage(stage, { tab: 'run', nodeId });
  }
  async function perform(method: string, params: Record<string, unknown> = {}) {
    if (inFlight.current || blocked) return;
    inFlight.current = true; setPending(method); setError('');
    try {
      const result = await action(method, { runId: run.id, ...params }, method === 'run.cancel' ? '已请求停止制作' : '已请求继续制作');
      if (result === null) setError('操作未完成，请核对提示后重试。');
      inspection.refresh();
    } finally { inFlight.current = false; setPending(''); }
  }
  return <section className="workbench-production" aria-label="当前制作">
    <ol ref={progressList} className={`workbench-guide__steps ${stages ? 'workbench-guide__steps--stages' : ''} workbench-production__stage-steps`} aria-label={stages ? '制作阶段进度' : '制作步骤进度'}>{groups.map((stage, index) => {
      const active = synchronized && stage.tasks.some(isCurrent);
      const highlighted = index === visibleGroup;
      const finished = synchronized && !active && stage.tasks.every(taskCompleted);
      const task = stage.tasks.find(task => active && isCurrent(task)) ?? stage.tasks.find(task => task.step && ['failed', 'needs_attention', 'waiting_review', 'running', 'waiting_external', 'retry_scheduled'].includes(task.step.status)) ?? stage.tasks.find(task => !taskCompleted(task)) ?? stage.tasks.at(-1);
      if (!task) return null;
      const status = !synchronized ? 'pending' : active ? run.status : finished ? stage.tasks.every(task => task.step?.status === 'skipped') ? 'skipped' : 'succeeded' : task.step?.status ?? 'pending';
      const state = synchronized ? progressLabel(status) : inspection.error ? '进度读取失败' : '正在同步进度';
      return <WorkbenchStepCard key={stage.key} index={status === 'succeeded' ? <Check size={12} aria-hidden="true" /> : index + 1} label={stage.label} description={stage.description} actionLabel={`打开${stages ? '阶段' : '步骤'}：${stage.label}`} current={highlighted} status={status} onClick={() => openStage(stage)}>{stages ? active ? `${task.step?.label ?? task.label} · ${state}` : `${stage.tasks.filter(taskCompleted).length} / ${stage.tasks.length} 任务 · ${state}` : state}</WorkbenchStepCard>;
    })}</ol>
    {(run.error || data?.recovery.reason) && <Notice kind="error"><span>{run.error || data?.recovery.reason}</span>{configurationFailure && <span>请从顶部“制作设置”调整配置后重新制作。</span>}</Notice>}
    {inspection.error && <Notice kind="error">{inspection.error}<Button static onClick={inspection.refresh}><RefreshCw size={14} />重试读取制作进度</Button></Notice>}
    {error && <Notice kind="error">{error}</Notice>}
    <div className="workbench-production__actions">
      <div className="workbench-production__buttons">
        {output && <Button static disabled={blocked || Boolean(pending)} onClick={() => { onPausePreview(); onOpenOutput({ projectId: run.projectId, runId: run.id, nodeId: output.id, kind: output.kind }); }}>查看产物</Button>}
        {data?.recovery.resume && !configurationFailure && <Button static variant="primary" busy={pending === 'run.resume'} disabled={blocked || Boolean(pending)} onClick={() => void perform('run.resume')}>继续原制作</Button>}
      </div>
    </div>
  </section>;
}
