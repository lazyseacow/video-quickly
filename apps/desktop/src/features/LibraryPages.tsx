import { pathExample } from '../lib/desktop';
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { BookOpen, Code2, Eye, EyeOff, File, FileImage, FolderOpen, Image, Link, LoaderCircle, Mic, Pencil, Power, RefreshCw, Search, Server, ShieldCheck, Trash2, Video, Upload, Plus, RotateCcw, Download, Check } from 'lucide-react';
import { modelConnectionTypes, getModelConnectionType, validateModelConnection, platformForConnection, modelDiscoverySchema, type ModelDiscovery, type ModelConnectionType, getModelParameterFields, getMediaAdapters, mediaAdapters, textProtocols, textProtocolSchema, type TextProtocol } from '@video-quickly/contracts';
import { assetListItemSchema, projectDetailSchema, recordPageSchema, jsonValueSchema, modelPlatforms, getModelPlatform, modelPlatformSchema, validateModelParameters, type ModelPlatform, type AssetRecord, type AssetListItem, type ProjectSummary, type JsonValue, type ModelCapability, type ModelProfile, type ProjectDocument } from '@video-quickly/contracts';
import { Button, Combobox, Dialog, EmptyState, Field, IconButton, Notice, Status, Select } from '../components/Primitives';
import { ScenePreview } from '../components/ScenePreview';
import type { Action, WorkspaceView, StepOutputSelection } from '../lib/types';
import { useRecordPage } from '../lib/use-record-page';
import { beginGuideAction } from '../lib/guide-actions';
import { useConfirmation } from '../components/ConfirmationDialog';
export { default as RunsPage } from './RunHistory';
const assetsPageSchema = recordPageSchema(assetListItemSchema);
import { getAssetUrl, rpc } from '../lib/client';
import { assetAvailabilityUrl, useAssetAvailability } from '../lib/asset-availability';
import PathPicker, { nativeDesktop, revealFile } from '../components/PathPicker';
import ModelParameters, { modelParameterSections } from '../components/ModelParameters';
import SettingsSections from '../components/SettingsSections';
import PlatformIcon from '../components/PlatformIcon';
import './model-connections.css';
const WorksPanel = lazy(() => import('./WorksPanel'));
const ImageGridDialog = lazy(() => import('../components/ImageGridDialog'));
const AssetRecoveryDialog = lazy(() => import('../components/AssetRecoveryDialog'));

type PageProps = { workspace: WorkspaceView; action: Action };
const capabilityLabels: Record<ModelCapability, string> = { text: '文本问答', image: '图片生成', video: '视频生成', vision: '图片理解', tools: '工具调用', 'structured-output': '结构化输出' };


