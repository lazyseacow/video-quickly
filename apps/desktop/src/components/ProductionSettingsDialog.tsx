import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Ellipsis, WandSparkles } from 'lucide-react';
import { VIDEO_FIT_MODE_LABELS, applyWorkflowProposal, formatFrameRate, formatPlanningDocument, getMediaAdapters, planningDocumentSchemas, productionEditingSkillIds, productionEditingStep, productionModelSetting, productionPlanningStep, productionPlanningSteps, productionSettingsSchema, resolveProductionWorkflow, supportsAutomaticCasting, supportsProductionAgent, usesManualPlanning, videoAspectRatioPreset, videoProfileSchema, type AssetRecord, type PlanningDocumentKind, type ProductionPlanningStep, type ProductionSettings, type ProjectDocument, type PromptDraft, type RunSummary, type WorkflowDefinition, type WorkflowNode, type WorkflowStage } from '@video-quickly/contracts';
import type { WorkspaceView, StepOutputSelection } from '../lib/types';
import { planningLabels, storyboardDraftSchema, type PlanningControls } from '../lib/planning-edits';
import type { ProductionProjectSettings } from '../lib/stage-configuration-draft';
import { matchingStepModels, stepGuidance } from '../lib/workflow-guidance';
import { readPlanningPrefill } from '../lib/planning-prefill';
import { useChargeRpc } from './ConfirmationDialog';
import { Button, Combobox, Dialog, Field, Notice, Select } from './Primitives';
import SettingsSections from './SettingsSections';
import VideoSettings from './VideoSettings';
import { ProjectSettingsActions, type ProjectSettingsAction } from './ProjectSettingsPanel';
import ReferenceAudioPicker from './ReferenceAudioPicker';
import CreativeContextEditor from './CreativeContextEditor';
import PlanningDocumentFields, { initialPlanningDocument } from './PlanningDocumentFields';
import GenerationConcurrencySettings from './GenerationConcurrencySettings';
import SkillPicker from './SkillPicker';
import ToolConnectionPicker from './ToolConnectionPicker';
import ToolBindings from './ToolBindings';
import ToastNotice, { type ToastMessage } from './ToastNotice';
import './production-settings.css';

const StageRunView = lazy(() => import('../features/StageRunView'));
const WorkflowAssistant = lazy(() => import('./WorkflowAssistant'));
const steps = [{ id: 'planning', label: '创作要求' }, { id: 'materials', label: '模型与素材' }, { id: 'delivery', label: '声音与成片' }, { id: 'review', label: '确认保存' }] as const;
const unifiedModelFields = [
  { key: 'textModelId', label: '文本模型', capability: 'text' },
  { key: 'videoModelId', label: '视频模型', capability: 'video' },
  { key: 'imageModelId', label: '图片模型', capability: 'image' },
] as const;
const planningSourceLabels = { brief: '简报来源', style: '风格来源', script: '分镜来源' };
const prefillLabels = { brief: 'AI 填写简报', style: 'AI 填写风格', script: 'AI 填写分镜' };
type ConfigurationStep = typeof steps[number]['id'];
export interface ProductionConfiguration { nodes: WorkflowNode[]; production: ProductionSettings; project: ProductionProjectSettings; execution: WorkflowDefinition['execution']; }

