import { useEffect, useId, useRef, useState } from 'react';
import { BookOpen, Code2, Eye, EyeOff, File, FileImage, FolderOpen, Image, Link, LoaderCircle, Mic, Pencil, Power, RefreshCw, Search, Server, ShieldCheck, Trash2, Video, Upload, Plus, RotateCcw, Download, Check } from 'lucide-react';
import { modelConnectionTypes, getModelConnectionType, getModelCapabilities, validateModelConnection, platformForConnection, modelDiscoverySchema, getModelVoiceCatalog, supportsAccountVoices, voiceDiscoverySchema, type VoiceDiscovery, type ModelDiscovery, type ModelConnectionType, getModelParameterFields, getMediaAdapters, mediaAdapters, textProtocols, textProtocolSchema, type TextProtocol } from '@video-quickly/contracts';
import { assetListItemSchema, projectDetailSchema, recordPageSchema, jsonValueSchema, modelPlatforms, getModelPlatform, modelPlatformSchema, validateModelParameters, type ModelPlatform, type AssetRecord, type AssetListItem, type ProjectSummary, type JsonValue, type ModelCapability, type ModelProfile, type ProjectDocument, type SkillPackage } from '@video-quickly/contracts';
import { Button, Dialog, EmptyState, Field, IconButton, Notice, Status, formatTime, Select } from '../components/Primitives';
import { ScenePreview } from '../components/ScenePreview';
import type { Action, WorkspaceView } from '../lib/types';
import { useRecordPage } from '../lib/use-record-page';
export { default as RunsPage } from './RunHistory';
const assetsPageSchema = recordPageSchema(assetListItemSchema);
import { getAssetUrl, rpc } from '../lib/client';
import ToolConnections from './ToolConnections';
import PathPicker from '../components/PathPicker';
import ModelParameters, { modelParameterSections } from '../components/ModelParameters';
import SettingsSections from '../components/SettingsSections';
import PlatformIcon from '../components/PlatformIcon';
import './model-connections.css';

type PageProps = { workspace: WorkspaceView; action: Action };
const capabilityLabels: Record<ModelCapability, string> = { text: '文本问答', image: '图片生成', video: '视频生成', tts: '配音生成', asr: '语音识别', vision: '图片理解', tools: '工具调用', 'structured-output': '结构化输出' };

export function ProjectsPage({ workspace, action, onOpen, onCreate }: PageProps & { onOpen: (id: string) => void; onCreate: () => void }) {
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [importing, setImporting] = useState(false);
  const [backupPath, setBackupPath] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const projects = workspace.projects.filter(project => project.archived === archived && `${project.title}${project.brief}`.includes(search));
  return <div className="content-page"><div className="page-heading"><div><h1>我的项目</h1></div><div className="heading-actions"><Button aria-label="导入项目" onClick={() => setImporting(true)}><Upload size={15} />导入</Button><Button variant="primary" onClick={onCreate}><Plus size={16} />新建项目</Button></div></div><div className="page-toolbar"><div className="search-field"><Search size={16} /><input aria-label="搜索项目" placeholder="搜索项目" value={search} onChange={event => setSearch(event.target.value)} /></div><div className="tabs"><button aria-label="全部项目" className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>全部 <small>{workspace.projects.filter(project => !project.archived).length}</small></button><button className={archived ? 'active' : ''} onClick={() => setArchived(true)}><Trash2 size={13} />回收站</button></div></div>{projects.length ? <div className="project-cards">{projects.map(project => <article className="project-card" key={project.id}><div className="project-card-preview">{project.thumbnailShot && <ScenePreview project={project} shot={project.thumbnailShot} shotIndex={0} assets={project.thumbnailAsset ? [project.thumbnailAsset] : []} thumbnail />}<span className="pill">{project.templateId === 'history-handdrawn' ? '历史手绘' : '通用视频'}</span></div><div className="project-card-body"><h3>{project.title}</h3><p>{project.shotCount} 个镜头 · {formatTime(project.durationUs).split('.')[0]} · {project.profile.width} × {project.profile.height}</p><div className="project-card-footer"><span className="tiny-meta">{new Date(project.updatedAt).toLocaleDateString('zh-CN')}</span>{archived ? <Button onClick={() => void action('project.restore', { projectId: project.id }, '项目已恢复')}><RotateCcw size={14} />恢复项目</Button> : <><IconButton label={`将“${project.title}”移入回收站`} onClick={() => void action('project.archive', { projectId: project.id }, '项目已移入回收站')}><Trash2 size={14} /></IconButton><Button onClick={() => onOpen(project.id)}>继续创作</Button></>}</div></div></article>)}</div> : <EmptyState icon={<FolderOpen size={25} />} title={archived ? '回收站为空' : search ? '没有找到这个项目' : '开始你的第一个视频'} description={archived ? '移入回收站的项目会保留素材，随时可以恢复。' : search ? '试试其他关键词。' : '填写主题，选择视频规格，再逐步完成分镜和画面。'}>{!archived && !search && <Button variant="primary" onClick={onCreate}><Plus size={15} />新建项目</Button>}</EmptyState>}{importing && <Dialog title="导入项目备份" onClose={() => setImporting(false)}><form onSubmit={event => { event.preventDefault(); setImportBusy(true); void action<ProjectDocument>('project.importBackup', { path: backupPath }, '项目备份已导入').then(result => { setImportBusy(false); if (result) { setImporting(false); onOpen(result.id); } }); }}><div className="dialog__body"><Field label="项目备份路径" hint="选择备份目录或 project.json。"><PathPicker label="项目备份路径" mode="directory" autoFocus required value={backupPath} onChange={setBackupPath} placeholder="D:\Backups\我的视频项目" /></Field><p className="tiny-meta">将创建独立项目，并校验和复制备份素材。</p></div><div className="dialog__footer"><Button onClick={() => setImporting(false)}>取消</Button><Button aria-label="导入备份" type="submit" variant="primary" busy={importBusy}><Upload size={15} />导入</Button></div></form></Dialog>}</div>;
}

