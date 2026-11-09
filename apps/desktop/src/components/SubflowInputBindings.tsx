import { useEffect, useRef, useState } from 'react';
import { subflowReferenceSchema, type WorkflowNode } from '@video-quickly/contracts';
import { Field, Notice } from './Primitives';

export default function SubflowInputBindings({ node, onChange }: { node: WorkflowNode; onChange: (node: WorkflowNode) => void }) {
  const { subflow } = node;
  const draft = node.config.inputBindingsDraft;
  const hasInvalidDraft = typeof draft === 'string';
  const externalText = hasInvalidDraft ? draft : JSON.stringify(subflow?.inputs ?? {}, null, 2);
  const identity = `${node.id}:${subflow?.id}:${subflow?.version}`;
  const lastEmitted = useRef(externalText);
  const lastIdentity = useRef(identity);
  const [text, setText] = useState(externalText);
  const invalidDraftMessage = '请修正输入绑定草稿后保存。';
  const [error, setError] = useState(hasInvalidDraft ? invalidDraftMessage : '');
  useEffect(() => {
    if (lastIdentity.current === identity && lastEmitted.current === externalText) return;
    lastIdentity.current = identity;
    lastEmitted.current = externalText;
    setText(externalText);
    setError(hasInvalidDraft ? invalidDraftMessage : '');
  }, [identity, externalText, hasInvalidDraft]);
  if (!subflow) return null;
  return <>
    <p className="tiny-meta">固定子流程 v{subflow.version}。库中后续更新不会改变这里的版本。</p>
    <Field label="子流程输入绑定" hint={'填写字面值 {"topic":{"literal":"主题"}}，或上游字段 {"topic":{"nodeId":"brief","path":["brief"]}}。'}>
      <textarea aria-invalid={Boolean(error)} rows={5} spellCheck={false} value={text} onChange={event => {
        const value = event.target.value;
        setText(value);
        try {
          const inputs = subflowReferenceSchema.shape.inputs.parse(JSON.parse(value));
          lastEmitted.current = JSON.stringify(inputs, null, 2);
          const { inputBindingsDraft: _draft, ...config } = node.config;
          onChange({ ...node, config, subflow: { ...subflow, inputs } });
          setError('');
        } catch {
          lastEmitted.current = value;
          onChange({ ...node, config: { ...node.config, inputBindingsDraft: value } });
          setError('请输入有效的输入绑定。当前文本已保留为草稿，请修正后保存。');
        }
      }} />
    </Field>
    {error && <Notice kind="error">{error}</Notice>}
  </>;
}
