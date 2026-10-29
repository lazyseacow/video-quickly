import { useEffect, useState } from 'react';
import { BookOpen, Check, CheckCheck, CircleHelp, Copy, Download, File, FileImage, FolderOpen, History, Image, Link, Mic, MoreHorizontal, Pencil, Plus, Power, RefreshCw, RotateCcw, Search, Server, ShieldCheck, Sparkles, Square, Trash2, Upload, Video } from 'lucide-react';
import { assetListItemSchema, projectDetailSchema, recordPageSchema, jsonValueSchema, modelCapabilitySchema, modelPricingSchema, validateModelParameters, type AssetRecord, type AssetListItem, type ProjectSummary, type JsonValue, type ModelCapability, type ModelProfile, type ProjectDocument, type SkillPackage } from '@video-quickly/contracts';
import { Button, Dialog, EmptyState, Field, IconButton, Notice, Status, formatTime } from '../components/Primitives';
import { ScenePreview } from '../components/ScenePreview';
import type { Action, WorkspaceView } from '../lib/types';
import { useRecordPage } from '../lib/use-record-page';
export { default as RunsPage } from './RunHistory';
const assetsPageSchema = recordPageSchema(assetListItemSchema);
import { rpc } from '../lib/client';
import ToolConnections from './ToolConnections';
import PathPicker from '../components/PathPicker';
import ModelParameters from '../components/ModelParameters';
import ModelPricingEditor from '../components/ModelPricingEditor';

type PageProps = { workspace: WorkspaceView; action: Action };
const capabilityLabels: Record<ModelCapability, string> = { text: '文本', image: '图片', video: '视频', tts: '配音', asr: '语音识别', vision: '视觉输入', tools: '工具调用', 'structured-output': '结构化输出' };
const providerLabels: Record<ModelProfile['provider'], string> = { 'openai-compatible': 'OpenAI 兼容 API', ollama: 'Ollama', comfyui: 'ComfyUI', seedream: 'Seedream', seedance: 'Seedance', 'qwen-tts': 'Qwen TTS', 'custom-http': '自定义 HTTP' };

export function ProjectsPage({ workspace, action, onOpen, onCreate }: PageProps & { onOpen: (id: string) => void; onCreate: () => void }) {
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [importing, setImporting] = useState(false);
  const [backupPath, setBackupPath] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const projects = workspace.projects.filter(project => project.archived === archived && `${project.title}${project.brief}`.includes(search));
  return <div className="content-page"><div className="page-heading"><div><h1>我的项目</h1></div><div className="heading-actions"><Button onClick={() => setImporting(true)}><Upload size={15} />导入项目</Button><Button variant="primary" onClick={onCreate}><Plus size={16} />新建项目</Button></div></div><div className="page-toolbar"><div className="search-field"><Search size={16} /><input aria-label="搜索项目" placeholder="搜索项目" value={search} onChange={event => setSearch(event.target.value)} /></div><div className="tabs"><button className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>全部项目 <small>{workspace.projects.filter(project => !project.archived).length}</small></button><button className={archived ? 'active' : ''} onClick={() => setArchived(true)}><Trash2 size={13} />回收站</button></div></div>{projects.length ? <div className="project-cards">{projects.map(project => <article className="project-card" key={project.id}><div className="project-card-preview">{project.thumbnailShot && <ScenePreview project={project} shot={project.thumbnailShot} shotIndex={0} assets={project.thumbnailAsset ? [project.thumbnailAsset] : []} thumbnail />}<span className="pill">{project.templateId === 'history-handdrawn' ? '历史手绘' : '通用视频'}</span></div><div className="project-card-body"><h3>{project.title}</h3><p>{project.shotCount} 个镜头 · {formatTime(project.durationUs).split('.')[0]} · {project.profile.width} × {project.profile.height}</p><div className="project-card-footer"><span className="tiny-meta">{new Date(project.updatedAt).toLocaleDateString('zh-CN')}</span>{archived ? <Button onClick={() => void action('project.restore', { projectId: project.id }, '项目已恢复')}><RotateCcw size={14} />恢复项目</Button> : <><IconButton label={`将“${project.title}”移入回收站`} onClick={() => void action('project.archive', { projectId: project.id }, '项目已移入回收站')}><Trash2 size={14} /></IconButton><Button onClick={() => onOpen(project.id)}>继续创作 <span aria-hidden="true">↗</span></Button></>}</div></div></article>)}</div> : <EmptyState icon={<FolderOpen size={25} />} title={archived ? '回收站为空' : search ? '没有找到这个项目' : '开始你的第一个视频'} description={archived ? '移入回收站的项目会保留素材，随时可以恢复。' : search ? '试试其他关键词。' : '填写主题，选择视频规格，再逐步完成分镜和画面。'}>{!archived && !search && <Button variant="primary" onClick={onCreate}><Plus size={15} />新建项目</Button>}</EmptyState>}{importing && <Dialog title="导入项目备份" onClose={() => setImporting(false)}><form onSubmit={event => { event.preventDefault(); setImportBusy(true); void action<ProjectDocument>('project.importBackup', { path: backupPath }, '项目备份已导入').then(result => { setImportBusy(false); if (result) { setImporting(false); onOpen(result.id); } }); }}><div className="dialog__body"><Field label="项目备份路径" hint="选择备份目录或填写其中的 project.json 路径。"><PathPicker label="项目备份路径" mode="directory" autoFocus required value={backupPath} onChange={setBackupPath} placeholder="D:\Backups\我的视频项目" /></Field><p className="tiny-meta">将创建独立项目，并校验和复制备份素材。</p></div><div className="dialog__footer"><Button onClick={() => setImporting(false)}>取消</Button><Button type="submit" variant="primary" busy={importBusy}><Upload size={15} />导入备份</Button></div></form></Dialog>}</div>;
}