export function ModelsPage({ workspace, action }: PageProps) {
  const [editing, setEditing] = useState<ModelProfile | ModelConnectionType | null>(null);
  const [choosingType, setChoosingType] = useState(false);
  const [filter, setFilter] = useState<ModelConnectionType | 'all'>('all');
  const models = workspace.models.filter(model => filter === 'all' || getModelConnectionType(model) === filter);
  function addModel() { if (filter !== 'all') setEditing(filter); else setChoosingType(true); }
  return <div className="content-page">
    <div className="page-heading"><div><h1>模型连接</h1><p>分别配置文本、图片、视频与音频服务。</p></div><Button aria-label="添加模型" variant="primary" onClick={addModel}><Plus size={16} />添加</Button></div>
    <div className="page-toolbar"><div className="tabs model-type-tabs" role="group" aria-label="模型类型筛选">
      <button type="button" className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</button>
      {modelConnectionTypes.map(type => <button type="button" key={type.id} className={filter === type.id ? 'active' : ''} aria-pressed={filter === type.id} onClick={() => setFilter(type.id)}>{type.label}</button>)}
    </div><span className="tiny-meta">{models.length} 个连接</span></div>
    <div className="model-connections-list">{models.length ? models.map(model => {
      const category = getModelConnectionType(model);
      const label = modelConnectionTypes.find(type => type.id === category)!.label;
      return <article className="list-card" key={model.id}><div className="list-card__icon"><PlatformIcon platform={getModelPlatform(model).id} /></div><div className="list-card__body"><h3>{model.name}</h3><p>{getModelPlatform(model).label} · {model.model}</p><div className="pill-row"><span className="pill">{label}</span>{model.capabilities.map(capability => <span className="pill" key={capability}>{capabilityLabels[capability]}</span>)}</div></div><div className="list-card__actions"><IconButton label={`检查“${model.name}”连接`} onClick={() => void action('model.test', { modelId: model.id }, ['volcengine-tts', 'volcengine-asr'].includes(model.provider) ? '语音配置已核对，实际连接将在任务中验证。' : '连接检查完成')}><RefreshCw size={16} /></IconButton><IconButton label={`编辑“${model.name}”`} onClick={() => setEditing(model)}><Pencil size={16} /></IconButton><IconButton label={`移除“${model.name}”`} onClick={() => void action('model.delete', { modelId: model.id }, '模型已移除')}><Trash2 size={16} /></IconButton></div></article>;
    }) : <div className="section-card"><EmptyState icon={<Server size={25} />} title={filter === 'all' ? '连接你的第一个模型' : '还没有此类模型'} description="选择类型并填写连接信息。" /></div>}</div>
    {choosingType && <Dialog title="选择模型类型" onClose={() => setChoosingType(false)} className="model-type-picker"><div className="dialog__body model-type-grid">{modelConnectionTypes.map(type => {
      const Icon = type.id === 'text' ? Server : type.id === 'image' ? Image : type.id === 'video' ? Video : Mic;
      return <Button static variant="ghost" className="model-type-choice" key={type.id} onClick={() => { setChoosingType(false); setEditing(type.id); }}><Icon size={22} /><span><strong>{type.label}</strong><small>{type.description}</small></span></Button>;
    })}</div></Dialog>}
    {editing && <ModelDialog key={typeof editing === 'string' ? editing : editing.id} model={typeof editing === 'string' ? undefined : editing} connectionType={typeof editing === 'string' ? editing : undefined} action={action} onClose={() => setEditing(null)} />}
  </div>;
}

