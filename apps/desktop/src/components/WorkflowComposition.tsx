import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { subflowInputSchema, subflowOutputSchema, workflowTemplateSchema, recordPageSchema, subflowReferenceSchema, type ModelProfile, type WorkflowDefinition, type WorkflowNode, type WorkflowTemplate } from '@video-quickly/contracts';
import { Button, Dialog, Field, Notice, Select } from './Primitives';
import { rpc } from '../lib/client';

export function SubflowInputBindings({ node, onChange }: { node: WorkflowNode; onChange: (node: WorkflowNode) => void }) {
  const externalText = typeof node.config.inputBindingsDraft === 'string' ? node.config.inputBindingsDraft : JSON.stringify(node.subflow?.inputs ?? {}, null, 2);
  const lastEmitted = useRef(externalText), lastIdentity = useRef(node.id);
  const [text, setText] = useState(externalText);
  const [error, setError] = useState('');
  const identity = `${node.id}:${node.subflow?.id}:${node.subflow?.version}`;
  useEffect(() => { if (lastIdentity.current !== identity || lastEmitted.current !== externalText) { lastIdentity.current = identity; lastEmitted.current = externalText; setText(externalText); setError(typeof node.config.inputBindingsDraft === 'string' ? '请修正输入绑定草稿后保存。' : ''); } }, [identity, externalText]);
  if (!node.subflow) return null;
  return <><p className="tiny-meta">固定子流程 v{node.subflow.version}。库中后续更新不会改变这里的版本。</p><Field label="子流程输入绑定" hint={'填写字面值 {"topic":{"literal":"主题"}}，或上游字段 {"topic":{"nodeId":"brief","path":["brief"]}}。'}><textarea aria-invalid={Boolean(error)} rows={5} spellCheck={false} value={text} onChange={event => {
    const value = event.target.value; setText(value);
    try { const inputs = subflowReferenceSchema.shape.inputs.parse(JSON.parse(value)); lastEmitted.current = JSON.stringify(inputs, null, 2); const { inputBindingsDraft: _draft, ...config } = node.config; onChange({ ...node, config, subflow: { ...node.subflow!, inputs } }); setError(''); }
    catch { lastEmitted.current = value; onChange({ ...node, config: { ...node.config, inputBindingsDraft: value } }); setError('请输入有效的输入绑定；当前文本保留为草稿，修正后才能保存流程。'); }
  }} /></Field>{error && <Notice kind="error">{error}</Notice>}</>;
}

