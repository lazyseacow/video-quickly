import { ChevronRight } from 'lucide-react';
import type { ModelProfile, ProjectDocument, WorkflowNode } from '@video-quickly/contracts';
import { Button } from '../components/Primitives';
import { matchingStepModels, stepGuidance, stepModelLabel } from '../lib/workflow-guidance';
import './workbench-guide.css';

export default function WorkbenchGuide({ project, models, mediaReady, onBrief, onConfigure }: {
  project: ProjectDocument; models: ModelProfile[]; mediaReady: boolean;
  onBrief: () => void; onConfigure: (node: WorkflowNode) => void;
}) {
  const { nodes } = project.workflow;
  const missingBrief = !project.brief.trim();
  const unavailable = nodes.find(node => node.modelId && !matchingStepModels(node, models).some(model => model.id === node.modelId));
  const suggested = unavailable ?? nodes.find(node => ['script', 'assets', 'voice', 'animation', 'agent'].includes(node.kind) && !node.modelId);
  const reviewCount = nodes.filter(node => node.requiresReview).length;
  return <section className="workbench-guide" aria-label="制作指引">
    <div className="workbench-guide__heading"><div><span>制作指引 · {nodes.length} 个步骤 · {reviewCount} 处人工审阅</span><h2>{missingBrief ? '先写下视频主题' : suggested ? '确认每一步的制作方式' : '确认步骤后开始制作'}</h2>{missingBrief && <p>说明想讲什么、讲给谁，以及希望的视频风格。</p>}</div>
      <div className="workbench-guide__actions">{missingBrief ? <Button static onClick={onBrief}>填写创意简报<ChevronRight size={14} /></Button> : suggested && <Button static onClick={() => onConfigure(suggested)}>配置生成步骤<ChevronRight size={14} /></Button>}</div>
    </div>
    <ol className="workbench-guide__steps" aria-label="流程步骤设置">{nodes.map((node, index) => <li key={node.id}><button type="button" aria-label={`配置步骤：${node.label}`} onClick={() => onConfigure(node)}><span className="workbench-guide__index">{index + 1}</span><span className="workbench-guide__step-copy"><strong>{node.label}</strong><small>{stepGuidance(node).result}</small><span>{stepModelLabel(node, models)}{node.requiresReview && ' · 需审阅'}</span></span></button></li>)}</ol>
    <p className="workbench-guide__hint">点击“开始制作”进入流程，遇到审阅点时会暂停等待确认。{!mediaReady && nodes.some(node => node.kind === 'export') && ' 当前媒体引擎待配置，导出前需准备 FFmpeg 和 FFprobe。'}</p>
  </section>;
}
