import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
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
import GenerationConcurrencySettings from './GenerationConcurrencySettings';
import SkillPicker from './SkillPicker';
import ToolConnectionPicker from './ToolConnectionPicker';
import ToolBindings from './ToolBindings';
import { sameContent } from '../lib/project-edits';
import ToastNotice, { type ToastMessage } from './ToastNotice';
import './production-settings.css';

const StageRunView = lazy(() => import('../features/StageRunView'));
const PromptWorkbench = lazy(() => import('./PromptWorkbench'));
const WorkflowAssistant = lazy(() => import('./WorkflowAssistant'));
const ModelAlternatives = lazy(() => import('./ModelAlternatives'));
const steps = [{ id: 'planning', label: '创作要求' }, { id: 'materials', label: '模型与素材' }, { id: 'delivery', label: '声音与成片' }, { id: 'review', label: '确认保存' }] as const;
type ConfigurationStep = typeof steps[number]['id'];
export interface ProductionConfiguration { nodes: WorkflowNode[]; production: ProductionSettings; project: ProductionProjectSettings; execution: WorkflowDefinition['execution']; }

export default function ProductionSettingsDialog({ project, projectId, projectRevision, workflow, workspace, run, version, usedEntityKeys = [], initialStage = 'planning', initialNodeId, initialTab, flatRecords, pendingConfiguration, configurationError, onSave, onDiscardPending, onClose, onOpenOutput, onOpenCandidate, onOpenTool, onOpenAdvanced, onSectionChange, onImportReferenceAudio, planning }: {
  project: Pick<ProjectDocument, 'brief' | 'style' | 'profile' | 'creativeContext'>; workflow: WorkflowDefinition; workspace: WorkspaceView; run?: RunSummary; version: number; usedEntityKeys?: string[];
  projectId?: string; projectRevision?: number; onOpenCandidate?(shotId: string): void;
  planning?: PlanningControls;
  initialStage?: string; initialNodeId?: string; initialTab?: 'settings' | 'run'; flatRecords?: boolean; pendingConfiguration?: boolean; configurationError?: string;
  onSave: (value: ProductionConfiguration) => Promise<boolean>;
  onDiscardPending?: () => Promise<boolean>; onClose: () => void; onOpenOutput: (value: StepOutputSelection) => void;
  onOpenTool: (action: ProjectSettingsAction) => void; onSectionChange?: (section: string) => void;
  onOpenAdvanced: () => void;
  onImportReferenceAudio: (path: string) => Promise<AssetRecord | undefined>;
}) {
  const [settings, setSettings] = useState(() => productionSettingsSchema.parse(workflow.production));
  const [fields, setFields] = useState<ProductionProjectSettings>(() => ({ brief: project.brief, style: project.style, profile: project.profile, creativeContext: project.creativeContext }));
  const [nodes, setNodes] = useState(workflow.nodes);
  const [execution, setExecution] = useState(workflow.execution);
  const baseline = useRef({ settings, fields, nodes, execution });
  const [promptNode, setPromptNode] = useState<WorkflowNode>();
  const [assistantNodeId, setAssistantNodeId] = useState<string>(), [alternativesId, setAlternativesId] = useState<string>();
  const initialTask = workflow.nodes.find(node => node.id === initialNodeId);
  const initialStep = initialTask ? stepGuidance(initialTask).capability === 'text' ? 'planning' : 'materials' : steps.find(item => item.id === initialStage)?.id ?? 'planning';
  const [step, setStep] = useState<ConfigurationStep>(initialStep);
  const [runStage, setRunStage] = useState(initialStage);
  const [selectedTasks, setSelectedTasks] = useState<Record<string, string>>(initialNodeId ? { [initialStep]: initialNodeId } : {});
  const [advancedStage, setAdvancedStage] = useState<string | undefined>(initialNodeId ? initialStep : undefined);
  const [requestedTool, setRequestedTool] = useState<ProjectSettingsAction | 'workflow'>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'save' | 'discard' | 'import'>();
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
  const id = useId(), form = useRef<HTMLFormElement>(null), content = useRef<HTMLDivElement>(null);
  const focusTarget = useRef<ConfigurationStep | undefined>(undefined);
  const focusStep = useCallback((value: ConfigurationStep) => {
    const section = content.current?.querySelector<HTMLElement>(`[data-production-step="${value}"]`);
    const field = [...section?.querySelectorAll<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])') ?? []].find(element => element.checkVisibility());
    (field ?? section)?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    if (focusTarget.current !== step) return;
    focusTarget.current = undefined;
    focusStep(step);
  }, [step, focusStep]);
  const records = initialTab === 'run';
  const flat = flatRecords ?? workflow.id === 'native-video';
  const active = Boolean(run && ['queued', 'running', 'waiting_review', 'waiting_external', 'retry_scheduled'].includes(run.status));
  const resolved = resolveProductionWorkflow({ ...workflow, nodes, production: settings, execution });
  const assistantNode = resolved.nodes.find(node => node.id === assistantNodeId);
  const stages = resolved.stages ?? resolved.nodes.map(node => ({ id: node.id, label: node.label, description: node.description, nodeIds: [node.id] }));
  const selectedStage = stages.find(item => item.id === runStage) ?? stages[0];
  const stepIndex = steps.findIndex(item => item.id === step);
  const modelName = (modelId?: string) => workspace.models.find(model => model.id === modelId)?.name ?? '未选择';
  const textModel = workspace.models.find(model => model.id === settings.textModelId);
  const toolNames = { series: '系列模板', saveSeries: '保存系列模板', music: '背景音乐', caption: '字幕样式', workflow: '高级编排' };

  function updateSettings(patch: Partial<ProductionSettings>) { setSettings(value => ({ ...value, ...patch })); setError(''); }
  function updateNode(node: WorkflowNode, patch: Partial<WorkflowNode>) { setNodes(current => current.map(item => item.id === node.id ? { ...item, ...patch } : item)); setError(''); }
  function selectStep(value: ConfigurationStep, focus = false) {
    focusTarget.current = focus ? value : undefined;
    setStep(value); onSectionChange?.(value); setError('');
    if (value !== 'review') setRequestedTool(undefined);
    if (content.current) content.current.scrollTop = 0;
    // Focus the committed step before another interaction can begin. A delayed
    // RAF could otherwise blur an already opened model search and close it.
    if (focus && value === step) { focusTarget.current = undefined; focusStep(value); }
  }
  function requestTool(tool: ProjectSettingsAction | 'workflow') { setRequestedTool(tool); selectStep('review', true); }
  function openAdvanced() {
    if (sameContent({ settings, fields, nodes, execution }, baseline.current)) { close(); onOpenAdvanced(); }
    else requestTool('workflow');
  }
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
    requestAnimationFrame(() => {
      for (let parent = invalid.parentElement; parent && parent !== form.current; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      }
      invalid.focus(); invalid.reportValidity();
    });
    return false;
  }
  function next() { if (validate() && steps[stepIndex + 1]) selectStep(steps[stepIndex + 1].id, true); }
  function close() { closed.current = true; onClose(); }
  function modelField(label: string, value: string | undefined, models: WorkspaceView['models'], onChange: (value: string | undefined) => void) {
    return <Field label={label}><Combobox displayMode="label" id={`${id}-${label}`} label={label} value={value ?? ''} items={models.map(model => ({ id: model.id, label: model.name }))} placeholder="选择或搜索模型" onChange={value => onChange(value || undefined)} /></Field>;
  }
  function advanced(group: { id: string; label: string; nodeIds: string[] }) {
    const tasks = resolved.nodes.filter(node => group.nodeIds.includes(node.id) && stepGuidance(node).capability);
    const node = tasks.find(node => node.id === selectedTasks[group.id]) ?? tasks[0];
    if (!node) return null;
    return <details key={group.id} className="production-settings__advanced" open={advancedStage === group.id} onToggle={event => { const open = event.currentTarget.open; setAdvancedStage(current => open ? group.id : current === group.id ? undefined : current); }}><summary>{['planning', 'materials', 'delivery'].includes(group.id) ? '高级设置' : `${group.label} · 高级设置`}</summary>
      <div className="production-settings__task" role="group" aria-label={node.label}>
        <div className="production-settings__task-fields">
          <div className="production-settings__task-controls">
            {tasks.length > 1 && <Field label="任务"><Select value={node.id} onChange={event => { const nodeId = event.target.value; setSelectedTasks(current => ({ ...current, [group.id]: nodeId })); }}>{tasks.map(node => <option key={node.id} value={node.id}>{node.label}</option>)}</Select></Field>}
            <Field key={`${node.id}-model`} label={`${node.label}模型`}><Combobox displayMode="label" id={`${id}-${node.id}-model`} label={`${node.label}模型`} value={node.config.modelOverride === true || node.config.modelBinding !== 'default' ? node.modelId ?? '' : ''} placeholder="跟随统一模型" items={[{ id: '', label: '跟随统一模型' }, ...matchingStepModels(node, workspace.models).map(model => ({ id: model.id, label: model.name }))]} onChange={value => updateNode(node, { modelId: value || undefined, config: { ...node.config, modelBinding: 'default', modelOverride: Boolean(value) } })} /></Field>
          </div>
          <Field key={`${node.id}-prompt`} className="production-settings__task-prompt" label={`${node.label}补充要求`}><textarea value={node.prompt} rows={3} onChange={event => updateNode(node, { prompt: event.target.value })} /></Field>
        </div>
        <div className="production-settings__task-actions">
          {projectId && projectRevision && supportsPromptExperiment(node) && <Button onClick={() => setPromptNode(node)}>预览与实验提示词</Button>}
          {projectId && projectRevision && <Button onClick={() => setAssistantNodeId(node.id)}>对话修改任务</Button>}
          <Button aria-expanded={alternativesId === node.id} onClick={() => setAlternativesId(current => current === node.id ? undefined : node.id)}>查看替代模型</Button>
          <details key={`${node.id}-skills`} className="production-settings__task-skills"><summary>{node.label} Skill · 已选 {node.skillIds.length} 个</summary><SkillPicker skills={workspace.skills} groups={workspace.skillGroups} value={node.skillIds} onChange={skillIds => updateNode(node, { skillIds })} label={`${node.label} Skill`} /></details>
        </div>
        {alternativesId === node.id && <Suspense fallback={<p role="status">正在读取模型建议…</p>}><ModelAlternatives key={node.id} node={node} models={workspace.models} runId={run?.id} version={version} failure={run ? { error: run.error, runStatus: run.status, queueOwned: Boolean(run.productionQueueId), trial: run.purpose === 'prompt-trial' } : undefined} onSelect={modelId => updateNode(node, { modelId, config: { ...node.config, modelBinding: 'default', modelOverride: true } })} /></Suspense>}
        {node.kind === 'agent' && <><p className="field__hint">Skill 可多选；留空由 Agent 按任务自动选择，选定后仅使用所选 Skill。</p><ToolBindings node={node} onChange={value => updateNode(node, { config: value.config })} /></>}
      </div>
    </details>;
  }
  async function submit() {
    if (inFlight.current || configurationError || !validate(true)) return;
    inFlight.current = true; setPending('save'); setError('');
    try {
      const saved = await onSave({ nodes: resolved.nodes, production: settings, project: fields, execution });
      if (closed.current) return;
      if (saved) { close(); if (requestedTool === 'workflow') onOpenAdvanced(); else if (requestedTool) onOpenTool(requestedTool); }
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
      {records ? <div className="production-settings__run">{flat ? <Suspense fallback={<p role="status">正在读取制作记录…</p>}><StageRunView flat planning={planning} runId={run?.id} nodes={resolved.nodes} nodeIds={resolved.nodes.map(node => node.id)} initialNodeId={initialNodeId} version={version} actionsTarget={runActionsTarget} onNotice={showNotice} onOpenOutput={onOpenOutput} configurableNodeIds={[]} /></Suspense> : <SettingsSections label="制作阶段记录" layout="tabs" value={runStage} onValueChange={setRunStage} sections={stages.map(item => ({ id: item.id, label: item.label, content: item.id === selectedStage?.id ? <Suspense fallback={<p role="status">正在读取制作记录…</p>}><StageRunView planning={planning} runId={run?.id} stageId={item.id} nodeIds={item.nodeIds} initialNodeId={initialNodeId} version={version} actionsTarget={runActionsTarget} onNotice={showNotice} onOpenOutput={onOpenOutput} configurableNodeIds={[]} /></Suspense> : null }))} />}</div> : <form ref={form} noValidate className="production-settings__form" onSubmit={event => { event.preventDefault(); if (step === 'review') void submit(); else next(); }}>
        <fieldset disabled={Boolean(pending)} className="production-settings__fieldset"><div ref={content} className="production-settings__content">
          <section data-production-step="planning" hidden={step !== 'planning'} aria-label="创作要求配置" tabIndex={-1}>
            <div className="production-settings__models">
              <Field label="创作要求"><textarea value={fields.brief} onChange={event => setFields(current => ({ ...current, brief: event.target.value }))} rows={3} placeholder="主题、受众、核心信息与时长" autoFocus={step === 'planning'} /></Field>
              <Field label="视觉风格"><textarea value={fields.style} onChange={event => setFields(current => ({ ...current, style: event.target.value }))} rows={3} placeholder="画面风格、色调与光线" /></Field>
            </div>
            <CreativeContextEditor collapsibleRoles value={fields.creativeContext} version={version} usedEntityKeys={usedEntityKeys} onChange={creativeContext => setFields(current => ({ ...current, creativeContext }))} />
            <ProjectSettingsActions items={['series', 'saveSeries']} onAction={requestTool} />
            {advanced({ id: 'planning', label: '创作要求', nodeIds: resolved.nodes.filter(node => stepGuidance(node).capability === 'text').map(node => node.id) })}
          </section>
          <section data-production-step="materials" hidden={step !== 'materials'} aria-label="模型与素材" tabIndex={-1}>
            <div className="production-settings__models production-settings__models--mode">
              <Field label="制作方式"><Select value={settings.executionMode} aria-describedby={settings.executionMode === 'agent' ? `${id}-agent-help` : undefined} onChange={event => updateSettings({ executionMode: event.target.value === 'agent' ? 'agent' : 'workflow' })}><option value="workflow">按流程制作</option><option value="agent">Video Agent 自主制作</option></Select></Field>
              {modelField('文本模型', settings.textModelId, workspace.models.filter(model => model.enabled && model.capabilities.includes('text')), value => updateSettings({ textModelId: value }))}
              {modelField('视频模型', settings.videoModelId, workspace.models.filter(model => model.enabled && model.capabilities.includes('video')), value => updateSettings({ videoModelId: value }))}
            </div>
            {settings.executionMode === 'agent' && <><p id={`${id}-agent-help`} className="production-settings__agent-help">Agent 按任务选择能力，生成素材并完成导出。文本模型需支持工具调用，Skill 脚本需单独启用。</p>
              <details className="production-settings__advanced production-settings__agent-capabilities"><summary>Agent 任务能力 · {settings.agentSkillIds.length ? `${settings.agentSkillIds.length} 个 Skill` : 'Skill 自动选择'} · {settings.agentMcpServerIds.length ? `${settings.agentMcpServerIds.length} 个工具连接` : '工具自动选择'}</summary><p className="production-settings__agent-help">Skill 与工具连接分别设置，均可多选。某类留空时由 Agent 自动发现并选择合适能力；选定后仅使用该类已勾选且启用的能力。</p><SkillPicker label="Agent 任务使用的 Skill" skills={workspace.skills} groups={workspace.skillGroups} value={settings.agentSkillIds} onChange={agentSkillIds => updateSettings({ agentSkillIds })} /><ToolConnectionPicker label="Agent 任务使用的工具连接" value={settings.agentMcpServerIds} onChange={agentMcpServerIds => updateSettings({ agentMcpServerIds })} /></details>
            </>}
            {settings.executionMode === 'agent' && textModel && (!textModel.capabilities.includes('tools') || textModel.provider === 'ollama') && <Notice>{textModel.provider === 'ollama' ? '本地模型的 Agent 制作需通过支持工具调用的 OpenAI 兼容服务接入，请更换文本模型连接。' : '当前文本模型未开启工具调用能力，请选择支持工具调用的模型后开始 Agent 制作。'}</Notice>}
            <div className="production-settings__models">
              <Field label="参考素材"><Select value={settings.referenceMode} onChange={event => updateSettings({ referenceMode: event.target.value as ProductionSettings['referenceMode'] })}><option value="none">直接文生视频</option><option value="existing">使用已有参考图</option><option value="generate">先生成参考图</option></Select></Field>
              {settings.referenceMode === 'generate' && modelField('图片模型', settings.imageModelId, workspace.models.filter(model => model.enabled && model.capabilities.includes('image')), value => updateSettings({ imageModelId: value }))}
            </div>
            <ReferenceAudioPicker assets={workspace.assets} value={settings.referenceAudioAssetIds ?? []} onChange={referenceAudioAssetIds => updateSettings({ referenceAudioAssetIds })} onImport={importReferenceAudio} disabled={Boolean(pending)} />
            <GenerationConcurrencySettings workflow={resolved} models={workspace.models} onChange={setExecution} />
            {advanced({ id: 'materials', label: '模型与素材', nodeIds: resolved.nodes.filter(node => stepGuidance(node).capability && stepGuidance(node).capability !== 'text').map(node => node.id) })}
            <details className="production-settings__advanced"><summary>高级编排</summary><Button onClick={openAdvanced}>打开高级编排</Button></details>
          </section>
          <section data-production-step="delivery" hidden={step !== 'delivery'} aria-label="声音与成片" tabIndex={-1}>
            <Field label="声音要求"><textarea value={settings.soundPrompt} onChange={event => updateSettings({ soundPrompt: event.target.value })} rows={3} placeholder="语言、说话方式、环境音与音乐…" /></Field>
            <div className="production-settings__delivery-options">
              <Field label="字幕"><Select value={settings.subtitleMode} onChange={event => updateSettings({ subtitleMode: event.target.value === 'script' ? 'script' : 'off' })}><option value="off">关闭</option><option value="script">显示分镜文本（预估时间）</option></Select></Field>
              <VideoSettings mode="production" profile={fields.profile} onChange={profile => setFields(current => ({ ...current, profile }))} />
            </div>
            <ProjectSettingsActions items={['music', 'caption']} onAction={requestTool} />
          </section>
          {step === 'review' && <section data-production-step="review" aria-label="确认保存" className="production-settings__review" tabIndex={-1}>
            {requestedTool && <Notice>保存设置后将打开{toolNames[requestedTool]}。<Button static onClick={() => setRequestedTool(undefined)}>仅保存设置</Button></Notice>}
            {settings.executionMode === 'agent' && <Notice>Agent 任务使用的 Skill：{settings.agentSkillIds.length ? settings.agentSkillIds.map(id => workspace.skills.find(skill => skill.id === id)?.name ?? '不可用的 Skill').join('、') : '自动选择'}；工具连接：{settings.agentMcpServerIds.length ? `已选择 ${settings.agentMcpServerIds.length} 个` : '自动选择'}。</Notice>}
            <section><header><h3>创作要求</h3><Button static variant="ghost" aria-label="修改创作要求" onClick={() => selectStep('planning', true)}>修改</Button></header><dl><div><dt>创作要求</dt><dd>{fields.brief.trim() || '尚未填写'}</dd></div><div><dt>视觉风格</dt><dd>{fields.style.trim() || '沿用默认风格'}</dd></div><div><dt>项目角色池</dt><dd>{fields.creativeContext?.characterIds.length ? `已选择 ${fields.creativeContext.characterIds.length} 个角色` : '未选择'}</dd></div>{fields.creativeContext?.continuity && <div><dt>连续性要求</dt><dd>{fields.creativeContext.continuity}</dd></div>}{Boolean(fields.creativeContext?.entities.length) && <div><dt>文字设定</dt><dd>{fields.creativeContext?.entities.map(entity => entity.name).join('、')}</dd></div>}</dl></section>
            <section><header><h3>模型与素材</h3><Button static variant="ghost" aria-label="修改模型与素材" onClick={() => selectStep('materials', true)}>修改</Button></header><dl><div><dt>制作方式</dt><dd>{settings.executionMode === 'agent' ? 'Video Agent 自主制作' : '按流程制作'}</dd></div><div><dt>文本模型</dt><dd>{modelName(settings.textModelId)}</dd></div><div><dt>视频模型</dt><dd>{modelName(settings.videoModelId)}</dd></div><div><dt>参考素材</dt><dd>{{ none: '直接文生视频', existing: '使用已有参考图', generate: '先生成参考图' }[settings.referenceMode]}</dd></div>{settings.referenceMode === 'generate' && <div><dt>图片模型</dt><dd>{modelName(settings.imageModelId)}</dd></div>}<div><dt>参考音频</dt><dd>{settings.referenceAudioAssetIds?.length ? `已选择 ${settings.referenceAudioAssetIds.length} 段` : '未添加'}</dd></div><div><dt>镜头同时处理数</dt><dd>{execution?.maxConcurrentShots ?? 1}</dd></div><div><dt>模型并发上限</dt><dd>{Object.entries(execution?.modelLimits ?? {}).map(([modelId, limit]) => `${modelName(modelId)}：${limit}`).join('；') || '跟随镜头并发'}</dd></div></dl></section>
            <section><header><h3>声音与成片</h3><Button static variant="ghost" aria-label="修改声音与成片" onClick={() => selectStep('delivery', true)}>修改</Button></header><dl><div><dt>声音要求</dt><dd>{settings.soundPrompt.trim() || '跟随分镜内容'}</dd></div><div><dt>成片规格</dt><dd>{fields.profile.width} × {fields.profile.height} · {Number((fields.profile.frameRate.numerator / fields.profile.frameRate.denominator).toFixed(2))} fps</dd></div><div><dt>字幕</dt><dd>{settings.subtitleMode === 'off' ? '关闭' : '显示分镜文本（预估时间）'}</dd></div></dl></section>
          </section>}
        </div></fieldset>
      </form>}
    </div>
    <div className={`dialog__footer${records ? '' : ' production-settings__footer'}`}>{records ? <div ref={setRunActionsTarget} className="production-settings__record-actions" /> : <>
      <Button onClick={close}>取消</Button>
      <p className="production-settings__position" role="status">第 {stepIndex + 1} 步，共 {steps.length} 步</p>
      <div className="production-settings__navigation">{stepIndex > 0 && <Button disabled={Boolean(pending)} onClick={() => selectStep(steps[stepIndex - 1].id, true)}><ChevronLeft size={14} aria-hidden="true" />上一步</Button>}{step === 'review' ? <Button variant="primary" busy={pending === 'save'} disabled={Boolean(pending || configurationError)} onClick={() => void submit()}>{requestedTool ? '保存并打开' : active ? '保存待用配置' : '保存设置'}</Button> : <Button variant="primary" disabled={Boolean(pending || configurationError)} onClick={next}>下一步<ChevronRight size={14} aria-hidden="true" /></Button>}</div>
    </>}</div>
    {records && <ToastNotice toast={notice} onDismiss={() => setNotice(undefined)} />}
    {promptNode && projectId && projectRevision && <Suspense fallback={<p role="status">正在打开提示词实验…</p>}><PromptWorkbench projectId={projectId} projectRevision={projectRevision} node={promptNode} context={{ ...fields, production: settings }} models={workspace.models} skills={workspace.skills} groups={workspace.skillGroups} version={version} onClose={() => setPromptNode(undefined)} onApplyPrompt={value => { updateNode(promptNode, { prompt: value.prompt, promptBindings: value.promptBindings, promptTemplate: value.promptTemplate }); }} onOpenOutput={onOpenOutput} onOpenCandidate={onOpenCandidate} /></Suspense>}
    {assistantNode && projectId && projectRevision && <Suspense fallback={<p role="status">正在打开修改预览…</p>}><WorkflowAssistant projectId={projectId} projectRevision={projectRevision} node={assistantNode} models={workspace.models} onClose={() => setAssistantNodeId(undefined)} onApply={(_next, proposal) => {
      const current = resolved.nodes.find(node => node.id === proposal.baseline.id);
      if (!current) throw new Error('任务已移除，请重新选择任务。');
      const next = applyWorkflowProposal({ id: projectId, revision: projectRevision }, current, proposal);
      updateNode(current, { ...next, ...(Object.hasOwn(proposal.patch, 'modelId') ? { config: { ...next.config, modelBinding: 'default', modelOverride: Boolean(next.modelId) } } : {}) });
      setAssistantNodeId(undefined);
    }} /></Suspense>}
  </Dialog>;
}
