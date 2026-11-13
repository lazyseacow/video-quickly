import { lazy, Suspense, useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Ellipsis, Pencil, Plus, Trash2 } from 'lucide-react';
import { MAX_STORYBOARD_SHOTS, VIDEO_FIT_MODE_LABELS, applyWorkflowProposal, formatFrameRate, formatPlanningDocument, generatedPlanningSchema, getMediaAdapters, nativeReferenceStep, productionEditingSkillIds, productionEditingStep, productionModelSetting, productionPlanningStep, productionPlanningSteps, productionSettingsSchema, resolveProductionWorkflow, supportsAutomaticCasting, supportsProductionAgent, usesManualPlanning, videoAspectRatioPreset, videoProfileSchema, type AssetRecord, type PlanningDocumentKind, type ProductionSettings, type RunSummary, type WorkflowDefinition, type WorkflowNode } from '@video-quickly/contracts';
import type { WorkspaceView } from '../lib/types';
import type { PlanningControls } from '../lib/planning-edits';
import type { ProductionProjectSettings } from '../lib/stage-configuration-draft';
import { matchingStepModels, stepGuidance } from '../lib/workflow-guidance';
import { useRuntimeRead } from '../lib/use-runtime-read';
import { Button, Combobox, Dialog, Field, IconButton, Notice, Select } from './Primitives';
import VideoSettings from './VideoSettings';
import { ProjectSettingsActions, type ProjectSettingsAction } from './ProjectSettingsPanel';
import ReferenceAudioPicker from './ReferenceAudioPicker';
import CreativeContextEditor from './CreativeContextEditor';
import SkillPicker from './SkillPicker';
import ToolConnectionPicker from './ToolConnectionPicker';
import ToolBindings from './ToolBindings';
import './production-settings.css';

const WorkflowAssistant = lazy(() => import('./WorkflowAssistant'));
const steps = [{ id: 'planning', label: '创作要求' }, { id: 'materials', label: '模型与素材' }, { id: 'delivery', label: '声音与成片' }, { id: 'review', label: '确认保存' }] as const;
const unifiedModelFields = [
  { key: 'textModelId', label: '文本模型', capability: 'text' },
  { key: 'videoModelId', label: '视频模型', capability: 'video' },
  { key: 'imageModelId', label: '图片模型', capability: 'image' },
] as const;
const planningContentLabels = { brief: '简报内容', style: '风格内容', script: '分镜内容' };
const planningTextKinds = ['brief', 'style'] as const;
const autoPlanningPlaceholder = '未填写时由 AI 生成';
type ConfigurationStep = typeof steps[number]['id'];
export interface ProductionConfiguration { nodes: WorkflowNode[]; production: ProductionSettings; project: ProductionProjectSettings; }

