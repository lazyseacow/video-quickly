import { lazy, Suspense, useCallback, useId, useRef, useState } from 'react';
import { productionSettingsSchema, resolveProductionWorkflow, type AssetRecord, type ProductionSettings, type ProjectDocument, type RunSummary, type WorkflowDefinition, type WorkflowNode } from '@video-quickly/contracts';
import type { WorkspaceView, StepOutputSelection } from '../lib/types';
import type { ProductionProjectSettings } from '../lib/stage-configuration-draft';
import { matchingStepModels, stepGuidance } from '../lib/workflow-guidance';
import { Button, Combobox, Dialog, Field, Notice, Select } from './Primitives';
import SettingsSections from './SettingsSections';
import VideoSettings from './VideoSettings';
import { ProjectSettingsActions, type ProjectSettingsAction } from './ProjectSettingsPanel';
import ReferenceAudioPicker from './ReferenceAudioPicker';
import './production-settings.css';

const StageRunView = lazy(() => import('../features/StageRunView'));
export interface ProductionConfiguration { nodes: WorkflowNode[]; production: ProductionSettings; project: ProductionProjectSettings; }

export default function ProductionSettingsDialog({ project, workflow, workspace, run, version, initialStage = 'planning', initialNodeId, initialTab, pendingConfiguration, configurationError, onSave, onStart, onDiscardPending, onClose, onOpenOutput, onOpenTool, onSectionChange, onImportReferenceAudio }: {
  project: Pick<ProjectDocument, 'brief' | 'style' | 'profile'>; workflow: WorkflowDefinition; workspace: WorkspaceView; run?: RunSummary; version: number;
  initialStage?: string; initialNodeId?: string; initialTab?: 'settings' | 'run'; pendingConfiguration?: boolean; configurationError?: string;
  onSave: (value: ProductionConfiguration) => Promise<boolean>; onStart: (value: ProductionConfiguration) => Promise<boolean>;
  onDiscardPending?: () => Promise<boolean>; onClose: () => void; onOpenOutput: (value: StepOutputSelection) => void;
  onOpenTool: (action: ProjectSettingsAction) => void; onSectionChange?: (section: string) => void;
  onImportReferenceAudio: (path: string) => Promise<AssetRecord | undefined>;
}) {
  const [settings, setSettings] = useState(() => productionSettingsSchema.parse(workflow.production));
  const [fields, setFields] = useState<ProductionProjectSettings>(() => ({ brief: project.brief, style: project.style, profile: project.profile }));
  const [nodes, setNodes] = useState(workflow.nodes);
  // Configuration omits automatic stages; each view keeps its own selection.
  const [settingsStage, setSettingsStage] = useState(initialStage);
  const [runStage, setRunStage] = useState(initialStage);
  const [selectedTasks, setSelectedTasks] = useState<Record<string, string>>(initialNodeId ? { [initialStage]: initialNodeId } : {});
  const [advancedStage, setAdvancedStage] = useState<string | undefined>(initialNodeId ? initialStage : undefined);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'save' | 'start' | 'discard' | 'tool' | 'import'>();
  const inFlight = useRef(false), closed = useRef(false);
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const active = Boolean(run && ['queued', 'running', 'waiting_review', 'waiting_external', 'retry_scheduled'].includes(run.status));
  const resolved = resolveProductionWorkflow({ ...workflow, nodes, production: settings });
  const stages = resolved.stages ?? resolved.nodes.map(node => ({ id: node.id, label: node.label, description: node.description, nodeIds: [node.id] }));
  const projectSections = [{ id: 'planning', label: '策划与分镜' }, { id: 'materials', label: '素材与配音' }, { id: 'delivery', label: '审阅与导出' }];
  const configurationStages = [...projectSections.map(section => stages.find(item => item.id === section.id) ?? { ...section, nodeIds: section.id === 'delivery' ? resolved.nodes.filter(node => node.kind === 'export').map(node => node.id) : [] }), ...stages.filter(item => !projectSections.some(section => section.id === item.id))]
    .map(item => ({ ...item, configurableNodes: resolved.nodes.filter(node => item.nodeIds.includes(node.id) && stepGuidance(node).capability) }))
    .filter(item => projectSections.some(section => section.id === item.id) || item.configurableNodes.length > 0);
  const configurableNodeIds = configurationStages.flatMap(item => ['planning', 'materials', 'delivery'].includes(item.id) ? item.nodeIds : item.configurableNodes.map(node => node.id));
  const [tab, setTab] = useState(initialTab ?? (configurationStages.some(item => item.id === initialStage) ? 'settings' : 'run'));
  const selectedStage = stages.find(item => item.id === runStage) ?? stages[0];
  function updateSettings(patch: Partial<ProductionSettings>) { setSettings(value => ({ ...value, ...patch })); setError(''); }
  function updateNode(node: WorkflowNode, patch: Partial<WorkflowNode>) { setNodes(current => current.map(item => item.id === node.id ? { ...item, ...patch } : item)); setError(''); }
  const selectSettingsStage = useCallback((value: string) => { setSettingsStage(value); onSectionChange?.(value); }, [onSectionChange]);
  function configureTask(nodeId: string) {
    const target = configurationStages.find(item => item.nodeIds.includes(nodeId));
    selectSettingsStage(target?.id ?? configurationStages[0]?.id ?? 'planning');
    if (target?.configurableNodes.some(node => node.id === nodeId)) {
      setSelectedTasks(current => ({ ...current, [target.id]: nodeId })); setAdvancedStage(target.id);
    }
    setTab('settings');
  }
  function close() { closed.current = true; onClose(); }
  function modelField(label: string, value: string | undefined, models: WorkspaceView['models'], onChange: (value: string | undefined) => void) {
    return <Field label={label}><Combobox displayMode="label" id={`${id}-${label}`} label={label} value={value ?? ''} items={models.map(model => ({ id: model.id, label: model.name }))} placeholder="选择或搜索模型" onChange={value => onChange(value || undefined)} /></Field>;
  }
  async function submit(start: boolean, tool?: ProjectSettingsAction) {
    if (inFlight.current || configurationError) return;
    if (!form.current?.reportValidity()) return;
    const invalid = resolved.nodes.find(node => node.modelId || stepGuidance(node).requiresModel || node.kind === 'animation' && node.config.operation !== 'prepare-edit'
      ? !matchingStepModels(node, workspace.models).some(model => model.id === node.modelId) : false);
    if (start && invalid) { configureTask(invalid.id); setError(`请为「${invalid.label}」选择可用的模型。`); return; }
    inFlight.current = true; setPending(tool ? 'tool' : start ? 'start' : 'save'); setError('');
    try {
      const value = { nodes: resolved.nodes, production: settings, project: fields };
      const saved = await (start ? onStart(value) : onSave(value));
      if (closed.current) return;
      if (saved) { close(); if (tool) onOpenTool(tool); } else setError('操作尚未完成，当前输入已保留，请核对提示后重试。');
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
    try {
      const asset = await onImportReferenceAudio(path);
      return closed.current ? undefined : asset;
    } finally { inFlight.current = false; if (!closed.current) setPending(undefined); }
  }
  return <Dialog title="制作设置" onClose={close} onDismissStart={() => { closed.current = true; }} className="settings-dialog production-settings-dialog">
    <div className="production-settings__views" role="group" aria-label="制作视图"><Button static aria-pressed={tab === 'settings'} onClick={() => setTab('settings')}>制作设置</Button><Button static aria-pressed={tab === 'run'} onClick={() => setTab('run')}>本次制作</Button></div>
    <div className="dialog__body">
      {(pendingConfiguration || active || configurationError || error) && <div className="production-settings__context">
        {active && <p>本次制作使用启动时的设置，保存后用于下次制作。</p>}
        {pendingConfiguration && <Notice><span>已保存待用配置。</span>{onDiscardPending && <Button static disabled={Boolean(pending)} onClick={() => void discard()}>放弃待用配置</Button>}</Notice>}
        {(configurationError || error) && <Notice kind="error">{configurationError || error}</Notice>}
      </div>}
      <form ref={form} hidden={tab !== 'settings'} className="production-settings__form" onSubmit={event => { event.preventDefault(); void submit(false); }}>
        <fieldset disabled={Boolean(pending)} className="production-settings__fieldset">
          <div className="production-settings__models">
            {modelField('文本模型', settings.textModelId, workspace.models.filter(model => model.enabled && model.capabilities.includes('text')), value => updateSettings({ textModelId: value }))}
            {modelField('视频模型', settings.videoModelId, workspace.models.filter(model => model.enabled && model.capabilities.includes('video')), value => updateSettings({ videoModelId: value }))}
          </div>
          <SettingsSections label="制作配置分区" value={settingsStage} onValueChange={selectSettingsStage} sections={configurationStages.map(item => {
            const node = item.configurableNodes.find(node => node.id === selectedTasks[item.id]) ?? item.configurableNodes[0];
            return { id: item.id, label: item.label, content: <>
            {item.id === 'planning' && <><Field label="创作要求"><textarea value={fields.brief} onChange={event => setFields(current => ({ ...current, brief: event.target.value }))} rows={4} placeholder="主题、受众、核心信息和预期时长…" /></Field><Field label="视觉风格"><textarea value={fields.style} onChange={event => setFields(current => ({ ...current, style: event.target.value }))} rows={3} /></Field></>}
            {item.id === 'planning' && <ProjectSettingsActions items={['series', 'saveSeries']} onAction={tool => void submit(false, tool)} />}
            {item.id === 'materials' && <><Field label="参考素材"><Select value={settings.referenceMode} onChange={event => updateSettings({ referenceMode: event.target.value as ProductionSettings['referenceMode'] })}><option value="none">直接文生视频</option><option value="existing">使用已有参考图</option><option value="generate">先生成参考图</option></Select></Field>{settings.referenceMode === 'generate' && modelField('图片模型', settings.imageModelId, workspace.models.filter(model => model.enabled && model.capabilities.includes('image')), value => updateSettings({ imageModelId: value }))}<Field label="声音要求"><textarea value={settings.soundPrompt} onChange={event => updateSettings({ soundPrompt: event.target.value })} rows={4} placeholder="语言、说话方式、环境音与音乐…" /></Field><p className="production-settings__note">视频模型根据分镜台词与声音要求同步生成声音。</p></>}
            {item.id === 'materials' && <ReferenceAudioPicker assets={workspace.assets} value={settings.referenceAudioAssetIds ?? []} onChange={referenceAudioAssetIds => updateSettings({ referenceAudioAssetIds })} onImport={importReferenceAudio} disabled={Boolean(pending)} />}
            {item.id === 'materials' && <ProjectSettingsActions items={['music']} onAction={tool => void submit(false, tool)} />}
            {item.id === 'delivery' && <><Field label="字幕"><Select value={settings.subtitleMode} onChange={event => updateSettings({ subtitleMode: event.target.value === 'script' ? 'script' : 'off' })}><option value="off">关闭</option><option value="script">显示分镜文本（预估时间）</option></Select></Field>{settings.subtitleMode === 'script' && <p className="production-settings__note">字幕使用分镜文本，时间为预估，请核对实际语音。</p>}<VideoSettings mode="production" profile={fields.profile} onChange={profile => setFields(current => ({ ...current, profile }))} /></>}
            {item.id === 'delivery' && <ProjectSettingsActions items={['caption']} onAction={tool => void submit(false, tool)} />}
            {node && <details className="production-settings__advanced" open={advancedStage === item.id} onToggle={event => { const open = event.currentTarget.open; setAdvancedStage(current => open ? item.id : current === item.id ? undefined : current); }}><summary>高级设置</summary>
              {item.configurableNodes.length > 1 && <Field label="任务"><Select value={node.id} onChange={event => { const nodeId = event.target.value; setSelectedTasks(current => ({ ...current, [item.id]: nodeId })); }}>{item.configurableNodes.map(node => <option key={node.id} value={node.id}>{node.label}</option>)}</Select></Field>}
              <div key={node.id} className="production-settings__task" role="group" aria-label={node.label}>
              {stepGuidance(node).capability && <Field label={`${node.label}模型`}><Combobox displayMode="label" id={`${id}-${node.id}-model`} label={`${node.label}模型`} value={node.config.modelOverride === true || node.config.modelBinding !== 'default' ? node.modelId ?? '' : ''} placeholder="跟随统一模型" items={[{ id: '', label: '跟随统一模型' }, ...matchingStepModels(node, workspace.models).map(model => ({ id: model.id, label: model.name }))]} onChange={value => updateNode(node, { modelId: value || undefined, config: { ...node.config, modelBinding: 'default', modelOverride: Boolean(value) } })} /></Field>}
              <Field label={`${node.label}补充要求`}><textarea value={node.prompt} rows={3} onChange={event => updateNode(node, { prompt: event.target.value })} /></Field>
              {workspace.skills.filter(skill => skill.enabled).map(skill => <label className="field-inline" key={skill.id}><input type="checkbox" checked={node.skillIds.includes(skill.id)} onChange={event => updateNode(node, { skillIds: event.target.checked ? [...node.skillIds, skill.id] : node.skillIds.filter(id => id !== skill.id) })} />{skill.name}</label>)}
              </div>
            </details>}
          </> }; })} />
        </fieldset>
      </form>
      {tab === 'run' && <div className="production-settings__run"><SettingsSections label="制作阶段记录" layout="tabs" value={runStage} onValueChange={setRunStage} sections={stages.map(item => ({ id: item.id, label: item.label, content: item.id === selectedStage?.id ? <Suspense fallback={<p role="status">正在读取制作记录…</p>}><StageRunView runId={run?.id} stageId={item.id} nodeIds={item.nodeIds} initialNodeId={initialNodeId} version={version} onOpenOutput={onOpenOutput} configurableNodeIds={configurableNodeIds} onConfigure={configureTask} /></Suspense> : null }))} /></div>}
    </div>
    <div className="dialog__footer"><Button onClick={close}>{tab === 'run' ? '关闭' : '取消'}</Button>{tab === 'settings' && <><Button busy={pending === 'save'} disabled={Boolean(pending || configurationError)} onClick={() => void submit(false)}>{active ? '保存待用配置' : '保存设置'}</Button>{!active && <Button variant="primary" busy={pending === 'start'} disabled={Boolean(pending || configurationError)} onClick={() => void submit(true)}>保存并开始制作</Button>}</>}</div>
  </Dialog>;
}
