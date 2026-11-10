import { desktopBridge, pathExample } from '../lib/desktop';
import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Code2, Eye, EyeOff, File, FileImage, FolderOpen, Image, Link, ListChecks, LoaderCircle, Mic, Pencil, RefreshCw, Search, Server, ShieldCheck, Trash2, Video, Upload, Plus, RotateCcw, Download, Check } from 'lucide-react';
import { modelConnectionTypes, getModelConnectionType, validateModelConnection, modelToolProtocolIssue, platformForConnection, modelAuthModeSchema, modelDiscoverySchema, type ModelAuthMode, type ModelDiscovery, type ModelConnectionType, getModelParameterFields, getMediaAdapters, mediaAdapters, textProtocols, textProtocolSchema, type TextProtocol } from '@video-quickly/contracts';
import { assetListItemSchema, currencySchema, isRunActive, projectDetailSchema, recordPageSchema, runSummarySchema, jsonValueSchema, modelPlatforms, getModelPlatform, modelPlatformSchema, modelPricingSchema, validateModelParameters, type ModelPricing, type ModelPlatform, type AssetListItem, type ProjectSummary, type JsonValue, type ModelCapability, type ModelProfile, type ProjectDocument } from '@video-quickly/contracts';
import { Button, Combobox, Dialog, EmptyState, Field, IconButton, Notice, Select } from '../components/Primitives';
import { ScenePreview } from '../components/ScenePreview';
import type { Action, WorkspaceView, StepOutputSelection } from '../lib/types';
import { useRecordPage } from '../lib/use-record-page';
import { useRuntimeRead } from '../lib/use-runtime-read';
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


