import type { ProjectDocument, ResolvedWorkflowStage } from '@video-quickly/contracts';
import { stepGuidance } from '../lib/workflow-guidance';
import { resolveWorkbenchStages } from '../lib/workbench-stages';
import WorkbenchStepCard from './WorkbenchStepCard';
import './workbench-guide.css';

export default function WorkbenchGuide({ project, mediaReady, onOpenStage }: {
  project: ProjectDocument; mediaReady: boolean; onOpenStage: (stage: ResolvedWorkflowStage) => void;
}) {
  const { nodes } = project.workflow;
  const stages = resolveWorkbenchStages(project.workflow);
  const groups = stages ?? nodes.map(node => ({ id: node.id, label: node.label, description: stepGuidance(node).result, nodeIds: [node.id], nodes: [node] }));
  return <section className="workbench-guide" aria-label="制作指引">
    <ol className={`workbench-guide__steps ${stages ? 'workbench-guide__steps--stages' : ''}`} aria-label={stages ? '制作阶段进度' : '制作步骤进度'}>{groups.map((stage, index) => <WorkbenchStepCard key={stage.id} index={index + 1} label={stage.label} description={stage.description} actionLabel={`打开${stages ? '阶段' : '步骤'}：${stage.label}`} status="pending" onClick={() => onOpenStage(stage)}>尚未制作</WorkbenchStepCard>)}</ol>
    {!mediaReady && nodes.some(node => node.kind === 'export') && <p className="workbench-guide__hint">导出前需准备 FFmpeg 和 FFprobe。</p>}
  </section>;
}
