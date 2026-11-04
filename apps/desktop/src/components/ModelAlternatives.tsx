import { useEffect, useState } from 'react';
import { modelAlternatives, runInspectionSchema, type ModelFailureContext, type ModelProfile, type WorkflowNode } from '@video-quickly/contracts';
import { rpc } from '../lib/client';
import { Button, Notice } from './Primitives';
import './workflow-assistant.css';

export default function ModelAlternatives({ node, models, failure, runId, version, onSelect }: {
  node: WorkflowNode; models: ModelProfile[]; failure?: ModelFailureContext; runId?: string; version?: number; onSelect(modelId: string): void;
}) {
  const [frozen, setFrozen] = useState<{ runId: string; nodeId: string; failure: ModelFailureContext; modelId?: string }>(), [error, setError] = useState('');
  useEffect(() => {
    if (!runId) return;
    let current = true; setError('');
    void rpc('run.inspect', { runId, nodeId: node.id }).then(value => {
      if (!current) return;
      const inspection = runInspectionSchema.parse(value);
      setFrozen({ runId, nodeId: node.id, modelId: inspection.selected?.node.modelId, failure: { error: inspection.steps.find(step => step.id === node.id)?.error ?? inspection.run.error, unknownSubmission: inspection.steps.some(step => step.unknownSubmission), runStatus: inspection.run.status, queueOwned: Boolean(inspection.run.productionQueueId), trial: inspection.run.purpose === 'prompt-trial' } });
    }).catch(error => { if (current) setError(error instanceof Error ? error.message : String(error)); });
    return () => { current = false; };
  }, [runId, node.id, version]);
  const source = runId && frozen?.runId === runId && frozen.nodeId === node.id ? frozen : undefined;
  const result = modelAlternatives(source?.modelId ? { ...node, modelId: source.modelId } : node, models, source?.failure ?? failure);
  if (!result.capability) return null;
  return <section className="model-alternatives" aria-label="替代模型建议">
    <h3>替代模型</h3>{error ? <Notice kind="error">{error}</Notice> : runId && !source ? <p role="status">正在核对原运行的提交状态…</p> : <Notice>{result.guidance}</Notice>}
    <p className="workflow-assistant__hint">建议按已配置的能力和协议筛选。参考素材数量等输入限制会在开始制作前检查。</p>
    {result.alternatives.length ? <ul>{result.alternatives.map(({ model, reasons, price }) => <li key={model.id}>
      <div><strong>{model.name}</strong><p>{reasons.join(' · ')}</p><small>{price}</small></div>
      <Button disabled={Boolean(runId && (!source || error))} onClick={() => onSelect(model.id)}>用于下次配置</Button>
    </li>)}</ul> : <p className="workflow-assistant__hint">没有其他符合此任务能力和协议的已启用模型。</p>}
  </section>;
}