function ModelDialog({ model, connectionType: addingType = 'text', action, onClose }: { model?: ModelProfile; connectionType?: ModelConnectionType; action: Action; onClose: () => void }) {
  const connectionType = model ? getModelConnectionType(model) : addingType;
  const definition = modelConnectionTypes.find(type => type.id === connectionType)!;
  const legacyConfiguration = Boolean(model && !model.connectionType && (model.capabilities.some(capability => !definition.capabilities.includes(capability)) || model.capabilities.includes('tts') && model.capabilities.includes('asr')));
  const savedConnectionType = model ? model.connectionType : addingType;
  const [name, setName] = useState(model?.name ?? '');
  const [platform, setPlatform] = useState<ModelPlatform>(model ? getModelPlatform(model).id : 'openai');
  const [provider, setProvider] = useState<ModelProfile['provider']>(model?.provider ?? 'openai-compatible');
  const [textProtocol, setTextProtocol] = useState<TextProtocol>(model?.textProtocol ?? 'chat-completions');
  const preset = platformForConnection(platform, connectionType);
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? 'https://api.openai.com/v1');
  const [modelId, setModelId] = useState(model?.model ?? '');
  const [secret, setSecret] = useState('');
  const [secretVisible, setSecretVisible] = useState(false);
  const secretId = useId();
  const modelInputId = useId();
  const [capabilities, setCapabilities] = useState<ModelCapability[]>((model ? getModelCapabilities(model) : undefined) ?? (addingType === 'text' ? ['text', 'vision', 'tools', 'structured-output'] : [addingType === 'audio' ? 'tts' : addingType]));
  const [busy, setBusy] = useState(false);
  const [parametersText, setParametersText] = useState(JSON.stringify(model?.parameters ?? {}, null, 2));
  const [saveError, setSaveError] = useState('');
  const [discovery, setDiscovery] = useState<ModelDiscovery>();
  const [discovering, setDiscovering] = useState(false);
  const [manualModel, setManualModel] = useState(false);
  const [discoveryRefresh, setDiscoveryRefresh] = useState(0);
  const forceDiscovery = useRef(false);
  const speechProvider = provider === 'volcengine-tts' || provider === 'volcengine-asr';
  useEffect(() => {
    let active = true, local = false, valid = false;
    try { const url = new URL(baseUrl); valid = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); } catch { /* An incomplete address is expected while editing. */ }
    const force = forceDiscovery.current; forceDiscovery.current = false;
    setDiscovery(undefined); setDiscovering(false);
    if (!valid || !(force || speechProvider || provider === 'comfyui' || provider === 'ollama' || local || secret || model?.hasSecret && baseUrl === model.baseUrl)) return;
    const timer = setTimeout(() => {
      setDiscovering(true);
      void rpc('model.discover', { model: { id: model?.id, provider, platform, textProtocol, baseUrl, capabilities }, ...(secret ? { secret } : {}) }).then(value => {
        if (!active) return;
        const result = modelDiscoverySchema.parse(value); setDiscovery(result);
        if (result.source === 'workflow') setModelId('workflow');
      }).catch(() => { if (active) setDiscovery({ source: 'remote', items: [], message: '模型读取失败，可重试或手动填写。' }); }).finally(() => { if (active) setDiscovering(false); });
    }, speechProvider || provider === 'comfyui' ? 0 : 500);
    return () => { active = false; clearTimeout(timer); };
  }, [baseUrl, secret, provider, platform, textProtocol, model?.id, model?.hasSecret, model?.baseUrl, capabilities.join('|'), discoveryRefresh]);
  const [voiceResult, setVoiceResult] = useState<{ key: string; catalog: VoiceDiscovery }>();
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voiceRefresh, setVoiceRefresh] = useState(0);
  const voiceKey = JSON.stringify([provider, platform, baseUrl, modelId]);
  const voiceContext = { provider, platform, baseUrl, model: modelId };
  const voices = voiceResult?.key === voiceKey ? voiceResult.catalog : getModelVoiceCatalog(voiceContext);
  const canReadVoices = capabilities.includes('tts') && supportsAccountVoices(voiceContext) && Boolean(secret || model?.hasSecret && baseUrl === model.baseUrl);
  useEffect(() => {
    let active = true; setVoiceResult(undefined); setVoicesLoading(false);
    if (!canReadVoices) return;
    const timer = setTimeout(() => {
      setVoicesLoading(true);
      void rpc('model.voices', { model: { id: model?.id, provider, platform, baseUrl, model: modelId, capabilities }, ...(secret ? { secret } : {}) }).then(value => {
        if (active) setVoiceResult({ key: voiceKey, catalog: voiceDiscoverySchema.parse(value) });
      }).catch(() => { if (active) setVoiceResult({ key: voiceKey, catalog: { ...getModelVoiceCatalog({ provider, platform, baseUrl, model: modelId }), message: '账号音色暂时无法读取，可选择公共音色预设或自定义填写。' } }); }).finally(() => { if (active) setVoicesLoading(false); });
    }, 500);
    return () => { active = false; clearTimeout(timer); };
  }, [voiceKey, secret, canReadVoices, model?.id, voiceRefresh]);
  let parameters: Record<string, JsonValue> = {}, jsonError = '', parameterError = '';
  try {
    const parsed = jsonValueSchema.parse(JSON.parse(parametersText));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数需要填写 JSON 对象。');
    parameters = parsed;
  } catch (error) { jsonError = error instanceof Error ? error.message : '参数 JSON 格式不正确。'; }
  if (!jsonError) {
    try { validateModelConnection({ connectionType: savedConnectionType, provider, capabilities }); validateModelParameters({ provider, capabilities, textProtocol, parameters }); }
    catch (error) { parameterError = error instanceof Error ? error.message : String(error); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaveError('');
    if (jsonError || parameterError) return;
    setBusy(true);
    const result = await action('model.save', { model: { ...model, ...(savedConnectionType ? { connectionType: savedConnectionType } : {}), name, platform, provider, ...(capabilities.includes('text') ? { textProtocol } : {}), baseUrl, model: modelId, capabilities, parameters }, ...(secret ? { secret } : {}) }, '模型连接已保存');
    setBusy(false);
    if (result !== null) onClose(); else setSaveError('连接尚未保存，请核对提示后重试。');
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
  const mediaCapabilities = capabilities.filter(capability => ['image', 'video', 'tts', 'asr'].includes(capability));
  const adapters = platform === 'custom' ? getMediaAdapters(capabilities) : mediaAdapters.filter(adapter => adapter.id === provider);
  const audioProtocol = provider === 'openai-compatible' ? capabilities.includes('asr') ? 'openai-asr' : 'openai-tts' : provider;
  const audioProtocols = [
    { id: 'openai-tts', label: 'OpenAI Speech · 配音生成' }, { id: 'openai-asr', label: 'OpenAI Transcriptions · 语音识别' },
    { id: 'volcengine-tts', label: '豆包语音合成 V3' }, { id: 'volcengine-asr', label: '豆包语音识别（极速版）' },
    { id: 'qwen-tts', label: 'Qwen TTS · 配音生成' }, { id: 'custom-http', label: '自定义 HTTP · 配音生成' },
  ].filter(protocol => platform === 'custom' || platform === 'volcengine' && protocol.id.startsWith('volcengine-') || platform !== 'volcengine' && provider === 'openai-compatible' && protocol.id.startsWith('openai-') || protocol.id === provider);
  const platforms = modelPlatforms.filter(item => legacyConfiguration || definition.platforms.includes(item.id) || model && item.id === getModelPlatform(model).id);
  return <Dialog title={model ? '编辑模型连接' : `添加${definition!.label}`} onClose={onClose} className="model-connection-dialog settings-dialog"><form onSubmit={event => void save(event)}>
    <div className="dialog__body"><SettingsSections label="模型连接设置" sections={[
      { id: 'connection', label: '基本连接', icon: Server, content: <><h3>基本连接</h3>
      {model && <div className="model-connection-type"><span className="pill">{definition!.label}</span><span>{definition.description}</span></div>}
      <div className="model-connection-fields"><Field label="连接名称"><input required autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="例如：本地分镜助手" /></Field>
      <Field label="模型平台"><Select value={platform} disabled={busy} onChange={event => {
        const selected = platformForConnection(modelPlatformSchema.parse(event.target.value), connectionType);
        setPlatform(selected.id); setProvider(selected.provider); setBaseUrl(selected.baseUrl); setManualModel(false);
        if (!jsonError) changeTextProtocol(selected.textProtocol ?? 'chat-completions');
        else setTextProtocol(selected.textProtocol ?? 'chat-completions');
        if (selected.provider === 'volcengine-tts') setModelId('seed-tts-2.0');
        setCapabilities(legacyConfiguration ? getModelCapabilities({ provider: selected.provider, capabilities: selected.provider === 'openai-compatible' ? model!.capabilities : [...selected.capabilities] }) : connectionType === 'text' ? ['text', 'vision', 'tools', 'structured-output'] : connectionType === 'audio' ? [['qwen-tts', 'volcengine-tts'].includes(selected.provider) ? 'tts' : capabilities.includes('asr') ? 'asr' : 'tts'] : [connectionType]);
      }}>{platforms.map(item => <option key={item.id} value={item.id}><span className="platform-option"><PlatformIcon platform={item.id} /><span>{platformForConnection(item.id, connectionType).label}</span></span></option>)}</Select></Field>
      {capabilities.includes('text') && <Field label={legacyConfiguration ? '文本 API 协议' : 'API 协议'}><Select value={provider === 'ollama' ? 'ollama' : textProtocol} disabled={busy || Boolean(jsonError) || provider === 'ollama'} onChange={event => changeTextProtocol(textProtocolSchema.parse(event.target.value))}>{provider === 'ollama' ? <option value="ollama">Ollama 原生 API</option> : textProtocols.map(protocol => <option key={protocol.id} value={protocol.id}>{protocol.label}</option>)}</Select></Field>}
      {connectionType === 'audio' && <Field label="API 协议"><Select value={audioProtocol} disabled={busy} onChange={event => { const protocol = event.target.value; setManualModel(false); setProvider(protocol.startsWith('openai-') ? 'openai-compatible' : protocol as ModelProfile['provider']); setCapabilities([protocol === 'openai-asr' || protocol === 'volcengine-asr' ? 'asr' : 'tts']); if (protocol.startsWith('volcengine-')) setModelId(protocol === 'volcengine-asr' ? 'volc.bigasr.auc_turbo' : 'seed-tts-2.0'); }}>{audioProtocols.map(protocol => <option key={protocol.id} value={protocol.id}>{protocol.label}</option>)}</Select></Field>}
      {mediaCapabilities.length > 0 && connectionType !== 'audio' && <Field label={legacyConfiguration ? '素材 API 协议' : 'API 协议'}><Select value={provider} disabled={busy || platform !== 'custom'} onChange={event => setProvider(event.target.value as ModelProfile['provider'])}>{!adapters.some(adapter => adapter.id === provider) && <option value={provider} disabled>{mediaAdapters.find(adapter => adapter.id === provider)?.label ?? '当前接入方式'}</option>}{adapters.map(adapter => <option key={adapter.id} value={adapter.id}>{adapter.id === 'openai-compatible' && !legacyConfiguration ? connectionType === 'image' ? 'OpenAI Images API' : 'OpenAI Videos API' : adapter.label}</option>)}</Select></Field>}
      <Field label="服务地址" hint={preset.addressHint} className={legacyConfiguration ? 'model-connection-fields__wide' : ''}><input required type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder={preset.addressPlaceholder} spellCheck={false} /></Field></div>
      <div className="field"><label className="field__label" htmlFor={secretId}>API Key</label><div className="model-secret-input"><input id={secretId} type={secretVisible ? 'text' : 'password'} autoComplete="new-password" autoCapitalize="none" spellCheck={false} aria-describedby={`${secretId}-hint`} value={secret} onChange={event => setSecret(event.target.value)} placeholder={model?.hasSecret ? '••••••••••••' : '输入密钥'} /><IconButton label={secretVisible ? '隐藏密钥' : '显示密钥'} aria-pressed={secretVisible} aria-controls={secretId} disabled={!secret} onClick={() => setSecretVisible(value => !value)}>{secretVisible ? <EyeOff size={16} /> : <Eye size={16} />}</IconButton></div><span id={`${secretId}-hint`} className="field__hint">{model?.hasSecret ? '已保存密钥；留空保留原值。' : '本地免鉴权服务可留空。'}</span></div>
      <div className="model-discovery"><div className="field"><label className="field__label" htmlFor={modelInputId}>{speechProvider ? '资源 ID' : '模型 ID'}</label><div className="model-discovery__control">
        {!manualModel && discovery?.items.length ? <Select id={modelInputId} aria-label={speechProvider ? '资源 ID' : '模型 ID'} required value={modelId} disabled={busy || discovery.source === 'workflow'} onChange={event => setModelId(event.target.value)}><option value="" disabled>选择模型</option>{modelId && !discovery.items.some(item => item.id === modelId) && <option value={modelId}>当前：{modelId}</option>}{discovery.items.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</Select> : <input id={modelInputId} aria-label={speechProvider ? '资源 ID' : '模型 ID'} required value={modelId} onChange={event => { setModelId(event.target.value); setManualModel(true); }} placeholder={discovering ? '正在读取可用模型…' : '填写连接信息后读取，或手动填写'} spellCheck={false} />}
        <IconButton label="获取模型列表" disabled={busy || discovering} aria-busy={discovering || undefined} onClick={() => { forceDiscovery.current = true; setManualModel(false); setDiscoveryRefresh(value => value + 1); }}>{discovering ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}</IconButton>
      </div></div>{Boolean(discovery?.items.length) && discovery?.source !== 'workflow' && <div className="model-discovery__actions"><Button static variant="ghost" onClick={() => setManualModel(value => !value)}>{manualModel ? '从列表选择' : '手动填写'}</Button></div>}<p className="field__hint" role="status">{discovering ? '正在读取模型列表…' : discovery?.message ?? '填写服务地址与密钥后，自动读取模型列表。'}</p></div>

      </> },
      ...modelParameterSections.filter(section => parameterFields.some(field => field.operation === section.id)).map(section => ({ id: section.id, label: section.label, content: <ModelParameters operation={section.id} provider={provider} textProtocol={textProtocol} capabilities={capabilities} value={parameters} disabled={busy || Boolean(jsonError)} voices={voices} voiceContextKey={voiceKey} voicesLoading={voicesLoading} onReloadVoices={canReadVoices ? () => setVoiceRefresh(value => value + 1) : undefined} onChange={changeParameters} /> })),
      { id: 'advanced', label: '高级设置', icon: Code2, content: <><h3>高级模型参数</h3><Field label="参数 JSON" hint="与表单同步，保留未知字段。ComfyUI 填写 workflow/inputMapping；自定义 HTTP 填写请求和响应映射。"><textarea rows={12} aria-label="模型参数 JSON" spellCheck={false} value={parametersText} disabled={busy} onChange={event => { setParametersText(event.target.value); setSaveError(''); }} /></Field></> },
    ]} notice={<>
      {(jsonError || parameterError) && <p role="alert" className="field-error">{jsonError || parameterError}</p>}
      {saveError && <p role="alert" className="field-error">{saveError}</p>}
    </>} /></div>
    <div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button aria-label="保存连接" variant="primary" type="submit" busy={busy} disabled={!capabilities.length || Boolean(jsonError || parameterError)}>保存</Button></div>
  </form></Dialog>;
}

export function SkillsPage({ workspace, action }: PageProps) {
  const [importing, setImporting] = useState(false);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<SkillPackage | null>(null);
  const [instructions, setInstructions] = useState('');
  return <div className="content-page"><div className="page-heading"><div><h1>Skill 工作室</h1></div><Button variant="primary" onClick={() => setImporting(true)}><Plus size={16} />导入 Skill</Button></div><div className="settings-grid"><div>{workspace.skills.length ? workspace.skills.map(skill => <article className="list-card" key={skill.id}><div className="list-card__icon"><BookOpen size={20} /></div><div className="list-card__body"><h3>{skill.name}</h3><p>{skill.description}</p><div className="pill-row"><span className="pill">{skill.version.slice(0, 12)}</span><span className="pill">{skill.resources.length} 个资源</span>{skill.tools.length > 0 && <span className="pill">{skill.tools.length} 个工具</span>}</div></div><div className="list-card__actions"><IconButton label={`查看“${skill.name}”`} onClick={() => { setSelected(skill); setInstructions(skill.instructions); }}><Pencil size={16} /></IconButton><IconButton label={skill.enabled ? `停用“${skill.name}”` : `启用“${skill.name}”`} aria-pressed={skill.enabled} onClick={() => void action('skill.toggle', { skillId: skill.id, enabled: !skill.enabled }, skill.enabled ? 'Skill 已停用' : 'Skill 已启用')}><Power size={16} /></IconButton></div></article>) : <div className="section-card"><EmptyState icon={<BookOpen size={25} />} title="把你的方法加入创作" description="导入含 SKILL.md 的目录或 GitHub 链接，再绑定到步骤。"><Button variant="primary" onClick={() => setImporting(true)}><Plus size={15} />导入 Skill</Button></EmptyState></div>}</div><aside><div className="section-card"><div className="list-help"><p>Skill 可包含写作规范、风格、模板和工具说明，资源按需加载。</p><p>任务使用固定的 Skill 版本，后续修改不影响当前任务。</p><p>工具需要单独启用，并遵循该步骤的执行与恢复规则。</p></div></div></aside></div><ToolConnections action={action} />{importing && <Dialog title="导入 Skill" onClose={() => setImporting(false)}><form onSubmit={event => { event.preventDefault(); setBusy(true); void action('skill.import', /^https?:\/\//i.test(source) ? { url: source } : { path: source }, 'Skill 已导入').then(result => { setBusy(false); if (result !== null) { setImporting(false); setSource(''); } }); }}><div className="dialog__body"><Field label="目录路径或 GitHub 链接" hint="目录需包含 SKILL.md 及引用资源。"><PathPicker label="目录路径或 GitHub 链接" mode="directory" autoFocus required value={source} onChange={setSource} placeholder="D:\skills\history-handdrawn-video" /></Field></div><div className="dialog__footer"><Button onClick={() => setImporting(false)}>取消</Button><Button variant="primary" type="submit" busy={busy}><Download size={15} />导入</Button></div></form></Dialog>}{selected && <Dialog title={selected.name} onClose={() => setSelected(null)} className="dialog--wide"><div className="dialog__body"><p>{selected.description}</p><Field label="Skill 指令"><textarea className="skill-editor" value={instructions} onChange={event => setInstructions(event.target.value)} spellCheck={false} /></Field><p className="tiny-meta">来源：{selected.source}</p>{selected.tools.length > 0 && <div className="skill-tools"><h3>工具权限</h3>{selected.tools.map(tool => <label key={tool.id} className="field-inline"><input type="checkbox" checked={tool.enabled} onChange={event => { const enabled = event.target.checked; void action<SkillPackage>('skill.tool.toggle', { skillId: selected.id, toolId: tool.id, enabled }, '工具权限已更新').then(value => { if (value) setSelected(value); }); }} />{tool.label} <span className="tiny-meta">{tool.permissions.join('、')}</span></label>)}</div>}</div><div className="dialog__footer"><Button onClick={() => setSelected(null)}>关闭</Button><Button aria-label="保存新版本" variant="primary" onClick={() => void action('skill.update', { skillId: selected.id, instructions }, 'Skill 已保存为新版本').then(result => { if (result !== null) setSelected(null); })}><Check size={15} />保存</Button></div></Dialog>}</div>;
}

export function AssetsPage({ workspace, action, project }: PageProps & { project?: ProjectDocument }) {
  const [importing, setImporting] = useState(false);
  const [source, setSource] = useState('');
  const [filter, setFilter] = useState('all');
  const library = useRecordPage('asset.list', filter === 'all' ? {} : { kind: filter }, workspace.version, assetsPageSchema, workspace.assetsVersion);
  const assets = library.items;
  return <div className="content-page"><div className="page-heading"><div><h1>素材库</h1></div><Button aria-label="导入素材" variant="primary" onClick={() => setImporting(true)}><Upload size={15} />导入</Button></div><div className="page-toolbar"><div className="tabs">{[['all', '全部'], ['image', '图片'], ['video', '视频'], ['audio', '音频'], ['document', '资料']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><span className="tiny-meta">{assets.length} 个素材</span></div>{library.error && <Notice kind="error">{library.error}<Button aria-label="重试读取素材" onClick={library.refresh}>重试</Button></Notice>}{assets.length ? <div className="asset-grid">{assets.map(asset => <AssetCard key={asset.id} asset={asset} action={action} projects={workspace.projects.filter(item => !item.archived)} initialProject={project} />)}</div> : <div className="section-card"><EmptyState icon={<Image size={25} />} title="把素材带进工作台" description="导入自有或已授权的图片、视频、音频和资料。" /></div>}{library.nextCursor !== null && <Button aria-label="加载更多素材" className="button-full" busy={library.busy} onClick={() => void library.loadMore()}>加载更多</Button>}{importing && <Dialog title="导入本地素材" onClose={() => setImporting(false)}><form onSubmit={event => { event.preventDefault(); void action('asset.import', { path: source, projectId: project?.id }, '素材已导入').then(result => { if (result !== null) { setImporting(false); setSource(''); } }); }}><div className="dialog__body"><Field label="文件路径"><PathPicker label="文件路径" autoFocus required value={source} onChange={setSource} placeholder="D:\materials\illustration.png" /></Field><p className="tiny-meta">请使用自己创作或已获授权的素材。源文件会保留。</p></div><div className="dialog__footer"><Button onClick={() => setImporting(false)}>取消</Button><Button variant="primary" type="submit"><Upload size={15} />导入</Button></div></form></Dialog>}</div>;
}

function AssetCard({ asset, action, projects, initialProject }: { asset: AssetListItem; action: Action; projects: ProjectSummary[]; initialProject?: ProjectDocument }) {
  const [image, setImage] = useState<string>();
  const [error, setError] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [projectId, setProjectId] = useState(initialProject?.id ?? projects[0]?.id ?? '');
  const [shotId, setShotId] = useState('');
  const [target, setTarget] = useState<ProjectDocument>();
  const [targetError, setTargetError] = useState('');
  useEffect(() => {
    let active = true;
    setError(false);
    if (asset.kind === 'image') void getAssetUrl(asset.path).then(url => { if (active) setImage(url); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [asset.kind, asset.path]);
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
    const value = asset.projectId && asset.projectId !== target.id
      ? await action('asset.import', { path: asset.path, projectId: target.id, shotId }, '素材已复制并应用到镜头')
      : await action('asset.select', { assetId: asset.id, projectId: target.id, shotId, revision: target.revision }, '素材已应用到镜头');
    if (value !== null) setSelecting(false);
  }
  return <article className="asset-card"><div className="asset-card__preview">{image && !error ? <img src={image} alt={asset.name} loading="lazy" decoding="async" onError={() => setError(true)} /> : <Icon size={31} role={error ? 'img' : undefined} aria-label={error ? `无法预览“${asset.name}”` : undefined} />}</div><h3>{asset.name}</h3>{asset.provenance && asset.provenance !== '用户导入' && <p>{asset.provenance}</p>}<div className="asset-card-footer"><span className="tiny-meta">{asset.size < 1024 * 1024 ? `${Math.round(asset.size / 1024)} KB` : `${(asset.size / (1024 * 1024)).toFixed(1)} MB`}{used ? ' · 使用中' : ''}</span><div className="asset-actions">{media && <IconButton label={`将“${asset.name}”用于镜头`} onClick={() => { setSelecting(true); setShotId(target?.shots[0]?.id ?? ''); }}><Link size={15} /></IconButton>}<IconButton label={asset.retained ? '取消保留此版本' : '保留此版本'} aria-pressed={asset.retained} onClick={() => void action('asset.retain', { assetId: asset.id, retained: !asset.retained }, asset.retained ? '已取消保留' : '此版本已保留')}><ShieldCheck size={15} /></IconButton><IconButton label={`移除素材“${asset.name}”`} disabled={used || asset.retained} onClick={() => void action('asset.delete', { assetId: asset.id }, '素材记录已移除')}><Trash2 size={15} /></IconButton></div></div>{selecting && <Dialog title="应用素材到镜头" onClose={() => setSelecting(false)}><div className="dialog__body"><p>{asset.name}</p>{targetError && <Notice kind="error">{targetError}</Notice>}<Field label="目标项目"><Select value={projectId} onChange={event => { setProjectId(event.target.value); setShotId(''); }}><option value="" disabled>选择项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</Select></Field><Field label="目标镜头"><Select value={shotId} onChange={event => setShotId(event.target.value)}><option value="" disabled>选择镜头</option>{target?.shots.map((shot, index) => <option key={shot.id} value={shot.id}>{index + 1}. {shot.title}</option>)}</Select></Field>{asset.projectId && asset.projectId !== target?.id && <Notice>素材将复制到目标项目，源项目保持独立。</Notice>}</div><div className="dialog__footer"><Button onClick={() => setSelecting(false)}>取消</Button><Button aria-label="应用此版本" variant="primary" disabled={!target || !shotId} onClick={() => void apply()}><Check size={14} />应用</Button></div></Dialog>}</article>;
}
