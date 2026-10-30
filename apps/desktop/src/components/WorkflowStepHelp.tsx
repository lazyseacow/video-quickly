import type { WorkflowDefinition, WorkflowNode } from '@video-quickly/contracts';
import { stepGuidance } from '../lib/workflow-guidance';
import './workflow-step-help.css';

export default function WorkflowStepHelp({ node, workflow }: { node: WorkflowNode; workflow: WorkflowDefinition }) {
  const help = stepGuidance(node);
  const labels = (ids: string[]) => ids.map(id => workflow.nodes.find(item => item.id === id)?.label ?? '连接待修正').join('、');
  const before = labels(workflow.edges.filter(edge => edge.target === node.id).map(edge => edge.source));
  const after = labels(workflow.edges.filter(edge => edge.source === node.id).map(edge => edge.target));
  return <section className="workflow-step-help" aria-label="步骤指引">
    <p>{node.description || help.purpose}</p>
    <dl><div><dt>本步产出</dt><dd>{help.result}</dd></div><div><dt>前置步骤</dt><dd>{before || '从项目已有内容开始'}</dd></div><div><dt>后续步骤</dt><dd>{after || '本轮流程结束'}</dd></div></dl>
    {node.requiresReview && <p className="workflow-step-help__review">审阅重点：{help.review}</p>}
  </section>;
}
