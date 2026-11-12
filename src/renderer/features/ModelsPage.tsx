import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Code2, Eye, EyeOff, Image, LoaderCircle, Pencil, RefreshCw, Server, Trash2, Video, Plus, Download } from 'lucide-react';
import { modelConnectionTypes, getModelConnectionType, validateModelConnection, modelToolProtocolIssue, platformForConnection, modelAuthModeSchema, modelDiscoverySchema, type ModelAuthMode, type ModelDiscovery, type ModelConnectionType, getModelParameterFields, getMediaAdapters, mediaAdapters, textProtocols, textProtocolSchema, type TextProtocol } from '@video-quickly/contracts';
import { currencySchema, jsonValueSchema, modelPlatforms, getModelPlatform, modelPlatformSchema, modelPricingSchema, validateModelParameters, type ModelPricing, type ModelPlatform, type JsonValue, type ModelCapability, type ModelProfile } from '@video-quickly/contracts';
import { Button, Combobox, Dialog, EmptyState, Field, IconButton, Notice, Select } from '../components/Primitives';
import type { Action, WorkspaceView } from '../lib/types';
import { beginGuideAction } from '../lib/guide-actions';
import { useConfirmation } from '../components/ConfirmationDialog';
import { rpc } from '../lib/client';
import ModelParameters, { modelParameterSections } from '../components/ModelParameters';
import SettingsSections from '../components/SettingsSections';
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

const pricingFields = [
  { key: 'perImage', capability: 'image', label: '每张图片单价' },
  { key: 'perVideoSecond', capability: 'video', label: '每秒视频单价' },
  { key: 'inputPerMillionTokens', capability: 'text', label: '每百万输入 Token 单价' },
  { key: 'outputPerMillionTokens', capability: 'text', label: '每百万输出 Token 单价' },
] as const;

