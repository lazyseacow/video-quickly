import type { WorkflowNode } from '@video-quickly/contracts';
import ToolConnectionPicker from './ToolConnectionPicker';

export default function ToolBindings({ node, onChange }: { node: WorkflowNode; onChange: (node: WorkflowNode) => void }) {
  const selected = Array.isArray(node.config.mcpServerIds) ? node.config.mcpServerIds.filter((value): value is string => typeof value === 'string') : [];
  return <ToolConnectionPicker value={selected} onChange={mcpServerIds => onChange({ ...node, config: { ...node.config, mcpServerIds } })} />;
}