export default function WorkflowComposition({ workflow, models, onChange }: { workflow: WorkflowDefinition; models: ModelProfile[]; onChange: (workflow: WorkflowDefinition, label: string) => void }) {
  const [libraryMode, setLibraryMode] = useState<'save' | 'insert'>();
  const current = useRef(workflow); current.current = workflow;
  const used = new Set([...workflow.nodes, ...(workflow.subflows ?? []).flatMap(definition => definition.nodes)].flatMap(node => node.modelId ? [node.modelId] : []));
  const execution = workflow.execution;
  return <div className="workflow-composition-controls">
    <div className="pill-row"><Button onClick={() => setLibraryMode('save')}>保存为子流程</Button><Button onClick={() => setLibraryMode('insert')}>插入子流程</Button></div>
    <Field label="镜头同时处理数" hint="图片、配音及视频使用逐镜头持久回执。恢复时复用已完成结果；失败后停止领取新镜头，并等待在途请求结束。"><Select value={execution?.maxConcurrentShots ?? 1} onChange={event => onChange({ ...current.current, execution: { modelLimits: execution?.modelLimits ?? {}, maxConcurrentShots: Number(event.target.value) } }, '修改镜头并行数')}>{Array.from({ length: 8 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}{index === 0 ? '（串行）' : ''}</option>)}</Select></Field>
    {execution && models.filter(model => used.has(model.id) && model.capabilities.some(capability => ['image', 'video', 'tts'].includes(capability))).map(model => <Field key={model.id} label={`${model.name} 并发上限`}><Select value={execution.modelLimits[model.id] ?? execution.maxConcurrentShots} onChange={event => onChange({ ...current.current, execution: { ...execution, modelLimits: { ...execution.modelLimits, [model.id]: Number(event.target.value) } } }, '修改模型并发上限')}>{Array.from({ length: 8 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</Select></Field>)}
    {libraryMode && <SubflowLibrary mode={libraryMode} workflow={workflow} onClose={() => setLibraryMode(undefined)} onInsert={template => {
      const latest = current.current, definitions = new Map((latest.subflows ?? []).map(definition => [`${definition.id}@${definition.version}`, definition]));
      for (const definition of [...template.dependencies, template.definition]) definitions.set(`${definition.id}@${definition.version}`, definition);
      const definition = template.definition, id = `subflow-${crypto.randomUUID().slice(0, 8)}`;
      const inputs = Object.fromEntries(definition.inputs.filter(input => input.default !== undefined).map(input => [input.name, { literal: input.default! }]));
      onChange({ ...latest, subflows: [...definitions.values()], nodes: [...latest.nodes, { id, kind: 'subflow', label: definition.name, description: definition.description, prompt: '', skillIds: [], config: {}, position: { x: 60 + latest.nodes.length * 45, y: 310 }, requiresReview: false, subflow: { id: definition.id, version: definition.version, inputs } }] }, '插入固定版本子流程'); setLibraryMode(undefined);
    }} />}
  </div>;
}

function SubflowLibrary({ mode, workflow, onClose, onInsert }: { mode: 'save' | 'insert'; workflow: WorkflowDefinition; onClose: () => void; onInsert: (template: WorkflowTemplate) => void }) {
  const [snapshot] = useState(workflow);
  const [items, setItems] = useState<WorkflowTemplate[]>([]), [cursor, setCursor] = useState<number | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [name, setName] = useState(workflow.name), [templateId, setTemplateId] = useState(''), [version, setVersion] = useState(1);
  const [inputs, setInputs] = useState('[]'), [outputs, setOutputs] = useState(() => JSON.stringify(workflow.nodes.length ? [{ name: 'result', type: 'json', nodeId: workflow.nodes.at(-1)!.id, path: [] }] : [], null, 2));
  const alive = useRef(true), reading = useRef(0);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; reading.current++; }; }, []);
  async function load(before?: number) {
    const request = ++reading.current; setBusy(true); setError('');
    try { const result = recordPageSchema(workflowTemplateSchema).parse(await rpc('workflowTemplate.list', { ...(before === undefined ? {} : { before }), limit: 20 })); if (!alive.current || reading.current !== request) return; setItems(previous => before === undefined ? result.items : [...previous, ...result.items]); setCursor(result.nextCursor); }
    catch (error) { if (alive.current && reading.current === request) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current && reading.current === request) setBusy(false); }
  }
  async function submit() {
    setBusy(true); setError('');
    try {
      if (mode === 'insert') {
        const template = workflowTemplateSchema.parse(await rpc('workflowTemplate.get', { templateId, version })); if (alive.current) onInsert(template);
      } else {
        const previous = items.find(item => item.id === templateId);
        await rpc('workflowTemplate.save', { ...(previous ? { templateId: previous.id, revision: previous.revision } : {}), name, workflow: snapshot, inputs: z.array(subflowInputSchema).parse(JSON.parse(inputs)), outputs: z.array(subflowOutputSchema).parse(JSON.parse(outputs)) });
        if (alive.current) onClose();
      }
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <Dialog title={mode === 'save' ? '保存子流程版本' : '插入固定版本子流程'} onClose={onClose}><form onSubmit={event => { event.preventDefault(); void submit(); }}><div className="dialog__body">
    {error && <Notice kind="error">{error}<Button onClick={() => void load()}>刷新模板</Button></Notice>}
    <Field label={mode === 'save' ? '模板' : '选择模板'}><Select disabled={busy} value={templateId} required={mode === 'insert'} onChange={event => { const id = event.target.value; setTemplateId(id); setVersion(items.find(item => item.id === id)?.definition.version ?? 1); }}><option value="">{mode === 'save' ? '创建新模板' : '选择子流程'}</option>{items.map(item => <option key={item.id} value={item.id}>{item.definition.name} · 最新 v{item.definition.version}</option>)}</Select></Field>
    {cursor !== null && <Button busy={busy} onClick={() => void load(cursor)}>加载更多模板</Button>}
    {mode === 'insert' ? <><Field label="固定版本"><input disabled={busy} type="number" min={1} step={1} required value={version} onChange={event => setVersion(Number(event.target.value))} /></Field><p className="tiny-meta">插入时复制该版本及全部依赖。打开步骤后填写其输入绑定，再保存流程。</p></> : <><Field label="名称"><input disabled={busy} required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></Field><Field label="输入契约" hint={'例如 [{"name":"topic","type":"string","required":true}]。步骤中用 {{input.topic}} 引用。'}><textarea disabled={busy} rows={5} spellCheck={false} value={inputs} onChange={event => setInputs(event.target.value)} /></Field><Field label="输出契约" hint="声明输出名称、类型、来源步骤与字段路径。"><textarea disabled={busy} rows={5} spellCheck={false} value={outputs} onChange={event => setOutputs(event.target.value)} /></Field><p className="tiny-meta">保存为新版本，不修改任何已插入项目或已启动任务。模型与 Skill 继续使用步骤中选择的连接。</p></>}
  </div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={busy} disabled={mode === 'insert' && !templateId}>{mode === 'save' ? '保存版本' : '插入'}</Button></div></form></Dialog>;
}