export function ModelsPage({ workspace, action }: PageProps) {
  const [editing, setEditing] = useState<ModelProfile | 'new' | null>(null);
  return <div className="content-page"><div className="page-heading"><div><h1>模型连接</h1><p>连接云端 API 或本地服务，为不同步骤选择合适的模型。</p></div><Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} />添加模型</Button></div><div className="settings-grid"><div>{workspace.models.length ? workspace.models.map(model => <article className="list-card" key={model.id}><div className="list-card__icon"><Server size={20} /></div><div className="list-card__body"><h3>{model.name}</h3><p>{providerLabels[model.provider]} · {model.model}</p><div className="pill-row">{model.capabilities.map(capability => <span className="pill" key={capability}>{capabilityLabels[capability]}</span>)}</div></div><div className="list-card__actions"><IconButton label={`检查“${model.name}”连接`} onClick={() => void action('model.test', { modelId: model.id }, '连接检查完成')}><RefreshCw size={16} /></IconButton><IconButton label={`编辑“${model.name}”`} onClick={() => setEditing(model)}><Pencil size={16} /></IconButton><IconButton label={`移除“${model.name}”`} onClick={() => void action('model.delete', { modelId: model.id }, '模型已移除')}><Trash2 size={16} /></IconButton></div></article>) : <div className="section-card"><EmptyState icon={<Server size={25} />} title="连接你的第一个模型" description="你可以先编辑分镜和使用本地素材。准备好后，再添加生成画面或旁白的模型。"><Button variant="primary" onClick={() => setEditing('new')}><Plus size={15} />添加模型</Button></EmptyState></div>}</div><aside><div className="section-card"><div className="list-help"><p>文本、图片、视频、配音和语音识别可使用不同服务。模型能力会用于检查步骤是否兼容。</p><p>Ollama 与 ComfyUI 连接到你已启动的本地服务。</p></div></div><div className="section-card"><div className="section-heading"><ShieldCheck size={17} /><h3>凭据保存在本机</h3></div><p className="list-help">密钥不会显示在项目、日志或导出文件中。编辑已有连接时，留空可保留原密钥。</p>{!workspace.system.secureStorageAvailable && <p className="field-error">系统安全存储当前不可用，密钥仅在本次会话中使用。</p>}</div></aside></div>{editing && <ModelDialog model={editing === 'new' ? undefined : editing} action={action} onClose={() => setEditing(null)} />}</div>;
}