export function ProjectsPage({ workspace, action, onOpen, onCreate, onOpenOutput }: PageProps & { onOpen: (id: string) => void; onCreate: () => void; onOpenOutput: (value: StepOutputSelection) => void }) {
  const [worksOpen, setWorksOpen] = useState(false);
  const confirm = useConfirmation();
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [importing, setImporting] = useState(false);
  const [backupPath, setBackupPath] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [backingUp, setBackingUp] = useState<string>();
  const [backup, setBackup] = useState<{ title: string; path: string }>();
  const backupInFlight = useRef(false);
  async function archiveProject(project: ProjectSummary) {
    if (!await confirm({ title: '将项目移入回收站？', description: `“${project.title}”将从全部项目中移除。项目与素材会保留，可在回收站恢复。`, confirmLabel: '移入回收站' })) return;
    await action('project.archive', { projectId: project.id }, '项目已移入回收站');
  }
  async function backupProject(project: ProjectSummary) {
    if (backupInFlight.current) return;
    backupInFlight.current = true; setBackingUp(project.id); setBackup(undefined);
    try {
      const result = await action<{ path: string }>('project.backup', { projectId: project.id });
      if (result) setBackup({ title: project.title, path: result.path });
    } finally { backupInFlight.current = false; setBackingUp(undefined); }
  }
  if (worksOpen) return <Suspense fallback={<p role="status">正在读取作品…</p>}><WorksPanel workspace={workspace} onBack={() => setWorksOpen(false)} onOpen={onOpen} onOpenOutput={onOpenOutput} /></Suspense>;
  const projects = workspace.projects.filter(project => project.archived === archived && `${project.title}${project.brief}`.includes(search));
  return <div className="content-page"><div className="page-heading"><div><h1>我的项目</h1></div><div className="heading-actions"><Button onClick={() => setWorksOpen(true)}>作品与分集</Button><Button aria-label="导入项目" onClick={() => setImporting(true)}><Upload size={15} />导入</Button><Button variant="primary" onClick={onCreate}><Plus size={16} />新建项目</Button></div></div><div className="page-toolbar"><div className="search-field"><Search size={16} /><input aria-label="搜索项目" placeholder="搜索项目" value={search} onChange={event => setSearch(event.target.value)} /></div><div className="tabs"><button aria-label="全部项目" className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>全部 <small>{workspace.projects.filter(project => !project.archived).length}</small></button><button className={archived ? 'active' : ''} onClick={() => setArchived(true)}><Trash2 size={13} />回收站</button></div></div>{backup && <Notice kind="success"><span>已备份“{backup.title}”：{backup.path}</span>{nativeDesktop && <Button onClick={() => void revealFile(backup.path)}>打开备份位置</Button>}</Notice>}{projects.length ? <div className="project-cards">{projects.map(project => <article className="project-card" key={project.id}><div className="project-card-preview">{project.thumbnailShot && <ScenePreview project={project} shot={project.thumbnailShot} shotIndex={0} assets={project.thumbnailAsset ? [project.thumbnailAsset] : []} thumbnail />}<span className="pill">{project.templateId === 'history-handdrawn' ? '历史手绘' : '通用视频'}</span></div><div className="project-card-body"><h3>{project.title}</h3>{project.episode && <p className="tiny-meta">作品分集 · 第 {project.episode.number} 集</p>}{!project.episode && project.episodeSource && <p className="tiny-meta">来源：{project.episodeSource.workTitle} · 第 {project.episodeSource.number} 集</p>}<div className="project-card-footer"><span className="tiny-meta">{new Date(project.updatedAt).toLocaleDateString('zh-CN')}</span>{archived ? <Button onClick={() => void action('project.restore', { projectId: project.id }, '项目已恢复')}><RotateCcw size={14} />恢复项目</Button> : <><IconButton label={`备份“${project.title}”`} disabled={Boolean(backingUp)} onClick={() => void backupProject(project)}>{backingUp === project.id ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}</IconButton><IconButton label={`将“${project.title}”移入回收站`} onClick={() => void archiveProject(project)}><Trash2 size={14} /></IconButton><Button data-guide="project-open" onClick={() => onOpen(project.id)}>继续创作</Button></>}</div></div></article>)}</div> : <EmptyState icon={<FolderOpen size={25} />} title={archived ? '回收站为空' : search ? '没有找到这个项目' : '开始你的第一个视频'} description={archived ? '移入回收站的项目会保留素材，随时可以恢复。' : search ? '试试其他关键词。' : '填写主题，选择视频规格，再逐步完成分镜和画面。'}>{!archived && !search && <Button variant="primary" onClick={onCreate}><Plus size={15} />新建项目</Button>}</EmptyState>}{importing && <Dialog title="导入项目备份" onClose={() => setImporting(false)}><form onSubmit={event => { event.preventDefault(); setImportBusy(true); void action<ProjectDocument>('project.importBackup', { path: backupPath }, '项目备份已导入').then(result => { setImportBusy(false); if (result) { setImporting(false); onOpen(result.id); } }); }}><div className="dialog__body"><Field label="项目备份路径" hint="选择备份目录或 project.json。"><PathPicker label="项目备份路径" mode="directory" autoFocus required value={backupPath} onChange={setBackupPath} placeholder={pathExample('backup')} /></Field><p className="tiny-meta">将创建独立项目，并校验和复制备份素材。</p></div><div className="dialog__footer"><Button onClick={() => setImporting(false)}>取消</Button><Button aria-label="导入备份" type="submit" variant="primary" busy={importBusy}><Upload size={15} />导入</Button></div></form></Dialog>}</div>;
}

