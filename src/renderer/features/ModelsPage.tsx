import { useEffect, useId, useRef, useState } from 'react';
import { Eye, EyeOff, Image, LoaderCircle, Pencil, RefreshCw, Server, Trash2, Video, Plus, Download } from 'lucide-react';
import { modelConnectionTypes, getModelConnectionType, validateModelConnection, modelToolProtocolIssue, platformForConnection, modelDiscoverySchema, getMediaAdapters, mediaAdapters, textProtocols, textModelBasePath, textProtocolSchema, modelPlatforms, getModelPlatform, modelPlatformSchema, type ModelDiscovery, type ModelConnectionType, type TextProtocol, type ModelPlatform, type ModelCapability, type ModelProfile } from '@video-quickly/contracts';
import { Button, Combobox, Dialog, EmptyState, Field, IconButton, Notice, Select } from '../components/Primitives';
import type { Action, WorkspaceView } from '../lib/types';
import { beginGuideAction } from '../lib/guide-actions';
import { useConfirmation } from '../components/ConfirmationDialog';
import { rpc } from '../lib/client';
import PlatformIcon from '../components/PlatformIcon';
import './model-connections.css';

const capabilityLabels: Record<ModelCapability, string> = { text: '文本问答', image: '图片生成', video: '视频生成', vision: '图片理解', tools: '工具调用', 'structured-output': '结构化输出' };

