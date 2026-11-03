import { ChevronRight } from 'lucide-react';
import type { ModelProfile, ProjectDocument, ResolvedWorkflowStage, WorkflowNode } from '@video-quickly/contracts';
import { Button } from '../components/Primitives';
import { matchingStepModels, stepGuidance } from '../lib/workflow-guidance';
import { resolveWorkbenchStages } from '../lib/workbench-stages';
import WorkbenchStepCard from './WorkbenchStepCard';
import './workbench-guide.css';

export default function WorkbenchGuide({ project, models, mediaReady, onBrief, onConfigure, onConfigureStage }: {
  project: ProjectDocument; models: ModelProfile[]; mediaReady: boolean;
  onBrief: () => void; onConfigure: (node: WorkflowNode) => void; onConfigureStage?: (stage: ResolvedWorkflowStage) => void;
}) {
  const { nodes } = project.workflow;
  const production = project.workflow.production;
  const stages = resolveWorkbenchStages(project.workflow);
  const missingBrief = !project.brief.trim();
  const unavailable = nodes.find(node => node.modelId && !matchingStepModels(node, models).some(model => model.id === node.modelId));
  const suggested = unavailable ?? nodes.find(node => !node.modelId && stepGuidance(node).requiresModel);
  const currentNode = missingBrief ? nodes.find(node => node.kind === 'brief') ?? nodes[0] : suggested ?? nodes[0];
  function configure(node: WorkflowNode) {
    const stage = stages?.find(stage => stage.nodeIds.includes(node.id));
    if (stage && onConfigureStage) onConfigureStage(stage); else onConfigure(node);
  }
  return <section className="workbench-guide" aria-label="制作指引">
    <div className="workbench-guide__heading"><div><span>制作指引 · {stages?.length ?? nodes.length} 个步骤</span><h2>{production ? missingBrief || suggested ? '统一设置模型与制作要求' : '制作设置已就绪' : missingBrief ? '先写下视频主题' : suggested ? '确认每一步的制作方式' : '确认步骤后开始制作'}</h2>{missingBrief && <p>说明想讲什么、讲给谁，以及希望的视频风格。</p>}</div>
      <div className="workbench-guide__actions">{missingBrief ? <Button static onClick={() => { if (production && stages?.[0] && onConfigureStage) onConfigureStage(stages[0]); else onBrief(); }}>填写创意简报<ChevronRight size={14} /></Button> : suggested && <Button static onClick={() => configure(suggested)}>{production ? '打开制作设置' : '配置生成步骤'}<ChevronRight size={14} /></Button>}</div>
    </div>
    <ol className={`workbench-guide__steps ${stages ? 'workbench-guide__steps--stages' : ''}`} aria-label="流程步骤设置">{stages ? stages.map((stage, index) => <WorkbenchStepCard key={stage.id} index={index + 1} label={stage.label} description={stage.description} actionLabel={`打开阶段：${stage.label}`} current={stage.nodeIds.includes(currentNode?.id ?? '')} onClick={() => { if (onConfigureStage) onConfigureStage(stage); else if (stage.nodes[0]) onConfigure(stage.nodes[0]); }} />) : nodes.map((node, index) => <WorkbenchStepCard key={node.id} index={index + 1} label={node.label} description={stepGuidance(node).result} actionLabel={`打开步骤：${node.label}`} current={node.id === currentNode?.id} onClick={() => onConfigure(node)} />)}</ol>
    <p className="workbench-guide__hint">点击“开始制作”后，各步骤根据上游结果自动继续。{!mediaReady && nodes.some(node => node.kind === 'export') && ' 当前媒体引擎待配置，导出前需准备 FFmpeg 和 FFprobe。'}</p>
  </section>;
}