export function ModelsPage({ workspace, action, repairModelId, onRepairConsumed }: PageProps & { repairModelId?: string; onRepairConsumed?: () => void }) {
  const confirm = useConfirmation();
  const [editing, setEditing] = useState<ModelProfile | ModelConnectionType | null>(null);
  const [choosingType, setChoosingType] = useState(false);
  const [filter, setFilter] = useState<ModelConnectionType | 'all'>('all');
  const [repairError, setRepairError] = useState('');
  useEffect(() => {
    if (!repairModelId) return;
    if (editing) {
      if (typeof editing === 'object' && editing.id === repairModelId) onRepairConsumed?.();
      return;
    }
    const model = workspace.models.find(model => model.id === repairModelId);
    if (model) { setFilter('all'); setEditing(model); setRepairError(''); }
    else setRepairError('待修复的模型连接已移除，请重新检查项目并选择其他连接。');
    onRepairConsumed?.();
  }, [repairModelId, workspace.models, editing, onRepairConsumed]);
  const models = workspace.models.filter(model => (filter === 'all' || getModelConnectionType(model) === filter));
  function addModel() { if (filter !== 'all') setEditing(filter); else setChoosingType(true); }
  async function removeModel(model: ModelProfile) {
    if (!await confirm({ title: '移除模型连接？', description: `将移除“${model.name}”及其已保存的 API Key。使用此连接的任务需要重新配置模型，此操作无法撤销。`, confirmLabel: '确认移除' })) return;
    await action('model.delete', { modelId: model.id }, '模型已移除');
  }
  return <div className="content-page">
    <div className="page-heading"><div><h1>模型连接</h1><p>配置文本、图片和视频模型。</p></div><Button data-guide="model-connection" aria-label="添加模型" variant="primary" onClick={addModel}><Plus size={16} />添加</Button></div>
    <div className="page-toolbar"><div className="tabs model-type-tabs" role="group" aria-label="模型类型筛选">
      <button type="button" className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</button>
      {modelConnectionTypes.map(type => <button type="button" key={type.id} className={filter === type.id ? 'active' : ''} aria-pressed={filter === type.id} onClick={() => setFilter(type.id)}>{type.label}</button>)}
    </div><span className="tiny-meta">{models.length} 个连接</span></div>
    {repairError && <Notice kind="error">{repairError}</Notice>}
    <div className="model-connections-list">{models.length ? models.map(model => {
      const category = getModelConnectionType(model);
      const label = modelConnectionTypes.find(type => type.id === category)!.label;
      return <article className="list-card" key={model.id}><div className="list-card__icon"><PlatformIcon platform={getModelPlatform(model).id} /></div><div className="list-card__body"><h3>{model.name}</h3><p>{getModelPlatform(model).label} · {model.model}</p><div className="pill-row"><span className="pill">{label}</span>{model.capabilities.map(capability => <span className="pill" key={capability}>{capabilityLabels[capability]}</span>)}</div></div><div className="list-card__actions"><IconButton label={`检查“${model.name}”连接`} onClick={() => void action('model.test', { modelId: model.id }, '连接检查完成')}><RefreshCw size={16} /></IconButton><IconButton label={`编辑“${model.name}”`} onClick={() => setEditing(model)}><Pencil size={16} /></IconButton><IconButton label={`移除“${model.name}”`} onClick={() => void removeModel(model)}><Trash2 size={16} /></IconButton></div></article>;
    }) : <div className="section-card"><EmptyState icon={<Server size={25} />} title={filter === 'all' ? '连接你的第一个模型' : '还没有此类模型'} description="选择类型并填写连接信息。" /></div>}</div>
    {choosingType && <Dialog title="选择模型类型" onClose={() => setChoosingType(false)} className="model-type-picker"><div className="dialog__body model-type-grid">{modelConnectionTypes.map(type => {
      const Icon = type.id === 'text' ? Server : type.id === 'image' ? Image : Video;
      return <Button static variant="ghost" className="model-type-choice" key={type.id} onClick={() => { setChoosingType(false); setEditing(type.id); }}><Icon size={22} /><span><strong>{type.label}</strong><small>{type.description}</small></span></Button>;
    })}</div></Dialog>}
    {editing && <ModelDialog key={typeof editing === 'string' ? editing : editing.id} model={typeof editing === 'string' ? undefined : editing} connectionType={typeof editing === 'string' ? editing : undefined} action={action} onClose={() => setEditing(null)} />}
  </div>;
}