export default function ProductionSettingsDialog({ project, projectId, projectRevision, workflow, workspace, run, version, usedEntityKeys = [], initialStage = 'planning', initialNodeId, initialTab, flatRecords, recordStages, pendingConfiguration, configurationError, onSave, onDiscardPending, onClose, onOpenOutput, onOpenTool, onSectionChange, onImportReferenceAudio, planning }: {
  project: Pick<ProjectDocument, 'brief' | 'style' | 'profile' | 'creativeContext'>; workflow: WorkflowDefinition; workspace: WorkspaceView; run?: RunSummary; version: number; usedEntityKeys?: string[];
  projectId?: string; projectRevision?: number;
  planning?: PlanningControls;
  initialStage?: string; initialNodeId?: string; initialTab?: 'settings' | 'run'; flatRecords?: boolean; recordStages?: WorkflowStage[]; pendingConfiguration?: boolean; configurationError?: string;
  onSave: (value: ProductionConfiguration) => Promise<boolean>;
  onDiscardPending?: () => Promise<boolean>; onClose: () => void; onOpenOutput: (value: StepOutputSelection) => void;
  onOpenTool: (action: ProjectSettingsAction) => void; onSectionChange?: (section: string) => void;
  onImportReferenceAudio: (path: string) => Promise<AssetRecord | undefined>;
}) {
  const chargeRpc = useChargeRpc();
  const [settings, setSettings] = useState(() => productionSettingsSchema.parse(workflow.production));
  const [fields, setFields] = useState<ProductionProjectSettings>(() => ({ brief: project.brief, style: project.style, profile: project.profile, creativeContext: project.creativeContext }));
  const [documents, setDocuments] = useState(() => ({
    brief: initialPlanningDocument('brief', settings.manualPlanningFields?.brief, project.brief, planning?.project.title),
    style: initialPlanningDocument('style', settings.manualPlanningFields?.style, project.style),
  }));
  const [nodes, setNodes] = useState(workflow.nodes);
  const [execution, setExecution] = useState(workflow.execution);
  const [assistantNodeId, setAssistantNodeId] = useState<string>();
  const initialTask = workflow.nodes.find(node => node.id === initialNodeId);
  const initialStep = initialTask ? stepGuidance(initialTask).capability === 'text' ? 'planning' : 'materials' : steps.find(item => item.id === initialStage)?.id ?? 'planning';
  const [step, setStep] = useState<ConfigurationStep>(initialStep);
  const [runStage, setRunStage] = useState(initialStage);
  const [selectedTasks, setSelectedTasks] = useState<Record<string, string>>(initialNodeId ? { [initialStep]: initialNodeId } : {});
  const [advancedStage, setAdvancedStage] = useState<string | undefined>(initialNodeId ? initialStep : undefined);
  const [showAgentControls, setShowAgentControls] = useState(false);
  const [requestedTool, setRequestedTool] = useState<ProjectSettingsAction>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'save' | 'discard' | 'import' | ProductionPlanningStep>();
  const [runActionsTarget, setRunActionsTarget] = useState<HTMLDivElement | null>(null);
  const [notice, setNotice] = useState<ToastMessage>();
  const noticeState = useRef({ id: 0, text: '' });
  const showNotice = useCallback((text: string) => {
    if (noticeState.current.text === text) return;
    noticeState.current = { id: noticeState.current.id + 1, text };
    setNotice(text ? noticeState.current : undefined);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(current => current === notice ? undefined : current), 2000);
    return () => clearTimeout(timer);
  }, [notice]);
  const inFlight = useRef(false), closed = useRef(false);
  const prefillRequest = useRef<{ input: string; id: string } | undefined>(undefined);
  const latestRevision = useRef(projectRevision); latestRevision.current = projectRevision;
  const id = useId(), form = useRef<HTMLFormElement>(null), content = useRef<HTMLDivElement>(null);
  const storyboardEditor = useRef<HTMLButtonElement>(null);
  const focusTarget = useRef<ConfigurationStep | undefined>(undefined);
  const focusStep = useCallback((value: ConfigurationStep) => {
    const section = content.current?.querySelector<HTMLElement>(`[data-production-step="${value}"]`);
    const controls = [...section?.querySelectorAll<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled)') ?? []].filter(element => element.checkVisibility());
    const primary = value === 'planning' ? controls.find(element => element.closest('.production-settings__prompts')) : undefined;
    (primary ?? controls[0] ?? section)?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    if (initialTab !== 'run') focusStep(initialStep);
  }, [initialStep, initialTab, focusStep]);
  useLayoutEffect(() => {
    if (focusTarget.current !== step) return;
    focusTarget.current = undefined;
    focusStep(step);
  }, [step, focusStep]);
  const records = initialTab === 'run';
  const flat = flatRecords ?? workflow.id === 'native-video';
  const active = Boolean(run && ['queued', 'running', 'waiting_review', 'waiting_external', 'retry_scheduled'].includes(run.status));
  const resolved = resolveProductionWorkflow({ ...workflow, nodes, production: settings, execution });
  const automaticCasting = supportsAutomaticCasting(resolved);
  const showImageModel = automaticCasting || settings.referenceMode === 'generate';
  const planningSteps = productionPlanningSteps.filter(kind => resolved.nodes.some(node => productionPlanningStep(resolved, node) === kind));
  const manualSteps = planningSteps.filter(kind => settings.manualPlanningSteps?.includes(kind));
  const shotCount = planning?.project.shots.length ?? 0;
  const requiredModelTasks = resolved.nodes.filter(node => !usesManualPlanning(resolved, node) && stepGuidance(node).requiresModel);
  const modelFields = unifiedModelFields.map(field => {
    const tasks = requiredModelTasks.filter(node => productionModelSetting(node) === field.key);
    const models = workspace.models.filter(model => model.enabled && model.capabilities.includes(field.capability)
      && (field.key !== 'imageModelId' || getMediaAdapters(['image']).some(adapter => adapter.id === model.provider))
      && tasks.every(node => matchingStepModels(node, [model]).length > 0));
    return { ...field, models, required: tasks.length > 0 };
  });
  const [textField, videoField, imageField] = modelFields;
  const assistantNode = resolved.nodes.find(node => node.id === assistantNodeId);
  const stages = recordStages ?? resolved.stages ?? resolved.nodes.map(node => ({ id: node.id, label: node.label, description: node.description, nodeIds: [node.id] }));
  const selectedStage = stages.find(item => item.id === runStage) ?? stages[0];
  const stepIndex = steps.findIndex(item => item.id === step);
  const modelName = (modelId?: string) => workspace.models.find(model => model.id === modelId)?.name ?? '未选择';
  const textModel = workspace.models.find(model => model.id === settings.textModelId);
  const hasEditingStep = Boolean(productionEditingStep(resolved));
  const agentSkillIds = productionEditingSkillIds(resolved);
  const inheritedAgentSkills = agentSkillIds.length > 0 && settings.agentSkillIds.length === 0;
  const toolNames = { series: '系列模板', saveSeries: '保存系列模板', music: '背景音乐', caption: '字幕样式' };

  function updateSettings(patch: Partial<ProductionSettings>) { setSettings(value => ({ ...value, ...patch })); setError(''); }
  function updatePlanningSource(kind: ProductionPlanningStep, manual: boolean) {
    const next = productionPlanningSteps.filter(step => step === kind ? manual : manualSteps.includes(step));
    updateSettings({ manualPlanningSteps: next.length ? next : undefined });
  }
  function updateDocument(kind: PlanningDocumentKind, key: string, text: string) {
    setDocuments(current => ({ ...current, [kind]: { ...current[kind], [key]: text } }));
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
  async function prefill(kind: ProductionPlanningStep) {
    if (inFlight.current || active || !projectId || !projectRevision || !planning || configurationError) return;
    if (!validateProfile()) return;
    const node = resolved.nodes.find(node => productionPlanningStep(resolved, node) === kind);
    if (!node?.modelId || !workspace.models.some(model => model.id === node.modelId && model.enabled && model.capabilities.includes('text'))) {
      selectStep('materials', true); setError('请先选择文本模型，再返回创作要求使用 AI 填写。');
      return;
    }
    const document = (kind: PlanningDocumentKind) => manualSteps.includes(kind) ? formatPlanningDocument(kind, documents[kind]) : fields[kind];
    const draft: PromptDraft = { projectId, projectRevision, node, context: { ...fields, brief: document('brief'), style: document('style'), production: settings } };
    const input = JSON.stringify(draft);
    const request = prefillRequest.current?.input === input ? prefillRequest.current : { input, id: crypto.randomUUID() };
    prefillRequest.current = request;
    inFlight.current = true; setPending(kind); setError('');
    try {
      const output = await readPlanningPrefill(draft, request.id, () => !closed.current, () => { prefillRequest.current = undefined; }, chargeRpc);
      if (closed.current || output === undefined) return;
      if (latestRevision.current !== projectRevision) throw new Error('生成期间项目已更新，请按当前内容重新填写。');
      if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('AI 草稿没有可回填的字段。');
      if (kind === 'script') {
        planning.onEdit('script', { storyboard: storyboardDraftSchema.parse(output), profile: fields.profile, onSaved(context) {
          updatePlanningSource('script', true);
          setFields(current => ({ ...current, creativeContext: context }));
          showNotice('分镜已保存，后续制作会使用修改后的镜头。');
        } });
      } else {
        const values = planningDocumentSchemas[kind].parse(output.fields);
        setDocuments(current => ({ ...current, [kind]: values }));
        updatePlanningSource(kind, true);
        showNotice(`${planningLabels[kind]}已回填，修改后可保存设置。`);
      }
    } catch (failure) { if (!closed.current) setError(failure instanceof Error ? failure.message : 'AI 填写未完成。'); }
    finally { inFlight.current = false; if (!closed.current) setPending(undefined); }
  }
  function validateProfile() {
    const result = videoProfileSchema.safeParse(fields.profile);
    if (result.success) return true;
    selectStep('planning'); setError('请检查分镜尺寸与帧率。');
    const field = result.error.issues[0]?.path[0];
    const label = field === 'frameRate' ? '视频帧率' : field === 'height' ? '视频高度' : '视频宽度';
    requestAnimationFrame(() => {
      const control = form.current?.querySelector<HTMLElement>(`[aria-label="${label}"]`);
      for (let details = control?.closest('details'); details; details = details.parentElement?.closest('details')) details.open = true;
      control?.focus();
    });
    return false;
  }
  function validate(all = false) {
    if (all || step === 'planning') for (const kind of ['brief', 'style'] as const) {
      if (!manualSteps.includes(kind)) continue;
      const result = planningDocumentSchemas[kind].safeParse(documents[kind]);
      if (result.success) continue;
      const issue = result.error.issues[0];
      selectStep('planning'); setError(issue.message);
      const field = `${kind}-${String(issue.path[0])}`;
      requestAnimationFrame(() => form.current?.querySelector<HTMLElement>(`[data-planning-field="${CSS.escape(field)}"]`)?.focus());
      return false;
    }
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
    if (step === 'planning' && manualSteps.includes('script') && !shotCount) {
      setError('使用已填写的分镜时，请至少添加一个镜头。');
      const editor = storyboardEditor.current;
      (editor && !editor.disabled ? editor : form.current?.querySelector<HTMLElement>('[aria-label="分镜来源"]'))?.focus();
      return;
    }
    if (step === 'materials') {
      const missing = modelFields.find(({ required, key, models }) => required && !models.some(model => model.id === settings[key]));
      if (missing) {
        setError(missing.models.length ? `请选择可用的${missing.label}。` : `暂无可用的${missing.label}，请在模型连接中添加或启用。`);
        form.current?.querySelector<HTMLInputElement>(`#${CSS.escape(`${id}-${missing.label}`)}`)?.focus();
        return;
      }
    }
    selectStep(following.id, true);
  }
  function close() { closed.current = true; onClose(); }
  function modelField({ key, label, models, required }: (typeof modelFields)[number]) {
    return <Field label={label} required={required}>
      <Combobox displayMode="label" id={`${id}-${label}`} label={label} required={required} value={settings[key] ?? ''} items={models.map(model => ({ id: model.id, label: model.name }))} placeholder="选择或搜索模型" onChange={value => updateSettings({ [key]: value || undefined })} />
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
      const manualPlanningFields = { ...settings.manualPlanningFields };
      const project = { ...fields };
      if (manualSteps.includes('brief')) {
        manualPlanningFields.brief = planningDocumentSchemas.brief.parse(documents.brief);
        project.brief = formatPlanningDocument('brief', manualPlanningFields.brief);
      }
      if (manualSteps.includes('style')) {
        manualPlanningFields.style = planningDocumentSchemas.style.parse(documents.style);
        project.style = formatPlanningDocument('style', manualPlanningFields.style);
      }
      const production = { ...settings, manualPlanningFields: manualPlanningFields.brief || manualPlanningFields.style ? manualPlanningFields : undefined };
      const saved = await onSave({ nodes: resolved.nodes, production, project, execution });
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
  return <Dialog title={records ? '本次制作' : '制作设置'} onClose={close} onDismissStart={() => { closed.current = true; }} className={`settings-dialog production-settings-dialog ${records ? 'production-results-dialog' : 'dialog--aligned-gutters'}`}>
    {!records && <nav className="dialog__band production-settings__steps" aria-label="制作设置步骤"><ol>{steps.map((item, index) => <li key={item.id}><button type="button" aria-current={step === item.id ? 'step' : undefined} disabled={Boolean(pending)} onClick={() => selectStep(item.id)}><span className="production-settings__step-index" aria-hidden="true">{index + 1}</span><span>{item.label}</span></button></li>)}</ol></nav>}
    <div className="dialog__body">
      {!records && (pendingConfiguration || active || configurationError || error) && <div className="dialog__band production-settings__context">
        {active && <p>本次制作使用启动时的设置，保存后用于下次制作。</p>}
        {pendingConfiguration && <Notice><span>已保存待用配置。</span>{onDiscardPending && <Button static disabled={Boolean(pending)} onClick={() => void discard()}>放弃待用配置</Button>}</Notice>}
        {(configurationError || error) && <Notice kind="error">{configurationError || error}</Notice>}
      </div>}
      {records ? <div className="production-settings__run">{flat ? <Suspense fallback={<p role="status">正在读取制作记录…</p>}><StageRunView flat planning={planning} runId={run?.id} nodes={resolved.nodes} nodeIds={resolved.nodes.map(node => node.id)} initialNodeId={initialNodeId} version={version} actionsTarget={runActionsTarget} onNotice={showNotice} onOpenOutput={onOpenOutput} configurableNodeIds={[]} /></Suspense> : <SettingsSections label="制作阶段记录" layout="tabs" value={runStage} onValueChange={setRunStage} sections={stages.map(item => ({ id: item.id, label: item.label, content: item.id === selectedStage?.id ? <Suspense fallback={<p role="status">正在读取制作记录…</p>}><StageRunView planning={planning} runId={run?.id} stageId={item.id} nodeIds={item.nodeIds} initialNodeId={initialNodeId} version={version} actionsTarget={runActionsTarget} onNotice={showNotice} onOpenOutput={onOpenOutput} configurableNodeIds={[]} /></Suspense> : null }))} />}</div> : <form ref={form} noValidate className="production-settings__form" onSubmit={event => { event.preventDefault(); if (step === 'review') void submit(); else next(); }}>
        <fieldset disabled={Boolean(pending)} className="production-settings__fieldset"><div ref={content} className="dialog__scroll production-settings__content">
          <section className="form-stack" data-production-step="planning" hidden={step !== 'planning'} aria-label="创作要求配置" tabIndex={-1}>
            <details className="form-disclosure production-settings__storyboard">
              <summary><span>分镜全局参数</span><small>{width} × {height} · {formatFrameRate(frameRate)} fps</small></summary>
              <div className="form-disclosure__body" role="group" aria-label="分镜全局参数">
                <VideoSettings mode="generation" profile={fields.profile} onChange={profile => setFields(current => ({ ...current, profile }))} />
              </div>
            </details>
            {planningSteps.length > 0 && <div role="group" aria-label="策划内容来源" className="production-settings__models production-settings__planning-sources">
              {planningSteps.map(kind => <div key={kind} className="production-settings__planning-source">
                <Field label={planningSourceLabels[kind]}>
                  <Select value={manualSteps.includes(kind) ? 'manual' : 'ai'} onChange={event => updatePlanningSource(kind, event.target.value === 'manual')}>
                    <option value="ai">制作时由 AI 生成</option><option value="manual">使用已填写内容</option>
                  </Select>
                </Field>
                {projectId && projectRevision && planning && <Button static variant="ghost" busy={pending === kind} disabled={active || Boolean(configurationError || planning.disabledReason)} onClick={() => void prefill(kind)}>
                  {pending !== kind && <WandSparkles size={15} aria-hidden="true" />}{prefillLabels[kind]}
                </Button>}
              </div>)}
            </div>}
            <div className="production-settings__models production-settings__prompts">
              {manualSteps.includes('brief') ? <PlanningDocumentFields kind="brief" value={documents.brief} onChange={(key, text) => updateDocument('brief', key, text)} />
                : <Field label="创作要求"><textarea value={fields.brief} onChange={event => setFields(current => ({ ...current, brief: event.target.value }))} placeholder="主题、受众、核心信息与时长" /></Field>}
              {manualSteps.includes('style') ? <PlanningDocumentFields kind="style" value={documents.style} onChange={(key, text) => updateDocument('style', key, text)} />
                : <Field label="视觉风格"><textarea value={fields.style} onChange={event => setFields(current => ({ ...current, style: event.target.value }))} placeholder="画面风格、色调与光线" /></Field>}
            </div>
            {manualSteps.includes('script') && <div className="production-settings__planning-note">
              <p>项目分镜<span className="field__required" aria-hidden="true">*</span> · {shotCount ? `已填写 ${shotCount} 个镜头` : '请至少填写一个镜头'}</p>
              {planning && <Button ref={storyboardEditor} static disabled={Boolean(planning.disabledReason)} onClick={() => {
                if (!validateProfile()) return;
                setError(''); planning.onEdit('script', { profile: fields.profile });
              }}>{shotCount ? '编辑项目分镜' : '填写项目分镜'}</Button>}
            </div>}
            <CreativeContextEditor floatingSections value={fields.creativeContext} version={version} usedEntityKeys={usedEntityKeys} onChange={creativeContext => setFields(current => ({ ...current, creativeContext }))} />
            <ProjectSettingsActions items={['series', 'saveSeries']} onAction={requestTool} />
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
            <div className="production-settings__models">
              {modelField(textField)}
              {modelField(videoField)}
            </div>
            {!textField.required && hasEditingStep && <p className="production-settings__agent-help">文本模型可选，供剪辑 Agent 使用。</p>}
            <div className="production-settings__models">
              <Field label="参考素材"><Select value={settings.referenceMode} onChange={event => updateSettings({ referenceMode: event.target.value as ProductionSettings['referenceMode'] })}><option value="none">直接文生视频</option><option value="existing">使用已有参考图</option><option value="generate">先生成参考图</option></Select></Field>
              {showImageModel && modelField(imageField)}
            </div>
            {automaticCasting && <p className="field__hint">反复出镜的人物缺少参考图时，使用图片模型自动定妆。留空时使用唯一可用的图片模型。</p>}
            <ReferenceAudioPicker assets={workspace.assets} value={settings.referenceAudioAssetIds ?? []} onChange={referenceAudioAssetIds => updateSettings({ referenceAudioAssetIds })} onImport={importReferenceAudio} disabled={Boolean(pending)} />
            <GenerationConcurrencySettings workflow={resolved} models={workspace.models} onChange={setExecution} />
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
              <header><h3>创作要求</h3><Button static variant="ghost" aria-label="修改创作要求" onClick={() => selectStep('planning', true)}>修改</Button></header>
              <dl>
                <div><dt>分镜全局参数</dt><dd>{aspectRatio && `${aspectRatio} · `}{width} × {height} · {formatFrameRate(frameRate)} fps</dd></div>
                <div><dt>素材适配</dt><dd>{VIDEO_FIT_MODE_LABELS[fitMode]}</dd></div>
                <div><dt>{manualSteps.includes('brief') ? '创意简报' : '创作要求'}</dt><dd>{(manualSteps.includes('brief') ? formatPlanningDocument('brief', documents.brief) : fields.brief.trim()) || '尚未填写'}</dd></div>
                <div><dt>视觉风格</dt><dd>{(manualSteps.includes('style') ? formatPlanningDocument('style', documents.style) : fields.style.trim()) || '沿用默认风格'}</dd></div>
                {manualSteps.length > 0 && <div><dt>手动策划内容</dt><dd>{manualSteps.map(kind => planningLabels[kind]).join('、')}</dd></div>}
                <div><dt>项目角色池</dt><dd>{fields.creativeContext?.characterIds.length ? `已选择 ${fields.creativeContext.characterIds.length} 个角色` : '未选择'}</dd></div>
                {fields.creativeContext?.continuity && <div><dt>连续性要求</dt><dd>{fields.creativeContext.continuity}</dd></div>}
                {Boolean(fields.creativeContext?.entities.length) && <div><dt>文字设定</dt><dd>{fields.creativeContext?.entities.map(entity => entity.name).join('、')}</dd></div>}
                {hasEditingStep && (agentSkillIds.length > 0 || settings.agentMcpServerIds.length > 0) && <div>
                  <dt>剪辑 Agent</dt><dd>{agentSkillIds.length ? `${inheritedAgentSkills ? '沿用 ' : ''}${agentSkillIds.length} 个 Skill` : 'Skill 自动选择'} · {settings.agentMcpServerIds.length ? `${settings.agentMcpServerIds.length} 个工具连接` : '工具自动选择'}</dd>
                </div>}
              </dl>
            </section>
            <section><header><h3>模型与素材</h3><Button static variant="ghost" aria-label="修改模型与素材" onClick={() => selectStep('materials', true)}>修改</Button></header><dl><div><dt>文本模型</dt><dd>{modelName(settings.textModelId)}</dd></div><div><dt>视频模型</dt><dd>{modelName(settings.videoModelId)}</dd></div><div><dt>参考素材</dt><dd>{{ none: '直接文生视频', existing: '使用已有参考图', generate: '先生成参考图' }[settings.referenceMode]}</dd></div>{showImageModel && <div><dt>图片模型</dt><dd>{settings.imageModelId || imageField.required ? modelName(settings.imageModelId) : '按需自动选择'}</dd></div>}<div><dt>参考音频</dt><dd>{settings.referenceAudioAssetIds?.length ? `已选择 ${settings.referenceAudioAssetIds.length} 段` : '未添加'}</dd></div><div><dt>镜头同时处理数</dt><dd>{execution?.maxConcurrentShots ?? 1}</dd></div><div><dt>模型并发上限</dt><dd>{Object.entries(execution?.modelLimits ?? {}).map(([modelId, limit]) => `${modelName(modelId)}：${limit}`).join('；') || '跟随镜头并发'}</dd></div></dl></section>
            <section>
              <header><h3>声音与成片</h3><Button static variant="ghost" aria-label="修改声音与成片" onClick={() => selectStep('delivery', true)}>修改</Button></header>
              <dl>
                <div><dt>声音要求</dt><dd>{settings.soundPrompt.trim() || '跟随分镜内容'}</dd></div>
                <div><dt>字幕</dt><dd>{settings.subtitleMode === 'off' ? '关闭' : '显示分镜文本（预估时间）'}</dd></div>
              </dl>
            </section>
          </section>}
        </div></fieldset>
      </form>}
    </div>
    <div className={`dialog__footer${records ? '' : ' dialog__band production-settings__footer'}`}>{records ? <div ref={setRunActionsTarget} className="production-settings__record-actions" /> : <>
      {stepIndex > 0 && <Button variant="ghost" disabled={Boolean(pending)} onClick={() => selectStep(steps[stepIndex - 1].id, true)}><ChevronLeft size={14} aria-hidden="true" />上一步</Button>}
      {step === 'review' ? <Button variant="primary" busy={pending === 'save'} disabled={Boolean(pending || configurationError)} onClick={() => void submit()}>{requestedTool ? '保存并打开' : active ? '保存待用配置' : '保存设置'}</Button> : <Button variant="primary" disabled={Boolean(pending || configurationError)} onClick={next}>下一步<ChevronRight size={14} aria-hidden="true" /></Button>}
    </>}</div>
    {records && <ToastNotice toast={notice} onDismiss={() => setNotice(undefined)} />}
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