function ModelDialog({ model, action, onClose }: { model?: ModelProfile; action: Action; onClose: () => void }) {
  const [name, setName] = useState(model?.name ?? '');
  const [provider, setProvider] = useState<ModelProfile['provider']>(model?.provider ?? 'openai-compatible');
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? 'https://api.openai.com/v1');
  const [modelId, setModelId] = useState(model?.model ?? '');
  const [secret, setSecret] = useState('');
  const [capabilities, setCapabilities] = useState<ModelCapability[]>(model?.capabilities ?? ['text']);
  const [busy, setBusy] = useState(false);
  const [parametersText, setParametersText] = useState(JSON.stringify(model?.parameters ?? {}, null, 2));
  const [pricing, setPricing] = useState<ModelProfile['pricing']>(model?.pricing ?? null);
  const [saveError, setSaveError] = useState('');
  let parameters: Record<string, JsonValue> = {}, jsonError = '', parameterError = '';
  try {
    const parsed = jsonValueSchema.parse(JSON.parse(parametersText));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数需要填写 JSON 对象。');
    parameters = parsed;
  } catch (error) { jsonError = error instanceof Error ? error.message : '参数 JSON 格式不正确。'; }
  if (!jsonError) {
    try { validateModelParameters({ provider, capabilities, parameters }); }
    catch (error) { parameterError = error instanceof Error ? error.message : String(error); }
  }
  const pricingError = pricing && !modelPricingSchema.safeParse(pricing).success ? '价格须为非负有限数值，请检查填写内容。' : '';
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaveError('');
    if (jsonError || parameterError || pricingError) return;
    setBusy(true);
    const result = await action('model.save', { model: { ...model, name, provider, baseUrl, model: modelId, capabilities, parameters, pricing }, ...(secret ? { secret } : {}) }, '模型连接已保存');
    setBusy(false);
    if (result !== null) onClose(); else setSaveError('连接尚未保存，请核对提示后重试。');
  }
  return <Dialog title={model ? '编辑模型连接' : '添加模型连接'} onClose={onClose} className="model-connection-dialog"><form onSubmit={event => void save(event)}>
    <div className="dialog__body">
      <Field label="连接名称"><input required autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="例如：本地分镜助手" /></Field>
      <Field label="服务协议"><select value={provider} onChange={event => { const selected = event.target.value as ModelProfile['provider']; setProvider(selected); if (!model) setBaseUrl(selected === 'ollama' ? 'http://127.0.0.1:11434' : selected === 'comfyui' ? 'http://127.0.0.1:8188' : 'https://api.openai.com/v1'); }}>{Object.entries(providerLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="服务地址"><input required type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} spellCheck={false} /></Field>
      <Field label="模型 ID"><input required value={modelId} onChange={event => setModelId(event.target.value)} placeholder="填写服务提供的模型名称" spellCheck={false} /></Field>
      <Field label="API Key" hint={model?.hasSecret ? '已保存密钥；留空保留原值。' : '本地免鉴权服务可留空。'}><input type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)} placeholder={model?.hasSecret ? '••••••••••••' : '输入密钥'} /></Field>
      <fieldset className="capability-fieldset"><legend>模型能力</legend><div className="capability-grid">{modelCapabilitySchema.options.map(capability => <label className="field-inline" key={capability}><input type="checkbox" checked={capabilities.includes(capability)} disabled={busy} onChange={event => setCapabilities(current => event.target.checked ? [...current, capability] : current.filter(item => item !== capability))} />{capabilityLabels[capability]}</label>)}</div></fieldset>
      <ModelParameters provider={provider} capabilities={capabilities} value={parameters} disabled={busy || Boolean(jsonError)} onChange={value => { setParametersText(JSON.stringify(value, null, 2)); setSaveError(''); }} />
      <details className="advanced-parameters"><summary>高级模型参数</summary><Field label="参数 JSON" hint="与上方表单同步，未知字段会保留。ComfyUI 使用 workflow/inputMapping，自定义 HTTP 使用请求与响应映射。"><textarea aria-label="模型参数 JSON" spellCheck={false} value={parametersText} disabled={busy} onChange={event => { setParametersText(event.target.value); setSaveError(''); }} /></Field></details>
      {(jsonError || parameterError) && <p role="alert" className="field-error">{jsonError || parameterError}</p>}
      <ModelPricingEditor value={pricing} disabled={busy} onChange={setPricing} />
      {(pricingError || saveError) && <p role="alert" className="field-error">{pricingError || saveError}</p>}
    </div>
    <div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" busy={busy} disabled={!capabilities.length || Boolean(jsonError || parameterError || pricingError)}>保存连接</Button></div>
  </form></Dialog>;
}