export function ModelsPage({ workspace, action, repairModelId, onRepairConsumed }: {
  workspace: WorkspaceView;
  action: Action;
  repairModelId?: string;
  onRepairConsumed?: () => void;
}) {
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
    <div className="page-heading"><h1>模型连接</h1><Button data-guide="model-connection" variant="primary" onClick={addModel}><Plus size={16} />添加模型</Button></div>
    <div className="page-toolbar"><div className="tabs model-type-tabs" role="group" aria-label="模型类型筛选">
      <button type="button" className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</button>
      {modelConnectionTypes.map(type => <button type="button" key={type.id} className={filter === type.id ? 'active' : ''} aria-pressed={filter === type.id} onClick={() => setFilter(type.id)}>{type.label}</button>)}
    </div><span className="tiny-meta">{models.length} 个连接</span></div>
    {repairError && <Notice kind="error">{repairError}</Notice>}
    <div className="model-connections-list">{models.length ? models.map(model => {
      const category = getModelConnectionType(model);
      const label = modelConnectionTypes.find(type => type.id === category)!.label;
      return <article className="list-card" key={model.id}><div className="list-card__icon"><PlatformIcon platform={getModelPlatform(model).id} /></div><div className="list-card__body"><h3>{model.name}</h3><p>{getModelPlatform(model).label} · {model.model}</p><div className="pill-row"><span className="pill">{label}</span>{model.capabilities.map(capability => <span className="pill" key={capability}>{capabilityLabels[capability]}</span>)}</div></div><div className="list-card__actions"><IconButton label={`检查“${model.name}”连接`} onClick={() => void action('model.test', { modelId: model.id }, '连接检查完成')}><RefreshCw size={16} /></IconButton><IconButton label={`编辑“${model.name}”`} onClick={() => setEditing(model)}><Pencil size={16} /></IconButton><IconButton label={`移除“${model.name}”`} onClick={() => void removeModel(model)}><Trash2 size={16} /></IconButton></div></article>;
    }) : <EmptyState icon={<Server size={25} />} title={filter === 'all' ? '还没有模型连接' : '还没有此类模型'} description={filter === 'all' ? '添加文本、图片或视频模型，用于后续制作。' : '可添加此类模型，或切换类型查看已有连接。'} />}</div>
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
  const initialPreset = platformForConnection(definition.platforms[0]);
  const [name, setName] = useState(model?.name ?? '');
  const [platform, setPlatform] = useState<ModelPlatform>(model ? getModelPlatform(model).id : initialPreset.id);
  const [provider, setProvider] = useState<ModelProfile['provider']>(model?.provider ?? initialPreset.provider);
  const [textProtocol, setTextProtocol] = useState<TextProtocol>(model?.textProtocol ?? initialPreset.textProtocol ?? 'chat-completions');
  const preset = platformForConnection(platform, connectionType);
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? initialPreset.baseUrl);
  const [modelId, setModelId] = useState(model?.model ?? '');
  const [secret, setSecret] = useState('');
  const draftSecretOrigin = useRef<string | undefined>(undefined);
  const secretValue = secret.trim();
  const [secretVisible, setSecretVisible] = useState(false);
  const secretId = useId();
  const modelInputId = useId();
  const addressErrorId = useId();
  const baseUrlInput = useRef<HTMLInputElement>(null), secretInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const closed = useRef(false);
  useEffect(() => { closed.current = false; return () => { closed.current = true; }; }, []);
  function close() { closed.current = true; onClose(); }
  const [discoveryResult, setDiscoveryResult] = useState<{ key: string; catalog: ModelDiscovery }>();
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<{ field: 'address' | 'secret'; message: string }>();
  const discoveryGeneration = useRef(0);
  let serviceUrl: URL | undefined;
  try { serviceUrl = new URL(baseUrl); } catch { /* An incomplete address is expected while editing. */ }
  const sameProtocol = model?.provider === provider && (model.textProtocol ?? 'chat-completions') === textProtocol;
  const fullUrl = connectionType === 'text' && (sameProtocol && model.baseUrl === baseUrl
    ? Boolean(model.fullUrl)
    : serviceUrl !== undefined && textModelBasePath(serviceUrl.pathname, { provider, textProtocol }) !== undefined);
  const serviceKey = JSON.stringify([baseUrl, provider, platform, textProtocol, fullUrl]);
  const [savedServiceKey] = useState(serviceKey);
  const discoveryKey = JSON.stringify([serviceKey, secretValue]);
  const discovery = discoveryResult?.key === discoveryKey ? discoveryResult.catalog : undefined;
  const catalog = discovery?.items ?? [];
  const modelItems = model && serviceKey === savedServiceKey && !catalog.some(item => item.id === model.model)
    ? [...catalog, { id: model.model, label: model.model }]
    : catalog;
  const selectedModel = modelItems.find(item => item.id === modelId);
  const selectedModelId = selectedModel?.id ?? '';
  const keyOptional = provider === 'comfyui' || provider === 'ollama' && serviceUrl?.hostname !== 'ollama.com'
    || Boolean(serviceUrl && ['localhost', '127.0.0.1', '[::1]'].includes(serviceUrl.hostname));
  const sameOrigin = Boolean(model && new URL(model.baseUrl).origin === serviceUrl?.origin);
  const hasSavedSecret = Boolean(model?.hasSecret && sameOrigin);
  const authMode = sameOrigin && sameProtocol
    ? model.authMode ?? 'protocol-default'
    : 'protocol-default';
  function changeAddress(value: string) {
    if (draftSecretOrigin.current && URL.canParse(value) && draftSecretOrigin.current !== new URL(value).origin) {
      setSecret(''); setSecretVisible(false); draftSecretOrigin.current = undefined;
    }
    setBaseUrl(value);
  }
  function changeSecret(value: string) {
    draftSecretOrigin.current = value.trim() ? serviceUrl?.origin : undefined;
    setSecret(value);
  }
  useEffect(() => {
    discoveryGeneration.current++;
    setDiscoveryResult(undefined); setDiscovering(false); setDiscoveryError(undefined);
    return () => { discoveryGeneration.current++; };
  }, [discoveryKey]);
  function validateConnectionInputs() {
    const error = !baseUrl.trim() ? { field: 'address' as const, message: '请填写服务地址。' }
      : !serviceUrl || !['http:', 'https:'].includes(serviceUrl.protocol) || serviceUrl.username || serviceUrl.password || serviceUrl.search || serviceUrl.hash ? { field: 'address' as const, message: '请填写不含凭据、查询参数和片段的 HTTP 或 HTTPS 地址。' }
      : !keyOptional && !secretValue && !hasSavedSecret ? { field: 'secret' as const, message: '请填写当前服务的 API Key。' } : undefined;
    setDiscoveryError(error);
    if (!error) {
      if (secretValue) draftSecretOrigin.current = serviceUrl?.origin;
      return true;
    }
    (error.field === 'address' ? baseUrlInput : secretInput).current?.focus();
    return false;
  }
  async function discover() {
    if (busy || discovering || !validateConnectionInputs()) return;
    const generation = ++discoveryGeneration.current;
    setDiscovering(true);
    try {
      const value = await rpc('model.discover', { model: { id: model?.id, provider, platform, connectionType, textProtocol, authMode, fullUrl, baseUrl, capabilities: [connectionType] }, ...(secretValue ? { secret: secretValue } : {}) });
      if (closed.current || generation !== discoveryGeneration.current) return;
      const result = modelDiscoverySchema.parse(value); setDiscoveryResult({ key: discoveryKey, catalog: result });
      if (result.source === 'workflow') setModelId('workflow');
    } catch {
      if (!closed.current && generation === discoveryGeneration.current) setDiscoveryResult({ key: discoveryKey, catalog: { source: 'remote', items: [], message: '模型读取失败，请重试。' } });
    } finally {
      if (!closed.current && generation === discoveryGeneration.current) setDiscovering(false);
    }
  }
  const sameModel = sameOrigin && model?.provider === provider && model.model === selectedModelId;
  const reportedCapabilities = selectedModel?.capabilities ?? (sameModel ? model.capabilities : []);
  const parameters = (model?.provider === provider ? model.parameters : undefined) ?? {};
  const connection = { connectionType, provider, platform, baseUrl, fullUrl, authMode, model: selectedModelId,
    textProtocol: connectionType === 'text' && provider !== 'ollama' ? textProtocol : undefined };
  const toolIssue = reportedCapabilities.includes('tools') && modelToolProtocolIssue({ ...connection, parameters });
  const capabilities = [connectionType, ...definition.capabilities.filter(capability => capability !== connectionType
    && reportedCapabilities.includes(capability) && (capability !== 'tools' || !toolIssue))];
  const configuration = { ...connection, capabilities };
  let connectionError = '';
  try { validateModelConnection({ ...configuration, parameters }); }
  catch (error) { connectionError = error instanceof Error ? error.message : String(error); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaveError('');
    if (busy || discovering || connectionError || !selectedModelId || !validateConnectionInputs()) return;
    const completed = beginGuideAction('model-saved');
    setBusy(true);
    const clearPricing = model?.pricing && (!sameModel || model.baseUrl !== baseUrl.trim());
    const result = await action('model.save', {
      model: { id: model?.id, name, ...configuration, ...(clearPricing ? { pricing: null } : {}) },
      ...(secretValue ? { secret: secretValue } : {}),
    }, '模型连接已保存');
    if (closed.current) return;
    setBusy(false);
    if (result !== null) { completed(); onClose(); } else setSaveError('连接尚未保存，请核对提示后重试。');
  }
  const adapters = platform === 'custom' ? getMediaAdapters([connectionType]) : mediaAdapters.filter(adapter => adapter.id === provider);
  const platforms = modelPlatforms.filter(item => definition.platforms.includes(item.id));
  const mediaSetupHint = provider === 'comfyui' && parameters.workflow === undefined ? '生成视频需要预先配置 ComfyUI 工作流。'
    : provider === 'custom-http' && parameters.requestTemplate === undefined ? '生成需要预先配置自定义 HTTP 请求模板。' : undefined;
  return <Dialog title={model ? '编辑模型连接' : `添加${definition.label}`} onClose={close} onDismissStart={() => { closed.current = true; }} className="model-connection-dialog dialog--wide">
    <form onSubmit={event => void save(event)}>
      <div className="dialog__body">
        {model && <div className="model-connection-type"><span className="pill">{definition.label}</span><span>{definition.description}</span></div>}
        <div className="model-connection-fields">
          <Field label="连接名称"><input required autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="例如：本地分镜助手" /></Field>
          <Field label="模型平台"><Select value={platform} disabled={busy} onChange={event => {
            const selected = platformForConnection(modelPlatformSchema.parse(event.target.value), connectionType);
            setPlatform(selected.id); setProvider(selected.provider); changeAddress(selected.baseUrl);
            setTextProtocol(selected.textProtocol ?? 'chat-completions');
          }}>{!definition.platforms.includes(platform) && <option value={platform} disabled>请选择可用平台</option>}{platforms.map(item => <option key={item.id} value={item.id}><span className="platform-option"><PlatformIcon platform={item.id} /><span>{platformForConnection(item.id, connectionType).label}</span></span></option>)}</Select></Field>
          {connectionType === 'text'
            ? <Field label="API 协议"><Select value={provider === 'ollama' ? 'ollama' : textProtocol} disabled={busy || provider === 'ollama'} onChange={event => setTextProtocol(textProtocolSchema.parse(event.target.value))}>{provider === 'ollama' ? <option value="ollama">Ollama 原生 API</option> : textProtocols.map(protocol => <option key={protocol.id} value={protocol.id}>{protocol.label}</option>)}</Select></Field>
            : <Field label="API 协议" hint={mediaSetupHint}><Select value={provider} disabled={busy || platform !== 'custom'} onChange={event => setProvider(event.target.value as ModelProfile['provider'])}>{!adapters.some(adapter => adapter.id === provider) && <option value={provider} disabled>{mediaAdapters.find(adapter => adapter.id === provider)?.label ?? '当前接入方式'}</option>}{adapters.map(adapter => <option key={adapter.id} value={adapter.id}>{adapter.id === 'openai-compatible' ? connectionType === 'image' ? 'OpenAI Images API' : 'OpenAI 兼容视频接口' : adapter.label}</option>)}</Select></Field>}
          <Field label="服务地址" hint={preset.addressHint ?? (connectionType === 'text' && platform === 'custom' ? '可填 API 地址前缀或与所选协议匹配的完整请求地址。' : undefined)}>
            <input ref={baseUrlInput} required type="url" autoCorrect="off" autoCapitalize="none" spellCheck={false} aria-invalid={discoveryError?.field === 'address' || undefined} aria-describedby={discoveryError?.field === 'address' ? addressErrorId : undefined} value={baseUrl} onChange={event => changeAddress(event.target.value)} placeholder={preset.addressPlaceholder} />
          </Field>
        </div>
        {discoveryError?.field === 'address' && <div id={addressErrorId} className="field-error" role="alert">{discoveryError.message}</div>}
        <div className="field">
          <label className="field__label" htmlFor={secretId}>API Key</label>
          <div className="model-secret-input">
            <input ref={secretInput} id={secretId} type={secretVisible ? 'text' : 'password'} autoComplete="new-password" autoCapitalize="none" spellCheck={false} aria-required={!keyOptional && !hasSavedSecret || undefined} aria-invalid={discoveryError?.field === 'secret' || undefined} aria-describedby={`${secretId}-hint`} value={secret} onChange={event => changeSecret(event.target.value)} placeholder={hasSavedSecret ? '••••••••••••' : '输入密钥'} />
            <IconButton label={secretVisible ? '隐藏密钥' : '显示密钥'} aria-pressed={secretVisible} aria-controls={secretId} disabled={!secret} onClick={() => setSecretVisible(value => !value)}>{secretVisible ? <EyeOff size={16} /> : <Eye size={16} />}</IconButton>
          </div>
          <span id={`${secretId}-hint`} className={discoveryError?.field === 'secret' ? 'field-error' : 'field__hint'} role={discoveryError?.field === 'secret' ? 'alert' : undefined}>{discoveryError?.field === 'secret' ? discoveryError.message : hasSavedSecret ? '已保存密钥，留空沿用。' : keyOptional ? '免鉴权服务可留空。' : '请填写服务的 API Key。'}</span>
        </div>
        <div className="model-discovery">
          <div className="field">
            <label className="field__label" htmlFor={modelInputId}>模型 ID</label>
            <Combobox id={modelInputId} label="模型 ID" descriptionId={`${modelInputId}-hint`} required value={selectedModelId} items={modelItems} disabled={busy || discovering || !modelItems.length || discovery?.source === 'workflow'} placeholder={discovering ? '正在读取模型…' : !modelItems.length ? discovery ? '暂无可用模型' : '请先获取模型列表' : '选择模型，可输入搜索'} onChange={setModelId} action={<IconButton label="获取模型列表" disabled={busy || discovering} aria-busy={discovering || undefined} onClick={() => void discover()}>{discovering ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}</IconButton>} />
          </div>
          <p id={`${modelInputId}-hint`} className="field__hint" role="status">{discovering ? '正在读取模型列表…' : discovery?.message ?? '点击右侧按钮获取模型列表。'}</p>
        </div>
        {(connectionError || saveError) && <div role="alert" className="field-error">{connectionError || saveError}</div>}
      </div>
      <div className="dialog__footer"><Button onClick={close}>取消</Button><Button aria-label="保存连接" variant="primary" type="submit" busy={busy} disabled={!selectedModelId || discovering || Boolean(connectionError)}>保存</Button></div>
    </form>
  </Dialog>;
}
