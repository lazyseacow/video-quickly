import { lazy, Suspense, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { applyWorkflowProposal, productionSettingsSchema, resolveProductionWorkflow, supportsPromptExperiment, videoProfileSchema, type AssetRecord, type ProductionSettings, type ProjectDocument, type RunSummary, type WorkflowDefinition, type WorkflowNode } from '@video-quickly/contracts';
import type { WorkspaceView, StepOutputSelection } from '../lib/types';
import type { PlanningControls } from '../lib/planning-edits';
import type { ProductionProjectSettings } from '../lib/stage-configuration-draft';
import { matchingStepModels, stepGuidance } from '../lib/workflow-guidance';
import { Button, Combobox, Dialog, Field, Notice, Select } from './Primitives';
import SettingsSections from './SettingsSections';
import VideoSettings from './VideoSettings';
import { ProjectSettingsActions, type ProjectSettingsAction } from './ProjectSettingsPanel';
import ReferenceAudioPicker from './ReferenceAudioPicker';
import CreativeContextEditor from './CreativeContextEditor';
import './production-settings.css';

const StageRunView = lazy(() => import('../features/StageRunView'));
const PromptWorkbench = lazy(() => import('./PromptWorkbench'));
const WorkflowAssistant = lazy(() => import('./WorkflowAssistant'));
const ModelAlternatives = lazy(() => import('./ModelAlternatives'));
const steps = [{ id: 'planning', label: '创作要求' }, { id: 'materials', label: '模型与素材' }, { id: 'delivery', label: '声音与成片' }, { id: 'review', label: '确认保存' }] as const;
type ConfigurationStep = typeof steps[number]['id'];
export interface ProductionConfiguration { nodes: WorkflowNode[]; production: ProductionSettings; project: ProductionProjectSettings; }

export default function ProductionSettingsDialog({ project, projectId, projectRevision, workflow, workspace, run, version, usedEntityKeys = [], initialStage = 'planning', initialNodeId, initialTab, pendingConfiguration, configurationError, onSave, onDiscardPending, onClose, onOpenOutput, onOpenCandidate, onOpenTool, onSectionChange, onImportReferenceAudio, planning }: {
  project: Pick<ProjectDocument, 'brief' | 'style' | 'profile' | 'creativeContext'>; workflow: WorkflowDefinition; workspace: WorkspaceView; run?: RunSummary; version: number; usedEntityKeys?: string[];
  projectId?: string; projectRevision?: number; onOpenCandidate?(shotId: string): void;
  planning?: PlanningControls;
  initialStage?: string; initialNodeId?: string; initialTab?: 'settings' | 'run'; pendingConfiguration?: boolean; configurationError?: string;
  onSave: (value: ProductionConfiguration) => Promise<boolean>;
  onDiscardPending?: () => Promise<boolean>; onClose: () => void; onOpenOutput: (value: StepOutputSelection) => void;
  onOpenTool: (action: ProjectSettingsAction) => void; onSectionChange?: (section: string) => void;
  onImportReferenceAudio: (path: string) => Promise<AssetRecord | undefined>;
}) {
  const [settings, setSettings] = useState(() => productionSettingsSchema.parse(workflow.production));
  const [fields, setFields] = useState<ProductionProjectSettings>(() => ({ brief: project.brief, style: project.style, profile: project.profile, creativeContext: project.creativeContext }));
  const [nodes, setNodes] = useState(workflow.nodes);
  const [promptNode, setPromptNode] = useState<WorkflowNode>();
  const [assistantNodeId, setAssistantNodeId] = useState<string>(), [alternativesId, setAlternativesId] = useState<string>();
  const initialTask = workflow.nodes.find(node => node.id === initialNodeId);
  const initialStep = initialTask ? stepGuidance(initialTask).capability === 'text' ? 'planning' : 'materials' : steps.find(item => item.id === initialStage)?.id ?? 'planning';
  const [step, setStep] = useState<ConfigurationStep>(initialStep);
  const [runStage, setRunStage] = useState(initialStage);
  const [selectedTasks, setSelectedTasks] = useState<Record<string, string>>(initialNodeId ? { [initialStep]: initialNodeId } : {});
  const [advancedStage, setAdvancedStage] = useState<string | undefined>(initialNodeId ? initialStep : undefined);
  const [requestedTool, setRequestedTool] = useState<ProjectSettingsAction>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'save' | 'discard' | 'import'>();
  const inFlight = useRef(false), closed = useRef(false);
  const id = useId(), form = useRef<HTMLFormElement>(null), content = useRef<HTMLDivElement>(null);
  const records = initialTab === 'run';
  const active = Boolean(run && ['queued', 'running', 'waiting_review', 'waiting_external', 'retry_scheduled'].includes(run.status));
  const resolved = resolveProductionWorkflow({ ...workflow, nodes, production: settings });
  const assistantNode = resolved.nodes.find(node => node.id === assistantNodeId);
  const stages = resolved.stages ?? resolved.nodes.map(node => ({ id: node.id, label: node.label, description: node.description, nodeIds: [node.id] }));
  const selectedStage = stages.find(item => item.id === runStage) ?? stages[0];
  const stepIndex = steps.findIndex(item => item.id === step);
  const modelName = (modelId?: string) => workspace.models.find(model => model.id === modelId)?.name ?? '未选择';
  const toolNames = { series: '系列模板', saveSeries: '保存系列模板', music: '背景音乐', caption: '字幕样式' };

  function updateSettings(patch: Partial<ProductionSettings>) { setSettings(value => ({ ...value, ...patch })); setError(''); }
  function updateNode(node: WorkflowNode, patch: Partial<WorkflowNode>) { setNodes(current => current.map(item => item.id === node.id ? { ...item, ...patch } : item)); setError(''); }
  function selectStep(value: ConfigurationStep) {
    setStep(value); onSectionChange?.(value); setError('');
    if (value !== 'review') setRequestedTool(undefined);
    if (content.current) content.current.scrollTop = 0;
  }
  function requestTool(tool: ProjectSettingsAction) { setRequestedTool(tool); selectStep('review'); }
  function validate(all = false) {
    if ((all || step === 'delivery') && !videoProfileSchema.safeParse(fields.profile).success) {
      selectStep('delivery'); setError('请检查成片尺寸与帧率。');
      requestAnimationFrame(() => {
        const details = form.current?.querySelector<HTMLDetailsElement>('.video-settings__advanced');
        if (details) details.open = true;
        form.current?.querySelector<HTMLInputElement>('[aria-label="视频宽度"]')?.focus();
      });
      return false;
    }
    const target = all ? form.current : form.current?.querySelector(`[data-production-step="${step}"]`);
    const invalid = target?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:invalid, select:invalid, textarea:invalid');
    if (!invalid) return true;
    const targetStep = steps.find(item => item.id === invalid.closest<HTMLElement>('[data-production-step]')?.dataset.productionStep);
    if (targetStep) selectStep(targetStep.id);
    requestAnimationFrame(() => { const details = invalid.closest('details'); if (details) details.open = true; invalid.focus(); invalid.reportValidity(); });
    return false;
  }
  function next() { if (validate() && steps[stepIndex + 1]) selectStep(steps[stepIndex + 1].id); }
  function close() { closed.current = true; onClose(); }
  function modelField(label: string, value: string | undefined, models: WorkspaceView['models'], onChange: (value: string | undefined) => void) {
    return <Field label={label}><Combobox displayMode="label" id={`${id}-${label}`} label={label} value={value ?? ''} items={models.map(model => ({ id: model.id, label: model.name }))} placeholder="选择或搜索模型" onChange={value => onChange(value || undefined)} /></Field>;
  }
  function advanced(group: { id: string; label: string; nodeIds: string[] }) {
    const tasks = resolved.nodes.filter(node => group.nodeIds.includes(node.id) && stepGuidance(node).capability);
    const node = tasks.find(node => node.id === selectedTasks[group.id]) ?? tasks[0];
    if (!node) return null;
    return <details key={group.id} className="production-settings__advanced" open={advancedStage === group.id} onToggle={event => { const open = event.currentTarget.open; setAdvancedStage(current => open ? group.id : current === group.id ? undefined : current); }}><summary>{['planning', 'materials', 'delivery'].includes(group.id) ? '高级设置' : `${group.label} · 高级设置`}</summary>
      {tasks.length > 1 && <Field label="任务"><Select value={node.id} onChange={event => { const nodeId = event.target.value; setSelectedTasks(current => ({ ...current, [group.id]: nodeId })); }}>{tasks.map(node => <option key={node.id} value={node.id}>{node.label}</option>)}</Select></Field>}
      <div key={node.id} className="production-settings__task" role="group" aria-label={node.label}>
        <Field label={`${node.label}模型`}><Combobox displayMode="label" id={`${id}-${node.id}-model`} label={`${node.label}模型`} value={node.config.modelOverride === true || node.config.modelBinding !== 'default' ? node.modelId ?? '' : ''} placeholder="跟随统一模型" items={[{ id: '', label: '跟随统一模型' }, ...matchingStepModels(node, workspace.models).map(model => ({ id: model.id, label: model.name }))]} onChange={value => updateNode(node, { modelId: value || undefined, config: { ...node.config, modelBinding: 'default', modelOverride: Boolean(value) } })} /></Field>
        <Field label={`${node.label}补充要求`}><textarea value={node.prompt} rows={3} onChange={event => updateNode(node, { prompt: event.target.value })} /></Field>
        {projectId && projectRevision && supportsPromptExperiment(node) && <Button onClick={() => setPromptNode(node)}>预览与实验提示词</Button>}
        {projectId && projectRevision && <Button onClick={() => setAssistantNodeId(node.id)}>对话修改任务</Button>}
        <Button aria-expanded={alternativesId === node.id} onClick={() => setAlternativesId(current => current === node.id ? undefined : node.id)}>查看替代模型</Button>
        {alternativesId === node.id && <Suspense fallback={<p role="status">正在读取模型建议…</p>}><ModelAlternatives node={node} models={workspace.models} runId={run?.id} version={version} failure={run ? { error: run.error, runStatus: run.status, queueOwned: Boolean(run.productionQueueId), trial: run.purpose === 'prompt-trial' } : undefined} onSelect={modelId => updateNode(node, { modelId, config: { ...node.config, modelBinding: 'default', modelOverride: true } })} /></Suspense>}
        {workspace.skills.filter(skill => skill.enabled).map(skill => <label className="field-inline" key={skill.id}><input type="checkbox" checked={node.skillIds.includes(skill.id)} onChange={event => updateNode(node, { skillIds: event.target.checked ? [...node.skillIds, skill.id] : node.skillIds.filter(id => id !== skill.id) })} />{skill.name}</label>)}
      </div>
    </details>;
  }
  async function submit() {
    if (inFlight.current || configurationError || !validate(true)) return;
    inFlight.current = true; setPending('save'); setError('');
    try {
      const saved = await onSave({ nodes: resolved.nodes, production: settings, project: fields });
      if (closed.current) return;
      if (saved) { close(); if (requestedTool) onOpenTool(requestedTool); }
      else setError('操作尚未完成，当前输入已保留，请核对提示后重试。');
    } catch (failure) { if (!closed.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { inFlight.current = false; if (!closed.current) setPending(undefined); }
  }
  async function discard() {
    if (!onDiscardPending || inFlight.current) return;
    inFlight.current = true; setPending('discard');
    try { if (await onDiscardPending()) close(); }
    catch (failure) { if (!closed.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { inFlight.current = false; if (!closed.current) setPending(undefined); }
  }
  async function importReferenceAudio(path: string) {
    if (inFlight.current || closed.current) return;
    inFlight.current = true; setPending('import');
    try { const asset = await onImportReferenceAudio(path); return closed.current ? undefined : asset; }
    finally { inFlight.current = false; if (!closed.current) setPending(undefined); }
  }
  return <Dialog title={records ? '本次制作' : '制作设置'} onClose={close} onDismissStart={() => { closed.current = true; }} className={`settings-dialog production-settings-dialog${records ? ' production-results-dialog' : ''}`}>
    {!records && <nav className="production-settings__steps" aria-label="制作设置步骤"><ol>{steps.map((item, index) => <li key={item.id}><button type="button" aria-current={step === item.id ? 'step' : undefined} disabled={Boolean(pending)} onClick={() => selectStep(item.id)}><span className="production-settings__step-index" aria-hidden="true">{index + 1}</span><span>{item.label}</span></button></li>)}</ol></nav>}
    <div className="dialog__body">
      {!records && (pendingConfiguration || active || configurationError || error) && <div className="production-settings__context">
        {active && <p>本次制作使用启动时的设置，保存后用于下次制作。</p>}
        {pendingConfiguration && <Notice><span>已保存待用配置。</span>{onDiscardPending && <Button static disabled={Boolean(pending)} onClick={() => void discard()}>放弃待用配置</Button>}</Notice>}
        {(configurationError || error) && <Notice kind="error">{configurationError || error}</Notice>}
      </div>}
      {records ? <div className="production-settings__run"><SettingsSections label="制作阶段记录" layout="tabs" value={runStage} onValueChange={setRunStage} sections={stages.map(item => ({ id: item.id, label: item.label, content: item.id === selectedStage?.id ? <Suspense fallback={<p role="status">正在读取制作记录…</p>}><StageRunView planning={planning} runId={run?.id} stageId={item.id} nodeIds={item.nodeIds} initialNodeId={initialNodeId} version={version} onOpenOutput={onOpenOutput} configurableNodeIds={[]} /></Suspense> : null }))} /></div> : <form ref={form} noValidate className="production-settings__form" onSubmit={event => { event.preventDefault(); if (step === 'review') void submit(); else next(); }}>
        <fieldset disabled={Boolean(pending)} className="production-settings__fieldset"><div ref={content} className="production-settings__content">
          <p className="production-settings__position" role="status">第 {stepIndex + 1} 步，共 {steps.length} 步</p>
          <section data-production-step="planning" hidden={step !== 'planning'} aria-label="创作要求配置">
            <Field label="创作要求"><textarea value={fields.brief} onChange={event => setFields(current => ({ ...current, brief: event.target.value }))} rows={5} placeholder="主题、受众、核心信息和预期时长…" autoFocus={step === 'planning'} /></Field>
            <Field label="视觉风格"><textarea value={fields.style} onChange={event => setFields(current => ({ ...current, style: event.target.value }))} rows={3} /></Field>
            <CreativeContextEditor value={fields.creativeContext} version={version} usedEntityKeys={usedEntityKeys} onChange={creativeContext => setFields(current => ({ ...current, creativeContext }))} />
            <ProjectSettingsActions items={['series', 'saveSeries']} onAction={requestTool} />
            {advanced({ id: 'planning', label: '创作要求', nodeIds: resolved.nodes.filter(node => stepGuidance(node).capability === 'text').map(node => node.id) })}
          </section>
          <section data-production-step="materials" hidden={step !== 'materials'} aria-label="模型与素材">
            <div className="production-settings__models">
              {modelField('文本模型', settings.textModelId, workspace.models.filter(model => model.enabled && model.capabilities.includes('text')), value => updateSettings({ textModelId: value }))}
              {modelField('视频模型', settings.videoModelId, workspace.models.filter(model => model.enabled && model.capabilities.includes('video')), value => updateSettings({ videoModelId: value }))}
            </div>
            <Field label="参考素材"><Select value={settings.referenceMode} onChange={event => updateSettings({ referenceMode: event.target.value as ProductionSettings['referenceMode'] })}><option value="none">直接文生视频</option><option value="existing">使用已有参考图</option><option value="generate">先生成参考图</option></Select></Field>
            {settings.referenceMode === 'generate' && modelField('图片模型', settings.imageModelId, workspace.models.filter(model => model.enabled && model.capabilities.includes('image')), value => updateSettings({ imageModelId: value }))}
            <ReferenceAudioPicker assets={workspace.assets} value={settings.referenceAudioAssetIds ?? []} onChange={referenceAudioAssetIds => updateSettings({ referenceAudioAssetIds })} onImport={importReferenceAudio} disabled={Boolean(pending)} />
            {advanced({ id: 'materials', label: '模型与素材', nodeIds: resolved.nodes.filter(node => stepGuidance(node).capability && stepGuidance(node).capability !== 'text').map(node => node.id) })}
          </section>
          <section data-production-step="delivery" hidden={step !== 'delivery'} aria-label="声音与成片">
            <Field label="声音要求"><textarea value={settings.soundPrompt} onChange={event => updateSettings({ soundPrompt: event.target.value })} rows={3} placeholder="语言、说话方式、环境音与音乐…" /></Field>
            <p className="production-settings__note">视频模型根据分镜台词与声音要求同步生成声音。</p>
            <Field label="字幕"><Select value={settings.subtitleMode} onChange={event => updateSettings({ subtitleMode: event.target.value === 'script' ? 'script' : 'off' })}><option value="off">关闭</option><option value="script">显示分镜文本（预估时间）</option></Select></Field>
            {settings.subtitleMode === 'script' && <p className="production-settings__note">字幕使用分镜文本，时间为预估，请核对实际语音。</p>}
            <VideoSettings mode="production" profile={fields.profile} onChange={profile => setFields(current => ({ ...current, profile }))} />
            <ProjectSettingsActions items={['music', 'caption']} onAction={requestTool} />
          </section>
          {step === 'review' && <section data-production-step="review" aria-label="确认保存" className="production-settings__review">
            <p className="production-settings__note">核对以下配置，保存后返回工作台。准备好后再点击“开始制作”。</p>
            {requestedTool && <Notice>保存设置后将打开{toolNames[requestedTool]}。<Button static onClick={() => setRequestedTool(undefined)}>仅保存设置</Button></Notice>}
            <section><header><h3>创作要求</h3><Button static variant="ghost" aria-label="修改创作要求" onClick={() => selectStep('planning')}>修改</Button></header><dl><div><dt>创作要求</dt><dd>{fields.brief.trim() || '尚未填写'}</dd></div><div><dt>视觉风格</dt><dd>{fields.style.trim() || '沿用默认风格'}</dd></div><div><dt>项目角色池</dt><dd>{fields.creativeContext?.characterIds.length ? `已选择 ${fields.creativeContext.characterIds.length} 个角色` : '未选择'}</dd></div>{fields.creativeContext?.continuity && <div><dt>连续性要求</dt><dd>{fields.creativeContext.continuity}</dd></div>}{Boolean(fields.creativeContext?.entities.length) && <div><dt>文字设定</dt><dd>{fields.creativeContext?.entities.map(entity => entity.name).join('、')}</dd></div>}</dl></section>
            <section><header><h3>模型与素材</h3><Button static variant="ghost" aria-label="修改模型与素材" onClick={() => selectStep('materials')}>修改</Button></header><dl><div><dt>文本模型</dt><dd>{modelName(settings.textModelId)}</dd></div><div><dt>视频模型</dt><dd>{modelName(settings.videoModelId)}</dd></div><div><dt>参考素材</dt><dd>{{ none: '直接文生视频', existing: '使用已有参考图', generate: '先生成参考图' }[settings.referenceMode]}</dd></div>{settings.referenceMode === 'generate' && <div><dt>图片模型</dt><dd>{modelName(settings.imageModelId)}</dd></div>}<div><dt>参考音频</dt><dd>{settings.referenceAudioAssetIds?.length ? `已选择 ${settings.referenceAudioAssetIds.length} 段` : '未添加'}</dd></div></dl></section>
            <section><header><h3>声音与成片</h3><Button static variant="ghost" aria-label="修改声音与成片" onClick={() => selectStep('delivery')}>修改</Button></header><dl><div><dt>声音要求</dt><dd>{settings.soundPrompt.trim() || '跟随分镜内容'}</dd></div><div><dt>成片规格</dt><dd>{fields.profile.width} × {fields.profile.height} · {Number((fields.profile.frameRate.numerator / fields.profile.frameRate.denominator).toFixed(2))} fps</dd></div><div><dt>字幕</dt><dd>{settings.subtitleMode === 'off' ? '关闭' : '显示分镜文本（预估时间）'}</dd></div></dl></section>
          </section>}
        </div></fieldset>
      </form>}
    </div>
    <div className="dialog__footer"><Button onClick={close}>{records ? '关闭' : '取消'}</Button>{!records && <>{stepIndex > 0 && <Button disabled={Boolean(pending)} onClick={() => selectStep(steps[stepIndex - 1].id)}><ChevronLeft size={14} />上一步</Button>}{step === 'review' ? <Button variant="primary" busy={pending === 'save'} disabled={Boolean(pending || configurationError)} onClick={() => void submit()}>{requestedTool ? '保存并打开' : active ? '保存待用配置' : '保存设置'}</Button> : <Button variant="primary" disabled={Boolean(pending || configurationError)} onClick={next}>下一步<ChevronRight size={14} /></Button>}</>}</div>
    {promptNode && projectId && projectRevision && <Suspense fallback={<p role="status">正在打开提示词实验…</p>}><PromptWorkbench projectId={projectId} projectRevision={projectRevision} node={promptNode} context={{ ...fields, production: settings }} models={workspace.models} skills={workspace.skills} version={version} onClose={() => setPromptNode(undefined)} onApplyPrompt={value => { updateNode(promptNode, { prompt: value.prompt, promptBindings: value.promptBindings, promptTemplate: value.promptTemplate }); }} onOpenOutput={onOpenOutput} onOpenCandidate={onOpenCandidate} /></Suspense>}
    {assistantNode && projectId && projectRevision && <Suspense fallback={<p role="status">正在打开修改预览…</p>}><WorkflowAssistant projectId={projectId} projectRevision={projectRevision} node={assistantNode} models={workspace.models} onClose={() => setAssistantNodeId(undefined)} onApply={(_next, proposal) => {
      const current = resolved.nodes.find(node => node.id === proposal.baseline.id);
      if (!current) throw new Error('任务已移除，请重新选择任务。');
      const next = applyWorkflowProposal({ id: projectId, revision: projectRevision }, current, proposal);
      updateNode(current, { ...next, ...(Object.hasOwn(proposal.patch, 'modelId') ? { config: { ...next.config, modelBinding: 'default', modelOverride: Boolean(next.modelId) } } : {}) });
      setAssistantNodeId(undefined);
    }} /></Suspense>}
  </Dialog>;
}
