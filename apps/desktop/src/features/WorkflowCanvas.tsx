import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Background, Controls, Handle, Panel, Position, ReactFlow, SelectionMode, addEdge, applyEdgeChanges, applyNodeChanges, type AriaLabelConfig, type Connection, type Edge, type IsValidConnection, type Node, type NodeProps, type NodeTypes, type OnEdgesChange, type OnInit, type OnNodesChange, type OnSelectionChangeFunc, type ReactFlowInstance } from '@xyflow/react';
import { BookOpen, Check, GitBranch, Image, Layers, Mic, Plus, Save, Sparkles, Trash2 } from 'lucide-react';
import { nodeKindSchema, type ModelProfile, type WorkflowDefinition, type WorkflowNode } from '@video-quickly/contracts';
import { Button, Field, IconButton, Notice } from '../components/Primitives';
import ToolBindings from '../components/ToolBindings';
import { sameWorkflow } from '../lib/project-edits';
import './workflow-canvas.css';

type FlowNode = Node<{ node: WorkflowNode }, 'activity'>;
const typeLabels: Record<string, string> = { brief: '创意简报', research: '资料与史实', style: '风格与角色', script: '旁白与分镜', assets: '画面素材', voice: '配音与字幕', animation: '动画与运镜', review: '人工审阅', export: '导出成片', agent: 'Agent 步骤', condition: '条件分支', join: '汇合' };
const ActivityNode = memo(function ActivityNode({ data, selected }: NodeProps<FlowNode>) {
  const Icon = data.node.kind === 'assets' ? Image : data.node.kind === 'voice' ? Mic : data.node.kind === 'condition' ? GitBranch : data.node.kind === 'review' ? Check : data.node.kind === 'research' ? BookOpen : data.node.kind === 'animation' ? Layers : Sparkles;
  return <div className={`flow-node ${selected ? 'selected' : ''}`}><Handle type="target" position={Position.Left} /><div className="flow-node__type">{typeLabels[data.node.kind]}</div><div className="flow-node__title"><Icon size={17} />{data.node.label}</div><div className="flow-node__footer">{data.node.requiresReview ? '完成后等待审阅' : data.node.modelId ? '已指定模型' : '使用步骤配置'}</div><Handle type="source" position={Position.Right} /></div>;
});
const nodeTypes: NodeTypes = { activity: ActivityNode };
const fitViewOptions = { padding: .2 };
const panButtons = [1, 2];
const deleteKeys = ['Backspace', 'Delete'];
const ariaLabels: Partial<AriaLabelConfig> = {
  'node.a11yDescription.default': '按 Enter 或空格选择步骤，用方向键移动，按 Delete 移除，按 Escape 取消选择。',
  'node.a11yDescription.keyboardDisabled': '按 Enter 或空格选择步骤，按 Delete 移除，按 Escape 取消选择。',
  'edge.a11yDescription.default': '按 Enter 或空格选择连接，按 Delete 移除，按 Escape 取消选择。',
  'controls.ariaLabel': '流程画布控制', 'controls.zoomIn.ariaLabel': '放大流程画布',
  'controls.zoomOut.ariaLabel': '缩小流程画布', 'controls.fitView.ariaLabel': '适应全部步骤', 'handle.ariaLabel': '步骤连接点',
};
function flowNodes(workflow: WorkflowDefinition): FlowNode[] {
  return workflow.nodes.map(node => ({ id: node.id, type: 'activity', position: node.position, data: { node }, ariaLabel: `${node.label}，${typeLabels[node.kind]}` }));
}
function conditionLabel(condition?: string) { return condition === 'true' ? '条件成立' : condition === 'false' ? '条件不成立' : undefined; }
function flowEdges(workflow: WorkflowDefinition): Edge[] {
  return workflow.edges.map(edge => ({ ...edge, label: conditionLabel(edge.condition), data: { condition: edge.condition }, type: 'smoothstep' }));
}
interface Props {
  workflow: WorkflowDefinition; models: ModelProfile[]; dirty: boolean; saving: boolean; conflicted: boolean;
  onChange: (workflow: WorkflowDefinition, label: string, group?: string) => void;
  onEndGroup: () => void; onSave: () => Promise<boolean>; onHistory: (direction: 'undo' | 'redo') => void;
}
export default function WorkflowCanvas({ workflow, models, dirty, saving, conflicted, onChange, onEndGroup, onSave, onHistory }: Props) {
  const [nodes, setNodes] = useState<FlowNode[]>(() => flowNodes(workflow));
  const [edges, setEdges] = useState<Edge[]>(() => flowEdges(workflow));
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState('');
  const nodesRef = useRef(nodes), edgesRef = useRef(edges), workflowRef = useRef(workflow);
  const canvas = useRef<ReactFlowInstance<FlowNode> | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const initializeCanvas = useCallback<OnInit<FlowNode>>(instance => { canvas.current = instance; }, []);
  const focusNode = useCallback((_: React.MouseEvent, node: FlowNode) => {
    void canvas.current?.fitView({ nodes: [{ id: node.id }], padding: .8, minZoom: .7, maxZoom: 1, duration: 0 });
  }, []);
  useEffect(() => {
    const element = container.current; if (!element) return;
    let previous = element.getBoundingClientRect();
    const observer = new ResizeObserver(() => {
      const next = element.getBoundingClientRect();
      if (canvas.current && previous.width && previous.height && next.width && next.height) {
        const viewport = canvas.current.getViewport();
        void canvas.current.setViewport({ ...viewport, x: viewport.x + (next.width - previous.width) / 2, y: viewport.y + (next.height - previous.height) / 2 });
      }
      previous = next;
    });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const unchanged = sameWorkflow(workflowRef.current, workflow);
    workflowRef.current = workflow;
    if (unchanged) return;
    const previous = new Map(nodesRef.current.map(node => [node.id, node]));
    const previousEdges = new Map(edgesRef.current.map(edge => [edge.id, edge]));
    const nextNodes = flowNodes(workflow).map(node => ({ ...previous.get(node.id), ...node }));
    const nextEdges = flowEdges(workflow).map(edge => ({ ...previousEdges.get(edge.id), ...edge }));
    nodesRef.current = nextNodes; edgesRef.current = nextEdges; setNodes(nextNodes); setEdges(nextEdges);
    setSelectedId(current => nextNodes.some(node => node.id === current) ? current : undefined);
    setError('');
  }, [workflow]);
  const commit = useCallback((nextNodes: FlowNode[], nextEdges: Edge[], label: string, group?: string) => {
    nodesRef.current = nextNodes; edgesRef.current = nextEdges; setNodes(nextNodes); setEdges(nextEdges); setError('');
    const next = { ...workflowRef.current, nodes: nextNodes.map(node => ({ ...node.data.node, position: node.position })), edges: nextEdges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, condition: typeof edge.data?.condition === 'string' ? edge.data.condition || undefined : undefined })) };
    workflowRef.current = next; onChange(next, label, group);
  }, [onChange]);
  const selected = nodes.find(node => node.id === selectedId)?.data.node;
  const updateSelected = useCallback((patch: Partial<WorkflowNode>) => {
    const next = nodesRef.current.map(node => node.id === selectedId ? { ...node, ariaLabel: `${patch.label ?? node.data.node.label}，${typeLabels[patch.kind ?? node.data.node.kind]}`, data: { node: { ...node.data.node, ...patch } } } : node);
    const active = document.activeElement;
    const typing = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement && active.type !== 'checkbox';
    commit(next, edgesRef.current, '修改步骤设置', typing ? `workflow:${selectedId}:${Object.keys(patch).join(',')}` : undefined);
  }, [selectedId, commit]);
  const changeNodes = useCallback<OnNodesChange<FlowNode>>(changes => {
    const next = applyNodeChanges(changes, nodesRef.current);
    const removed = new Set(changes.filter(change => change.type === 'remove').map(change => change.id));
    const nextEdges = removed.size ? edgesRef.current.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)) : edgesRef.current;
    if (removed.size) setSelectedId(current => current && removed.has(current) ? undefined : current);
    if (changes.some(change => change.type !== 'select' && change.type !== 'dimensions')) commit(next, nextEdges, removed.size ? '移除编排步骤' : '移动编排步骤', removed.size ? undefined : 'workflow:position');
    else { nodesRef.current = next; setNodes(next); }
  }, [commit]);
  const changeEdges = useCallback<OnEdgesChange>(changes => {
    const next = applyEdgeChanges(changes, edgesRef.current);
    if (changes.some(change => change.type !== 'select')) commit(nodesRef.current, next, '移除流程连接');
    else { edgesRef.current = next; setEdges(next); }
  }, [commit]);
  const changeSelection = useCallback<OnSelectionChangeFunc<FlowNode>>(({ nodes: selectedNodes }) => {
    setSelectedId(current => selectedNodes.some(node => node.id === current) ? current : selectedNodes[0]?.id);
  }, []);
  const validConnection = useCallback<IsValidConnection>(connection => {
    if (!connection.source || !connection.target || connection.source === connection.target) return false;
    if (edgesRef.current.some(edge => edge.source === connection.source && edge.target === connection.target)) return false;
    const remaining = [connection.target], visited = new Set<string>();
    while (remaining.length) {
      const id = remaining.pop(); if (!id || visited.has(id)) continue;
      if (id === connection.source) return false;
      visited.add(id);
      for (const edge of edgesRef.current) if (edge.source === id) remaining.push(edge.target);
    }
    return true;
  }, []);
  const connect = useCallback((connection: Connection) => {
    if (!validConnection(connection)) return;
    commit(nodesRef.current, addEdge({ ...connection, id: `${connection.source}-${connection.target}`, type: 'smoothstep' }, edgesRef.current), '连接编排步骤');
  }, [validConnection, commit]);
  const beforeDelete = useCallback(async ({ nodes: deleting }: { nodes: FlowNode[] }) => {
    if (deleting.length >= nodesRef.current.length) { setError('流程至少保留一个步骤。'); return false; }
    return true;
  }, []);
  function addNode() {
    const id = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const node: WorkflowNode = { id, kind: 'agent', label: '新步骤', description: '', prompt: '', skillIds: [], config: {}, position: { x: 60 + nodesRef.current.length * 45, y: 310 }, requiresReview: false };
    commit([...nodesRef.current.map(item => item.selected ? { ...item, selected: false } : item), { id, type: 'activity', position: node.position, data: { node }, ariaLabel: '新步骤，Agent 步骤', selected: true }], edgesRef.current, '添加编排步骤');
    setSelectedId(id);
  }
  function removeNode(id: string) {
    if (nodesRef.current.length <= 1) return;
    commit(nodesRef.current.filter(node => node.id !== id), edgesRef.current.filter(edge => edge.source !== id && edge.target !== id), '移除编排步骤'); setSelectedId(undefined);
  }
  async function save() {
    if (!dirty) return true;
    if (saving || conflicted) return false;
    if (!workflowRef.current.nodes.length) { setError('流程至少保留一个步骤。'); return false; }
    const unnamed = workflowRef.current.nodes.findIndex(node => !node.label.trim());
    if (unnamed !== -1) { setError(`请为第 ${unnamed + 1} 个步骤填写名称。`); return false; }
    onEndGroup(); setError('');
    const captured = workflowRef.current;
    const saved = await onSave();
    if (!saved) setError(sameWorkflow(captured, workflowRef.current) ? '流程未保存，编辑内容已保留。请修正后重试。' : '保存期间有新修改，继续保存即可。');
    return saved;
  }
  return <div className="flow-layout" onKeyUpCapture={event => { if (event.key.startsWith('Arrow')) onEndGroup(); }} onKeyDownCapture={event => {
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyS') { event.preventDefault(); event.stopPropagation(); void save(); }
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
      const target = event.target;
      if (target instanceof HTMLElement && (target.closest('input,textarea,select') || target.isContentEditable)) return;
      event.preventDefault(); event.stopPropagation(); onEndGroup(); onHistory(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo');
    }
  }}>
    <div className="flow-container" ref={container}><div className="flow-viewport">
      <ReactFlow<FlowNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={initializeCanvas} onNodeDoubleClick={focusNode} onNodeDragStart={onEndGroup} onNodeDragStop={onEndGroup} zoomOnDoubleClick={false} onNodesChange={changeNodes} onEdgesChange={changeEdges} onConnect={connect} onSelectionChange={changeSelection} onBeforeDelete={beforeDelete} isValidConnection={validConnection} fitView fitViewOptions={fitViewOptions} minZoom={.2} maxZoom={1.5} deleteKeyCode={deleteKeys} ariaLabelConfig={ariaLabels} panOnScroll selectionOnDrag selectionMode={SelectionMode.Partial} panOnDrag={panButtons} zoomOnScroll={false} connectionRadius={24} nodeDragThreshold={3}>
        <Background gap={22} size={1} color="var(--border)" /><Controls showInteractive={false} />
        <Panel position="top-left" className="flow-gestures">滚动平移 · Ctrl + 滚轮缩放<span>空格 + 拖动平移 · 双击步骤聚焦</span></Panel>
      </ReactFlow>
    </div></div>
    <aside className="flow-inspector">
      <div className="section-heading"><h3>流程编排</h3><IconButton label="添加编排步骤" disabled={nodes.length >= 100} onClick={addNode}><Plus size={17} /></IconButton></div>
      {error && <Notice kind="error">{error}</Notice>}
      {selected ? <>
        <Field label="步骤名称"><input value={selected.label} onChange={event => updateSelected({ label: event.target.value })} /></Field>
        <Field label="步骤类型"><select value={selected.kind} onChange={event => updateSelected({ kind: nodeKindSchema.parse(event.target.value) })}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field label="步骤说明"><textarea value={selected.description} onChange={event => updateSelected({ description: event.target.value })} /></Field>
        <Field label="提示词"><textarea value={selected.prompt} onChange={event => updateSelected({ prompt: event.target.value })} placeholder="补充这个步骤的具体要求" /></Field>
        <Field label="使用模型"><select value={selected.modelId ?? ''} onChange={event => updateSelected({ modelId: event.target.value || undefined })}><option value="">本地素材 / 手动制作</option>{models.filter(model => model.enabled).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></Field>
        {selected.kind === 'agent' && <ToolBindings node={selected} onChange={value => updateSelected(value)} />}
        {selected.kind === 'condition' && <Field label="条件结果"><select aria-label="条件分支结果" value={selected.config.value === true ? 'true' : 'false'} onChange={event => updateSelected({ config: { ...selected.config, value: event.target.value === 'true' } })}><option value="true">成立</option><option value="false">不成立</option></select></Field>}
        {edges.some(edge => edge.source === selected.id) && <div className="edge-conditions"><h3>后续连接</h3>{edges.filter(edge => edge.source === selected.id).map(edge => <Field key={edge.id} label={nodes.find(node => node.id === edge.target)?.data.node.label ?? edge.target}><select value={typeof edge.data?.condition === 'string' ? edge.data.condition : ''} onChange={event => {
          const condition = event.target.value;
          commit(nodesRef.current, edgesRef.current.map(item => item.id === edge.id ? { ...item, data: { ...item.data, condition }, label: conditionLabel(condition) } : item), '修改分支条件');
        }}><option value="">始终执行</option><option value="true">条件成立时</option><option value="false">条件不成立时</option></select></Field>)}</div>}
        <label className="field-inline"><input type="checkbox" checked={selected.requiresReview} onChange={event => updateSelected({ requiresReview: event.target.checked })} />完成后人工审阅</label>
        <Button variant="danger" className="button-full" disabled={nodes.length <= 1} onClick={() => removeNode(selected.id)}><Trash2 size={15} />移除步骤</Button>
      </> : <p className="list-help">选择步骤修改提示词、模型和审阅要求。拖动连接点设置步骤依赖。</p>}
      <div className="flow-save"><span className="flow-save-state" role="status">{saving ? '正在保存…' : conflicted ? '请先处理修订冲突' : dirty ? '有未保存修改' : '修改已保存'}</span><Button variant="primary" className="button-full" disabled={!dirty || conflicted} busy={saving} onClick={() => void save()}><Save size={15} />保存流程</Button><p className="tiny-meta">保存前检查依赖关系。已启动的制作使用其固定版本。</p></div>
    </aside>
  </div>;
}