function ModelDialog({ model, connectionType: addingType = 'text', action, onClose }: { model?: ModelProfile; connectionType?: ModelConnectionType; action: Action; onClose: () => void }) {
  const connectionType = model ? getModelConnectionType(model) : addingType;
  const definition = modelConnectionTypes.find(type => type.id === connectionType)!;
  const initialPreset = platformForConnection(definition.platforms[0]);
  const [name, setName] = useState(model?.name ?? '');
  const [platform, setPlatform] = useState<ModelPlatform>(model ? getModelPlatform(model).id : initialPreset.id);
  const [provider, setProvider] = useState<ModelProfile['provider']>(model?.provider ?? initialPreset.provider);
  const [textProtocol, setTextProtocol] = useState<TextProtocol>(model?.textProtocol ?? initialPreset.textProtocol ?? 'chat-completions');
  const [authMode, setAuthMode] = useState<ModelAuthMode>(model?.authMode ?? 'protocol-default');
  const [fullUrl, setFullUrl] = useState(model?.fullUrl ?? false);
  const preset = platformForConnection(platform, connectionType);
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? initialPreset.baseUrl);
  const [modelId, setModelId] = useState(model?.model ?? '');
  const [modelSource, setModelSource] = useState<'catalog' | 'manual'>('catalog');
  const [secret, setSecret] = useState('');
  const draftSecretOrigin = useRef<string | undefined>(undefined);
  const secretValue = secret.trim();
  const [secretVisible, setSecretVisible] = useState(false);
  const secretId = useId();
  const modelInputId = useId();
  const addressErrorId = useId();
  const baseUrlInput = useRef<HTMLInputElement>(null), secretInput = useRef<HTMLInputElement>(null);
  const [section, setSection] = useState('connection');
  const discoveryFocus = useRef<'address' | 'secret' | undefined>(undefined);
  useLayoutEffect(() => {
    if (section !== 'connection' || !discoveryFocus.current) return;
    const field = discoveryFocus.current; discoveryFocus.current = undefined;
    (field === 'address' ? baseUrlInput : secretInput).current?.focus();
  }, [section]);
  const [capabilities, setCapabilities] = useState<ModelCapability[]>(model?.capabilities ?? [connectionType]);
  const [busy, setBusy] = useState(false);
  const [parametersText, setParametersText] = useState(JSON.stringify(model?.parameters ?? {}, null, 2));
  const [pricingDraft, setPricingDraft] = useState<{ key: string; currency: ModelPricing['currency']; rates: Partial<Record<typeof pricingFields[number]['key'], string>> }>();
  const [saveError, setSaveError] = useState('');
  const closed = useRef(false);
  useEffect(() => { closed.current = false; return () => { closed.current = true; }; }, []);
  function close() { closed.current = true; onClose(); }
  const [discoveryResult, setDiscoveryResult] = useState<{ key: string; catalog: ModelDiscovery }>();
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<{ field: 'address' | 'secret'; message: string }>();
  const discoveryGeneration = useRef(0);
  const discoveryKey = JSON.stringify([baseUrl, secretValue, provider, platform, connectionType, textProtocol, authMode, fullUrl]);
  const [savedDiscoveryKey] = useState(discoveryKey);
  const discovery = discoveryResult?.key === discoveryKey ? discoveryResult.catalog : undefined;
  const modelItems: ModelDiscovery['items'] = discovery?.items ?? (model && discoveryKey === savedDiscoveryKey ? [{ id: model.model, label: model.model, capabilities: model.capabilities }] : []);
  const manualModel = provider !== 'comfyui' && (fullUrl || modelSource === 'manual');
  const selectedModelId = manualModel ? modelId.trim() : modelItems.some(item => item.id === modelId) ? modelId : '';
  const pricingKey = JSON.stringify([provider, baseUrl.trim(), selectedModelId]);
  const savedPricing = model?.provider === provider && model.baseUrl === baseUrl.trim() && model.model === selectedModelId ? model.pricing : undefined;
  const pricingInput = pricingDraft?.key === pricingKey ? pricingDraft : {
    key: pricingKey, currency: savedPricing?.currency ?? 'CNY',
    rates: Object.fromEntries(pricingFields.map(({ key }) => [key, savedPricing?.[key]?.toString() ?? ''])),
  };
  const rates = Object.fromEntries(pricingFields.flatMap(({ key }) => {
    const value = pricingInput.rates[key];
    return value === undefined || value === '' ? [] : [[key, Number(value)]];
  }));
  const parsedPricing = modelPricingSchema.safeParse({ currency: pricingInput.currency, ...rates });
  const pricingError = parsedPricing.success ? '' : '请填写有效的非负单价。';
  let serviceUrl: URL | undefined;
  try { serviceUrl = new URL(baseUrl); } catch { /* An incomplete address is expected while editing. */ }
  const lastServiceOrigin = useRef(serviceUrl?.origin);
  const keyOptional = ['ollama', 'comfyui'].includes(provider) || Boolean(serviceUrl && ['localhost', '127.0.0.1', '[::1]'].includes(serviceUrl.hostname));
  const hasSavedSecret = Boolean(model?.hasSecret && new URL(model.baseUrl).origin === serviceUrl?.origin);
  function changeAddress(value: string) {
    if (URL.canParse(value)) {
      const origin = new URL(value).origin;
      if (draftSecretOrigin.current && draftSecretOrigin.current !== origin) {
        setSecret(''); setSecretVisible(false); draftSecretOrigin.current = undefined;
      }
      if (lastServiceOrigin.current && lastServiceOrigin.current !== origin) setCapabilities([connectionType]);
      lastServiceOrigin.current = origin;
    }
    setBaseUrl(value);
  }
  function changeSecret(value: string) {
    draftSecretOrigin.current = value.trim() ? serviceUrl?.origin : undefined;
    setSecret(value);
  }
  function changeModelSource(value: 'catalog' | 'manual') {
    if (value === 'manual') { discoveryGeneration.current++; setDiscovering(false); }
    setModelSource(value);
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
    if (section === 'connection') (error.field === 'address' ? baseUrlInput : secretInput).current?.focus();
    else { discoveryFocus.current = error.field; setSection('connection'); }
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
      const discovered = result.items.find(item => item.id === modelId)?.capabilities;
      if (discovered) setCapabilities(discovered);
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
  const configuration = { connectionType, provider, platform, baseUrl, fullUrl, authMode, model: selectedModelId, capabilities, textProtocol, parameters };
  const toolIssue = connectionType === 'text' ? modelToolProtocolIssue(configuration) : undefined;
  if (!jsonError) {
    try { validateModelConnection(configuration); validateModelParameters(configuration); }
    catch (error) { parameterError = error instanceof Error ? error.message : String(error); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaveError('');
    if (jsonError || parameterError || !parsedPricing.success || !selectedModelId || discovering || !validateConnectionInputs()) return;
    const completed = beginGuideAction('model-saved');
    setBusy(true);
    const pricing = Object.keys(rates).length ? parsedPricing.data : model?.pricing ? null : undefined;
    const result = await action('model.save', { model: { id: model?.id, name, ...configuration, pricing, textProtocol: connectionType === 'text' && provider !== 'ollama' ? textProtocol : undefined }, ...(secretValue ? { secret: secretValue } : {}) }, '模型连接已保存');
    if (closed.current) return;
    setBusy(false);
    if (result !== null) { completed(); onClose(); } else setSaveError('连接尚未保存，请核对提示后重试。');
  }
  const parameterFields = getModelParameterFields({ provider, capabilities, textProtocol });
  function chooseDiscoveredModel(id: string) {
    setModelId(id);
    setCapabilities(modelItems.find(item => item.id === id)?.capabilities ?? [connectionType]);
  }
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
        setPlatform(selected.id); setProvider(selected.provider); changeAddress(selected.baseUrl);
        setAuthMode('protocol-default'); setFullUrl(false);
        if (!jsonError) changeTextProtocol(selected.textProtocol ?? 'chat-completions');
        else setTextProtocol(selected.textProtocol ?? 'chat-completions');
        setCapabilities([connectionType]);
      }}>{!definition.platforms.includes(platform) && <option value={platform} disabled>请选择可用平台</option>}{platforms.map(item => <option key={item.id} value={item.id}><span className="platform-option"><PlatformIcon platform={item.id} /><span>{platformForConnection(item.id, connectionType).label}</span></span></option>)}</Select></Field>
      {capabilities.includes('text') && <Field label="API 协议"><Select value={provider === 'ollama' ? 'ollama' : textProtocol} disabled={busy || Boolean(jsonError) || provider === 'ollama'} onChange={event => changeTextProtocol(textProtocolSchema.parse(event.target.value))}>{provider === 'ollama' ? <option value="ollama">Ollama 原生 API</option> : textProtocols.map(protocol => <option key={protocol.id} value={protocol.id}>{protocol.label}</option>)}</Select></Field>}
      {mediaCapabilities.length > 0 && <Field label="API 协议"><Select value={provider} disabled={busy || platform !== 'custom'} onChange={event => setProvider(event.target.value as ModelProfile['provider'])}>{!adapters.some(adapter => adapter.id === provider) && <option value={provider} disabled>{mediaAdapters.find(adapter => adapter.id === provider)?.label ?? '当前接入方式'}</option>}{adapters.map(adapter => <option key={adapter.id} value={adapter.id}>{adapter.id === 'openai-compatible' ? connectionType === 'image' ? 'OpenAI Images API' : 'OpenAI 兼容视频接口' : adapter.label}</option>)}</Select></Field>}
      {connectionType === 'text' && <>
        <Field label="鉴权方式"><Select value={authMode} disabled={busy} onChange={event => setAuthMode(modelAuthModeSchema.parse(event.target.value))}><option value="protocol-default">按协议默认</option><option value="bearer">Bearer Token</option><option value="x-api-key">x-api-key</option></Select></Field>
        <Field label="服务地址格式"><Select value={fullUrl ? 'full' : 'prefix'} disabled={busy} onChange={event => setFullUrl(event.target.value === 'full')}><option value="prefix">API 地址前缀</option><option value="full">完整请求地址</option></Select></Field>
      </>}
      <Field label="服务地址" hint={fullUrl ? '填写生成接口的完整地址。' : preset.addressHint}><input ref={baseUrlInput} required type="url" aria-invalid={discoveryError?.field === 'address' || undefined} aria-describedby={discoveryError?.field === 'address' ? addressErrorId : undefined} value={baseUrl} onChange={event => changeAddress(event.target.value)} placeholder={fullUrl ? undefined : preset.addressPlaceholder} spellCheck={false} /></Field></div>
      {discoveryError?.field === 'address' && <p id={addressErrorId} className="field-error" role="alert">{discoveryError.message}</p>}
      <div className="field"><label className="field__label" htmlFor={secretId}>API Key</label><div className="model-secret-input"><input ref={secretInput} id={secretId} type={secretVisible ? 'text' : 'password'} autoComplete="new-password" autoCapitalize="none" spellCheck={false} aria-required={!keyOptional && !hasSavedSecret || undefined} aria-invalid={discoveryError?.field === 'secret' || undefined} aria-describedby={`${secretId}-hint`} value={secret} onChange={event => changeSecret(event.target.value)} placeholder={hasSavedSecret ? '••••••••••••' : '输入密钥'} /><IconButton label={secretVisible ? '隐藏密钥' : '显示密钥'} aria-pressed={secretVisible} aria-controls={secretId} disabled={!secret} onClick={() => setSecretVisible(value => !value)}>{secretVisible ? <EyeOff size={16} /> : <Eye size={16} />}</IconButton></div><span id={`${secretId}-hint`} className={discoveryError?.field === 'secret' ? 'field-error' : 'field__hint'} role={discoveryError?.field === 'secret' ? 'alert' : undefined}>{discoveryError?.field === 'secret' ? discoveryError.message : hasSavedSecret ? '已保存密钥，留空沿用。' : keyOptional ? '免鉴权服务可留空。' : '请填写服务的 API Key。'}</span></div>
      <div className="model-discovery">
        {provider !== 'comfyui' && !fullUrl && <Field label="模型来源"><Select value={modelSource} disabled={busy} onChange={event => changeModelSource(event.target.value === 'manual' ? 'manual' : 'catalog')}><option value="catalog">从模型目录选择</option><option value="manual">手动填写</option></Select></Field>}
        <div className="field"><label className="field__label" htmlFor={modelInputId}>模型 ID</label>
          {manualModel ? <input id={modelInputId} required maxLength={200} value={modelId} disabled={busy} onChange={event => {
            if (event.target.value.trim() !== modelId.trim()) setCapabilities([connectionType]);
            setModelId(event.target.value);
          }} aria-describedby={`${modelInputId}-hint`} />
            : <Combobox id={modelInputId} label="模型 ID" descriptionId={`${modelInputId}-hint`} required value={selectedModelId} items={modelItems} disabled={busy || discovering || !modelItems.length || discovery?.source === 'workflow'} placeholder={discovering ? '正在读取模型…' : !modelItems.length ? discovery ? '暂无可用模型' : '请先获取模型列表' : '选择模型，可输入搜索'} onChange={chooseDiscoveredModel} action={<IconButton label="获取模型列表" disabled={busy || discovering} aria-busy={discovering || undefined} onClick={() => void discover()}>{discovering ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}</IconButton>} />}
        </div><p id={`${modelInputId}-hint`} className="field__hint" role="status">{manualModel ? '填写服务实际接受的模型 ID 或推理接入点 ID。' : discovering ? '正在读取模型列表…' : discovery?.message ?? '点击右侧按钮获取模型列表。'}</p>
      </div>
      {connectionType === 'text' && <fieldset className="capability-fieldset"><legend>模型能力</legend>
        {definition.capabilities.filter(capability => capability !== 'text').map(capability => <label key={capability} className="field-inline">
          <input type="checkbox" checked={capabilities.includes(capability)} disabled={busy || capability === 'tools' && Boolean(toolIssue) && !capabilities.includes('tools')}
            onChange={event => setCapabilities(values => event.target.checked ? [...values, capability] : values.filter(value => value !== capability))} />{capabilityLabels[capability]}
        </label>)}
        <p className="field__hint">{toolIssue ?? '请按所选型号和 API 协议确认能力。工具调用用于剪辑 Agent。'}</p>
      </fieldset>}

      </> },
      ...modelParameterSections.filter(section => parameterFields.some(field => field.operation === section.id)).map(section => ({ id: section.id, label: section.label, content: <ModelParameters operation={section.id} provider={provider} textProtocol={textProtocol} capabilities={capabilities} value={parameters} disabled={busy || Boolean(jsonError)} onChange={changeParameters} /> })),
      { id: 'advanced', label: '高级设置', icon: Code2, content: <><h3>高级模型参数</h3>
        <details className="form-disclosure">
          <summary>费用估算</summary>
          <div className="form-disclosure__body form-stack">
            <p className="field__hint">填写当前连接的服务商单价，用于生成前估算。留空时显示费用暂无法估算。</p>
            <div className="model-connection-fields">
              <Field label="计费币种"><Select value={pricingInput.currency} disabled={busy} onChange={event => setPricingDraft({ ...pricingInput, currency: currencySchema.parse(event.target.value) })}><option value="CNY">人民币 CNY</option><option value="USD">美元 USD</option></Select></Field>
              {pricingFields.filter(field => capabilities.includes(field.capability)).map(({ key, label }) => <Field key={key} label={label}>
                <input type="number" inputMode="decimal" min="0" step="any" value={pricingInput.rates[key] ?? ''} disabled={busy}
                  onChange={event => setPricingDraft({ ...pricingInput, rates: { ...pricingInput.rates, [key]: event.target.value } })} />
              </Field>)}
            </div>
          </div>
        </details>
        <Field label="参数 JSON" hint={provider === 'comfyui' && connectionType === 'video' ? '填写视频工作流 workflow 和输入映射 inputMapping。' : provider === 'custom-http' ? '填写请求和响应映射。' : '与表单同步，保留未知字段。'}><textarea rows={12} aria-label="模型参数 JSON" spellCheck={false} value={parametersText} disabled={busy} onChange={event => { setParametersText(event.target.value); setSaveError(''); }} /></Field></> },
    ]} notice={<>
      {(jsonError || parameterError || pricingError) && <p role="alert" className="field-error">{jsonError || parameterError || pricingError}</p>}
      {saveError && <p role="alert" className="field-error">{saveError}</p>}
    </>} /></div>
    <div className="dialog__footer"><Button onClick={close}>取消</Button><Button aria-label="保存连接" variant="primary" type="submit" busy={busy} disabled={!selectedModelId || discovering || !capabilities.length || Boolean(jsonError || parameterError || pricingError)}>保存</Button></div>
  </form></Dialog>;
}