function ModelDialog({ model, connectionType: addingType = 'text', action, onClose }: { model?: ModelProfile; connectionType?: ModelConnectionType; action: Action; onClose: () => void }) {
  const connectionType = model ? getModelConnectionType(model) : addingType;
  const definition = modelConnectionTypes.find(type => type.id === connectionType)!;
  const [name, setName] = useState(model?.name ?? '');
  const [platform, setPlatform] = useState<ModelPlatform>(model ? getModelPlatform(model).id : 'openai');
  const [provider, setProvider] = useState<ModelProfile['provider']>(model?.provider ?? 'openai-compatible');
  const [textProtocol, setTextProtocol] = useState<TextProtocol>(model?.textProtocol ?? 'chat-completions');
  const preset = platformForConnection(platform, connectionType);
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? 'https://api.openai.com/v1');
  const [modelId, setModelId] = useState(model?.model ?? '');
  const [secret, setSecret] = useState('');
  const secretValue = secret.trim();
  const [secretVisible, setSecretVisible] = useState(false);
  const secretId = useId();
  const modelInputId = useId();
  const addressErrorId = useId();
  const baseUrlInput = useRef<HTMLInputElement>(null), secretInput = useRef<HTMLInputElement>(null);
  const [section, setSection] = useState('connection');
  const [capabilities, setCapabilities] = useState<ModelCapability[]>([...definition.capabilities]);
  const [busy, setBusy] = useState(false);
  const [parametersText, setParametersText] = useState(JSON.stringify(model?.parameters ?? {}, null, 2));
  const [saveError, setSaveError] = useState('');
  const closed = useRef(false);
  useEffect(() => { closed.current = false; return () => { closed.current = true; }; }, []);
  function close() { closed.current = true; onClose(); }
  const [discoveryResult, setDiscoveryResult] = useState<{ key: string; catalog: ModelDiscovery }>();
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<{ field: 'address' | 'secret'; message: string }>();
  const discoveryGeneration = useRef(0);
  const discoveryKey = JSON.stringify([baseUrl, secretValue, provider, platform, connectionType, textProtocol, capabilities]);
  const [savedDiscoveryKey] = useState(discoveryKey);
  const discovery = discoveryResult?.key === discoveryKey ? discoveryResult.catalog : undefined;
  const modelItems = discovery?.items ?? (model && discoveryKey === savedDiscoveryKey ? [{ id: model.model, label: model.model }] : []);
  const selectedModelId = modelItems.some(item => item.id === modelId) ? modelId : '';
  let serviceUrl: URL | undefined;
  try { serviceUrl = new URL(baseUrl); } catch { /* An incomplete address is expected while editing. */ }
  const keyOptional = ['ollama', 'comfyui'].includes(provider) || Boolean(serviceUrl && ['localhost', '127.0.0.1', '[::1]'].includes(serviceUrl.hostname));
  const hasSavedSecret = Boolean(model?.hasSecret);
  useEffect(() => {
    discoveryGeneration.current++;
    setDiscoveryResult(undefined); setDiscovering(false); setDiscoveryError(undefined);
    return () => { discoveryGeneration.current++; };
  }, [discoveryKey]);
  function validateDiscoveryInputs() {
    const error = !baseUrl.trim() ? { field: 'address' as const, message: '请填写服务地址。' }
      : !serviceUrl || !['http:', 'https:'].includes(serviceUrl.protocol) || serviceUrl.username || serviceUrl.password ? { field: 'address' as const, message: '请填写有效的 HTTP 或 HTTPS 服务地址。' }
      : !keyOptional && !secretValue && !hasSavedSecret ? { field: 'secret' as const, message: '请填写 API Key 后获取模型列表。' } : undefined;
    setDiscoveryError(error);
    if (!error) return true;
    setSection('connection');
    requestAnimationFrame(() => (error.field === 'address' ? baseUrlInput : secretInput).current?.focus());
    return false;
  }
  async function discover() {
    if (busy || discovering || !validateDiscoveryInputs()) return;
    const generation = ++discoveryGeneration.current;
    setDiscovering(true);
    try {
      const value = await rpc('model.discover', { model: { id: model?.id, provider, platform, connectionType, textProtocol, baseUrl, capabilities }, reuseSavedSecret: hasSavedSecret, ...(secretValue ? { secret: secretValue } : {}) });
      if (closed.current || generation !== discoveryGeneration.current) return;
      const result = modelDiscoverySchema.parse(value); setDiscoveryResult({ key: discoveryKey, catalog: result });
      if (result.source === 'workflow') setModelId('workflow');
    } catch {
      if (!closed.current && generation === discoveryGeneration.current) setDiscoveryResult({ key: discoveryKey, catalog: { source: 'remote', items: [], message: '模型读取失败，请重试。' } });
    } finally {
      if (!closed.current && generation === discoveryGeneration.current) setDiscovering(false);
    }
  }
  let parameters: Record<string, JsonValue> = {}, jsonError = '', parameterError = '';
  try {
    const parsed = jsonValueSchema.parse(JSON.parse(parametersText));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数需要填写 JSON 对象。');
    parameters = parsed;
  } catch (error) { jsonError = error instanceof Error ? error.message : '参数 JSON 格式不正确。'; }
  if (!jsonError) {
    try { validateModelConnection({ connectionType, provider, capabilities }); validateModelParameters({ provider, capabilities, textProtocol, parameters }); }
    catch (error) { parameterError = error instanceof Error ? error.message : String(error); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaveError('');
    if (jsonError || parameterError || !selectedModelId || discovering || !validateDiscoveryInputs()) return;
    const completed = beginGuideAction('model-saved');
    setBusy(true);
    const result = await action('model.save', { model: { ...model, connectionType, name, platform, provider, ...(capabilities.includes('text') ? { textProtocol } : {}), baseUrl, model: selectedModelId, capabilities, parameters }, ...(secretValue ? { secret: secretValue } : {}) }, '模型连接已保存');
    if (closed.current) return;
    setBusy(false);
    if (result !== null) { completed(); onClose(); } else setSaveError('连接尚未保存，请核对提示后重试。');
  }
  const parameterFields = getModelParameterFields({ provider, capabilities, textProtocol });
  const changeParameters = (value: Record<string, JsonValue>) => { setParametersText(JSON.stringify(value, null, 2)); setSaveError(''); };
  function changeTextProtocol(next: TextProtocol) {
    setTextProtocol(next);
    const maximum = parameters.max_tokens ?? parameters.max_completion_tokens ?? parameters.max_output_tokens;
    if (maximum !== undefined) {
      const updated = { ...parameters };
      delete updated.max_tokens; delete updated.max_completion_tokens; delete updated.max_output_tokens;
      updated[next === 'responses' ? 'max_output_tokens' : 'max_tokens'] = maximum;
      changeParameters(updated);
    }
  }
  const mediaCapabilities = capabilities.filter(capability => ['image', 'video'].includes(capability));
  const adapters = platform === 'custom' ? getMediaAdapters(capabilities) : mediaAdapters.filter(adapter => adapter.id === provider);
  const platforms = modelPlatforms.filter(item => definition.platforms.includes(item.id));
  return <Dialog title={model ? '编辑模型连接' : `添加${definition!.label}`} onClose={close} onDismissStart={() => { closed.current = true; }} className="model-connection-dialog settings-dialog"><form onSubmit={event => void save(event)}>
    <div className="dialog__body"><SettingsSections label="模型连接设置" value={section} onValueChange={setSection} sections={[
      { id: 'connection', label: '基本连接', icon: Server, content: <><h3>基本连接</h3>
      {model && <div className="model-connection-type"><span className="pill">{definition!.label}</span><span>{definition.description}</span></div>}
      <div className="model-connection-fields"><Field label="连接名称"><input required autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="例如：本地分镜助手" /></Field>
      <Field label="模型平台"><Select value={platform} disabled={busy} onChange={event => {
        const selected = platformForConnection(modelPlatformSchema.parse(event.target.value), connectionType);
        setPlatform(selected.id); setProvider(selected.provider); setBaseUrl(selected.baseUrl);
        if (!jsonError) changeTextProtocol(selected.textProtocol ?? 'chat-completions');
        else setTextProtocol(selected.textProtocol ?? 'chat-completions');
        setCapabilities([...definition.capabilities]);
      }}>{platforms.map(item => <option key={item.id} value={item.id}><span className="platform-option"><PlatformIcon platform={item.id} /><span>{platformForConnection(item.id, connectionType).label}</span></span></option>)}</Select></Field>
      {capabilities.includes('text') && <Field label="API 协议"><Select value={provider === 'ollama' ? 'ollama' : textProtocol} disabled={busy || Boolean(jsonError) || provider === 'ollama'} onChange={event => changeTextProtocol(textProtocolSchema.parse(event.target.value))}>{provider === 'ollama' ? <option value="ollama">Ollama 原生 API</option> : textProtocols.map(protocol => <option key={protocol.id} value={protocol.id}>{protocol.label}</option>)}</Select></Field>}
      {mediaCapabilities.length > 0 && <Field label="API 协议"><Select value={provider} disabled={busy || platform !== 'custom'} onChange={event => setProvider(event.target.value as ModelProfile['provider'])}>{!adapters.some(adapter => adapter.id === provider) && <option value={provider} disabled>{mediaAdapters.find(adapter => adapter.id === provider)?.label ?? '当前接入方式'}</option>}{adapters.map(adapter => <option key={adapter.id} value={adapter.id}>{adapter.id === 'openai-compatible' ? connectionType === 'image' ? 'OpenAI Images API' : 'OpenAI Videos API' : adapter.label}</option>)}</Select></Field>}
      <Field label="服务地址" hint={preset.addressHint}><input ref={baseUrlInput} required type="url" aria-invalid={discoveryError?.field === 'address' || undefined} aria-describedby={discoveryError?.field === 'address' ? addressErrorId : undefined} value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder={preset.addressPlaceholder} spellCheck={false} /></Field></div>
      {discoveryError?.field === 'address' && <p id={addressErrorId} className="field-error" role="alert">{discoveryError.message}</p>}
      <div className="field"><label className="field__label" htmlFor={secretId}>API Key</label><div className="model-secret-input"><input ref={secretInput} id={secretId} type={secretVisible ? 'text' : 'password'} autoComplete="new-password" autoCapitalize="none" spellCheck={false} aria-required={!keyOptional && !hasSavedSecret || undefined} aria-invalid={discoveryError?.field === 'secret' || undefined} aria-describedby={`${secretId}-hint`} value={secret} onChange={event => setSecret(event.target.value)} placeholder={hasSavedSecret ? '••••••••••••' : '输入密钥'} /><IconButton label={secretVisible ? '隐藏密钥' : '显示密钥'} aria-pressed={secretVisible} aria-controls={secretId} disabled={!secret} onClick={() => setSecretVisible(value => !value)}>{secretVisible ? <EyeOff size={16} /> : <Eye size={16} />}</IconButton></div><span id={`${secretId}-hint`} className={discoveryError?.field === 'secret' ? 'field-error' : 'field__hint'} role={discoveryError?.field === 'secret' ? 'alert' : undefined}>{discoveryError?.field === 'secret' ? discoveryError.message : hasSavedSecret ? '已保存密钥；留空保留原值。' : keyOptional ? '免鉴权服务可留空。' : '请填写服务的 API Key。'}</span></div>
      <div className="model-discovery"><div className="field"><label className="field__label" htmlFor={modelInputId}>{'模型 ID'}</label>
        <Combobox id={modelInputId} label={'模型 ID'} descriptionId={`${modelInputId}-hint`} required value={selectedModelId} items={modelItems} disabled={busy || discovering || !modelItems.length || discovery?.source === 'workflow'} placeholder={discovering ? '正在读取模型…' : !modelItems.length ? discovery ? '暂无可用模型' : '请先获取模型列表' : '选择模型，可输入搜索'} onChange={setModelId} action={<IconButton label="获取模型列表" disabled={busy || discovering} aria-busy={discovering || undefined} onClick={() => void discover()}>{discovering ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}</IconButton>} />
      </div><p id={`${modelInputId}-hint`} className="field__hint" role="status">{discovering ? '正在读取模型列表…' : discovery?.message ?? '点击右侧按钮获取模型列表。'}</p></div>

      </> },
      ...modelParameterSections.filter(section => parameterFields.some(field => field.operation === section.id)).map(section => ({ id: section.id, label: section.label, content: <ModelParameters operation={section.id} provider={provider} textProtocol={textProtocol} capabilities={capabilities} value={parameters} disabled={busy || Boolean(jsonError)} onChange={changeParameters} /> })),
      { id: 'advanced', label: '高级设置', icon: Code2, content: <><h3>高级模型参数</h3><Field label="参数 JSON" hint="与表单同步，保留未知字段。ComfyUI 填写 workflow/inputMapping；自定义 HTTP 填写请求和响应映射。"><textarea rows={12} aria-label="模型参数 JSON" spellCheck={false} value={parametersText} disabled={busy} onChange={event => { setParametersText(event.target.value); setSaveError(''); }} /></Field></> },
    ]} notice={<>
      {(jsonError || parameterError) && <p role="alert" className="field-error">{jsonError || parameterError}</p>}
      {saveError && <p role="alert" className="field-error">{saveError}</p>}
    </>} /></div>
    <div className="dialog__footer"><Button onClick={close}>取消</Button><Button aria-label="保存连接" variant="primary" type="submit" busy={busy} disabled={!selectedModelId || discovering || !capabilities.length || Boolean(jsonError || parameterError)}>保存</Button></div>
  </form></Dialog>;
}

