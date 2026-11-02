import { useEffect, useRef, useState } from 'react';
import { type ResolvedWorkflowStage, type WorkflowNode } from '@video-quickly/contracts';
import type { WorkspaceView } from '../lib/types';
import { matchingStepModels, stepGuidance, stepModelLabel, stepModelPlaceholder } from '../lib/workflow-guidance';
import { Button, Dialog, Field, Notice, Select } from './Primitives';
import SettingsSections from './SettingsSections';
import './workflow-stage-editor.css';

export default function WorkflowStageEditor({ stage, workspace, onSave, onClose }: {
  stage: ResolvedWorkflowStage; workspace: WorkspaceView;
  onSave: (nodes: WorkflowNode[]) => Promise<boolean>; onClose: () => void;
}) {
  const [draft, setDraft] = useState(stage.nodes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const closed = useRef(false), inFlight = useRef(false);
  useEffect(() => { closed.current = false; return () => { closed.current = true; }; }, []);
  function close() { closed.current = true; onClose(); }
  function update(nodeId: string, patch: Partial<WorkflowNode>) {
    setDraft(nodes => nodes.map(node => node.id === nodeId ? { ...node, ...patch } : node));
    setError('');
  }
  async function save() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const saved = await onSave(draft);
      if (closed.current) return;
      if (!saved) { setError('阶段配置尚未保存，当前输入已保留，请核对提示后重试。'); return; }
      close();
    } catch (failure) {
      if (!closed.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      inFlight.current = false;
      if (!closed.current) setBusy(false);
    }
  }
  return <Dialog title={stage.label} onClose={close} onDismissStart={() => { closed.current = true; }} className="settings-dialog workflow-stage-editor">
    <div className="dialog__body"><SettingsSections label="阶段内容设置" sections={draft.map(node => {
      const help = stepGuidance(node);
      const models = matchingStepModels(node, workspace.models);
      const invalidModel = Boolean(node.modelId && !models.some(model => model.id === node.modelId));
      const creation = node.kind !== 'review' && node.kind !== 'export';
      return { id: node.id, label: node.label, content: <fieldset aria-label={node.label} className="workflow-stage-editor__task" disabled={busy}>
        {creation && <>
          {(help.capability || node.modelId) && <Field label="使用模型" hint={help.requiresModel ? '执行时需要选择匹配的模型；可以先保存配置。' : undefined}><Select aria-label={`${node.label}使用模型`} value={node.modelId ?? ''} disabled={!models.length && !invalidModel} aria-invalid={invalidModel || undefined} onChange={event => update(node.id, { modelId: event.target.value || undefined })}><option value="">{stepModelPlaceholder(node, models)}</option>{invalidModel && <option value={node.modelId} disabled>{models.length ? `当前：${stepModelLabel(node, workspace.models)}` : '无可用模型'}</option>}{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</Select></Field>}
          {invalidModel && <Notice kind="error">当前模型不可用于此项内容，请选择匹配的模型{!help.requiresModel && '，或改用已有内容'}。</Notice>}
          {help.requiresModel && !node.modelId && <Notice>执行此项内容前需要选择模型，当前配置可以先保存。</Notice>}
          <Field label="提示词与补充要求"><textarea aria-label={`${node.label}提示词与补充要求`} value={node.prompt} onChange={event => update(node.id, { prompt: event.target.value })} placeholder="补充内容方向、风格或制作要求…" rows={5} /></Field>
          {workspace.skills.some(skill => skill.enabled) && <fieldset className="workflow-stage-editor__skills"><legend>应用 Skill</legend>{workspace.skills.filter(skill => skill.enabled).map(skill => <label className="field-inline" key={skill.id}><input type="checkbox" aria-label={`${node.label}应用 Skill：${skill.name}`} checked={node.skillIds.includes(skill.id)} onChange={event => update(node.id, { skillIds: event.target.checked ? [...node.skillIds, skill.id] : node.skillIds.filter(id => id !== skill.id) })} />{skill.name}</label>)}</fieldset>}
        </>}
        {node.kind === 'review' && <p className="workflow-stage-editor__note">制作到此处会暂停，核对画面、声音与字幕后确认是否继续。</p>}
        {node.kind === 'export' && <p className="workflow-stage-editor__note">视频规格与输出路径请在工作台“导出”中设置。</p>}
      </fieldset> };
    })} notice={error ? <Notice kind="error">{error}</Notice> : undefined} /></div>
    <div className="dialog__footer"><Button onClick={close}>取消</Button><Button aria-label="保存阶段配置" variant="primary" busy={busy} onClick={() => void save()}>保存</Button></div>
  </Dialog>;
}