export default function ProductionSettingsDialog({ project, projectId, projectRevision, savedShotCount, workflow, workspace, run, version, usedEntityKeys = [], initialStage = 'planning', initialNodeId, pendingConfiguration, configurationError, onSave, onDiscardPending, onClose, onOpenTool, onSectionChange, onImportReferenceAudio, planning, onRemoveShot }: {
  project: ProductionProjectSettings; workflow: WorkflowDefinition; workspace: WorkspaceView; run?: RunSummary; version: number; usedEntityKeys?: string[];
  projectId?: string; projectRevision?: number;
  savedShotCount: number;
  planning?: PlanningControls;
  onRemoveShot: (shotId: string) => Promise<void>;
  initialStage?: string; initialNodeId?: string; pendingConfiguration?: boolean; configurationError?: string;
  onSave: (value: ProductionConfiguration) => Promise<boolean>;
  onDiscardPending?: () => Promise<boolean>; onClose: () => void;
  onOpenTool: (action: ProjectSettingsAction) => void; onSectionChange?: (section: string) => void;
  onImportReferenceAudio: (path: string) => Promise<AssetRecord | undefined>;
}) {
  const [settings, setSettings] = useState(() => productionSettingsSchema.parse(workflow.production));
  const [fields, setFields] = useState<ProductionProjectSettings>(() => ({
    brief: settings.manualPlanningSteps?.includes('brief') ? '' : project.brief,
    style: settings.manualPlanningSteps?.includes('style') ? '' : project.style,
    originalText: project.originalText, profile: project.profile, creativeContext: project.creativeContext,
  }));
  const [authored, setAuthored] = useState<Partial<Record<PlanningDocumentKind, { text: string; runId?: string }>>>(() => ({
    brief: settings.manualPlanningSteps?.includes('brief') ? { text: project.brief } : undefined,
    style: settings.manualPlanningSteps?.includes('style') ? { text: project.style } : undefined,
  }));
  const [manualStoryboard, setManualStoryboard] = useState(() => settings.manualPlanningSteps?.includes('script') ?? false);
  const [nodes, setNodes] = useState(workflow.nodes);
  const [assistantNodeId, setAssistantNodeId] = useState<string>();
  const initialTask = workflow.nodes.find(node => node.id === initialNodeId);
  const initialStep = initialTask ? stepGuidance(initialTask).capability === 'text' ? 'planning' : 'materials' : steps.find(item => item.id === initialStage)?.id ?? 'planning';
  const [step, setStep] = useState<ConfigurationStep>(initialStep);
  const [selectedTasks, setSelectedTasks] = useState<Record<string, string>>(initialNodeId ? { [initialStep]: initialNodeId } : {});
  const [advancedStage, setAdvancedStage] = useState<string | undefined>(initialNodeId ? initialStep : undefined);
  const [showAgentControls, setShowAgentControls] = useState(false);
  const [requestedTool, setRequestedTool] = useState<ProjectSettingsAction>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'save' | 'discard' | 'import'>();
  const inFlight = useRef(false), closed = useRef(false);
  const id = useId(), form = useRef<HTMLFormElement>(null), content = useRef<HTMLDivElement>(null);
  const storyboardAction = useRef<HTMLButtonElement>(null);
  const focusTarget = useRef<ConfigurationStep | undefined>(undefined);
  const focusStep = useCallback((value: ConfigurationStep) => {
    const section = content.current?.querySelector<HTMLElement>(`[data-production-step="${value}"]`);
    const controls = [...section?.querySelectorAll<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled)') ?? []].filter(element => element.checkVisibility());
    const primary = value === 'planning' ? controls.find(element => element.closest('.production-settings__planning-content, .production-settings__prompts')) : undefined;
    (primary ?? controls[0] ?? section)?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    focusStep(initialStep);
  }, [initialStep, focusStep]);
  useLayoutEffect(() => {
    if (focusTarget.current !== step) return;
    focusTarget.current = undefined;
    focusStep(step);
  }, [step, focusStep]);
  const active = Boolean(run && ['queued', 'running', 'waiting_review', 'waiting_external', 'retry_scheduled'].includes(run.status));
  const planningSteps = productionPlanningSteps.filter(kind => nodes.some(node => productionPlanningStep(workflow, node) === kind));
  const { data: generated, error: generatedError, refresh: refreshGenerated } = useRuntimeRead(
    'project.planning.outputs', { projectId }, version, generatedPlanningSchema, Boolean(projectId && planningSteps.length),
  );
  const projectShots = planning?.project.shots ?? [];
  const shotCount = projectShots.length;
  const manualSteps = planningSteps.filter(kind => kind === 'script' ? manualStoryboard && shotCount > 0 : Boolean(authored[kind]?.text.trim()));
  const resolved = resolveProductionWorkflow({ ...workflow, nodes, production: { ...settings, manualPlanningSteps: manualSteps.length ? manualSteps : undefined } });
  const automaticCasting = supportsAutomaticCasting(resolved);
  const nativeReferences = Boolean(nativeReferenceStep(resolved));
  const continues = resolved.production.continueFromLastFrame !== false;
  const showImageModel = !nativeReferences && (automaticCasting || resolved.production.referenceMode === 'generate');
  const groupReferenceImages = settings.groupReferenceImages !== false;
  const requiredModelTasks = resolved.nodes.filter(node => !usesManualPlanning(resolved, node) && stepGuidance(node).requiresModel);
  const modelFields = unifiedModelFields.map(field => {
    const tasks = requiredModelTasks.filter(node => productionModelSetting(node) === field.key);
    const models = workspace.models.filter(model => model.enabled && model.capabilities.includes(field.capability)
      && (field.key !== 'imageModelId' || getMediaAdapters(['image']).some(adapter => adapter.id === model.provider))
      && tasks.every(node => matchingStepModels(node, [model]).length > 0));
    return { ...field, models, value: resolved.production[field.key], required: tasks.length > 0 };
  });
  const [textField, videoField, imageField] = modelFields;
  const assistantNode = resolved.nodes.find(node => node.id === assistantNodeId);
  const stepIndex = steps.findIndex(item => item.id === step);
  const modelName = (modelId?: string) => workspace.models.find(model => model.id === modelId)?.name ?? '未选择';
  const textModel = workspace.models.find(model => model.id === settings.textModelId);
  const hasEditingStep = Boolean(productionEditingStep(resolved));
  const agentSkillIds = productionEditingSkillIds(resolved);
  const inheritedAgentSkills = agentSkillIds.length > 0 && settings.agentSkillIds.length === 0;
  const toolNames = { music: '背景音乐', caption: '字幕样式' };
  const planningDisabled = active || Boolean(configurationError || planning?.disabledReason);
  function generatedText(kind: PlanningDocumentKind) {
    const output = generated?.[kind];
    return output && output.runId !== settings.clearedPlanningOutputs?.[kind] ? output : undefined;
  }
  function planningTextSummary(kind: PlanningDocumentKind, empty: string) {
    if (!planningSteps.includes(kind)) return fields[kind].trim() || empty;
    const edit = authored[kind];
    return edit?.text.trim() || (!edit && generatedText(kind) ? '继续由 AI 生成' : autoPlanningPlaceholder);
  }

  function updateSettings(patch: Partial<ProductionSettings>) { setSettings(value => ({ ...value, ...patch })); setError(''); }
  function updateContent(kind: PlanningDocumentKind, text: string) {
    const output = generatedText(kind);
    const matchesAI = !settings.manualPlanningSteps?.includes(kind) && output?.text === text;
    setAuthored(current => ({ ...current, [kind]: matchesAI ? undefined : { text, runId: current[kind]?.runId ?? output?.runId } }));
    setError('');
  }
  function updateNode(node: WorkflowNode, patch: Partial<WorkflowNode>) { setNodes(current => current.map(item => item.id === node.id ? { ...item, ...patch } : item)); setError(''); }
  function selectStep(value: ConfigurationStep, focus = false) {
    if (value !== step) content.current?.querySelector<HTMLElement>('[popover]:popover-open')?.hidePopover();
    focusTarget.current = focus ? value : undefined;
    setStep(value); onSectionChange?.(value); setError('');
    if (value !== 'review') setRequestedTool(undefined);
    if (content.current) content.current.scrollTop = 0;
    // Focus the committed step before another interaction can begin. A delayed
    // RAF could otherwise blur an already opened model search and close it.
    if (focus && value === step) { focusTarget.current = undefined; focusStep(value); }
  }
  function requestTool(tool: ProjectSettingsAction) { setRequestedTool(tool); selectStep('review', true); }
  function editStoryboard(shotId?: string) {
    if (!planning || !validateProfile()) return;
    setError('');
    planning.onEdit('script', shotId ? { profile: fields.profile, shotId }
      : { profile: fields.profile, addShot: true, ...(!shotCount ? { onSaved: () => setManualStoryboard(true) } : {}) });
  }
  function validateProfile() {
    const result = videoProfileSchema.safeParse(fields.profile);
    if (result.success) return true;
    selectStep('planning'); setError('请检查分镜尺寸与帧率。');
    const field = result.error.issues[0]?.path[0];
    const label = field === 'frameRate' ? '视频帧率' : '分辨率';
    requestAnimationFrame(() => form.current?.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.focus());
    return false;
  }
  function validate(all = false) {
    if ((all || step === 'planning') && !validateProfile()) return false;
    const target = all ? form.current : form.current?.querySelector(`[data-production-step="${step}"]`);
    const invalid = target?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:invalid, select:invalid, textarea:invalid');
    if (!invalid) return true;
    const targetStep = steps.find(item => item.id === invalid.closest<HTMLElement>('[data-production-step]')?.dataset.productionStep);
    if (targetStep) selectStep(targetStep.id);
    requestAnimationFrame(() => {
      for (let parent = invalid.parentElement; parent && parent !== form.current; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        if (parent.matches('[popover]:not(:popover-open)')) {
          form.current?.querySelector<HTMLButtonElement>(`[popovertarget="${CSS.escape(parent.id)}"]`)?.focus();
          parent.showPopover();
        }
      }
      invalid.focus(); invalid.reportValidity();
    });
    return false;
  }
  function next() {
    const following = steps[stepIndex + 1];
    if (inFlight.current || configurationError || !following || !validate()) return;
    if (step === 'materials') {
      const missing = modelFields.find(({ required, models, value }) => required && !models.some(model => model.id === value));
      if (missing) {
        setError(missing.models.length ? `请选择可用的${missing.label}。` : `暂无可用的${missing.label}，请在模型连接中添加或启用。`);
        form.current?.querySelector<HTMLInputElement>(`#${CSS.escape(`${id}-${missing.label}`)}`)?.focus();
        return;
      }
    }
    selectStep(following.id, true);
  }
  function close() { closed.current = true; onClose(); }
  function modelField({ key, label, models, required, value }: (typeof modelFields)[number]) {
    const items = models.map(model => ({ id: model.id, label: model.name }));
    return <Field label={label} required={required}>
      <Combobox displayMode="label" id={`${id}-${label}`} label={label} required={required} value={value ?? ''} items={items} placeholder="选择或搜索模型" onChange={selected => updateSettings({ [key]: selected || undefined })} />
    </Field>;
  }
  function advanced(group: { id: string; label: string; nodeIds: string[] }) {
    if (workflow.id === 'native-video') return null;
    const tasks = resolved.nodes.filter(node => group.nodeIds.includes(node.id) && stepGuidance(node).capability && !usesManualPlanning(resolved, node));
    const node = tasks.find(node => node.id === selectedTasks[group.id]) ?? tasks[0];
    if (!node) return null;
    return <details key={group.id} className="form-disclosure form-disclosure--divided production-settings__advanced" open={advancedStage === group.id} onToggle={event => { const open = event.currentTarget.open; setAdvancedStage(current => open ? group.id : current === group.id ? undefined : current); }}><summary>{['planning', 'materials', 'delivery'].includes(group.id) ? '高级设置' : `${group.label} · 高级设置`}</summary>
      <div className="form-disclosure__body production-settings__task" role="group" aria-label={node.label}>
        <div className="production-settings__task-fields">
          <div className="production-settings__task-controls">
            {tasks.length > 1 && <Field label="任务"><Select value={node.id} onChange={event => { const nodeId = event.target.value; setSelectedTasks(current => ({ ...current, [group.id]: nodeId })); }}>{tasks.map(node => <option key={node.id} value={node.id}>{node.label}</option>)}</Select></Field>}
            <Field key={`${node.id}-model`} label={`${node.label}模型`}><Combobox displayMode="label" id={`${id}-${node.id}-model`} label={`${node.label}模型`} value={node.config.modelOverride === true || node.config.modelBinding !== 'default' ? node.modelId ?? '' : ''} placeholder="跟随统一模型" items={[{ id: '', label: '跟随统一模型' }, ...matchingStepModels(node, workspace.models).map(model => ({ id: model.id, label: model.name }))]} onChange={value => updateNode(node, { modelId: value || undefined, config: { ...node.config, modelBinding: 'default', modelOverride: Boolean(value) } })} /></Field>
          </div>
          <Field key={`${node.id}-prompt`} className="production-settings__task-prompt" label={`${node.label}补充要求`}><textarea value={node.prompt} rows={3} onChange={event => updateNode(node, { prompt: event.target.value })} /></Field>
        </div>
        <TaskMoreActions key={node.id} node={node} workspace={workspace} onSkillsChange={skillIds => updateNode(node, { skillIds })}
          onOpenAssistant={projectId && projectRevision ? () => setAssistantNodeId(node.id) : undefined} />
        {node.kind === 'agent' && <ToolBindings node={node} onChange={value => updateNode(node, { config: value.config })} />}
      </div>
    </details>;
  }
  async function submit() {
    if (inFlight.current || configurationError || !validate(true)) return;
    inFlight.current = true; setPending('save'); setError('');
    try {
      const manualPlanningFields: NonNullable<ProductionSettings['manualPlanningFields']> = {};
      const clearedPlanningOutputs = { ...settings.clearedPlanningOutputs };
      const project = { ...fields };
      for (const kind of planningTextKinds) {
        const edit = authored[kind];
        if (edit) {
          project[kind] = edit.text.trim() ? edit.text : '';
          const runId = edit.runId ?? generatedText(kind)?.runId;
          if (!project[kind] && runId) clearedPlanningOutputs[kind] = runId;
        }
        const stored = settings.manualPlanningFields?.[kind];
        if (stored && formatPlanningDocument(kind, stored) === project[kind]) Object.assign(manualPlanningFields, { [kind]: stored });
      }
      const production = { ...resolved.production, manualPlanningFields: manualPlanningFields.brief || manualPlanningFields.style ? manualPlanningFields : undefined,
        clearedPlanningOutputs: clearedPlanningOutputs.brief || clearedPlanningOutputs.style ? clearedPlanningOutputs : undefined };
      const saved = await onSave({ nodes: resolved.nodes, production, project });
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
  const { width, height, frameRate, fitMode } = fields.profile;
  const aspectRatio = videoAspectRatioPreset(width, height)?.label;
  const storyboardContent = manualSteps.includes('script') ? `已填写 ${shotCount} 个镜头` : '';
  const generatedStoryboard = storyboardContent ? undefined : generated?.script;
  // An unapplied result belongs to the project revision it was generated from. Edits such as deleting the last shot supersede it.
  const previewStoryboard = generatedStoryboard?.shots.length && (active
    ? generatedStoryboard.runId === run?.id
    : !shotCount && !savedShotCount && !generatedStoryboard.applied && generatedStoryboard.projectRevision === projectRevision)
    ? generatedStoryboard.shots : undefined;
  const storyboardShots = previewStoryboard ?? projectShots;
  const matchesGenerated = generatedStoryboard?.shots.length === shotCount && projectShots.every((shot, index) => {
    const original = generatedStoryboard.shots[index];
    return shot.id === original.id && shot.title === original.title && shot.visualPrompt === original.visualPrompt
      && shot.narration === original.narration && (shot.soundPrompt ?? '') === (original.soundPrompt ?? '');
  });
  const generatedStoryboardStatus = previewStoryboard || matchesGenerated ? `AI 生成 · ${storyboardShots.length} 个镜头` : '';
  const storyboardStatus = generatedStoryboardStatus || storyboardContent || (shotCount ? `项目分镜 · ${shotCount} 个镜头` : autoPlanningPlaceholder);
  function planningTextField(kind: PlanningDocumentKind) {
    const edit = authored[kind];
    const output = edit ? undefined : generatedText(kind);
    return <Field key={kind} className="production-settings__planning-entry" label={planningContentLabels[kind]} hint={output ? 'AI 生成' : undefined}>
      {control => <textarea {...control} rows={3} maxLength={30000} value={edit?.text ?? output?.text ?? ''}
        placeholder={autoPlanningPlaceholder} onChange={event => updateContent(kind, event.target.value)} />}
    </Field>;
  }
  return <Dialog title="制作设置" onClose={close} onDismissStart={() => { closed.current = true; }} className="settings-dialog production-settings-dialog dialog--aligned-gutters">
    <nav className="dialog__band production-settings__steps" aria-label="制作设置步骤"><ol>{steps.map((item, index) => <li key={item.id}><button type="button" aria-current={step === item.id ? 'step' : undefined} disabled={Boolean(pending)} onClick={() => selectStep(item.id)}><span className="production-settings__step-index" aria-hidden="true">{index + 1}</span><span>{item.label}</span></button></li>)}</ol></nav>
    <div className="dialog__body">
      {(pendingConfiguration || active || configurationError || error) && <div className="dialog__band production-settings__context">
        {active && <p>本次制作使用启动时的设置，保存后用于下次制作。</p>}
        {pendingConfiguration && <Notice><span>已保存待用配置。</span>{onDiscardPending && <Button static disabled={Boolean(pending)} onClick={() => void discard()}>放弃待用配置</Button>}</Notice>}
        {(configurationError || error) && <Notice kind="error">{configurationError || error}</Notice>}
      </div>}
      <form ref={form} noValidate className="production-settings__form" onSubmit={event => { event.preventDefault(); if (step === 'review') void submit(); else next(); }}>
        <fieldset disabled={Boolean(pending)} className="production-settings__fieldset"><div ref={content} className="dialog__scroll production-settings__content">
          <section className="form-stack" data-production-step="planning" hidden={step !== 'planning'} aria-label="创作要求配置" tabIndex={-1}>
            <div className="production-settings__storyboard" role="group" aria-label="分镜全局参数">
              <VideoSettings mode="generation" profile={fields.profile} onChange={profile => setFields(current => ({ ...current, profile }))} />
            </div>
            <textarea className="production-settings__original-text" aria-label="项目原文" rows={3} maxLength={30000} placeholder="可粘贴小说或剧本正文，供 AI 简报和分镜使用" value={fields.originalText ?? ''} onChange={event => setFields(current => ({ ...current, originalText: event.target.value }))} />
            {planningSteps.length > 0 && <div role="group" aria-label="策划内容" className="production-settings__planning-content">
              {planningSteps.map(kind => kind === 'script' ? <div key={kind} role="group" aria-labelledby={`${id}-storyboard-heading`} className="production-settings__planning-entry production-settings__storyboard-card">
                <header className="production-settings__storyboard-header">
                  <div>
                    <h3 id={`${id}-storyboard-heading`}>{planningContentLabels.script}</h3>
                    <p className="production-settings__storyboard-status" id={`${id}-storyboard-status`}>{storyboardStatus}</p>
                  </div>
                  <div className="production-settings__storyboard-actions">
                    {storyboardContent && <Button static variant="ghost" onClick={() => { setManualStoryboard(false); storyboardAction.current?.focus(); }}>改用 AI 生成</Button>}
                    {!storyboardContent && shotCount > 0 && !planningDisabled && <Button static variant="ghost" onClick={() => { setManualStoryboard(true); storyboardAction.current?.focus(); }}>使用项目分镜</Button>}
                    {(!previewStoryboard || !planningDisabled) && <Button ref={storyboardAction} static aria-describedby={`${id}-storyboard-status`} aria-haspopup="dialog" disabled={!planning || planningDisabled || shotCount >= MAX_STORYBOARD_SHOTS} onClick={() => editStoryboard()}>
                      <Plus aria-hidden="true" />添加分镜
                    </Button>}
                  </div>
                </header>
                {storyboardShots.length > 0 && <ol role="list" className="production-settings__storyboard-shots">
                  {storyboardShots.map(shot => {
                    const locked = 'locked' in shot && shot.locked === true;
                    const disabled = !planning || planningDisabled || locked;
                    return <li key={shot.id}>
                      <details>
                        <summary>
                          <ChevronDown size={16} aria-hidden="true" />
                          <span>{shot.title}</span>
                          <span className="production-settings__shot-duration">{(shot.durationUs / 1_000_000).toLocaleString('zh-CN', { maximumFractionDigits: 3 })} 秒</span>
                        </summary>
                        <dl className="production-settings__shot-details">
                          <div><dt>画面</dt><dd>{shot.visualPrompt}</dd></div>
                          {shot.narration && <div><dt>旁白</dt><dd>{shot.narration}</dd></div>}
                          {shot.soundPrompt && <div><dt>声音</dt><dd>{shot.soundPrompt}</dd></div>}
                        </dl>
                      </details>
                      {!previewStoryboard && <div className="production-settings__shot-actions">
                        <IconButton label={`编辑镜头：${shot.title}`} title={locked ? '请先解锁镜头' : undefined}
                          aria-haspopup="dialog" disabled={disabled} onClick={() => editStoryboard(shot.id)}><Pencil aria-hidden="true" /></IconButton>
                        <IconButton label={`删除镜头：${shot.title}`} title={locked ? '请先解锁镜头' : undefined}
                          aria-haspopup="dialog" disabled={disabled} className="production-settings__shot-delete"
                          onClick={() => void onRemoveShot(shot.id)}><Trash2 aria-hidden="true" /></IconButton>
                      </div>}
                    </li>;
                  })}
                </ol>}
              </div> : planningTextField(kind))}
            </div>}
            {generatedError && <Notice kind="error">读取 AI 产物失败。<Button static onClick={() => void refreshGenerated()}>重试</Button></Notice>}
            {!planningSteps.length && <div className="production-settings__models production-settings__prompts">
              <Field label="创作要求"><textarea rows={3} maxLength={30000} value={fields.brief} onChange={event => setFields(current => ({ ...current, brief: event.target.value }))} placeholder="主题、受众、核心信息与时长" /></Field>
              <Field label="视觉风格"><textarea rows={3} value={fields.style} onChange={event => setFields(current => ({ ...current, style: event.target.value }))} placeholder="画面风格、色调与光线" /></Field>
            </div>}
            <CreativeContextEditor floatingSections value={fields.creativeContext} version={version} usedEntityKeys={usedEntityKeys} onChange={creativeContext => setFields(current => ({ ...current, creativeContext }))} />
            {advanced({ id: 'planning', label: '创作要求', nodeIds: resolved.nodes.filter(node => stepGuidance(node).capability === 'text').map(node => node.id) })}
            {hasEditingStep && <details className="form-disclosure form-disclosure--divided production-settings__agent-capabilities" onToggle={event => {
              if (event.target === event.currentTarget && event.currentTarget.open) setShowAgentControls(true);
            }}>
              <summary>剪辑 Agent 设置</summary>
              {showAgentControls && <div className="form-disclosure__body production-settings__agent-options">
                {textModel && !supportsProductionAgent(textModel) && <p className="production-settings__agent-help">当前文本模型使用常规剪辑步骤。支持工具调用的文本模型可在剪辑阶段使用 Agent。</p>}
                <SkillPicker inline
                  label="剪辑 Agent 的 Skill"
                  selectionSummary={agentSkillIds.length ? `${inheritedAgentSkills ? '沿用' : '已选'} ${new Set(agentSkillIds).size} 个` : '自动选择'}
                  skills={workspace.skills} groups={workspace.skillGroups} value={agentSkillIds}
                  onChange={ids => updateSettings({ agentSkillIds: ids, agentInheritsPlanningSkills: false })}
                />
                <div className="production-settings__agent-tools">
                  <div className="production-settings__agent-tools-heading">
                    <h3>工具连接</h3>
                    <span className="production-settings__agent-selection" aria-live="polite">{settings.agentMcpServerIds.length ? `已选 ${settings.agentMcpServerIds.length} 个` : '自动选择'}</span>
                  </div>
                  <ToolConnectionPicker embedded label="剪辑 Agent 的工具连接" value={settings.agentMcpServerIds} onChange={agentMcpServerIds => updateSettings({ agentMcpServerIds })} />
                </div>
              </div>}
            </details>}
          </section>
          <section className="form-stack" data-production-step="materials" hidden={step !== 'materials'} aria-label="模型与素材" tabIndex={-1}>
            {modelField(textField)}
            {modelField(videoField)}
            {!textField.required && hasEditingStep && <p className="production-settings__agent-help">文本模型可选，供剪辑 Agent 使用。</p>}
            {!nativeReferences && <div className="production-settings__models production-settings__reference-models">
              <Field label="参考素材" hint="直接生成时沿用镜头绑定的角色参考图。使用已有参考图时，采用镜头中选定的画面。"><Select value={settings.referenceMode} onChange={event => updateSettings({ referenceMode: event.target.value as ProductionSettings['referenceMode'] })}><option value="none">直接生成视频</option><option value="existing">使用已有参考图</option><option value="generate">先生成参考图</option></Select></Field>
              {showImageModel && modelField(imageField)}
              {settings.referenceMode === 'generate' && <Field label="首帧生成" hint="按相邻镜头的角色和场景绑定归组。根据图片接口能力使用原生组图、首镜续图或逐镜生成。">
                <Select value={groupReferenceImages ? 'auto' : 'individual'} onChange={event => updateSettings({ groupReferenceImages: event.target.value === 'auto' ? undefined : false })}>
                  <option value="auto">自动组图</option><option value="individual">逐镜生成</option>
                </Select>
              </Field>}
            </div>}
            {nativeReferences ? <div className="production-settings__continuation">
              <label className="field-inline">
                <input type="checkbox" {...{ switch: '' }} role="switch" name="continueFromLastFrame" checked={continues}
                  aria-describedby={`${id}-continuation-hint`} onChange={event => updateSettings({ continueFromLastFrame: event.target.checked })} />
                <span className="field__label">尾帧续镜</span>
              </label>
              <p className="field__hint" id={`${id}-continuation-hint`}>{continues
                ? '首镜使用已有画面、角色参考图或文字生成。后续镜头依次使用上一镜尾帧。'
                : '每个镜头使用自己的已有画面、角色参考图或文字独立生成。可并行处理。'}</p>
            </div>
              : automaticCasting && <p className="field__hint">反复出镜的人物缺少参考图时，使用图片模型自动定妆。留空时使用唯一可用的图片模型。</p>}
            <ReferenceAudioPicker assets={workspace.assets} value={settings.referenceAudioAssetIds ?? []} onChange={referenceAudioAssetIds => updateSettings({ referenceAudioAssetIds })} onImport={importReferenceAudio} disabled={Boolean(pending)} />
            {advanced({ id: 'materials', label: '模型与素材', nodeIds: resolved.nodes.filter(node => stepGuidance(node).capability && stepGuidance(node).capability !== 'text').map(node => node.id) })}
          </section>
          <section className="form-stack" data-production-step="delivery" hidden={step !== 'delivery'} aria-label="声音与成片" tabIndex={-1}>
            <Field label="声音要求"><textarea value={settings.soundPrompt} onChange={event => updateSettings({ soundPrompt: event.target.value })} rows={3} placeholder="语言、说话方式、环境音与音乐…" /></Field>
            <Field label="字幕"><Select value={settings.subtitleMode} onChange={event => updateSettings({ subtitleMode: event.target.value === 'script' ? 'script' : 'off' })}><option value="off">关闭</option><option value="script">显示分镜文本（预估时间）</option></Select></Field>
            <ProjectSettingsActions items={['music', 'caption']} onAction={requestTool} />
          </section>
          {step === 'review' && <section data-production-step="review" aria-label="确认保存" className="production-settings__review" tabIndex={-1}>
            {requestedTool && <Notice>保存设置后将打开{toolNames[requestedTool]}。<Button static onClick={() => setRequestedTool(undefined)}>仅保存设置</Button></Notice>}
            <section>
              <header><h3>创作要求</h3><IconButton label="修改创作要求" onClick={() => selectStep('planning', true)}><Pencil size={16} aria-hidden="true" /></IconButton></header>
              <dl>
                <div><dt>画面规格</dt><dd>{aspectRatio && `${aspectRatio} · `}{width} × {height} · {formatFrameRate(frameRate)} fps</dd></div>
                <div><dt>素材适配</dt><dd>{VIDEO_FIT_MODE_LABELS[fitMode]}</dd></div>
                <div><dt>{planningSteps.includes('brief') ? '简报内容' : '创作要求'}</dt><dd>{planningTextSummary('brief', '尚未填写')}</dd></div>
                {Boolean(fields.originalText?.trim()) && <div><dt>项目原文</dt><dd>{fields.originalText?.length} 字符</dd></div>}
                <div><dt>{planningSteps.includes('style') ? '风格内容' : '视觉风格'}</dt><dd>{planningTextSummary('style', '沿用默认风格')}</dd></div>
                {planningSteps.includes('script') && <div><dt>分镜内容</dt><dd>{storyboardContent || (generatedStoryboardStatus ? '继续由 AI 生成' : autoPlanningPlaceholder)}</dd></div>}
                <div><dt>项目角色池</dt><dd>{fields.creativeContext?.characterIds.length ? `已选择 ${fields.creativeContext.characterIds.length} 个角色` : '未选择'}</dd></div>
                {fields.creativeContext?.continuity && <div><dt>连续性要求</dt><dd>{fields.creativeContext.continuity}</dd></div>}
                {Boolean(fields.creativeContext?.entities.length) && <div><dt>文字设定</dt><dd>{fields.creativeContext?.entities.map(entity => entity.name).join('、')}</dd></div>}
                {hasEditingStep && (agentSkillIds.length > 0 || settings.agentMcpServerIds.length > 0) && <div>
                  <dt>剪辑 Agent</dt><dd>{agentSkillIds.length ? `${inheritedAgentSkills ? '沿用 ' : ''}${agentSkillIds.length} 个 Skill` : 'Skill 自动选择'} · {settings.agentMcpServerIds.length ? `${settings.agentMcpServerIds.length} 个工具连接` : '工具自动选择'}</dd>
                </div>}
              </dl>
            </section>
            <section>
              <header><h3>模型与素材</h3><IconButton label="修改模型与素材" onClick={() => selectStep('materials', true)}><Pencil size={16} aria-hidden="true" /></IconButton></header>
              <dl>
                <div><dt>文本模型</dt><dd>{modelName(settings.textModelId)}</dd></div>
                <div><dt>视频模型</dt><dd>{modelName(settings.videoModelId)}</dd></div>
                {!nativeReferences && <div><dt>参考素材</dt><dd>{{ none: '直接生成视频', existing: '使用已有参考图', generate: '先生成参考图' }[settings.referenceMode]}</dd></div>}
                {showImageModel && <div><dt>图片模型</dt><dd>{imageField.value || imageField.required ? modelName(imageField.value) : '按需自动选择'}</dd></div>}
                {nativeReferences ? <div><dt>{continues ? '首镜画面' : '镜头画面'}</dt><dd>已有画面、角色参考图或文字</dd></div>
                  : settings.referenceMode === 'generate' && <div><dt>首帧生成</dt><dd>{groupReferenceImages ? '自动组图' : '逐镜生成'}</dd></div>}
                {nativeReferences && <div><dt>尾帧续镜</dt><dd>{continues ? '沿用上一镜尾帧' : '各镜头独立生成'}</dd></div>}
                <div><dt>参考音频</dt><dd>{settings.referenceAudioAssetIds?.length ? `已选择 ${settings.referenceAudioAssetIds.length} 段` : '未添加'}</dd></div>
              </dl>
            </section>
            <section>
              <header><h3>声音与成片</h3><IconButton label="修改声音与成片" onClick={() => selectStep('delivery', true)}><Pencil size={16} aria-hidden="true" /></IconButton></header>
              <dl>
                <div><dt>声音要求</dt><dd>{settings.soundPrompt.trim() || '跟随分镜内容'}</dd></div>
                <div><dt>字幕</dt><dd>{settings.subtitleMode === 'off' ? '关闭' : '显示分镜文本（预估时间）'}</dd></div>
              </dl>
            </section>
          </section>}
        </div></fieldset>
      </form>
    </div>
    <div className="dialog__footer dialog__band production-settings__footer">
      {stepIndex > 0 && <Button variant="ghost" disabled={Boolean(pending)} onClick={() => selectStep(steps[stepIndex - 1].id, true)}><ChevronLeft size={14} aria-hidden="true" />上一步</Button>}
      {step === 'review' ? <Button variant="primary" busy={pending === 'save'} disabled={Boolean(pending || configurationError)} onClick={() => void submit()}>{requestedTool ? '保存并打开' : active ? '保存待用配置' : '保存设置'}</Button> : <Button variant="primary" disabled={Boolean(pending || configurationError)} onClick={next}>下一步<ChevronRight size={14} aria-hidden="true" /></Button>}
    </div>
    {assistantNode && projectId && projectRevision && <Suspense fallback={<p role="status">正在打开修改预览…</p>}><WorkflowAssistant projectId={projectId} projectRevision={projectRevision} node={assistantNode} models={workspace.models} onClose={() => setAssistantNodeId(undefined)} onApply={(_next, proposal) => {
      const current = resolved.nodes.find(node => node.id === proposal.baseline.id);
      if (!current) throw new Error('任务已移除，请重新选择任务。');
      const next = applyWorkflowProposal({ id: projectId, revision: projectRevision }, current, proposal);
      updateNode(current, { ...next, ...(Object.hasOwn(proposal.patch, 'modelId') ? { config: { ...next.config, modelBinding: 'default', modelOverride: Boolean(next.modelId) } } : {}) });
      setAssistantNodeId(undefined);
    }} /></Suspense>}
  </Dialog>;
}

function TaskMoreActions({ node, workspace, onSkillsChange, onOpenAssistant }: {
  node: WorkflowNode; workspace: Pick<WorkspaceView, 'skills' | 'skillGroups'>;
  onSkillsChange(ids: string[]): void; onOpenAssistant?(): void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  return <div className="production-settings__task-actions" onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && panel.current?.matches(':popover-open')) panel.current.hidePopover();
  }}>
    <Button ref={trigger} static variant="ghost" popoverTarget={id} aria-controls={id}><Ellipsis size={16} aria-hidden="true" />更多操作</Button>
    <div ref={panel} id={id} popover="auto" role="group" aria-label={`${node.label}更多操作`} className="production-settings__task-menu">
      {onOpenAssistant && <Button static variant="ghost" onClick={() => {
        panel.current?.hidePopover();
        trigger.current?.focus({ preventScroll: true });
        onOpenAssistant();
      }}>对话修改任务</Button>}
      <SkillPicker className="production-settings__task-skills" label={`${node.label} Skill`} skills={workspace.skills} groups={workspace.skillGroups} value={node.skillIds} onChange={onSkillsChange}
        hint={node.kind === 'agent' ? 'Skill 可多选。Agent 仅使用所选 Skill，留空时按任务自动选择。' : undefined} />
    </div>
  </div>;
}