export function SkillsPage({ workspace, action }: PageProps) {
  const [importing, setImporting] = useState(false);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<SkillPackage | null>(null);
  const [instructions, setInstructions] = useState('');
  return <div className="content-page"><div className="page-heading"><div><h1>Skill 工作室</h1></div><Button variant="primary" onClick={() => setImporting(true)}><Plus size={16} />导入 Skill</Button></div><div className="settings-grid"><div>{workspace.skills.length ? workspace.skills.map(skill => <article className="list-card" key={skill.id}><div className="list-card__icon"><BookOpen size={20} /></div><div className="list-card__body"><h3>{skill.name}</h3><p>{skill.description}</p><div className="pill-row"><span className="pill">{skill.version.slice(0, 12)}</span><span className="pill">{skill.resources.length} 个资源</span>{skill.tools.length > 0 && <span className="pill">{skill.tools.length} 个工具</span>}</div></div><div className="list-card__actions"><IconButton label={`查看“${skill.name}”`} onClick={() => { setSelected(skill); setInstructions(skill.instructions); }}><Pencil size={16} /></IconButton><IconButton label={skill.enabled ? `停用“${skill.name}”` : `启用“${skill.name}”`} aria-pressed={skill.enabled} onClick={() => void action('skill.toggle', { skillId: skill.id, enabled: !skill.enabled }, skill.enabled ? 'Skill 已停用' : 'Skill 已启用')}><Power size={16} /></IconButton></div></article>) : <div className="section-card"><EmptyState icon={<BookOpen size={25} />} title="把你的方法加入创作" description="导入含 SKILL.md 的本地目录或 GitHub 链接，再将 Skill 绑定到工作流步骤。"><Button variant="primary" onClick={() => setImporting(true)}><Plus size={15} />导入 Skill</Button></EmptyState></div>}</div><aside><div className="section-card"><div className="list-help"><p>Skill 可以包含写作规范、风格参考、模板和工具说明。所需资源会随使用过程加载。</p><p>每次制作固定 Skill 版本，之后的修改不会改变正在进行的任务。</p><p>工具需要单独启用，并遵循该步骤的执行与恢复规则。</p></div></div></aside></div><ToolConnections action={action} />{importing && <Dialog title="导入 Skill" onClose={() => setImporting(false)}><form onSubmit={event => { event.preventDefault(); setBusy(true); void action('skill.import', /^https?:\/\//i.test(source) ? { url: source } : { path: source }, 'Skill 已导入').then(result => { setBusy(false); if (result !== null) { setImporting(false); setSource(''); } }); }}><div className="dialog__body"><Field label="目录路径或 GitHub 链接" hint="本地目录中应包含 SKILL.md 及其引用资源。"><PathPicker label="目录路径或 GitHub 链接" mode="directory" autoFocus required value={source} onChange={setSource} placeholder="D:\skills\history-handdrawn-video" /></Field></div><div className="dialog__footer"><Button onClick={() => setImporting(false)}>取消</Button><Button variant="primary" type="submit" busy={busy}><Download size={15} />导入</Button></div></form></Dialog>}{selected && <Dialog title={selected.name} onClose={() => setSelected(null)} className="dialog--wide"><div className="dialog__body"><p>{selected.description}</p><Field label="Skill 指令"><textarea className="skill-editor" value={instructions} onChange={event => setInstructions(event.target.value)} spellCheck={false} /></Field><p className="tiny-meta">来源：{selected.source}</p>{selected.tools.length > 0 && <div className="skill-tools"><h3>工具权限</h3>{selected.tools.map(tool => <label key={tool.id} className="field-inline"><input type="checkbox" checked={tool.enabled} onChange={event => { const enabled = event.target.checked; void action<SkillPackage>('skill.tool.toggle', { skillId: selected.id, toolId: tool.id, enabled }, '工具权限已更新').then(value => { if (value) setSelected(value); }); }} />{tool.label} <span className="tiny-meta">{tool.permissions.join('、')}</span></label>)}</div>}</div><div className="dialog__footer"><Button onClick={() => setSelected(null)}>关闭</Button><Button variant="primary" onClick={() => void action('skill.update', { skillId: selected.id, instructions }, 'Skill 已保存为新版本').then(result => { if (result !== null) setSelected(null); })}><Check size={15} />保存新版本</Button></div></Dialog>}</div>;
}

export function AssetsPage({ workspace, action, project }: PageProps & { project?: ProjectDocument }) {
  const [importing, setImporting] = useState(false);
  const [source, setSource] = useState('');
  const [filter, setFilter] = useState('all');
  const library = useRecordPage('asset.list', filter === 'all' ? {} : { kind: filter }, workspace.version, assetsPageSchema, workspace.assetsVersion);
  const assets = library.items;
  return <div className="content-page"><div className="page-heading"><div><h1>素材库</h1></div><Button variant="primary" onClick={() => setImporting(true)}><Upload size={15} />导入素材</Button></div><div className="page-toolbar"><div className="tabs">{[['all', '全部'], ['image', '图片'], ['video', '视频'], ['audio', '音频'], ['document', '资料']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><span className="tiny-meta">{assets.length} 个素材</span></div>{library.error && <Notice kind="error">{library.error}<Button onClick={library.refresh}>重试读取素材</Button></Notice>}{assets.length ? <div className="asset-grid">{assets.map(asset => <AssetCard key={asset.id} asset={asset} action={action} projects={workspace.projects.filter(item => !item.archived)} initialProject={project} />)}</div> : <div className="section-card"><EmptyState icon={<Image size={25} />} title="把素材带进工作台" description="导入自己创作或已获授权的图片、视频、录音和资料。" /></div>}{library.nextCursor !== null && <Button className="button-full" busy={library.busy} onClick={() => void library.loadMore()}>加载更多素材</Button>}{importing && <Dialog title="导入本地素材" onClose={() => setImporting(false)}><form onSubmit={event => { event.preventDefault(); void action('asset.import', { path: source, projectId: project?.id }, '素材已导入').then(result => { if (result !== null) { setImporting(false); setSource(''); } }); }}><div className="dialog__body"><Field label="文件路径"><PathPicker label="文件路径" autoFocus required value={source} onChange={setSource} placeholder="D:\materials\illustration.png" /></Field><p className="tiny-meta">请使用自己创作或已获授权的素材。源文件会保留。</p></div><div className="dialog__footer"><Button onClick={() => setImporting(false)}>取消</Button><Button variant="primary" type="submit"><Upload size={15} />导入</Button></div></form></Dialog>}</div>;
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
  return <article className="asset-card"><div className="asset-card__preview">{image ? <img src={image} alt={asset.name} /> : asset.kind === 'image' && !error ? <button className="asset-load" aria-label={`查看“${asset.name}”`} onClick={() => void rpc<{ dataUrl: string }>('asset.read', { assetId: asset.id }).then(result => setImage(result.dataUrl)).catch(() => setError(true))}><FileImage size={31} /><span>查看图片</span></button> : <Icon size={31} />}</div><h3>{asset.name}</h3><p>{asset.provenance} · v{asset.version}</p><div className="asset-card-footer"><span className="tiny-meta">{asset.size < 1024 * 1024 ? `${Math.round(asset.size / 1024)} KB` : `${(asset.size / (1024 * 1024)).toFixed(1)} MB`}{used ? ' · 使用中' : ''}</span><div className="asset-actions">{media && <IconButton label={`将“${asset.name}”用于镜头`} onClick={() => { setSelecting(true); setShotId(target?.shots[0]?.id ?? ''); }}><Link size={15} /></IconButton>}<IconButton label={asset.retained ? '取消保留此版本' : '保留此版本'} aria-pressed={asset.retained} onClick={() => void action('asset.retain', { assetId: asset.id, retained: !asset.retained }, asset.retained ? '已取消保留' : '此版本已保留')}><ShieldCheck size={15} /></IconButton><IconButton label={`移除素材“${asset.name}”`} disabled={used || asset.retained} onClick={() => void action('asset.delete', { assetId: asset.id }, '素材记录已移除')}><Trash2 size={15} /></IconButton></div></div>{selecting && <Dialog title="应用素材到镜头" onClose={() => setSelecting(false)}><div className="dialog__body"><p>{asset.name}</p>{targetError && <Notice kind="error">{targetError}</Notice>}<Field label="目标项目"><select value={projectId} onChange={event => { setProjectId(event.target.value); setShotId(''); }}><option value="" disabled>选择项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></Field><Field label="目标镜头"><select value={shotId} onChange={event => setShotId(event.target.value)}><option value="" disabled>选择镜头</option>{target?.shots.map((shot, index) => <option key={shot.id} value={shot.id}>{index + 1}. {shot.title}</option>)}</select></Field>{asset.projectId && asset.projectId !== target?.id && <Notice>素材将复制到目标项目，源项目保持独立。</Notice>}</div><div className="dialog__footer"><Button onClick={() => setSelecting(false)}>取消</Button><Button variant="primary" disabled={!target || !shotId} onClick={() => void apply()}><Check size={14} />应用此版本</Button></div></Dialog>}</article>;
}