export function ProjectsPage({ workspace, action, notify, onOpen, onCreate, onOpenOutput }: PageProps & { notify: (message: string, error?: boolean) => void; onOpen: (id: string) => void; onCreate: () => void; onOpenOutput: (value: StepOutputSelection) => void }) {
  const [worksOpen, setWorksOpen] = useState(false);
  const confirm = useConfirmation();
  const [search, setSearch] = useState('');
  const projectSearch = useRef<HTMLInputElement>(null);
  const [archived, setArchived] = useState(false);
  const [importing, setImporting] = useState(false);
  const [backupPath, setBackupPath] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>();
  const [removing, setRemoving] = useState(false);
  const selectionButton = useRef<HTMLButtonElement>(null);
  const removalInFlight = useRef(false);
  const [downloadingId, setDownloadingId] = useState<string>();
  const [videoExport, setVideoExport] = useState<{ title: string; name: string; runId: string }>();
  const [videoFile, setVideoFile] = useState<{ title: string; name: string; path: string; url?: string }>();
  const [videoError, setVideoError] = useState('');
  const downloadInFlight = useRef(false);
  const exportStatus = useRuntimeRead('run.get', { runId: videoExport?.runId }, workspace.version, runSummarySchema, Boolean(videoExport));
  const exportState = exportStatus.data?.status;
  const exportError = exportStatus.data?.error;

  useEffect(() => {
    if (!videoExport || !exportState) return;
    if (isRunActive(exportState) && !(exportState === 'queued' && exportError)) return;
    const { runId, title, name } = videoExport;
    let active = true;
    async function finish() {
      try {
        if (exportState !== 'succeeded') throw new Error(exportError ?? '完整视频导出未完成。');
        const output = await rpc<{ videoPath?: string } | null>('node.result', { runId, nodeId: 'export' });
        if (!output?.videoPath) throw new Error('导出完成，但找不到视频文件。');
        const url = nativeDesktop ? undefined : await getAssetUrl(output.videoPath);
        if (!active) return;
        setVideoFile({ title, name, path: output.videoPath, url });
        if (url) {
          const link = document.createElement('a');
          link.href = url;
          link.download = name;
          link.click();
        }
        notify(url ? '完整视频已生成' : '完整视频已保存');
      } catch (error) {
        if (active) {
          const message = error instanceof Error ? error.message : String(error);
          setVideoError(message);
          notify(message, true);
        }
      } finally {
        if (active) {
          downloadInFlight.current = false;
          setDownloadingId(undefined);
          setVideoExport(undefined);
        }
      }
    }
    void finish();
    return () => { active = false; };
  }, [videoExport, exportState, exportError, notify]);

  async function archiveProject(project: ProjectSummary) {
    if (!await confirm({ title: '将项目移入回收站？', description: `“${project.title}”将从全部项目中移除。项目与素材会保留，可在回收站恢复。`, confirmLabel: '移入回收站' })) return;
    await action('project.archive', { projectId: project.id }, '项目已移入回收站');
  }
  async function downloadProject(project: ProjectSummary) {
    if (downloadInFlight.current) return;
    downloadInFlight.current = true;
    setDownloadingId(project.id);
    setVideoFile(undefined);
    setVideoError('');
    const name = `${project.title.replace(/[<>:"/\\|?*.\u0000-\u001f]/g, '_').trim().slice(0, 100) || '项目'}-成片.mp4`;
    let started = false;
    try {
      const desktop = desktopBridge();
      const destination = await desktop?.pickPath({ mode: 'save', title: '保存完整视频', defaultPath: name, extensions: ['mp4'] });
      if (desktop && !destination) return;
      const result = await action<{ runId: string }>('render.export', { projectId: project.id, revision: project.revision, destination });
      if (result) {
        setVideoExport({ title: project.title, name, runId: result.runId });
        started = true;
      }
    } catch (error) {
      setVideoError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!started) { downloadInFlight.current = false; setDownloadingId(undefined); }
    }
  }
  if (worksOpen) return <Suspense fallback={<p role="status">正在读取作品…</p>}><WorksPanel workspace={workspace} notify={notify} onBack={() => setWorksOpen(false)} onOpen={onOpen} onOpenOutput={onOpenOutput} /></Suspense>;
  const projectsInView = workspace.projects.filter(project => project.archived === archived);
  const query = search.trim().toLocaleLowerCase();
  const projects = projectsInView.filter(project => `${project.title} ${project.brief}`.toLocaleLowerCase().includes(query));
  const selecting = !archived && selectedIds !== undefined;
  const selected = selecting ? projects.filter(project => selectedIds.has(project.id)) : [];
  const allSelected = projects.length > 0 && selected.length === projects.length;
  const noMatches = Boolean(query && projectsInView.length && !projects.length);
  function changeSearch(value: string) {
    setSearch(value);
    setSelectedIds(ids => ids && new Set());
  }
  function clearSearch() {
    changeSearch('');
    projectSearch.current?.focus();
  }
  async function removeSelected() {
    if (removalInFlight.current || !selected.length) return;
    removalInFlight.current = true;
    try {
      if (!await confirm({ title: '批量删除项目？', description: `将 ${selected.length} 个项目移入回收站。项目与素材会保留，可在回收站恢复。`, confirmLabel: '移入回收站' })) return;
      setRemoving(true);
      const result = await action('project.archiveMany', { projectIds: selected.map(project => project.id) }, '所选项目已移入回收站');
      if (result !== null) setSelectedIds(new Set());
    } finally {
      removalInFlight.current = false;
      setRemoving(false);
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) selectionButton.current?.focus({ preventScroll: true });
      });
    }
  }
  return <div className="content-page">
    <div className="page-heading">
      <div><h1>我的项目</h1></div>
      <div className="heading-actions">
        <Button onClick={() => setWorksOpen(true)}>作品与分集</Button>
        <Button aria-label="导入项目" onClick={() => setImporting(true)}><Upload size={15} />导入</Button>
        <Button variant="primary" onClick={onCreate}><Plus size={16} />新建项目</Button>
      </div>
    </div>
    <div className={`page-toolbar library-toolbar${selecting ? ' library-toolbar--selecting' : ''}`}>
      <div className="search-field">
        <Search size={16} aria-hidden="true" />
        <input ref={projectSearch} aria-label="搜索项目" placeholder="搜索项目" value={search} disabled={removing} onChange={event => changeSearch(event.target.value)} />
      </div>
      <div className="tabs">
        <button aria-label="全部项目" aria-pressed={!archived} className={!archived ? 'active' : ''} disabled={removing} onClick={() => setArchived(false)}>
          全部 <small>{workspace.projects.filter(project => !project.archived).length}</small>
        </button>
        <button aria-pressed={archived} className={archived ? 'active' : ''} disabled={removing} onClick={() => { setSelectedIds(undefined); setArchived(true); }}><Trash2 size={13} />回收站</button>
      </div>
      {!archived && <div className="library-toolbar__actions">
        {selecting && <>
          <label className="library-toolbar__select-all">
            <input type="checkbox" checked={allSelected} disabled={removing || !projects.length} ref={input => {
              if (input) input.indeterminate = selected.length > 0 && !allSelected;
            }} onChange={event => setSelectedIds(new Set(event.target.checked ? projects.map(project => project.id) : []))} />
            全选当前结果
          </label>
          <span className="tiny-meta" role="status">已选 {selected.length} 项</span>
          <Button variant="danger" busy={removing} disabled={!selected.length} onClick={() => void removeSelected()}><Trash2 size={15} />批量删除</Button>
        </>}
        <Button ref={selectionButton} disabled={removing || (!selecting && !projects.length)} onClick={() => setSelectedIds(selecting ? undefined : new Set())}>
          <ListChecks size={15} />{selecting ? '退出多选' : '多选'}
        </Button>
      </div>}
    </div>
    {videoExport && (exportStatus.error ? <Notice kind="error"><span>{exportStatus.error}</span><Button onClick={() => void exportStatus.refresh()}>重试读取</Button></Notice> : <Notice>正在导出“{videoExport.title}”的完整视频…</Notice>)}
    {videoError && <Notice kind="error">{videoError}</Notice>}
    {videoFile && <Notice kind="success">
      <span>{videoFile.url ? `“${videoFile.title}”的完整视频已生成。` : `完整视频已保存到 ${videoFile.path}`}</span>
      {videoFile.url ? <a className="button" href={videoFile.url} download={videoFile.name}>下载 MP4</a> : <Button onClick={() => void revealFile(videoFile.path).catch(error => setVideoError(error instanceof Error ? error.message : String(error)))}>打开保存位置</Button>}
    </Notice>}
    <section className="project-cards" aria-label="项目列表">
      {projects.map(project => <article className="project-card" key={project.id} data-selected={selecting && selectedIds.has(project.id) || undefined}>
        <div className="project-card-preview">
          {project.thumbnailShot && <ScenePreview project={project} shot={project.thumbnailShot} shotIndex={0} assets={project.thumbnailAsset ? [project.thumbnailAsset] : []} thumbnail />}
          <span className="pill">{project.templateId === 'history-handdrawn' ? '历史手绘' : '通用视频'}</span>
          {selecting && <label className="library-card-choice project-card-choice">
            <input type="checkbox" aria-label={`选择“${project.title}”`} checked={selectedIds.has(project.id)} disabled={removing} onChange={event => {
              const next = new Set(selectedIds);
              if (event.target.checked) next.add(project.id);
              else next.delete(project.id);
              setSelectedIds(next);
            }} />
          </label>}
        </div>
        <div className="project-card-body">
          <h3>{project.title}</h3>
          {project.episode && <p className="tiny-meta">作品分集 · 第 {project.episode.number} 集</p>}
          {!project.episode && project.episodeSource && <p className="tiny-meta">来源：{project.episodeSource.workTitle} · 第 {project.episodeSource.number} 集</p>}
          <div className="project-card-footer">
            <span className="tiny-meta">{new Date(project.updatedAt).toLocaleDateString('zh-CN')}</span>
            {archived ? <Button onClick={() => void action('project.restore', { projectId: project.id }, '项目已恢复')}><RotateCcw size={14} />恢复项目</Button> : !selecting && <>
              <IconButton label={`下载“${project.title}”的完整视频`} title={project.shotCount ? '下载完整视频（MP4）' : '添加镜头后可下载完整视频'} disabled={Boolean(downloadingId) || !project.shotCount} onClick={() => void downloadProject(project)}>
                {downloadingId === project.id ? <LoaderCircle className="spin" size={14} /> : <Download size={15} />}
              </IconButton>
              <IconButton label={`将“${project.title}”移入回收站`} onClick={() => void archiveProject(project)}><Trash2 size={14} /></IconButton>
              <Button data-guide="project-open" onClick={() => onOpen(project.id)}>继续创作</Button>
            </>}
          </div>
        </div>
      </article>)}
      {!projects.length && <EmptyState icon={<FolderOpen size={25} />}
        title={noMatches ? '没有匹配的项目' : archived ? '回收站为空' : '还没有视频项目'}
        description={noMatches ? '换个关键词，或清除搜索。' : archived ? '移入回收站的项目可在这里恢复。' : '新建项目后即可开始创作。'}>
        {noMatches && <Button onClick={clearSearch}>清除搜索</Button>}
      </EmptyState>}
    </section>
    {importing && <Dialog title="导入项目备份" onClose={() => setImporting(false)}>
      <form onSubmit={event => {
        event.preventDefault();
        setImportBusy(true);
        void action<ProjectDocument>('project.importBackup', { path: backupPath }, '项目备份已导入').then(result => {
          setImportBusy(false);
          if (result) { setImporting(false); onOpen(result.id); }
        });
      }}>
        <div className="dialog__body">
          <Field label="项目备份路径" hint="选择备份目录或 project.json。">
            <PathPicker label="项目备份路径" mode="directory" autoFocus required value={backupPath} onChange={setBackupPath} placeholder={pathExample('backup')} />
          </Field>
          <p className="tiny-meta">将创建独立项目，并校验和复制备份素材。</p>
        </div>
        <div className="dialog__footer">
          <Button onClick={() => setImporting(false)}>取消</Button>
          <Button aria-label="导入备份" type="submit" variant="primary" busy={importBusy}><Upload size={15} />导入</Button>
        </div>
      </form>
    </Dialog>}
  </div>;
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
      }}>{platforms.map(item => <option key={item.id} value={item.id}><span className="platform-option"><PlatformIcon platform={item.id} /><span>{platformForConnection(item.id, connectionType).label}</span></span></option>)}</Select></Field>
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
        <Field label="参数 JSON" hint="与表单同步，保留未知字段。ComfyUI 填写 workflow/inputMapping；自定义 HTTP 填写请求和响应映射。"><textarea rows={12} aria-label="模型参数 JSON" spellCheck={false} value={parametersText} disabled={busy} onChange={event => { setParametersText(event.target.value); setSaveError(''); }} /></Field></> },
    ]} notice={<>
      {(jsonError || parameterError || pricingError) && <p role="alert" className="field-error">{jsonError || parameterError || pricingError}</p>}
      {saveError && <p role="alert" className="field-error">{saveError}</p>}
    </>} /></div>
    <div className="dialog__footer"><Button onClick={close}>取消</Button><Button aria-label="保存连接" variant="primary" type="submit" busy={busy} disabled={!selectedModelId || discovering || !capabilities.length || Boolean(jsonError || parameterError || pricingError)}>保存</Button></div>
  </form></Dialog>;
}