export { default as SkillsPage } from './SkillStudio';

export function AssetsPage({ workspace, action, project }: PageProps & { project?: ProjectDocument }) {
  const [importing, setImporting] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [source, setSource] = useState('');
  const [filter, setFilter] = useState('all');
  const library = useRecordPage('asset.list', filter === 'all' ? {} : { kind: filter }, workspace.version, assetsPageSchema, workspace.assetsVersion);
  const assets = library.items;
  return <div className="content-page"><div className="page-heading"><div><h1>素材库</h1></div><div className="heading-actions"><Button aria-label="恢复缺失素材" onClick={() => setRecovering(true)}><RotateCcw size={15} />恢复缺失素材</Button><Button aria-label="导入素材" variant="primary" onClick={() => setImporting(true)}><Upload size={15} />导入</Button></div></div><div className="page-toolbar"><div className="tabs">{[['all', '全部'], ['image', '图片'], ['video', '视频'], ['audio', '音频'], ['document', '资料']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><span className="tiny-meta">{assets.length} 个素材</span></div>{library.error && <Notice kind="error">{library.error}<Button aria-label="重试读取素材" onClick={library.refresh}>重试</Button></Notice>}{assets.length ? <div className="asset-grid">{assets.map(asset => <AssetCard key={asset.id} asset={asset} action={action} projects={workspace.projects.filter(item => !item.archived)} initialProject={project} />)}</div> : <div className="section-card"><EmptyState icon={<Image size={25} />} title="把素材带进工作台" description="导入自有或已授权的图片、视频、音频和资料。" /></div>}{library.nextCursor !== null && <Button aria-label="加载更多素材" className="button-full" busy={library.loadingMore} disabled={!library.canLoadMore} onClick={() => void library.loadMore()}>加载更多</Button>}{importing && <Dialog title="导入本地素材" onClose={() => setImporting(false)}><form onSubmit={event => { event.preventDefault(); void action('asset.import', { path: source, projectId: project?.id }, '素材已导入').then(result => { if (result !== null) { setImporting(false); setSource(''); } }); }}><div className="dialog__body"><Field label="文件路径"><PathPicker label="文件路径" autoFocus required value={source} onChange={setSource} placeholder={pathExample('image')} /></Field><p className="tiny-meta">请使用自己创作或已获授权的素材。源文件会保留。</p></div><div className="dialog__footer"><Button onClick={() => setImporting(false)}>取消</Button><Button variant="primary" type="submit"><Upload size={15} />导入</Button></div></form></Dialog>}{recovering && <Suspense fallback={null}><AssetRecoveryDialog project={project} directory={workspace.system.dataDirectory} onClose={() => setRecovering(false)} /></Suspense>}</div>;
}

function AssetCard({ asset, action, projects, initialProject }: { asset: AssetListItem; action: Action; projects: ProjectSummary[]; initialProject?: ProjectDocument }) {
  const [cuttingGrid, setCuttingGrid] = useState(false);
  const confirm = useConfirmation();
  async function removeAsset() {
    if (!await confirm({ title: '移除素材记录？', description: `“${asset.name}”将从素材库中移除，素材文件会保留。需要再次使用时可重新导入。`, confirmLabel: '确认移除' })) return;
    await action('asset.delete', { assetId: asset.id }, '素材记录已移除');
  }
  const availability = useAssetAvailability(asset.id);
  const [image, setImage] = useState<string>();
  const [error, setError] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [projectId, setProjectId] = useState(initialProject?.id ?? projects[0]?.id ?? '');
  const [shotId, setShotId] = useState('');
  const [target, setTarget] = useState<ProjectDocument>();
  const [targetError, setTargetError] = useState('');
  useEffect(() => {
    let active = true;
    setError(false); setImage(undefined);
    if (asset.kind === 'image') void getAssetUrl(asset.path).then(url => { if (active) setImage(assetAvailabilityUrl(url, asset.id)); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [asset.kind, asset.path, availability]);
  useEffect(() => {
    if (!selecting || !projectId) return;
    let active = true; setTarget(undefined); setTargetError('');
    void rpc('project.get', { projectId }).then(value => {
      const project = projectDetailSchema.parse(value).project;
      if (active) { setTarget(project); setShotId(project?.shots[0]?.id ?? ''); }
    }).catch(error => { if (active) setTargetError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [selecting, projectId]);
  const used = asset.inUse;
  const media = ['image', 'audio', 'video'].includes(asset.kind);
  const Icon = asset.kind === 'image' ? FileImage : asset.kind === 'video' ? Video : asset.kind === 'audio' ? Mic : File;
  async function apply() {
    if (!target || !shotId) return;
    const shot = target.shots.find(shot => shot.id === shotId);
    const previous = asset.kind === 'video' ? shot?.videoAssetId : asset.kind === 'audio' ? shot?.audioAssetId : shot?.assetId;
    if (shot && (previous && previous !== asset.id || shot.clipEdit || asset.kind !== 'audio' && shot.sceneTemplate) && !await confirm({ title: '替换镜头素材？', description: `将把“${asset.name}”应用到“${target.title}”的镜头“${shot.title}”，替换对应的素材关联及剪辑设置。原素材文件会保留。`, confirmLabel: '确认替换', variant: 'primary' })) return;
    const value = asset.projectId && asset.projectId !== target.id
      ? await action('asset.import', { path: asset.path, projectId: target.id, shotId }, '素材已复制并应用到镜头')
      : await action('asset.select', { assetId: asset.id, projectId: target.id, shotId, revision: target.revision }, '素材已应用到镜头');
    if (value !== null) setSelecting(false);
  }
  return <article className="asset-card"><div className="asset-card__preview">{image && !error ? <img src={image} alt={asset.name} loading="lazy" decoding="async" onError={() => setError(true)} /> : <Icon size={31} role={error ? 'img' : undefined} aria-label={error ? `无法预览“${asset.name}”` : undefined} />}</div><h3>{asset.name}</h3>{asset.provenance && asset.provenance !== '用户导入' && <p>{asset.provenance}</p>}<div className="asset-card-footer"><span className="tiny-meta">{asset.size < 1024 * 1024 ? `${Math.round(asset.size / 1024)} KB` : `${(asset.size / (1024 * 1024)).toFixed(1)} MB`}{used ? ' · 使用中' : ''}</span><div className="asset-actions">{asset.kind === 'image' && <IconButton label={`网格切图“${asset.name}”`} onClick={() => setCuttingGrid(true)}><FileImage size={15} /></IconButton>}{media && <IconButton label={`将“${asset.name}”用于镜头`} onClick={() => { setSelecting(true); setShotId(target?.shots[0]?.id ?? ''); }}><Link size={15} /></IconButton>}<IconButton label={asset.retained ? '取消保留此版本' : '保留此版本'} aria-pressed={asset.retained} onClick={() => void action('asset.retain', { assetId: asset.id, retained: !asset.retained }, asset.retained ? '已取消保留' : '此版本已保留')}><ShieldCheck size={15} /></IconButton><IconButton label={`移除素材“${asset.name}”`} disabled={used || asset.retained} onClick={() => void removeAsset()}><Trash2 size={15} /></IconButton></div></div>{selecting && <Dialog title="应用素材到镜头" onClose={() => setSelecting(false)}><div className="dialog__body"><p>{asset.name}</p>{targetError && <Notice kind="error">{targetError}</Notice>}<Field label="目标项目"><Select value={projectId} onChange={event => { setProjectId(event.target.value); setShotId(''); }}><option value="" disabled>选择项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</Select></Field><Field label="目标镜头"><Select value={shotId} onChange={event => setShotId(event.target.value)}><option value="" disabled>选择镜头</option>{target?.shots.map((shot, index) => <option key={shot.id} value={shot.id}>{index + 1}. {shot.title}</option>)}</Select></Field>{asset.projectId && asset.projectId !== target?.id && <Notice>素材将复制到目标项目，源项目保持独立。</Notice>}</div><div className="dialog__footer"><Button onClick={() => setSelecting(false)}>取消</Button><Button aria-label="应用此版本" variant="primary" disabled={!target || !shotId} onClick={() => void apply()}><Check size={14} />应用</Button></div></Dialog>}{cuttingGrid && <Suspense fallback={null}><ImageGridDialog asset={asset} onClose={() => setCuttingGrid(false)} /></Suspense>}</article>;
}
