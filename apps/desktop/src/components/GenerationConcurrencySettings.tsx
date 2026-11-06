import type { ModelProfile, WorkflowDefinition } from '@video-quickly/contracts';
import { Field, Select } from './Primitives';

export default function GenerationConcurrencySettings({ workflow, models, onChange }: {
  workflow: WorkflowDefinition; models: ModelProfile[]; onChange: (execution: NonNullable<WorkflowDefinition['execution']>) => void;
}) {
  const execution = workflow.execution;
  const used = new Set([...workflow.nodes, ...(workflow.subflows ?? []).flatMap(definition => definition.nodes)].flatMap(node => node.modelId ? [node.modelId] : []));
  const mediaModels = models.filter(model => used.has(model.id) && model.capabilities.some(capability => capability === 'image' || capability === 'video'));
  const concurrentShots = execution?.maxConcurrentShots ?? 1;
  return <section className="production-settings__concurrency" aria-label="生成并发">
    <h3>生成并发</h3>
    <Field label="镜头同时处理数" hint="同时处理多个镜头，重试时复用已完成结果。"><Select value={concurrentShots} onChange={event => onChange({ modelLimits: execution?.modelLimits ?? {}, maxConcurrentShots: Number(event.target.value) })}>{Array.from({ length: 8 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}{index === 0 ? '（串行）' : ''}</option>)}</Select></Field>
    {mediaModels.map(model => <Field key={model.id} label={`${model.name} 并发上限`}><Select value={execution?.modelLimits[model.id] ?? ''} onChange={event => {
      const modelLimits = { ...execution?.modelLimits };
      if (event.target.value) modelLimits[model.id] = Number(event.target.value);
      else delete modelLimits[model.id];
      onChange({ maxConcurrentShots: concurrentShots, modelLimits });
    }}><option value="">跟随镜头并发（{concurrentShots}）</option>{Array.from({ length: 8 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</Select></Field>)}
    {mediaModels.length > 0 && <p className="production-settings__note">实际并发同时受镜头同时处理数和模型并发上限约束。</p>}
  </section>;
}