export { default as SkillsPage } from './SkillStudio';

function canRemoveAsset(asset: AssetListItem) {
  return !asset.inUse && !asset.retained;
}

export function AssetsPage({ workspace, action, project }: PageProps & { project?: ProjectDocument }) {
  const [importing, setImporting] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [source, setSource] = useState('');
  const [filter, setFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>();
  const [removing, setRemoving] = useState(false);
  const allAssets = useRef<HTMLButtonElement>(null);
  const selectionButton = useRef<HTMLButtonElement>(null);
  const removalInFlight = useRef(false);
  const confirm = useConfirmation();
  const library = useRecordPage('asset.list', filter === 'all' ? {} : { kind: filter }, workspace.version, assetsPageSchema, workspace.assetsVersion);
  const assets = library.stale ? [] : library.items;
  const loading = !assets.length && !library.error && (library.busy || !library.hasLoaded);
  const removable = selectedIds ? assets.filter(canRemoveAsset) : [];
  const selected = removable.filter(asset => selectedIds?.has(asset.id));
  const allSelected = removable.length > 0 && selected.length === removable.length;
  const projects = workspace.projects.filter(item => !item.archived);

  useEffect(() => {
    if (!library.hasLoaded || library.stale) return;
    setSelectedIds(ids => {
      if (!ids?.size) return ids;
      const current = library.items.filter(asset => ids.has(asset.id) && canRemoveAsset(asset));
      return current.length === ids.size ? ids : new Set(current.map(asset => asset.id));
    });
  }, [library.hasLoaded, library.items, library.stale]);

  function changeFilter(value: string) {
    if (value === filter) return;
    setSelectedIds(ids => ids && new Set());
    setFilter(value);
  }
  function showAllAssets() {
    changeFilter('all');
    allAssets.current?.focus();
  }
  function selectAsset(id: string, checked: boolean) {
    setSelectedIds(ids => {
      if (!ids) return ids;
      const next = new Set(ids);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  async function removeSelected() {
    if (removalInFlight.current || !selected.length) return;
    removalInFlight.current = true;
    try {
      if (!await confirm({ title: '批量移除素材记录？', description: `将从素材库中移除 ${selected.length} 条记录，素材文件会保留。需要再次使用时可重新导入。`, confirmLabel: '确认移除' })) return;
      setRemoving(true);
      const result = await action('asset.deleteMany', { assetIds: selected.map(asset => asset.id) }, `已移除 ${selected.length} 条素材记录`);
      if (result !== null) setSelectedIds(ids => ids && new Set());
      else library.refresh();
      if (document.activeElement === document.body) selectionButton.current?.focus({ preventScroll: true });
    } finally {
      removalInFlight.current = false;
      setRemoving(false);
    }
  }
  return <div className="content-page">
    <div className="page-heading">
      <h1>素材库</h1>
      <div className="heading-actions">
        <Button aria-label="恢复缺失素材" onClick={() => setRecovering(true)}><RotateCcw size={15} />恢复缺失素材</Button>
        <Button aria-label="导入素材" variant="primary" onClick={() => setImporting(true)}><Upload size={15} />导入</Button>
      </div>
    </div>
    <div className={`page-toolbar library-toolbar${selectedIds ? ' library-toolbar--selecting' : ''}`}>
      <div className="tabs">{[['all', '全部'], ['image', '图片'], ['video', '视频'], ['audio', '音频'], ['document', '资料']].map(([value, label]) => <button key={value} ref={value === 'all' ? allAssets : undefined} aria-pressed={filter === value} className={filter === value ? 'active' : ''} disabled={removing} onClick={() => changeFilter(value)}>{label}</button>)}</div>
      <div className="library-toolbar__actions">
        {selectedIds ? <>
          <label className="library-toolbar__select-all" title="选择当前筛选中已加载且可移除的素材">
            <input type="checkbox" checked={allSelected} disabled={removing || !removable.length} ref={input => {
              if (input) input.indeterminate = selected.length > 0 && !allSelected;
            }} onChange={event => setSelectedIds(new Set(event.target.checked ? removable.map(asset => asset.id) : []))} />
            全选已加载
          </label>
          <span className="tiny-meta" role="status">已选 {selected.length} 项</span>
          <Button variant="danger" busy={removing} disabled={!selected.length} onClick={() => void removeSelected()}><Trash2 size={15} />批量移除</Button>
        </> : library.hasLoaded && !library.stale && <span className="tiny-meta">{assets.length} 个素材</span>}
        <Button ref={selectionButton} disabled={!selectedIds && (removing || !assets.length)} onClick={() => setSelectedIds(ids => ids ? undefined : new Set())}>
          <ListChecks size={15} />{selectedIds ? '退出多选' : '多选'}
        </Button>
      </div>
    </div>
    {library.error && <Notice kind="error">{library.error}<Button aria-label="重试读取素材" onClick={library.refresh}>重试</Button></Notice>}
    {loading && <p role="status" className="muted">正在读取素材…</p>}
    {assets.length > 0 && <div className="asset-grid">{assets.map(asset => <AssetCard key={asset.id} asset={asset} action={action} projects={projects} initialProject={project}
      selection={selectedIds ? { checked: selectedIds.has(asset.id), busy: removing, onChange: checked => selectAsset(asset.id, checked) } : undefined} />)}</div>}
    {!loading && !library.error && assets.length === 0 && <EmptyState icon={<Image size={25} />} title={filter === 'all' ? '还没有素材' : '没有此类素材'} description={filter === 'all' ? '导入自有或已授权的图片、视频、音频和资料。' : '查看全部素材，或导入此类型的文件。'}>{filter !== 'all' && <Button onClick={showAllAssets}>查看全部素材</Button>}</EmptyState>}
    {!library.stale && library.nextCursor !== null && <Button aria-label="加载更多素材" className="button-full" busy={library.loadingMore} disabled={!library.canLoadMore} onClick={() => void library.loadMore()}>加载更多</Button>}{importing && <Dialog title="导入本地素材" onClose={() => setImporting(false)}><form onSubmit={event => { event.preventDefault(); void action('asset.import', { path: source, projectId: project?.id }, '素材已导入').then(result => { if (result !== null) { setImporting(false); setSource(''); } }); }}><div className="dialog__body"><Field label="文件路径"><PathPicker label="文件路径" autoFocus required value={source} onChange={setSource} placeholder={pathExample('image')} /></Field><p className="tiny-meta">请使用自己创作或已获授权的素材。源文件会保留。</p></div><div className="dialog__footer"><Button onClick={() => setImporting(false)}>取消</Button><Button variant="primary" type="submit"><Upload size={15} />导入</Button></div></form></Dialog>}{recovering && <Suspense fallback={null}><AssetRecoveryDialog project={project} directory={workspace.system.dataDirectory} onClose={() => setRecovering(false)} /></Suspense>}</div>;
}

function AssetCard({ asset, action, projects, initialProject, selection }: {
  asset: AssetListItem; action: Action; projects: ProjectSummary[]; initialProject?: ProjectDocument;
  selection?: { checked: boolean; busy: boolean; onChange: (checked: boolean) => void };
}) {
  const [cuttingGrid, setCuttingGrid] = useState(false);
  const [previewing, setPreviewing] = useState(false);
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
  const [loadedTarget, setTarget] = useState<ProjectDocument>();
  const [targetError, setTargetError] = useState('');
  const [targetReload, setTargetReload] = useState(0);
  const target = loadedTarget?.id === projectId ? loadedTarget : undefined;
  useEffect(() => {
    let active = true;
    setError(false); setImage(undefined);
    if (asset.kind === 'image') void getAssetUrl(asset.path).then(url => { if (active) setImage(assetAvailabilityUrl(url, asset.id)); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [asset.kind, asset.path, availability]);
  useEffect(() => {
    if (!selecting || !projectId) return;
    let active = true; setTarget(undefined); setTargetError(''); setShotId('');
    void rpc('project.get', { projectId }).then(value => {
      const project = projectDetailSchema.parse(value).project;
      if (active) { setTarget(project); setShotId(project?.shots[0]?.id ?? ''); }
    }).catch(error => { if (active) setTargetError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [selecting, projectId, targetReload]);
  const targetLoading = Boolean(projectId && !target && !targetError);
  const shotPlaceholder = !projectId ? '先选择项目' : targetError ? '镜头读取失败' : targetLoading ? '正在读取镜头…' : '暂无镜头';
  const removable = canRemoveAsset(asset);
  const checked = removable && selection?.checked;
  const source = asset.provenance === '用户导入' ? undefined : asset.provenance;
  const size = asset.size < 1024 * 1024 ? `${Math.round(asset.size / 1024)} KB` : `${(asset.size / (1024 * 1024)).toFixed(1)} MB`;
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
  const thumbnail = image && !error ? <img src={image} alt={asset.name} loading="lazy" decoding="async" onError={() => setError(true)} /> : <Icon size={31} role={error ? 'img' : undefined} aria-label={error ? `无法预览“${asset.name}”` : undefined} />;
  return <article className="asset-card" data-selected={checked || undefined}>
    <div className="asset-card__preview">
      {image && !error && !selection ? <button type="button" className="asset-card__image-button" aria-label={`预览“${asset.name}”`} title="查看大图" onClick={() => setPreviewing(true)}>{thumbnail}</button> : thumbnail}
      {selection && <label className="library-card-choice">
        <input type="checkbox" aria-label={`选择“${asset.name}”`} checked={Boolean(checked)} disabled={selection.busy || !removable} onChange={event => selection.onChange(event.target.checked)} />
      </label>}
    </div>
    <div className="asset-card__details">
      <h3 title={asset.name}>{asset.name}</h3>
      <div className="asset-card__meta">
        <span>{size}</span>
        {asset.inUse && <span>使用中</span>}
        {asset.retained && <span>已保留</span>}
        {source && <span className="asset-card__source" title={source}>{source}</span>}
      </div>
    </div>
    {!selection && <div className="asset-actions">
      {asset.kind === 'image' && <IconButton label={`网格切图“${asset.name}”`} onClick={() => setCuttingGrid(true)}><FileImage size={15} /></IconButton>}
      {media && <IconButton label={`将“${asset.name}”用于镜头`} onClick={() => { setSelecting(true); setShotId(target?.shots[0]?.id ?? ''); }}><Link size={15} /></IconButton>}
      <IconButton label={asset.retained ? '取消保留此版本' : '保留此版本'} aria-pressed={asset.retained} onClick={() => void action('asset.retain', { assetId: asset.id, retained: !asset.retained }, asset.retained ? '已取消保留' : '此版本已保留')}><ShieldCheck size={15} /></IconButton>
      <IconButton label={`移除素材“${asset.name}”`} disabled={!removable} onClick={() => void removeAsset()}><Trash2 size={15} /></IconButton>
    </div>}
    {previewing && <Dialog title={asset.name} className="dialog--wide asset-image-dialog" onClose={() => setPreviewing(false)}>
      <div className="dialog__body">
        {image && !error ? <img src={image} alt={asset.name} decoding="async" onError={() => setError(true)} /> : <Notice kind="error">无法读取此图片。</Notice>}
      </div>
    </Dialog>}
    {selecting && <Dialog title="应用素材到镜头" onClose={() => setSelecting(false)}><div className="dialog__body"><p>{asset.name}</p>{targetError && <Notice kind="error">{targetError}<Button aria-label="重试读取目标镜头" onClick={() => setTargetReload(value => value + 1)}>重试</Button></Notice>}<Field label="目标项目"><Select value={projectId} disabled={!projects.length} onChange={event => { setProjectId(event.target.value); setShotId(''); }}><option value="" disabled>{projects.length ? '选择项目' : '暂无项目'}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</Select></Field><Field label="目标镜头"><Select value={shotId} disabled={!target?.shots.length} aria-busy={targetLoading} onChange={event => setShotId(event.target.value)}><option key={shotPlaceholder} value="" disabled>{shotPlaceholder}</option>{target?.shots.map((shot, index) => <option key={shot.id} value={shot.id}>{index + 1}. {shot.title}</option>)}</Select></Field>{asset.projectId && target && asset.projectId !== target.id && <Notice>素材将复制到目标项目，源项目保持独立。</Notice>}</div><div className="dialog__footer"><Button onClick={() => setSelecting(false)}>取消</Button><Button aria-label="应用此版本" variant="primary" disabled={!target || !shotId} onClick={() => void apply()}><Check size={14} />应用</Button></div></Dialog>}
    {cuttingGrid && <Suspense fallback={null}><ImageGridDialog asset={asset} onClose={() => setCuttingGrid(false)} /></Suspense>}
  </article>;
}
