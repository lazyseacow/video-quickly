import type { ProjectDocument, ResolvedWorkflowStage } from '@video-quickly/contracts';
import { stepGuidance } from '../lib/workflow-guidance';
import { resolveGenerationSteps, resolveWorkbenchStages } from '../lib/workbench-stages';
import WorkbenchStepCard from './WorkbenchStepCard';
import './workbench-guide.css';

export default function WorkbenchGuide({ project, onOpenStage }: {
  project: ProjectDocument; onOpenStage: (stage: ResolvedWorkflowStage) => void;
}) {
  const { nodes } = project.workflow;
  const native = project.workflow.id === 'native-video';
  const stages = native ? undefined : resolveWorkbenchStages(project.workflow);
  const groups = native ? resolveGenerationSteps(project.workflow) : stages ?? nodes.map(node => ({ id: node.id, label: node.label, description: stepGuidance(node).result, nodeIds: [node.id], nodes: [node] }));
  function open(group: ResolvedWorkflowStage) {
    const stage = native ? resolveWorkbenchStages(project.workflow)?.find(stage => stage.nodeIds.includes(group.nodeIds[0])) : undefined;
    onOpenStage(stage ?? group);
  }
  return <section className="workbench-guide" aria-label="制作指引">
    <ol className={`workbench-guide__steps ${stages ? 'workbench-guide__steps--stages' : ''} ${native ? 'workbench-guide__steps--generation' : ''}`} aria-label={native ? '模型生成进度' : stages ? '制作阶段进度' : '制作步骤进度'}>{groups.map((stage, index) => <WorkbenchStepCard key={stage.id} index={index + 1} label={stage.label} description={stage.description} actionLabel={`打开${stages ? '阶段' : '步骤'}：${stage.label}`} status="pending" onClick={() => open(stage)}>{native ? '尚未生成' : '尚未制作'}</WorkbenchStepCard>)}</ol>
  </section>;
}
