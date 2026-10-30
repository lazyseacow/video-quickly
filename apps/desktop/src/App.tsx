import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Undo2, Redo2, PanelLeft, PanelRight, PanelRightClose, ScanLine, ArrowDownToLine, ArrowLeft, ArrowRight, BookOpen, CircleAlert, Clapperboard, Download, FileText, Film, FolderOpen, GitBranch, History, Image, Layers, LockKeyhole, Maximize2, Mic, Palette, Play, Plus, Receipt, RefreshCw, Save, ShieldCheck, Sparkles, Square, UnlockKeyhole, Upload, Users, WandSparkles, X } from 'lucide-react';
import { applyShotCandidate, captionTrackSchema, runInspectionSchema, runStepPayloadSchema, DEFAULT_VIDEO_PROFILE, formatFrameRate, shotSchema, usesVideoAudio, videoProfileSchema, projectSchema, projectDetailSchema, workspaceSummarySchema, type AssetRecord, type CaptionTrack, type MusicClip, type ProjectDocument, type Shot, type ShotCandidate, type ShotCandidateField, type ShotCandidateKind, type VideoProfile, type ProjectDetail, type WorkflowNode } from '@video-quickly/contracts';
import { buildTimeline, createSrt } from '@video-quickly/video';
import { canSplitShot, splitShot, trimShotInContext } from '@video-quickly/video/editing';
import ClipTiming from './components/ClipTiming';
import { sourceDurationsKey, useSourceDuration } from './lib/source-duration';
import { createRefreshQueue } from './lib/refresh-queue';
import { Button, Dialog, EmptyState, Field, IconButton, Notice, Status, formatTime } from './components/Primitives';
import VideoSettings from './components/VideoSettings';
import PlaybackPreview from './components/PlaybackPreview';
import Timeline from './components/Timeline';
import { PlaybackClock } from './lib/playback';
import WorkspaceSidebar, { type Page } from './components/WorkspaceSidebar';
import ProjectOutline from './components/ProjectOutline';
import { PanelResizeHandle } from './components/PanelResizeHandle';
import RuntimeConnectionNotice from './components/RuntimeConnectionNotice';
import TabSurface from './components/TabSurface';
import ToastNotice, { type ToastMessage } from './components/ToastNotice';
import { useContentMotion } from './lib/motion';
import { runtimeConnectionSchema, type RuntimeConnection } from '@video-quickly/contracts';
import ToolBindings from './components/ToolBindings';
import PathPicker, { nativeDesktop, revealFile } from './components/PathPicker';
import { AssetsPage, ModelsPage, ProjectsPage, RunsPage, SkillsPage } from './features/LibraryPages';
import { rpc, subscribe } from './lib/client';
import type { Action, StepOutputSelection, WorkspaceView } from './lib/types';
import { useProjectEdits } from './lib/use-project-edits';
import { editContent, sameContent, sameWorkflow, type EditContent } from './lib/project-edits';
import DraftConflictDialog from './components/DraftConflictDialog';
import CaptionEditor from './components/CaptionEditor';
import MusicEditor from './components/MusicEditor';
import { transcribeCaptions } from './lib/transcribe';
import CharactersPage, { CharacterPicker } from './features/CharactersPage';
import CostsPage from './features/CostsPage';
import SceneTemplateEditor from './components/SceneTemplateEditor';
import BatchExportDialog from './components/BatchExportDialog';
import { applyResearchClaims, createSceneTemplate, recordPageSchema, researchResultSchema, seriesTemplateSchema, type CaptionStyle, type Claim, type ResearchResult, type SeriesSettings, type ShotClaims } from '@video-quickly/contracts';
import { analyzeResearch } from './lib/research';
import { applyClaimsEdits, type ClaimsEdits } from './lib/research-edits';
import { useRecordPage } from './lib/use-record-page';
import { applyCaptionStyleEdit, applySeriesEdit, rememberSeriesSubmission, type CaptionStyleTarget, type SeriesSubmission } from './lib/style-edits';
import { seriesSettingsFromProject, type SeriesApplyOptions } from './lib/series-templates';
import { normalizeSelection, selectAllShots, selectShot as updateShotSelection, type SelectionModifiers, type ShotSelection } from './lib/shot-selection';
import { applyBulkShotEdit, bulkDuplicateShots, bulkMoveShots, bulkRemoveShots, bulkReorderShots } from './lib/bulk-shot-edits';
import type { BulkShotRequest } from './components/BulkShotDialog';
import { applyAudioProcessingEdit, type AudioProcessingValue } from './lib/audio-edits';
import { prepareAudioMixPreview, readAudioLevels, usePreparedProjectMix } from './lib/audio-mix';
import { measuredAudioShots, rememberAudioDurations } from './lib/audio-timing';
import { replaceShotMedia, sourceCaptionTrack } from '@video-quickly/video/clip-edits';
import { silenceDetectionSchema } from '@video-quickly/contracts';
import { applyTranscriptEdit, assertTranscriptBaseline, type TranscriptEditAction, type TranscriptSilenceOptions, type TranscriptSubmission } from './lib/transcript-edits';
import type { ClipRange } from '@video-quickly/video/clip-edits';

const TranscriptEditingDialog = lazy(() => import('./components/TranscriptEditingDialog'));
const AudioProcessingDialog = lazy(() => import('./components/AudioProcessingDialog'));
const CaptionStyleDialog = lazy(() => import('./components/CaptionStyleEditor').then(module => ({ default: module.CaptionStyleDialog })));
const SeriesTemplatesPage = lazy(() => import('./features/SeriesTemplatesPage'));
const SeriesTemplateDialog = lazy(() => import('./features/SeriesTemplatesPage').then(module => ({ default: module.SeriesTemplateDialog })));
const SeriesApplyDialog = lazy(() => import('./components/SeriesApplyDialog'));
const BulkShotDialog = lazy(() => import('./components/BulkShotDialog'));
const seriesTemplatesPageSchema = recordPageSchema(seriesTemplateSchema);
const ClaimsEditor = lazy(() => import('./components/ClaimsEditor'));
const ResearchReview = lazy(() => import('./components/ClaimsEditor').then(module => ({ default: module.ResearchReview })));
const WorkflowCanvas = lazy(() => import('./features/WorkflowCanvas'));
const ShotRegenerationDialog = lazy(() => import('./components/ShotRegenerationDialog'));
const RunScopeDialog = lazy(() => import('./components/RunScopeDialog'));
const pages: Array<{ id: Page; label: string; icon: typeof Film }> = [
  { id: 'projects', label: '我的项目', icon: FolderOpen },
  { id: 'workbench', label: '创作工作台', icon: Clapperboard },
  { id: 'assets', label: '素材库', icon: Layers },
  { id: 'characters', label: '角色参考库', icon: Users },
  { id: 'templates', label: '系列模板', icon: Palette },
  { id: 'models', label: '模型连接', icon: Sparkles },
  { id: 'skills', label: 'Skill 工作室', icon: BookOpen },
  { id: 'runs', label: '制作记录', icon: History },
  { id: 'costs', label: '费用记录', icon: Receipt },
];

function downloadText(name: string, content: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceView>();
  const [project, setProject] = useState<ProjectDocument>();
  const detail = useRef<ProjectDetail | undefined>(undefined);
  const currentProjectId = useRef<string | undefined>(undefined);
  const [loadError, setLoadError] = useState('');
  const [projectLoadError, setProjectLoadError] = useState('');
  const [connection, setConnection] = useState<RuntimeConnection>({ state: 'ready', generation: 0 });
  const [outputRequest, setOutputRequest] = useState<StepOutputSelection>();
  const consumeOutputRequest = useCallback(() => setOutputRequest(undefined), []);
  const [page, setPage] = useState<Page>('workbench');
  const [projectId, setProjectId] = useState<string>();
  currentProjectId.current = projectId;
  const [theme, setTheme] = useState(() => localStorage.getItem('vq-theme') === 'light' ? 'light' : 'dark');
  const [toast, setToast] = useState<ToastMessage>();
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth <= 1200 || localStorage.getItem('vq-sidebar-collapsed') === 'true');
  const toggleSidebar = useCallback(() => setSidebarCollapsed(value => { localStorage.setItem('vq-sidebar-collapsed', String(!value)); return !value; }), []);
  const appRoot = useRef<HTMLDivElement>(null);
  useContentMotion(appRoot, `${page}:${projectId ?? ''}:${Boolean(workspace)}`, '.page-body > .content-page, .page-body > .workbench');
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const snapshotRequest = useRef(0);
  const appliedSnapshot = useRef(0);
  const saveBeforeLeave = useRef<(() => Promise<boolean>) | null>(null);
  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const projectReads = useRef(new Map<string, () => Promise<ProjectDetail | undefined>>());
  const readProject = useCallback(async (id: string) => {
    if (currentProjectId.current !== id) return undefined;
    const previousDetail = detail.current?.id === id ? detail.current : undefined;
    setProjectLoadError('');
    try {
      const loaded = projectDetailSchema.parse(await rpc('project.get', { projectId: id, revision: previousDetail?.revision, assetsVersion: previousDetail?.assetsVersion }));
      if (currentProjectId.current !== id) return loaded;
      const merged = { ...loaded, project: loaded.project ?? previousDetail?.project, assets: loaded.assets ?? previousDetail?.assets ?? [] };
      detail.current = merged;
      setProject(current => merged.project && current?.id === merged.project.id && current.revision === merged.project.revision ? current : merged.project);
      setWorkspace(previous => previous ? { ...previous, assets: retainRecords(previous.assets, merged.assets), runs: loaded.latestRun ? [loaded.latestRun] : [] } : previous);
      return loaded;
    } catch (error) { if (currentProjectId.current === id) setProjectLoadError(error instanceof Error ? error.message : String(error)); return undefined; }
  }, []);
  const refreshProject = useCallback((id: string) => {
    let queued = projectReads.current.get(id);
    if (!queued) {
      queued = createRefreshQueue(() => readProject(id), () => { if (projectReads.current.get(id) === queued) projectReads.current.delete(id); });
      projectReads.current.set(id, queued);
    }
    return queued();
  }, [readProject]);
  const readWorkspace = useCallback(async () => {
    const request = ++snapshotRequest.current;
    const selectedAtStart = currentProjectId.current;
    try {
      const result = workspaceSummarySchema.parse(await rpc('workspace.summary'));
      if (request < appliedSnapshot.current) return { summary: result };
      appliedSnapshot.current = request;
      let id = currentProjectId.current, fallbackProjectId: string | undefined;
      if (id === selectedAtStart) {
        const nextId = result.projects.some(item => item.id === id && !item.archived) ? id : result.projects.find(item => !item.archived)?.id;
        if (nextId !== id) fallbackProjectId = nextId;
        id = nextId;
        currentProjectId.current = id; setProjectId(id);
      }
      if (!id) { detail.current = undefined; setProject(undefined); }
      setWorkspace(previous => ({
        ...result,
        projects: previous ? retainRecords(previous.projects, result.projects) : result.projects,
        models: previous ? retainRecords(previous.models, result.models) : result.models,
        skills: previous ? retainRecords(previous.skills, result.skills) : result.skills,
        assets: id ? previous?.assets ?? [] : [],
        runs: id ? previous?.runs ?? [] : [],
      }));
      setLoadError('');
      return { summary: result, fallbackProjectId };
    } catch (error) { setLoadError(error instanceof Error ? error.message : String(error)); return undefined; }
  }, []);
  const refreshWorkspace = useMemo(() => createRefreshQueue(readWorkspace), [readWorkspace]);
  const refresh = useCallback(async () => {
    const id = currentProjectId.current;
    const projectRead = id ? refreshProject(id) : undefined;
    const result = await refreshWorkspace();
    if (result?.fallbackProjectId && result.fallbackProjectId === currentProjectId.current) await refreshProject(result.fallbackProjectId);
    else await projectRead;
    return result?.summary;
  }, [refreshProject, refreshWorkspace]);
  useEffect(() => {
    const unsubscribe = subscribe(event => {
      if (event.type === 'runtime.connection') { const parsed = runtimeConnectionSchema.safeParse(event.data); if (parsed.success) setConnection(current => parsed.data.generation >= current.generation ? parsed.data : current); return; }
      if (refreshTimer.current) return;
      refreshTimer.current = setTimeout(() => { refreshTimer.current = undefined; void refresh(); }, 150);
    });
    let active = true;
    void rpc('runtime.status').then(status => { const parsed = runtimeConnectionSchema.safeParse(status); if (active && parsed.success) setConnection(current => parsed.data.generation >= current.generation ? parsed.data : current); }).catch(() => { /* The connection subscription reports transport failures. */ });
    void refresh();
    return () => { active = false; unsubscribe(); if (refreshTimer.current) clearTimeout(refreshTimer.current); };
  }, [refresh]);
  const reconnectRuntime = useCallback(async () => {
    setConnection(current => ({ ...current, state: 'reconnecting', message: undefined }));
    try { const status = runtimeConnectionSchema.parse(await rpc('runtime.reconnect')); setConnection(status); if (status.state === 'ready') await refresh(); }
    catch (error) { setConnection(current => ({ ...current, state: 'disconnected', message: error instanceof Error ? error.message : String(error) })); }
  }, [refresh]);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('vq-theme', theme); }, [theme]);
  useEffect(() => { const media = matchMedia('(max-width: 1200px)'); const update = () => setSidebarCollapsed(media.matches || localStorage.getItem('vq-sidebar-collapsed') === 'true'); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(current => current === toast ? undefined : current), 2000);
    return () => clearTimeout(timer);
  }, [toast]);
  const action: Action = useCallback(async <T,>(method: string, params?: unknown, message?: string): Promise<T | null> => {
    setSaving(value => value + 1);
    try { const result = await rpc<T>(method, params); if (!['node.result', 'run.replay', 'asset.read', 'project.backup'].includes(method)) await refresh(); if (message) notify(message); return result; }
    catch (error) { notify(error instanceof Error ? error.message : String(error), true); if (method === 'project.update') await refresh(); return null; }
    finally { setSaving(value => Math.max(0, value - 1)); }
  }, [notify, refresh]);
  useEffect(() => { if (projectId && detail.current?.id !== projectId) void refresh(); }, [projectId, refresh]);
  async function navigate(next: Page) { if (page === 'workbench' && next !== page && saveBeforeLeave.current && !await saveBeforeLeave.current()) return; setPage(next); }
  function registerSave(callback: (() => Promise<boolean>) | null) { saveBeforeLeave.current = callback; }
  async function openProject(id: string) { if (page === 'workbench' && id !== projectId && saveBeforeLeave.current && !await saveBeforeLeave.current()) return false; currentProjectId.current = id; setProjectId(id); setPage('workbench'); return true; }
  async function openStepOutput(selection: StepOutputSelection) { if (await openProject(selection.projectId)) setOutputRequest(selection); }
  async function createProject() { if (page === 'workbench' && saveBeforeLeave.current && !await saveBeforeLeave.current()) return; setCreating(true); }
  if (!workspace) return <div className="welcome-loading"><Clapperboard size={34} /><strong>Video Quickly</strong><RuntimeConnectionNotice connection={connection} onReconnect={() => void reconnectRuntime()} />{connection.state === 'ready' && <p>{loadError || '正在打开本地工作区…'}</p>}{loadError && connection.state === 'ready' && <Button onClick={() => void refresh()}><RefreshCw size={15} />重新连接</Button>}</div>;
  return <div ref={appRoot} className={`app workspace-shell ${sidebarCollapsed ? 'workspace-shell--collapsed' : ''}`}><WorkspaceSidebar page={page} projectId={projectId} projects={workspace.projects} navigation={pages} collapsed={sidebarCollapsed} theme={theme} onToggle={toggleSidebar} onTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} onNavigate={next => void navigate(next)} onOpen={id => void openProject(id)} onCreate={() => void createProject()} /><div className="main-shell">{saving > 0 && <span className="workspace-action-status" role="status"><RefreshCw className="spin" size={12} />正在处理</span>}<main className="page-body"><RuntimeConnectionNotice connection={connection} onReconnect={() => void reconnectRuntime()} />{loadError && connection.state === 'ready' && <div className="run-notice"><Notice kind="error">{loadError}</Notice></div>}{page === 'workbench' ? project && project.id === projectId ? <Workbench key={project.id} outputRequest={outputRequest} onOutputConsumed={consumeOutputRequest} project={project} workspace={workspace} action={action} notify={notify} onRegisterSave={registerSave} /> : projectId ? <div className="empty-state" role={projectLoadError || loadError ? 'alert' : 'status'}>{projectLoadError || loadError ? <><p>{projectLoadError || loadError}</p><Button onClick={() => void refresh()}>重新读取项目</Button></> : '正在读取项目…'}</div> : <EmptyState icon={<Clapperboard size={28} />} title="开始一段新的创作" description="创建项目，记录你的主题，再把想法展开成镜头。"><Button variant="primary" onClick={() => setCreating(true)}><Plus size={16} />新建项目</Button></EmptyState> : page === 'projects' ? <ProjectsPage workspace={workspace} action={action} onOpen={openProject} onCreate={() => setCreating(true)} /> : page === 'characters' ? <CharactersPage workspace={workspace} action={action} /> : page === 'templates' ? <Suspense fallback={<div className="empty-state">正在读取系列模板…</div>}><SeriesTemplatesPage workspace={workspace} action={action} /></Suspense> : page === 'costs' ? <CostsPage workspace={workspace} /> : page === 'models' ? <ModelsPage workspace={workspace} action={action} /> : page === 'skills' ? <SkillsPage workspace={workspace} action={action} /> : page === 'assets' ? <AssetsPage workspace={workspace} action={action} project={project} /> : <RunsPage workspace={workspace} action={action} onOpen={openProject} onOpenOutput={openStepOutput} />}</main><footer className="statusbar"><div className="statusbar-right"><span>{workspace.system.ffmpegAvailable ? '媒体引擎已就绪' : '媒体引擎待配置'}</span><span className="shortcut"><kbd>Space</kbd> 播放 / 暂停</span><span className="shortcut"><kbd>Ctrl</kbd><kbd>S</kbd> 保存</span></div></footer></div><ToastNotice toast={toast} onDismiss={() => setToast(undefined)} />{creating && <CreateProjectDialog action={action} onClose={() => setCreating(false)} onCreated={project => { setCreating(false); openProject(project.id); }} />}</div>;
}

function retainRecords<T extends { id: string }>(previous: T[], next: T[]): T[] {
  const records = new Map(previous.map(record => [record.id, record]));
  const result = next.map(record => { const existing = records.get(record.id); return existing && JSON.stringify(existing) === JSON.stringify(record) ? existing : record; });
  return result.length === previous.length && result.every((record, index) => record === previous[index]) ? previous : result;
}

function CreateProjectDialog({ action, onClose, onCreated }: { action: Action; onClose: () => void; onCreated: (project: ProjectDocument) => void }) {
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [profile, setProfile] = useState<VideoProfile>({ ...DEFAULT_VIDEO_PROFILE });
  const templates = useRecordPage('seriesTemplate.list', { archived: false, limit: 20 }, 0, seriesTemplatesPageSchema);
  const [seriesTemplateId, setSeriesTemplateId] = useState('');
  const selectedTemplate = templates.items.find(template => template.id === seriesTemplateId);
  const [busy, setBusy] = useState(false);
  return <Dialog title="新建视频项目" onClose={onClose}><form onSubmit={event => { event.preventDefault(); setBusy(true); void action<ProjectDocument>('project.create', { title, brief, profile, ...(selectedTemplate ? { seriesTemplateId: selectedTemplate.id, seriesTemplateRevision: selectedTemplate.revision } : {}) }, '项目已创建').then(result => { setBusy(false); if (result) onCreated(result); }); }}><div className="dialog__body"><Field label="项目名称"><input autoFocus required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} placeholder="给这段创作起个名字" /></Field><Field label="创意简报"><textarea value={brief} onChange={event => setBrief(event.target.value)} placeholder="主题、目标观众，以及你想讲清楚的一个问题…" /></Field><Field label="系列模板（可选）"><select value={seriesTemplateId} disabled={busy || templates.busy} onChange={event => setSeriesTemplateId(event.target.value)}><option value="">从默认设置开始</option>{templates.items.map(template => <option key={template.id} value={template.id}>{template.name} · 修订 {template.revision}</option>)}</select></Field>{templates.error && <Notice kind="error">{templates.error}<Button onClick={templates.refresh}>重新读取系列模板</Button></Notice>}{templates.nextCursor !== null && <Button busy={templates.busy} onClick={() => void templates.loadMore()}>加载更多系列模板</Button>}{seriesTemplateId && !selectedTemplate && <p className="field-error">所选模板不可用，请重新选择。</p>}<details className="creation-settings"><summary>视频规格 · {profile.width} × {profile.height} · {formatFrameRate(profile.frameRate)} fps</summary><VideoSettings profile={profile} onChange={setProfile} compact /></details></div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={busy} disabled={!title.trim() || !videoProfileSchema.safeParse(profile).success || Boolean(seriesTemplateId) && !selectedTemplate}>创建项目</Button></div></form></Dialog>;
}

function Workbench({ project, workspace, action, notify, onRegisterSave, outputRequest, onOutputConsumed }: { outputRequest?: StepOutputSelection; onOutputConsumed: () => void; project: ProjectDocument; workspace: WorkspaceView; action: Action; notify: (message: string, error?: boolean) => void; onRegisterSave: (callback: (() => Promise<boolean>) | null) => void }) {
  const [view, setView] = useState<'steps' | 'flow'>('steps');
  const { session, state: edits, ready, storageError } = useProjectEdits(project, workspace.system.dataDirectory);
  const content = edits.present;
  const authoredProject = useMemo(() => ({ ...project, ...content, revision: edits.revision }), [project, content, edits.revision]);
  const audioMix = usePreparedProjectMix(authoredProject, workspace.assets, ready && view === 'steps', edits.busy);
  const latestAssets = useRef(workspace.assets); latestAssets.current = workspace.assets;
  const [knownAudio] = useState(() => new Map<string, number>());
  if (audioMix.status === 'ready' && audioMix.mix) rememberAudioDurations(knownAudio, content.shots, audioMix.mix, workspace.assets);
  function measuredShots(shots: Shot[]) { return measuredAudioShots(shots, latestAssets.current, knownAudio); }
  const previewShots = useMemo(() => measuredShots(content.shots), [content.shots, audioMix.status, audioMix.mix, workspace.assets]);
  const previewPlayable = useRef(false);
  const setPreviewPlayable = useCallback((value: boolean) => { previewPlayable.current = value; }, []);
  const activeShotFallback = content.shots.some(shot => shot.id === edits.selectedShotId) ? edits.selectedShotId : content.shots[0]?.id;
  const [shotSelection, setShotSelection] = useState<ShotSelection>();
  const shotIds = useMemo(() => content.shots.map(shot => shot.id), [content.shots]);
  const selection = normalizeSelection(shotSelection ?? { ids: activeShotFallback ? [activeShotFallback] : [], primary: activeShotFallback, anchor: activeShotFallback }, shotIds, activeShotFallback);
  const selectedShotId = selection.primary ?? activeShotFallback;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  function setSelection(next: ShotSelection) {
    selectionRef.current = next; setShotSelection(next);
    if (next.primary) session.select(next.primary);
  }
  const setSelectedShotId = (id?: string) => { if (!id) session.select(undefined); setSelection({ ids: id ? [id] : [], primary: id, anchor: id }); };
  const selectAll = () => setSelection(selectAllShots(selectionRef.current, session.state.present.shots.map(shot => shot.id)));
  const clearSelection = () => setSelection({ ids: [] });
  const [conflictDialog, setConflictDialog] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState('script');
  const [inspectorTab, setInspectorTab] = useState<'shot' | 'project'>('shot');
  const { title, profile, brief, style } = content;
  function updateSettings(patch: Partial<EditContent>, label: string) {
    const active = document.activeElement;
    const group = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? `project:${Object.keys(patch).join(',')}` : undefined;
    session.edit({ ...session.state.present, ...patch }, label, group);
  }
  const setTitle = (title: string) => updateSettings({ title }, '修改项目名称');
  const setBrief = (brief: string) => updateSettings({ brief }, '修改创意简报');
  const setStyle = (style: string) => updateSettings({ style }, '修改系列风格');
  const setProfile = (profile: VideoProfile) => updateSettings({ profile }, '修改视频规格');
  const draft = content.shots.find(shot => shot.id === selectedShotId);
  const effectiveDraft = previewShots.find(shot => shot.id === selectedShotId);
  const draftCaptionTrack = draft ? sourceCaptionTrack(draft, content) : undefined;
  const captionAudio = workspace.assets.find(asset => asset.id === draft?.audioAssetId);
  const staleSpeechCaptions = draftCaptionTrack?.alignment === 'speech' && (draftCaptionTrack.sourceAssetId !== captionAudio?.id || draftCaptionTrack.sourceSha256 !== captionAudio?.sha256);
  function setDraft(next: Shot) {
    const current = session.state.present;
    const before = current.shots.find(shot => shot.id === next.id);
    if (!before) return;
    try {
      let changed = current;
      for (const kind of ['audio', 'video'] as const) {
        const field = kind === 'audio' ? 'audioAssetId' : 'videoAssetId';
        if (before[field] !== next[field] && next[field]) {
          const asset = workspace.assets.find(asset => asset.id === next[field]);
          if (!asset) throw new Error('新素材尚未读取，请稍后重新选择。');
          changed = replaceShotMedia(changed, before.id, kind, asset, () => crypto.randomUUID());
        }
      }
      const replacement = changed.shots.find(shot => shot.id === before.id)!;
      // Media replacements may fork a private plan; retain that mapping while applying other fields.
      const mediaChanged = before.audioAssetId !== next.audioAssetId || before.videoAssetId !== next.videoAssetId;
      if (mediaChanged) next = { ...next, clipEdit: replacement.clipEdit, captionTrack: replacement.captionTrack };
      if (before.clipEdit && next.durationUs !== before.durationUs) {
        if (source.status === 'loading' || source.status === 'error') throw new Error(source.error ?? '请等待真实素材时长读取完成后再修改剪辑时长。');
        const startUs = replacement.clipEdit?.inUs ?? replacement.sourceInUs ?? 0;
        changed = trimShotInContext(changed, before.id, { inUs: startUs, outUs: startUs + next.durationUs }, current.profile.frameRate, source.durationUs, () => crypto.randomUUID());
        const trimmed = changed.shots.find(shot => shot.id === before.id)!;
        next = { ...next, durationUs: trimmed.durationUs, sourceInUs: trimmed.sourceInUs, audioInUs: trimmed.audioInUs, videoInUs: trimmed.videoInUs, sceneInUs: trimmed.sceneInUs, sceneDurationUs: trimmed.sceneDurationUs, clipEdit: trimmed.clipEdit };
      }
      const field = Object.keys(next).find(key => !sameContent(before[key as keyof Shot], next[key as keyof Shot]));
      const active = document.activeElement;
      const group = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? `shot:${next.id}:${field}` : undefined;
      session.edit({ ...changed, shots: changed.shots.map(shot => shot.id === next.id ? next : shot) }, '修改镜头属性', group);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }
  const [transcriptDialog, setTranscriptDialog] = useState<{ project: ProjectDocument; shot: Shot; assets: AssetRecord[] }>();
  const transcriptSubmitted = useRef<TranscriptSubmission | undefined>(undefined);
  function openTranscript() {
    const current = timingContent();
    const shot = current.shots.find(shot => shot.id === selectedShotId);
    if (!shot) return;
    transcriptSubmitted.current = undefined; clock.pause();
    setTranscriptDialog(structuredClone({ project: { ...project, ...current, revision: session.state.revision }, shot, assets: workspace.assets }));
  }
  const [audioTarget, setAudioTarget] = useState<{ mode: 'project' } | { mode: 'shot'; shotId: string }>();
  const audioAssetsBaseline = useRef<AssetRecord[]>([]);
  const audioSubmitted = useRef<AudioProcessingValue | undefined>(undefined);
  function openAudio(target: NonNullable<typeof audioTarget>) { audioSubmitted.current = undefined; audioAssetsBaseline.current = structuredClone(workspace.assets); setAudioTarget(target); }
  useEffect(() => { if (audioTarget?.mode === 'shot' && !content.shots.some(shot => shot.id === audioTarget.shotId)) setAudioTarget(undefined); }, [audioTarget, content.shots]);
  const [exporting, setExporting] = useState(false);
  const [batchExporting, setBatchExporting] = useState(false);
  const [bulkEditing, setBulkEditing] = useState(false);
  const [captionStyleTarget, setCaptionStyleTarget] = useState<CaptionStyleTarget>();
  const captionStyleSubmitted = useRef<CaptionStyle | null | undefined>(undefined);
  const [seriesApplying, setSeriesApplying] = useState(false), [seriesSaving, setSeriesSaving] = useState(false);
  const seriesSubmitted = useRef<SeriesSubmission | undefined>(undefined);
  function openCaptionStyle(target: CaptionStyleTarget) { captionStyleSubmitted.current = undefined; setCaptionStyleTarget(target); }
  function openSeries() { seriesSubmitted.current = undefined; setSeriesApplying(true); }
  const [stepEditor, setStepEditor] = useState<WorkflowNode>();
  const [scopeNodeId, setScopeNodeId] = useState<string>();
  const stepSubmitted = useRef<WorkflowNode | undefined>(undefined);
  function openStep(node: WorkflowNode) { stepSubmitted.current = undefined; setStepEditor(node); }
  const [showClaimDialog, setShowClaimDialog] = useState(false);
  const [claimsShotId, setClaimsShotId] = useState<string>();
  const claimsSubmitted = useRef<ClaimsEdits | undefined>(undefined);
  function openClaims(shotId?: string) { claimsSubmitted.current = undefined; setClaimsShotId(shotId); setShowClaimDialog(true); }
  const [assetDialog, setAssetDialog] = useState(false);
  const [assetKind, setAssetKind] = useState<'image' | 'video'>('image');
  const [assetPath, setAssetPath] = useState('');
  const [output, setOutput] = useState<{ nodeId: string; data: unknown; runId: string; kind: WorkflowNode['kind'] }>();
  const outputReadNotify = useRef(notify); outputReadNotify.current = notify;
  useEffect(() => {
    if (!outputRequest || outputRequest.projectId !== project.id) return;
    let current = true;
    void rpc('run.step.payload', { runId: outputRequest.runId, nodeId: outputRequest.nodeId, kind: 'output' }).then(value => {
      if (!current) return;
      const payload = runStepPayloadSchema.parse(value);
      if (!payload.available) throw new Error('这个步骤尚未保存产物。');
      setOutput({ nodeId: outputRequest.nodeId, runId: outputRequest.runId, kind: outputRequest.kind, data: payload.value });
    }).catch(error => { if (current) outputReadNotify.current(error instanceof Error ? error.message : String(error), true); })
      .finally(() => { if (current) onOutputConsumed(); });
    return () => { current = false; };
  }, [outputRequest, project.id, onOutputConsumed]);
  const [captionEdit, setCaptionEdit] = useState<{ shot: Shot; audioAsset?: AssetRecord; context: Pick<ProjectDocument, 'clipEditSources' | 'clipEditPlans'> }>();
  const captionSubmitted = useRef<CaptionTrack | undefined>(undefined);
  const captionShot = captionEdit?.shot;
  const captionShotId = captionShot?.id;
  const [musicEditing, setMusicEditing] = useState(false);
  const [regenerationShotId, setRegenerationShotId] = useState<string>();
  const regenerationShot = content.shots.find(shot => shot.id === regenerationShotId);
  useEffect(() => { if (regenerationShotId && !regenerationShot) setRegenerationShotId(undefined); }, [regenerationShotId, regenerationShot]);
  const musicSubmitted = useRef<MusicClip[] | undefined>(undefined);
  const saveInFlight = useRef<Promise<boolean> | undefined>(undefined);
  const updateWorkflow = useCallback((workflow: EditContent['workflow'], label: string, group?: string) => { session.edit({ ...session.state.present, workflow }, label, group); }, [session]);
  const [savingEdits, setSavingEdits] = useState(false);
  const [outlineWidth, setOutlineWidth] = useState(() => panelWidth('vq-outline-width', 224, 184, 320));
  const [inspectorWidth, setInspectorWidth] = useState(() => panelWidth('vq-inspector-width', 304, 280, 400));
  const [outlineOpen, setOutlineOpen] = useState(() => localStorage.getItem('vq-outline-open') !== 'false');
  const [inspectorOpen, setInspectorOpen] = useState(() => localStorage.getItem('vq-inspector-open') !== 'false');
  const [focusPreview, setFocusPreview] = useState(false);
  const outlineVisible = outlineOpen && !focusPreview;
  const inspectorVisible = inspectorOpen && !focusPreview;
  const editor = useRef<HTMLDivElement>(null);
  const inspectorBody = useRef<HTMLDivElement>(null);
  useContentMotion(inspectorBody, `${view}:${inspectorTab}`);
  const [editorWidth, setEditorWidth] = useState(1280);
  const maxOutline = Math.max(184, Math.min(320, editorWidth - 400 - (inspectorVisible ? 280 : 0)));
  const actualOutline = outlineVisible ? Math.min(outlineWidth, maxOutline) : 0;
  const maxInspector = Math.max(280, Math.min(400, editorWidth - actualOutline - 400));
  const actualInspector = inspectorVisible ? Math.min(inspectorWidth, maxInspector) : 0;
  const layoutStyle = { '--outline-track': `${actualOutline}px`, '--inspector-track': `${actualInspector}px` } as CSSProperties;
  useLayoutEffect(() => {
    const element = editor.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width) setEditorWidth(Math.round(width)); });
    observer.observe(element); return () => observer.disconnect();
  }, [view, ready]);
  const totalUs = previewShots.reduce((sum, shot) => sum + shot.durationUs, 0);
  const [clock] = useState(() => new PlaybackClock(totalUs, project.profile.frameRate));
  const timeline = useMemo(() => buildTimeline(previewShots), [previewShots]);
  const selectedIndex = Math.max(0, content.shots.findIndex(shot => shot.id === selectedShotId));
  const selectedShot = content.shots[selectedIndex];
  const source = useSourceDuration(selectedShot, workspace.assets, content);
  const latestRun = workspace.runs.find(run => run.projectId === project.id);
  const runStatus = latestRun?.status;
  const runError = latestRun?.error;
  const runNodeLabel = project.workflow.nodes.find(node => node.id === latestRun?.currentNodeId)?.label ?? '当前步骤';
  // Stable run fields keep background refreshes from replaying an expired notification.
  useEffect(() => {
    if (runStatus === 'waiting_review') notify(`${runNodeLabel}已准备好，等待你的审阅。`);
    else if (runStatus === 'needs_attention' || runStatus === 'failed') notify(runError ?? '有一项任务需要核对。', true);
  }, [latestRun?.id, latestRun?.currentNodeId, runStatus, runError, runNodeLabel, notify]);
  const busy = latestRun && ['running', 'queued', 'waiting_external', 'retry_scheduled'].includes(latestRun.status);
  const dirtyShot = !sameContent(content.shots, edits.base.shots);
  const dirtyProject = !sameContent({ ...content, shots: undefined }, { ...edits.base, shots: undefined });
  useEffect(() => { clock.configure(totalUs, profile.frameRate); }, [clock, totalUs, profile.frameRate]);
  useEffect(() => () => clock.dispose(), [clock]);
  useEffect(() => { if (view === 'flow') clock.pause(); }, [view, clock]);
  useEffect(() => { if (stepEditor || scopeNodeId || exporting || batchExporting || bulkEditing || assetDialog || showClaimDialog || captionStyleTarget || seriesApplying || seriesSaving || output || captionShotId || musicEditing || regenerationShotId || audioTarget || transcriptDialog) clock.pause(); }, [clock, stepEditor, scopeNodeId, exporting, batchExporting, bulkEditing, assetDialog, showClaimDialog, captionStyleTarget, seriesApplying, seriesSaving, output, captionShotId, musicEditing, regenerationShotId, audioTarget, transcriptDialog]);
  const save = useCallback(async () => {
    if (saveInFlight.current) return saveInFlight.current;
    const operation = async () => {
      setSavingEdits(true);
      const workflowAtStart = session.state.present.workflow;
      try {
        if (session.state.conflict) { setConflictDialog(true); return false; }
        const dirty = session.dirty;
        if (dirty) {
          const captured = session.state.present;
          session.beginSave();
          try {
            const result = await action<ProjectDocument>('project.update', { projectId: project.id, revision: session.state.revision, patch: captured });
            if (!result) return false;
            session.saved(result);
          } finally { session.endSave(); }
        }
        if (view === 'flow' && !sameWorkflow(workflowAtStart, session.state.present.workflow)) return false;
        if (dirty) notify('修改已保存');
        return true;
      } finally { setSavingEdits(false); }
    };
    saveInFlight.current = operation();
    try { return await saveInFlight.current; } finally { saveInFlight.current = undefined; }
  }, [action, notify, project.id, session, view]);
  useEffect(() => {
    onRegisterSave(save);
    return () => onRegisterSave(null);
  }, [dirtyShot, dirtyProject, onRegisterSave, save]);
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) { if (dirtyShot || dirtyProject) event.preventDefault(); }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirtyShot, dirtyProject]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (document.querySelector('dialog[open]') || event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); return; }
      if (view !== 'steps') return;
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        void changeHistory(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo'); return;
      }
      const target = event.target;
      if (event.code === 'KeyS' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (target instanceof HTMLElement && (target.closest('input,textarea,select') || target.isContentEditable)) return;
        event.preventDefault(); if (!event.repeat) void splitSelected(); return;
      }
      if (target instanceof HTMLElement && (target.closest('input,textarea,select,button,[role="slider"]') || target.isContentEditable)) return;
      if (event.code === 'Space') { event.preventDefault(); if (!event.repeat && previewPlayable.current) clock.toggle(); }
      if (event.code === 'ArrowRight') { event.preventDefault(); clock.step(event.shiftKey ? 10 : 1); }
      if (event.code === 'ArrowLeft') { event.preventDefault(); clock.step(event.shiftKey ? -10 : -1); }
      if (event.code === 'Home') { event.preventDefault(); clock.seek(0); }
      if (event.code === 'End') { event.preventDefault(); clock.seek(totalUs); }
    }
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [clock, save, totalUs, view, selectedShotId, profile.frameRate, savingEdits]);
  async function selectShot(id: string, modifiers?: SelectionModifiers) {
    if ((dirtyShot || dirtyProject) && !await save()) return;
    const next = updateShotSelection(selectionRef.current, session.state.present.shots.map(shot => shot.id), id, modifiers);
    setSelection(next); setInspectorTab('shot');
    const clip = buildTimeline(timingContent().shots).find(item => item.shotId === (next.primary ?? id));
    if (clip) clock.seek(clip.startUs);
  }
  function timingContent(current = session.state.present, ids?: readonly string[]): EditContent {
    const resolved = measuredShots(current.shots);
    return { ...current, shots: resolved.map((shot, index) => !ids || ids.includes(shot.id) ? shot : current.shots[index]) };
  }
  function sceneShots(current = session.state.present) { return current.shots.map((shot, index) => shot.sceneIndex === undefined ? { ...shot, sceneIndex: index } : shot); }
  function clipStart(id?: string) { return buildTimeline(timingContent().shots).find(clip => clip.shotId === id)?.startUs ?? 0; }
  async function addShot() {
    if (!await save()) return;
    const preset = session.state.present.scenePreset;
    const sceneTemplate = preset ? { ...createSceneTemplate(preset.kind), palette: preset.palette, motion: preset.motion } : undefined;
    const shot = shotSchema.parse({ id: crypto.randomUUID(), title: `镜头 ${session.state.present.shots.length + 1}`, narration: '', visualPrompt: '', durationUs: 6_000_000, sceneTemplate });
    session.edit({ ...session.state.present, shots: [...sceneShots(), shot] }, '添加镜头');
    setSelectedShotId(shot.id); setInspectorTab('shot');
    if (await save()) clock.seek(clipStart(shot.id));
  }
  async function editGroup(label: string, ids: readonly string[], operation: (current: EditContent) => EditContent, after?: (next: EditContent) => ShotSelection) {
    if (!ids.length || savingEdits || session.state.busy || session.state.conflict) return;
    try {
      const beforeOrder = session.state.present.shots.map(shot => shot.id);
      const check = operation(session.state.present);
      if (sameContent(check, session.state.present) || !await save()) return;
      if (session.state.conflict || !sameContent(beforeOrder, session.state.present.shots.map(shot => shot.id))) throw new Error('镜头顺序已更新，请重新选择后操作。');
      const next = operation(session.state.present);
      clock.pause(); session.edit(next, label);
      if (after) setSelection(after(next));
      else setSelection(normalizeSelection({ ...selectionRef.current, ids: [...ids] }, next.shots.map(shot => shot.id), selectedShotId));
      if (await save()) clock.seek(clipStart(selectionRef.current.primary));
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }
  async function moveShot(offset: number) {
    const ids = [...selectionRef.current.ids];
    await editGroup('调整所选镜头顺序', ids, current => bulkMoveShots(current, ids, offset < 0 ? -1 : 1));
  }
  async function splitSelected() {
    if (selectionRef.current.ids.length !== 1 || savingEdits || session.state.busy || session.state.conflict) return;
    const id = selectedShotId;
    const rawBefore = session.state.present.shots.find(shot => shot.id === id);
    const before = timingContent().shots.find(shot => shot.id === id);
    const rateBefore = session.state.present.profile.frameRate;
    const localTimeUs = clock.getSnapshot().timeUs - clipStart(id);
    if (before?.locked) { notify('请先解锁镜头，再进行分割。', true); return; }
    if (!before || !canSplitShot(before, localTimeUs, session.state.present.profile.frameRate)) { notify('播放头两侧需各保留至少 0.5 秒'); return; }
    if (!await save()) return;
    try {
      const latest = session.state.present.shots.find(shot => shot.id === id);
      const fields = ['durationUs', 'sourceInUs', 'audioInUs', 'videoInUs', 'sceneInUs', 'sceneDurationUs', 'clipEdit', 'assetId', 'videoAssetId', 'audioAssetId', 'locked'] as const;
      if (!latest || !rawBefore || latest.locked || !sameContent(rateBefore, session.state.present.profile.frameRate) || fields.some(field => !sameContent(latest[field], rawBefore[field]))) throw new Error('待分割镜头的锁定、时间或素材已有修改，新输入已保留；请核对后重新分割。');
      const shots = sceneShots(timingContent(session.state.present, id ? [id] : []));
      const index = shots.findIndex(shot => shot.id === id);
      const shot = shots[index];
      if (!shot) return;
      const parts = splitShot(shot, localTimeUs, session.state.present.profile.frameRate, crypto.randomUUID(), session.state.present);
      const startUs = clipStart(id);
      session.edit({ ...session.state.present, shots: [...shots.slice(0, index), ...parts, ...shots.slice(index + 1)] }, '分割镜头');
      clock.pause(); setSelectedShotId(parts[1].id); setInspectorTab('shot');
      if (await save()) clock.seek(startUs + parts[0].durationUs);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }
  async function trimClip(id: string, inUs: number, outUs: number, expectedRevision?: number) {
    if (selectionRef.current.ids.length !== 1 || savingEdits || session.state.busy || session.state.conflict) return;
    if (expectedRevision !== undefined && expectedRevision !== session.state.revision) { notify('项目已更新，请重新调整入出点', true); return; }
    const raw = session.state.present.shots.find(item => item.id === id);
    const rateBefore = session.state.present.profile.frameRate;
    if (!raw || id !== selectedShotId) return;
    if (raw.locked) { notify('请先解锁镜头，再调整入出点。', true); return; }
    if (source.status === 'loading' || source.status === 'error') { notify(source.error ?? '请等待素材时长读取完成后再调整入出点', true); return; }
    try {
      const current = timingContent(session.state.present, [id]);
      const check = trimShotInContext(current, id, { inUs, outUs }, current.profile.frameRate, source.durationUs, () => crypto.randomUUID());
      if (sameContent(check, current) || !await save()) return;
      const latest = session.state.present.shots.find(item => item.id === id);
      const fields = ['durationUs', 'sourceInUs', 'audioInUs', 'videoInUs', 'sceneInUs', 'clipEdit', 'videoAssetId', 'audioAssetId', 'locked'] as const;
      if (!latest || !sameContent(rateBefore, session.state.present.profile.frameRate) || fields.some(field => !sameContent(latest[field], raw[field]))) throw new Error('镜头素材或剪辑范围已有修改，请重新调整入出点。');
      const live = timingContent(session.state.present, [id]);
      const next = trimShotInContext({ ...live, shots: sceneShots(live) }, id, { inUs, outUs }, live.profile.frameRate, source.durationUs, () => crypto.randomUUID());
      clock.pause(); session.edit(next, '调整镜头入出点'); setSelectedShotId(id);
      if (await save()) clock.seek(clipStart(id));
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }
  async function reorderClip(id: string, targetIndex: number, expectedRevision: number, groupIds?: readonly string[]) {
    if (savingEdits || session.state.busy || session.state.conflict) return;
    if (expectedRevision !== session.state.revision) { notify('项目已更新，请重新拖动镜头', true); return; }
    const ids = groupIds?.length ? [...groupIds] : [id];
    await editGroup('拖动所选镜头排序', ids, current => bulkReorderShots(current, ids, targetIndex), next => normalizeSelection({ ids, primary: id, anchor: selectionRef.current.anchor }, next.shots.map(shot => shot.id), id));
  }
  async function duplicateShot() {
    const ids = [...selectionRef.current.ids], newIds = Object.fromEntries(ids.map(id => [id, crypto.randomUUID()]));
    await editGroup('复制所选镜头', ids, current => bulkDuplicateShots(current, ids, newIds), next => normalizeSelection({ ids: ids.map(id => newIds[id]), primary: newIds[selectedShotId ?? ''] ?? newIds[ids[0]], anchor: newIds[ids[0]] }, next.shots.map(shot => shot.id)));
  }
  async function removeShot() {
    const ids = [...selectionRef.current.ids];
    const before = structuredClone(session.state.present.shots.filter(shot => ids.includes(shot.id)));
    await editGroup('移除所选镜头', ids, current => {
      if (!sameContent(before, current.shots.filter(shot => ids.includes(shot.id)))) throw new Error('待移除镜头有新的修改，输入已保留；请核对后重新移除。');
      return bulkRemoveShots(current, ids);
    }, next => {
      const id = next.shots[Math.min(selectedIndex, next.shots.length - 1)]?.id;
      session.select(id); return { ids: id ? [id] : [], primary: id, anchor: id };
    });
  }
  async function changeHistory(direction: 'undo' | 'redo') {
    if (session.state.busy || savingEdits || session.state.conflict) return;
    const wasSaved = !session.dirty;
    session[direction](); clock.pause();
    if (wasSaved) await save();
  }
  function openCaptionEditor() {
    const shot = timingContent().shots.find(shot => shot.id === selectedShotId);
    if (shot) {
      captionSubmitted.current = undefined;
      setCaptionEdit({ shot: structuredClone(shot), context: structuredClone({ clipEditSources: session.state.present.clipEditSources, clipEditPlans: session.state.present.clipEditPlans }), audioAsset: workspace.assets.find(asset => asset.id === shot.audioAssetId) });
    }
  }
  function openMusicEditor() {
    musicSubmitted.current = undefined;
    setMusicEditing(true);
  }
  function currentCaptionShot() {
    const shot = timingContent().shots.find(shot => shot.id === captionShotId);
    if (!shot || !captionShot) throw new Error('镜头已被移除，当前字幕草稿未应用。');
    const fields = ['narration', 'durationUs', 'sourceInUs', 'audioInUs', 'sceneInUs', 'sceneDurationUs', 'audioAssetId', 'clipEdit'] as const;
    const audio = workspace.assets.find(asset => asset.id === shot.audioAssetId);
    const trackChanged = !sameContent(sourceCaptionTrack(shot, session.state.present), captionSubmitted.current ?? sourceCaptionTrack(captionShot, captionEdit?.context));
    if (trackChanged || fields.some(field => !sameContent(shot[field], captionShot[field])) || audio?.sha256 !== captionEdit?.audioAsset?.sha256 || audio?.active !== captionEdit?.audioAsset?.active) throw new Error('字幕或镜头区间已在其他视图更新，当前草稿未应用。请重新打开编辑器后核对修改。');
    return shot;
  }
  async function applyCaptions(track: CaptionTrack) {
    if (session.state.conflict || session.state.busy) return false;
    const shot = currentCaptionShot();
    const parsed = captionTrackSchema.parse(track);
    const audio = workspace.assets.find(asset => asset.id === shot.audioAssetId);
    if (parsed.alignment === 'speech' && (parsed.sourceAssetId !== audio?.id || parsed.sourceSha256 !== audio?.sha256)) { notify('旁白音频已更换，请重新识别或手动校正字幕。', true); return false; }
    session.edit({ ...session.state.present, shots: session.state.present.shots.map(item => item.id === shot.id ? { ...item, captionTrack: parsed } : item) }, '编辑字幕');
    captionSubmitted.current = parsed;
    return save();
  }
  async function recognizeCaptions(modelId: string, signal: AbortSignal) {
    const shotId = captionShotId;
    currentCaptionShot();
    if (!shotId || !await save()) throw new Error('请先保存镜头修改，再识别字幕。');
    currentCaptionShot();
    try { return await transcribeCaptions({ projectId: project.id, shotId, modelId, revision: session.state.revision }, signal); }
    catch (error) {
      if (signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) notify(error instanceof Error ? error.message : String(error), true);
      throw error;
    }
  }
  async function applyMusic(musicClips: MusicClip[], baseline: MusicClip[]) {
    if (session.state.conflict || session.state.busy) return false;
    if (!sameContent(session.state.present.musicClips, baseline) && !sameContent(session.state.present.musicClips, musicSubmitted.current)) throw new Error('背景音乐已在其他视图更新，当前草稿未应用。请重新打开编辑器后核对修改。');
    session.edit({ ...session.state.present, musicClips }, '编辑背景音乐');
    musicSubmitted.current = musicClips;
    return save();
  }
  async function generateShotCandidate(input: { kind: ShotCandidateKind; modelId?: string; instruction?: string }) {
    if (savingEdits || session.state.busy || session.state.conflict || !await save()) return null;
    const shot = session.state.present.shots.find(shot => shot.id === regenerationShotId);
    if (!shot) throw new Error('镜头已被移除，请重新选择镜头。');
    if (shot.locked) throw new Error('请先解锁镜头，再重新生成。');
    return action<{ id: string }>('shot.regenerate', { projectId: project.id, shotId: shot.id, revision: session.state.revision, ...input }, '当前镜头已开始生成候选');
  }
  async function applyCandidate(candidate: ShotCandidate, fields?: ShotCandidateField[]) {
    if (savingEdits || session.state.busy || session.state.conflict) return false;
    if (candidate.projectId !== project.id || candidate.shotId !== regenerationShotId) throw new Error('候选与当前镜头不匹配。');
    const shot = session.state.present.shots.find(shot => shot.id === candidate.shotId);
    if (!shot) throw new Error('镜头已被移除，候选尚未应用。');
    applyShotCandidate(shot, candidate, fields);
    if (!await save()) return false;
    session.beginSave();
    try {
      const result = await action<ProjectDocument>('shot.candidate.apply', { projectId: project.id, candidateId: candidate.id, fields, revision: session.state.revision });
      if (!result) return false;
      session.applySaved(result, '应用镜头候选');
      notify(candidate.kind === 'audio' && shot.captionTrack ? '旁白候选已应用，请核对并重新对齐字幕' : '镜头候选已应用，可撤销恢复');
      return true;
    } finally { session.endSave(); }
  }
  async function applyClaims(next: ClaimsEdits, baseline: ClaimsEdits) {
    if (session.state.conflict || session.state.busy) return false;
    const merged = applyClaimsEdits(session.state.present, next, baseline, claimsSubmitted.current);
    session.edit(merged, '修改资料与镜头引用');
    // Own only the requested references; the merge can also preserve newer external bindings.
    claimsSubmitted.current = next;
    return save();
  }
  async function analyzeSources(input: { modelId: string; sourceIds: string[]; instruction?: string }, signal: AbortSignal) {
    if (session.state.conflict || session.state.busy || !await save()) throw new Error('请先保存资料修改，再整理证据候选。');
    signal.throwIfAborted();
    return analyzeResearch({ ...input, projectId: project.id, revision: session.state.revision }, signal);
  }
  async function applyResearch(result: ResearchResult, selected: Claim[], bindings: ShotClaims[]) {
    if (session.state.conflict || session.state.busy) return false;
    if (result.projectId !== project.id) throw new Error('证据候选不属于当前项目。');
    session.edit(applyResearchClaims(session.state.present, result, selected, bindings), '应用证据候选与镜头引用');
    return save();
  }
  async function applyCaptionStyle(value: CaptionStyle | null, baseline: ProjectDocument) {
    if (!captionStyleTarget || session.state.conflict || session.state.busy) return false;
    if (baseline.id !== project.id) throw new Error('字幕样式不属于当前项目。');
    const next = applyCaptionStyleEdit(session.state.present, baseline, captionStyleTarget, value, captionStyleSubmitted.current);
    session.edit(next, captionStyleTarget.mode === 'project' ? '修改项目字幕样式' : '修改镜头字幕样式');
    captionStyleSubmitted.current = value;
    return save();
  }
  function proposedAudio(value: AudioProcessingValue, baseline: ProjectDocument) {
    if (baseline.id !== project.id || !audioTarget || (audioTarget.mode === 'project') !== (value.scope === 'project') || audioTarget.mode === 'shot' && value.scope === 'shot' && audioTarget.shotId !== value.shot.id) throw new Error('声音设置不属于当前项目或镜头，请重新打开处理窗口。');
    if (value.scope === 'shot') {
      const before = baseline.shots.find(shot => shot.id === value.shot.id);
      const includeVideo = Boolean(before && (usesVideoAudio(before) || usesVideoAudio({ ...before, audioProcessing: value.shot.processing })));
      const references = [{ id: before?.audioAssetId, label: '旁白' }, ...(includeVideo ? [{ id: before?.videoAssetId, label: '视频' }] : [])];
      const identity = (asset?: AssetRecord) => asset && { sha256: asset.sha256, version: asset.version, path: asset.path, active: asset.active, kind: asset.kind, projectId: asset.projectId };
      for (const { id, label } of references) {
        if (!id) continue;
        const old = audioAssetsBaseline.current.find(asset => asset.id === id), live = workspace.assets.find(asset => asset.id === id);
        if (!sameContent(identity(old), identity(live))) throw new Error(`${label}素材已更新，请重新打开声音处理后核对。`);
      }
    }
    return applyAudioProcessingEdit(session.state.present, baseline, value, audioSubmitted.current);
  }
  async function applyAudio(value: AudioProcessingValue, baseline: ProjectDocument) {
    if (session.state.conflict || session.state.busy) return false;
    const next = proposedAudio(value, baseline);
    clock.pause(); session.edit(next, value.scope === 'project' ? '修改项目混音' : '修改镜头声音处理');
    audioSubmitted.current = structuredClone(value);
    return save();
  }
  async function previewAudio(value: AudioProcessingValue, baseline: ProjectDocument, signal: AbortSignal) {
    signal.throwIfAborted();
    if (session.state.conflict) throw new Error('请先比较并合并项目修改，再试听处理。');
    const next = proposedAudio(value, baseline);
    return prepareAudioMixPreview({ ...project, ...next, revision: session.state.revision }, signal);
  }
  function transcriptBaseline(baseline: ProjectDocument) {
    if (!transcriptDialog || baseline.id !== project.id) throw new Error('文稿剪辑不属于当前项目。');
    const current = timingContent(session.state.present, [transcriptDialog.shot.id]);
    assertTranscriptBaseline(current, baseline, transcriptDialog.shot.id, workspace.assets, transcriptDialog.assets, transcriptSubmitted.current);
    return current;
  }
  async function applyTranscript(action: TranscriptEditAction, baseline: ProjectDocument, assetsBaseline: readonly AssetRecord[]) {
    if (session.state.conflict || session.state.busy || !transcriptDialog) return false;
    const result = applyTranscriptEdit(timingContent(session.state.present, [transcriptDialog.shot.id]), baseline, transcriptDialog.shot.id, action, workspace.assets, assetsBaseline, () => crypto.randomUUID(), transcriptSubmitted.current);
    clock.pause(); session.edit(result.content, action.kind === 'restore' ? '恢复原始音视频与字幕' : '删除文稿音视频区间');
    transcriptSubmitted.current = result.submission;
    const saved = await save();
    if (saved) clock.seek(clipStart(transcriptDialog.shot.id));
    return saved;
  }
  async function detectSilence(options: TranscriptSilenceOptions, baseline: ProjectDocument, signal: AbortSignal) {
    signal.throwIfAborted(); transcriptBaseline(baseline);
    if (session.state.conflict || !await save()) throw new Error('请先保存镜头修改，再检测实际停顿。');
    signal.throwIfAborted(); transcriptBaseline(baseline);
    const result = silenceDetectionSchema.parse(await rpc('audio.silence', { projectId: project.id, shotId: transcriptDialog!.shot.id, revision: session.state.revision, ...options }));
    signal.throwIfAborted(); transcriptBaseline(baseline);
    return result;
  }
  async function previewTranscript(candidate: ProjectDocument, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!transcriptDialog) throw new Error('文稿剪辑窗口已关闭。');
    const current = transcriptBaseline(transcriptDialog.project), shotId = transcriptDialog.shot.id;
    const candidateShot = candidate.shots.find(shot => shot.id === shotId), liveShot = current.shots.find(shot => shot.id === shotId);
    if (!candidateShot || !liveShot) throw new Error('试听镜头已移除，请重新选择。');
    const fields = ['durationUs', 'sourceInUs', 'audioInUs', 'videoInUs', 'sceneInUs', 'sceneDurationUs', 'sceneIndex', 'clipEdit', 'captionTrack', 'assetId', 'audioAssetId', 'videoAssetId'] as const;
    const replacement = { ...liveShot, ...Object.fromEntries(fields.map(field => [field, candidateShot[field]])) };
    const sources = new Map(current.clipEditSources.map(value => [value.id, value])), plans = new Map(current.clipEditPlans.map(value => [value.id, value]));
    for (const value of candidate.clipEditSources ?? []) if (!sources.has(value.id)) sources.set(value.id, value);
    for (const value of candidate.clipEditPlans ?? []) if (!plans.has(value.id)) plans.set(value.id, value);
    return prepareAudioMixPreview({ ...project, ...current, revision: session.state.revision, shots: current.shots.map(shot => shot.id === shotId ? replacement : shot), clipEditSources: [...sources.values()], clipEditPlans: [...plans.values()] }, signal);
  }
  async function applyBulk(request: BulkShotRequest) {
    if (session.state.conflict) throw new Error('项目已有外部修改，请先关闭窗口并比较合并，当前草稿会保留。');
    if (session.state.busy || savingEdits) throw new Error('正在保存项目，请稍后重试。');
    const current = request.changes.durationUs === undefined ? session.state.present : timingContent(session.state.present, request.ids);
    const targets = current.shots.filter(shot => request.ids.includes(shot.id));
    if (request.changes.durationUs !== undefined && request.sourceKey !== sourceDurationsKey(targets, workspace.assets)) throw new Error('所选镜头的素材已更新，请关闭后重新读取时长。');
    const next = applyBulkShotEdit(current, request.baseline, request.ids, request.changes, request.sourceDurations);
    clock.pause(); session.edit(next, '批量修改镜头');
    return save();
  }
  async function applySeries(settings: SeriesSettings, options: SeriesApplyOptions, baseline: ProjectDocument) {
    if (session.state.conflict || session.state.busy) return false;
    if (baseline.id !== project.id) throw new Error('系列设置不属于当前项目。');
    const next = applySeriesEdit(session.state.present, baseline, settings, options, seriesSubmitted.current);
    session.edit(next, '应用系列模板');
    seriesSubmitted.current = rememberSeriesSubmission(seriesSubmitted.current, next, { ...options, updateExistingSceneLook: options.updateExistingSceneLook && Boolean(settings.scenePreset) }, baseline.shots.map(shot => shot.id));
    return save();
  }
  async function applyOutput() {
    if (!output || !await save()) return;
    session.beginSave();
    try {
      const result = await action<ProjectDocument>('node.apply', { runId: output.runId, nodeId: output.nodeId, revision: session.state.revision }, '步骤产物已应用');
      if (result) { session.applySaved(result, '应用步骤产物'); setOutput(undefined); }
    } finally { session.endSave(); }
  }
  async function changeView(next: 'steps' | 'flow') {
    if (next === view) return;
    // Opening the graph must allow fixing unfinished input from a recovered draft.
    if (next !== 'flow') {
      // Unfinished shot or project fields must remain reachable for correction.
      const validSettings = projectSchema.safeParse({ ...project, ...session.state.present, workflow: project.workflow }).success;
      if (validSettings && !await save()) return;
    }
    clock.pause(); setView(next);
  }
  async function saveStep(node: WorkflowNode) {
    if (session.state.conflict) throw new Error('项目已有新修订，请先比较草稿后再保存步骤。');
    const current = session.state.present.workflow.nodes.find(item => item.id === node.id);
    if (!current || !sameContent(current, stepSubmitted.current ?? stepEditor)) throw new Error('步骤已在其他视图更新，当前输入已保留，请核对后重新打开。');
    session.edit({ ...session.state.present, workflow: { ...session.state.present.workflow, nodes: session.state.present.workflow.nodes.map(item => item.id === node.id ? node : item) } }, '调整步骤设置');
    stepSubmitted.current = node;
    return save();
  }
  async function start(nodeId?: string) {
    if (!await save()) return;
    await action('run.start', { projectId: project.id, ...(nodeId ? { nodeId } : {}) }, nodeId ? '步骤已开始执行' : '制作已开始');
  }
  const displayedProject = useMemo(() => ({ ...authoredProject, shots: previewShots }), [authoredProject, previewShots]);
  const completedNodeIds = useMemo(() => latestRun?.completedNodeIds ?? [], [latestRun?.completedNodeIds]);
  function toggleOutline() { setFocusPreview(false); setOutlineOpen(value => { localStorage.setItem('vq-outline-open', String(!value)); return !value; }); }
  function toggleInspector() { setFocusPreview(false); setInspectorOpen(value => { localStorage.setItem('vq-inspector-open', String(!value)); return !value; }); if (document.activeElement?.closest('#project-inspector')) document.querySelector<HTMLButtonElement>('[data-inspector-toggle]')?.focus(); }
  function openSettings() { setFocusPreview(false); setInspectorOpen(true); setInspectorTab('project'); }
  const parsedResearch = output ? researchResultSchema.safeParse(output.data) : undefined;
  const researchOutput = parsedResearch?.success ? parsedResearch.data : undefined;
  const outputKind = output?.kind;
  const canApplyOutput = ['script', 'style', 'assets', 'voice', 'animation'].includes(outputKind ?? '') || Boolean(output?.data && typeof output.data === 'object' && 'captionTrack' in output.data);
  if (!ready) return <div className="empty-state">正在读取项目与本地草稿…</div>;
  return <div className="workbench" onBlurCapture={() => session.endGroup()} onPointerUpCapture={event => { if (event.target instanceof HTMLInputElement && event.target.type === 'range') session.endGroup(); }}><div className="project-heading"><div className="project-heading-copy"><input className="project-title-input" aria-label="项目名称" value={title} onChange={event => setTitle(event.target.value)} /><p><span>{content.shots.length} 个镜头</span><span>修订 {edits.revision}</span><span>{profile.width} × {profile.height}</span>{(dirtyShot || dirtyProject) && <span className="unsaved-dot">未保存</span>}</p></div><div className="project-heading-actions">{view === 'steps' && <div className="editor-layout-actions" role="group" aria-label="工作区面板布局"><IconButton label={outlineVisible ? '收起镜头导航' : '显示镜头导航'} aria-pressed={outlineVisible} onClick={toggleOutline}><PanelLeft size={16} /></IconButton><IconButton data-inspector-toggle label="切换属性面板" aria-pressed={inspectorVisible} onClick={toggleInspector}><PanelRight size={16} /></IconButton><IconButton label={focusPreview ? '退出专注预览' : '专注预览'} aria-pressed={focusPreview} onClick={() => setFocusPreview(value => !value)}><ScanLine size={16} /></IconButton></div>}<TabSurface value={view} aria-label="工作区视图"><button type="button" aria-pressed={view === 'steps'} className={view === 'steps' ? 'active' : ''} onClick={() => void changeView('steps')}><Film size={13} />分镜</button><button type="button" aria-pressed={view === 'flow'} className={view === 'flow' ? 'active' : ''} onClick={() => void changeView('flow')}><GitBranch size={13} />流程</button></TabSurface><IconButton className="editing-history-control" label="撤销" title={edits.undo.at(-1) ? `撤销：${edits.undo.at(-1)?.label}（Ctrl/⌘ Z）` : '撤销（Ctrl/⌘ Z）'} disabled={!edits.undo.length || savingEdits || Boolean(edits.conflict)} onClick={() => void changeHistory('undo')}><Undo2 size={16} /></IconButton><IconButton className="editing-history-control" label="重做" title={edits.redo.at(-1) ? `重做：${edits.redo.at(-1)?.label}（Ctrl/⌘ Shift Z）` : '重做（Ctrl/⌘ Shift Z）'} disabled={!edits.redo.length || savingEdits || Boolean(edits.conflict)} onClick={() => void changeHistory('redo')}><Redo2 size={16} /></IconButton><IconButton label={savingEdits ? '正在保存修改' : '保存修改'} disabled={savingEdits || !(dirtyShot || dirtyProject) && view !== 'flow'} onClick={() => void save()}><Save size={16} /></IconButton><Button disabled={Boolean(busy)} onClick={() => void start()}><WandSparkles size={15} />开始制作</Button><Button variant="primary" onClick={() => void save().then(saved => { if (saved) setExporting(true); })}><ArrowDownToLine size={15} />导出</Button></div></div>{storageError && <div className="run-notice"><Notice kind="error">{storageError} 请先保存项目，并保留此窗口。</Notice></div>}{edits.recovered && !edits.conflict && <div className="run-notice"><Notice><span>已恢复未保存的本地草稿，含撤销与重做历史。</span><Button variant="ghost" onClick={() => session.discard(project)}>放弃恢复草稿</Button></Notice></div>}{edits.conflict && <div className="run-notice"><Notice><span>项目已有新修订，人工草稿已保留。保存前请比较并合并修改。</span><Button onClick={() => setConflictDialog(true)}>比较并处理</Button></Notice></div>}{conflictDialog && edits.conflict && <DraftConflictDialog base={edits.base} local={content} remote={editContent(edits.conflict)} onClose={() => setConflictDialog(false)} onResolve={choices => { session.resolve(choices); setConflictDialog(false); }} onDiscard={() => { if (edits.conflict) session.discard(edits.conflict); setConflictDialog(false); }} />}{view === 'flow' ? <Suspense fallback={<div className="empty-state">正在打开流程画布…</div>}><WorkflowCanvas key={project.id} workflow={content.workflow} models={workspace.models} dirty={session.dirty} saving={savingEdits} conflicted={Boolean(edits.conflict)} onChange={updateWorkflow} onEndGroup={session.endGroup} onSave={save} onHistory={direction => void changeHistory(direction)} /></Suspense> : <div className={`workbench-grid ${!outlineVisible ? 'outline-collapsed' : ''} ${!inspectorVisible ? 'inspector-collapsed' : ''}`} style={layoutStyle} ref={editor}><aside className="story-panel" id="project-outline" hidden={!outlineVisible}><ProjectOutline project={displayedProject} assets={workspace.assets} selectedShotId={selectedShotId} selectedIds={selection.ids} onSelectAll={selectAll} onClearSelection={clearSelection} onBulkEdit={() => setBulkEditing(true)} selectedNodeId={selectedNodeId} completedNodeIds={completedNodeIds} onSelectShot={selectShot} onSelectNode={node => { setSelectedNodeId(node.id); openStep(node); }} onAddShot={addShot} onOpenFlow={() => void changeView('flow')} /><PanelResizeHandle id="outline-resize" label="调整镜头导航宽度" side="left" value={actualOutline} min={184} max={maxOutline} defaultValue={224} onChange={setOutlineWidth} onCommit={value => localStorage.setItem('vq-outline-width', String(value))} /></aside><PlaybackPreview project={displayedProject} draft={effectiveDraft} assets={workspace.assets} timeline={timeline} audioMix={audioMix} onLevels={readAudioLevels} onPlayableChange={setPreviewPlayable} clock={clock} onSettings={openSettings} onRepair={shot => { setSelectedShotId(shot.id); setAssetKind(shot.videoAssetId ? 'video' : 'image'); setAssetDialog(true); }} onSelect={selectShot} onAdd={addShot} onError={notify} /><aside className="inspector" id="project-inspector" hidden={!inspectorVisible}><PanelResizeHandle id="inspector-resize" label="调整属性面板宽度" side="right" value={actualInspector} min={280} max={maxInspector} defaultValue={304} onChange={setInspectorWidth} onCommit={value => localStorage.setItem('vq-inspector-width', String(value))} /><div className="panel-heading"><TabSurface value={inspectorTab} variant="underline" aria-label="属性视图"><button type="button" aria-pressed={inspectorTab === 'shot'} className={inspectorTab === 'shot' ? 'active' : ''} onClick={() => setInspectorTab('shot')}>镜头属性</button><button type="button" aria-pressed={inspectorTab === 'project'} className={inspectorTab === 'project' ? 'active' : ''} onClick={() => setInspectorTab('project')}>项目设置</button></TabSurface><IconButton label="收起属性面板" onClick={toggleInspector}><PanelRightClose size={15} /></IconButton></div><div ref={inspectorBody} className="inspector-body">{inspectorTab === 'shot' && draft ? <><section className="inspector-section"><div className="section-heading"><Film size={14} /><h3>镜头 {(selectedIndex + 1).toString().padStart(2, '0')}</h3><IconButton label={draft.locked ? '解锁镜头' : '锁定镜头'} aria-pressed={draft.locked} onClick={() => setDraft({ ...draft, locked: !draft.locked })}>{draft.locked ? <LockKeyhole size={13} /> : <UnlockKeyhole size={13} />}</IconButton></div><Field label="镜头标题"><input value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></Field><Field label="旁白"><textarea value={draft.narration} onChange={event => setDraft({ ...draft, narration: event.target.value })} placeholder="这一镜头想讲什么？" /></Field><div className="field-row"><Field label="时长（秒）"><input type="number" min="0.5" max="600" step="0.1" value={(effectiveDraft ?? draft).durationUs / 1_000_000} onChange={event => setDraft({ ...draft, durationUs: Math.round((event.target.valueAsNumber || .5) * 1_000_000), sourceInUs: draft.sourceInUs ?? 0, sceneInUs: draft.sceneInUs ?? 0, sceneDurationUs: draft.sceneDurationUs ?? draft.durationUs })} /></Field><Field label="转场"><select value={draft.animation.transition} onChange={event => setDraft({ ...draft, animation: { ...draft.animation, transition: event.target.value as Shot['animation']['transition'] } })}><option value="cut">直接切换</option><option value="fade">柔和叠化</option><option value="wipe">擦除显现</option></select></Field></div><ClipTiming shot={effectiveDraft ?? draft} context={content} rate={profile.frameRate} sourceStatus={source.status} sourceDurationUs={source.durationUs} sourceError={source.error} disabled={savingEdits || Boolean(edits.conflict) || selection.ids.length != 1 || draft.locked} onTrim={trimClip} /><div className="inspector-actions"><Button variant="primary" busy={savingEdits} disabled={!dirtyShot} onClick={() => void save()}><Save size={13} />保存镜头</Button><Button disabled={draft.locked} onClick={() => setRegenerationShotId(draft.id)}><WandSparkles size={13} />AI 微调</Button></div></section><section className="inspector-section"><div className="section-heading"><Image size={14} /><h3>画面与素材</h3></div><SceneTemplateEditor value={draft.sceneTemplate} disabled={draft.locked} onChange={sceneTemplate => setDraft({ ...draft, sceneTemplate })} /><CharacterPicker value={draft.characterIds} version={workspace.version} disabled={draft.locked} onChange={characterIds => setDraft({ ...draft, characterIds })} /><Button className="button-full" variant="ghost" onClick={() => openClaims(draft.id)}><BookOpen size={13} />资料引用{draft.claimIds.length ? `（${draft.claimIds.length}）` : ''}</Button>{draft.claimIds.length > 0 && <p className="tiny-meta">{draft.claimIds.map(id => { const index = content.claims.findIndex(claim => claim.id === id); const claim = content.claims[index]; return claim ? `[${index + 1}] ${claim.status === 'verified' ? '已核验' : claim.status === 'disputed' ? '有争议' : '待核验'}` : '引用已失效'; }).join(' · ')}</p>}<Field label="画面要求"><textarea value={draft.visualPrompt} onChange={event => setDraft({ ...draft, visualPrompt: event.target.value })} placeholder="场景、角色、构图和动作…" /></Field><Field label="画面素材"><select value={draft.assetId ?? ''} disabled={Boolean(draft.sceneTemplate)} onChange={event => setDraft({ ...draft, assetId: event.target.value || undefined })}><option value="">使用示例画面</option>{workspace.assets.filter(asset => asset.active && asset.kind === 'image' && (!asset.projectId || asset.projectId === project.id)).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field><Field label="镜头视频"><select value={draft.videoAssetId ?? ''} disabled={Boolean(draft.sceneTemplate)} onChange={event => setDraft({ ...draft, videoAssetId: event.target.value || undefined, videoInUs: event.target.value ? 0 : undefined })}><option value="">使用二维画面与运镜</option>{workspace.assets.filter(asset => asset.active && asset.kind === 'video' && (!asset.projectId || asset.projectId === project.id)).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field><Button className="button-full" variant="ghost" disabled={Boolean(draft.sceneTemplate)} onClick={() => { setAssetKind('image'); setAssetDialog(true); }}><Upload size={13} />导入本地画面</Button></section><section className="inspector-section"><div className="section-heading"><Layers size={14} /><h3>运镜</h3></div><Field label={`缩放 ${draft.animation.zoom.toFixed(2)}×`}><input type="range" min="1" max="1.5" step="0.01" value={draft.animation.zoom} onChange={event => setDraft({ ...draft, animation: { ...draft.animation, zoom: Number(event.target.value) } })} /></Field><div className="field-row"><Field label="水平移动"><input type="number" min="-1000" max="1000" value={draft.animation.panX} onChange={event => setDraft({ ...draft, animation: { ...draft.animation, panX: event.target.valueAsNumber || 0 } })} /></Field><Field label="垂直移动"><input type="number" min="-1000" max="1000" value={draft.animation.panY} onChange={event => setDraft({ ...draft, animation: { ...draft.animation, panY: event.target.valueAsNumber || 0 } })} /></Field></div></section><section className="inspector-section"><div className="section-heading"><Mic size={14} /><h3>配音</h3></div><Field label="旁白音频"><select value={draft.audioAssetId ?? ''} onChange={event => setDraft({ ...draft, audioAssetId: event.target.value || undefined, audioInUs: event.target.value ? 0 : undefined })}><option value="">尚未添加配音</option>{workspace.assets.filter(asset => asset.active && asset.kind === 'audio' && (!asset.projectId || asset.projectId === project.id)).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field><p className="tiny-meta">可用“AI 微调”重新生成当前镜头的配音。</p>{staleSpeechCaptions && <Notice>旁白音频已更换，请打开字幕编辑器重新对齐或手动校准。</Notice>}<div className="inspector-actions"><Button disabled={audioMix.status === 'pending'} onClick={openCaptionEditor}>编辑字幕</Button><Button disabled={draft.locked || audioMix.status === 'pending'} onClick={openTranscript}>文稿剪辑与停顿清理</Button><Button disabled={draft.locked} onClick={() => openCaptionStyle({ mode: 'shot', shotId: draft.id })}>镜头字幕样式</Button><Button onClick={openMusicEditor}>背景音乐</Button><Button disabled={draft.locked} onClick={() => openAudio({ mode: 'shot', shotId: draft.id })}>镜头声音处理</Button></div></section></> : <><section className="inspector-section"><div className="section-heading"><Maximize2 size={14} /><h3>视频规格</h3></div><VideoSettings profile={profile} onChange={setProfile} /><div className="inspector-actions"><Button variant="primary" busy={savingEdits} disabled={!dirtyProject || !videoProfileSchema.safeParse(profile).success} onClick={() => void save()}><Save size={13} />保存设置</Button></div></section><section className="inspector-section"><div className="section-heading"><FileText size={14} /><h3>创意简报</h3></div><Field label="主题与核心问题"><textarea value={brief} onChange={event => setBrief(event.target.value)} /></Field><Field label="系列风格"><textarea value={style} onChange={event => setStyle(event.target.value)} /></Field><Button className="button-full" onClick={() => openCaptionStyle({ mode: 'project' })}>项目字幕样式</Button><Button className="button-full" onClick={openSeries}>应用系列模板</Button><Button className="button-full" onClick={() => setSeriesSaving(true)}>保存当前系列为模板</Button><Button className="button-full" onClick={openMusicEditor}>背景音乐</Button><Button className="button-full" onClick={() => openAudio({ mode: 'project' })}>项目混音设置</Button><Button className="button-full" onClick={() => openClaims()}><BookOpen size={13} />资料与事实主张</Button><Field label="画面引用编号" hint="显示镜头引用的资料编号与核验状态；完整引用目录随分镜文件导出。"><select value={content.referenceDisplay} onChange={event => updateSettings({ referenceDisplay: event.target.value as 'hidden' | 'numbers' }, '修改引用显示')}><option value="hidden">隐藏编号</option><option value="numbers">显示资料编号</option></select></Field></section><section className="inspector-section"><div className="section-heading"><ShieldCheck size={14} /><h3>项目备份</h3></div><Button className="button-full" onClick={() => void action<{ path: string }>('project.backup', { projectId: project.id }).then(result => { if (result) notify(`备份已保存：${result.path}`); })}><Download size={13} />备份项目与素材</Button></section></>}</div></aside><Timeline project={displayedProject} assets={workspace.assets} shots={previewShots} timeline={timeline} selectedId={selectedShotId} selectedIds={selection.ids} onSelectAll={selectAll} onClearSelection={clearSelection} onBulkEdit={() => setBulkEditing(true)} rate={profile.frameRate} clock={clock} onSelect={selectShot} onMove={moveShot} onDuplicate={duplicateShot} onRemove={removeShot} onSplit={splitSelected} onReorder={reorderClip} onTrim={trimClip} sourceDurationUs={source.durationUs} sourceStatus={source.status} onOpenMusic={openMusicEditor} editingDisabled={savingEdits || Boolean(edits.conflict)} /></div>}{transcriptDialog && <Suspense fallback={null}><TranscriptEditingDialog project={transcriptDialog.project} shot={transcriptDialog.shot} assets={transcriptDialog.assets} disabled={savingEdits || Boolean(edits.conflict)} onClose={() => setTranscriptDialog(undefined)} onApply={(ranges: readonly ClipRange[], baseline: ProjectDocument, assetsBaseline: readonly AssetRecord[]) => applyTranscript({ kind: 'delete', ranges }, baseline, assetsBaseline)} onRestore={(baseline, assetsBaseline) => applyTranscript({ kind: 'restore' }, baseline, assetsBaseline)} onDetect={detectSilence} onPreview={previewTranscript} onLevels={readAudioLevels} /></Suspense>}{audioTarget && <Suspense fallback={null}><AudioProcessingDialog project={authoredProject} shot={audioTarget.mode === 'shot' ? content.shots.find(shot => shot.id === audioTarget.shotId) : undefined} disabled={savingEdits || Boolean(edits.conflict)} onClose={() => setAudioTarget(undefined)} onApply={applyAudio} onPreview={previewAudio} onLevels={readAudioLevels} /></Suspense>}{bulkEditing && <Suspense fallback={null}><BulkShotDialog project={displayedProject} ids={selection.ids} primaryId={selectedShotId} assets={workspace.assets} disabled={savingEdits || Boolean(edits.conflict)} onClose={() => setBulkEditing(false)} onApply={applyBulk} onRetry={save} /></Suspense>}{captionShot && <CaptionEditor key={captionShot.id} shot={captionShot} context={captionEdit?.context} rate={profile.frameRate} models={workspace.models} audioAsset={captionEdit?.audioAsset} disabled={savingEdits || Boolean(edits.conflict)} onClose={() => setCaptionEdit(undefined)} onApply={applyCaptions} onTranscribe={recognizeCaptions} onSeek={localUs => clock.seek(clipStart(captionShotId) + localUs)} />}{regenerationShot && <Suspense fallback={null}><ShotRegenerationDialog key={regenerationShot.id} project={displayedProject} shot={regenerationShot} models={workspace.models} assets={workspace.assets} onClose={() => setRegenerationShotId(undefined)} onGenerate={generateShotCandidate} onApply={applyCandidate} /></Suspense>}{musicEditing && <MusicEditor clips={content.musicClips} assets={workspace.assets} durationUs={totalUs} onClose={() => setMusicEditing(false)} onApply={applyMusic} onImport={async path => await action<AssetRecord>('asset.import', { projectId: project.id, path, kind: 'audio' }, '音乐已导入') ?? undefined} onSeek={clock.seek} />}{scopeNodeId && <Suspense fallback={<Notice>正在打开执行范围…</Notice>}><RunScopeDialog projectId={project.id} nodeId={scopeNodeId} version={workspace.version} onClose={() => setScopeNodeId(undefined)} onStarted={() => notify('所选范围已开始执行')} /></Suspense>}{stepEditor && <StepEditor onPreview={nodeId => { setStepEditor(undefined); setScopeNodeId(nodeId); }} node={stepEditor} workspace={workspace} onSave={saveStep} onClose={() => setStepEditor(undefined)} onExecute={async nodeId => { setStepEditor(undefined); await start(nodeId); }} onResult={async nodeId => { if (!latestRun) { notify('请先执行这个步骤'); return; } try { const inspection = runInspectionSchema.parse(await rpc('run.inspect', { runId: latestRun.id, nodeId })); const payload = runStepPayloadSchema.parse(await rpc('run.step.payload', { runId: latestRun.id, nodeId, kind: 'output' })); if (payload.available && inspection.selected) setOutput({ nodeId, runId: latestRun.id, data: payload.value, kind: inspection.selected.node.kind }); else notify('这个步骤尚未保存产物'); } catch (error) { notify(error instanceof Error ? error.message : String(error), true); } }} />}{exporting && <ExportDialog project={displayedProject} workspace={workspace} action={action} onClose={() => setExporting(false)} onBatch={() => void save().then(saved => { if (saved) { setExporting(false); setBatchExporting(true); } })} notify={notify} />}{batchExporting && <BatchExportDialog project={displayedProject} action={action} onClose={() => setBatchExporting(false)} notify={notify} />}{captionStyleTarget && <Suspense fallback={null}><CaptionStyleDialog key={captionStyleTarget.mode === 'shot' ? captionStyleTarget.shotId : 'project'} project={displayedProject} shot={captionStyleTarget.mode === 'shot' ? content.shots.find(shot => shot.id === captionStyleTarget.shotId) : undefined} assets={workspace.assets} mode={captionStyleTarget.mode} disabled={savingEdits || Boolean(edits.conflict)} onClose={() => setCaptionStyleTarget(undefined)} onApply={applyCaptionStyle} /></Suspense>}{seriesApplying && <Suspense fallback={null}><SeriesApplyDialog project={displayedProject} assets={workspace.assets} version={workspace.version} disabled={savingEdits || Boolean(edits.conflict)} onClose={() => setSeriesApplying(false)} onApply={applySeries} /></Suspense>}{seriesSaving && <Suspense fallback={null}><SeriesTemplateDialog initialSettings={seriesSettingsFromProject(displayedProject)} action={action} onClose={() => setSeriesSaving(false)} /></Suspense>}{showClaimDialog && <Suspense fallback={null}><ClaimsEditor project={displayedProject} models={workspace.models} initialShotId={claimsShotId} disabled={savingEdits || Boolean(edits.conflict)} onClose={() => setShowClaimDialog(false)} onApply={applyClaims} onAnalyze={analyzeSources} /></Suspense>}{assetDialog && <Dialog title={assetKind === 'video' ? '重新导入镜头视频' : '导入镜头画面'} onClose={() => setAssetDialog(false)}><form onSubmit={event => { event.preventDefault(); void action<AssetRecord>('asset.import', { projectId: project.id, path: assetPath, kind: assetKind }, '画面已导入').then(result => { if (result && draft) { const current = session.state.present.shots.find(shot => shot.id === draft.id); if (current) { const next = assetKind === 'video' ? replaceShotMedia(session.state.present, current.id, 'video', result, () => crypto.randomUUID()) : session.state.present; session.edit({ ...next, shots: next.shots.map(shot => shot.id === current.id ? assetKind === 'video' ? shot : { ...shot, assetId: result.id } : shot) }, '导入镜头素材'); } setAssetDialog(false); setAssetPath(''); } }); }}><div className="dialog__body"><Field label={assetKind === 'video' ? '视频文件路径' : '图片文件路径'}><PathPicker label={assetKind === 'video' ? '视频文件路径' : '图片文件路径'} value={assetPath} onChange={setAssetPath} extensions={assetKind === 'video' ? ['mp4', 'mov', 'webm'] : ['png', 'jpg', 'jpeg', 'webp', 'svg']} required autoFocus placeholder={assetKind === 'video' ? 'D:\materials\scene.mp4' : 'D:\materials\scene.png'} /></Field></div><div className="dialog__footer"><Button onClick={() => setAssetDialog(false)}>取消</Button><Button variant="primary" type="submit">导入素材</Button></div></form></Dialog>}{researchOutput && <Suspense fallback={null}><ResearchReview project={displayedProject} result={researchOutput} onClose={() => setOutput(undefined)} onApply={async (claims, bindings) => { const applied = await applyResearch(researchOutput, claims, bindings); if (applied) setOutput(undefined); return applied; }} /></Suspense>}{output && !researchOutput && <Dialog title="步骤产物" onClose={() => setOutput(undefined)} className="dialog--wide"><div className="dialog__body"><pre className="run-log">{typeof output.data === 'string' ? output.data : JSON.stringify(output.data, null, 2)}</pre></div><div className="dialog__footer"><Button onClick={() => setOutput(undefined)}>关闭</Button>{canApplyOutput && <Button variant="primary" disabled={savingEdits || Boolean(edits.conflict)} onClick={() => void applyOutput()}>应用到项目</Button>}{outputKind === 'research' && <Button onClick={() => { setOutput(undefined); openClaims(); }}>管理资料与引用</Button>}</div></Dialog>}</div>;
}

function panelWidth(key: string, fallback: number, min: number, max: number) {
  const stored = localStorage.getItem(key);
  const value = stored ? Number(stored) : fallback;
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function StepEditor({ node, workspace, onSave, onClose, onExecute, onResult, onPreview }: { node: WorkflowNode; workspace: WorkspaceView; onSave: (node: WorkflowNode) => Promise<boolean>; onClose: () => void; onExecute: (nodeId: string) => Promise<void>; onPreview: (nodeId: string) => void; onResult: (nodeId: string) => Promise<void> }) {
  const [draft, setDraft] = useState(node);
  const latestDraft = useRef(draft); latestDraft.current = draft;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(mode: 'save' | 'execute' | 'preview' = 'save') {
    setBusy(true); setError('');
    try {
      if (!await onSave(draft)) { setError('步骤未保存，当前输入已保留。'); return; }
      if (!sameContent(draft, latestDraft.current)) { setError('保存期间有新修改，当前输入已保留，请继续保存后再执行。'); return; }
      if (mode === 'execute') await onExecute(node.id); else if (mode === 'preview') onPreview(node.id); else onClose();
    }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <Dialog title={node.label} onClose={onClose}><div className="dialog__body">{error && <Notice kind="error">{error}</Notice>}<p>{node.description}</p><Field label="提示词与补充要求"><textarea value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} placeholder="为这个步骤补充规则、风格或修改要求…" rows={5} /></Field><Field label="使用模型"><select value={draft.modelId ?? ''} onChange={event => setDraft({ ...draft, modelId: event.target.value || undefined })}><option value="">本地素材 / 手动制作</option>{workspace.models.filter(model => model.enabled).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></Field><fieldset className="capability-fieldset"><legend>应用 Skill</legend>{workspace.skills.filter(skill => skill.enabled).length ? workspace.skills.filter(skill => skill.enabled).map(skill => <label className="field-inline" key={skill.id}><input type="checkbox" checked={draft.skillIds.includes(skill.id)} onChange={event => setDraft({ ...draft, skillIds: event.target.checked ? [...draft.skillIds, skill.id] : draft.skillIds.filter(id => id !== skill.id) })} />{skill.name}</label>) : <p className="tiny-meta">在 Skill 工作室导入创作规范后，即可绑定到这个步骤。</p>}</fieldset>{draft.kind === 'agent' && <ToolBindings node={draft} onChange={setDraft} />}<label className="field-inline"><input type="checkbox" checked={draft.requiresReview} onChange={event => setDraft({ ...draft, requiresReview: event.target.checked })} />完成后等待人工审阅</label><Button variant="ghost" className="button-full" busy={busy} onClick={() => void save('preview')}><GitBranch size={14} />预览这步及后续</Button><Button variant="ghost" className="button-full" onClick={() => void onResult(node.id)}><FileText size={14} />查看最近产物</Button></div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button busy={busy} onClick={() => void save()}>保存设置</Button><Button variant="primary" busy={busy} onClick={() => void save('execute')}><Play size={14} />执行这一步</Button></div></Dialog>;
}

function ExportDialog({ project, workspace, action, onClose, onBatch, notify }: { project: ProjectDocument; workspace: WorkspaceView; action: Action; onClose: () => void; onBatch: () => void; notify: (message: string, error?: boolean) => void }) {
  const [profile, setProfile] = useState(project.profile);
  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string>();
  const [result, setResult] = useState<string>();
  const run = workspace.runs.find(item => item.id === runId);
  const active = busy || Boolean(run && ['queued', 'running', 'waiting_external', 'retry_scheduled'].includes(run.status));
  useEffect(() => {
    if (run?.status !== 'succeeded') return;
    let mounted = true;
    void rpc<Record<string, unknown>>('node.result', { runId: run.id, nodeId: 'export' }).then(output => {
      if (!mounted || !output) return;
      const path = output.videoPath ?? output.path ?? output.outputPath;
      setResult(typeof path === 'string' ? path : '项目输出目录');
    }).catch(error => { if (mounted) notify(error instanceof Error ? error.message : String(error), true); });
    return () => { mounted = false; };
  }, [run?.id, run?.status, notify]);
  return <Dialog title="导出视频" onClose={onClose}><div className="dialog__body"><VideoSettings profile={profile} onChange={setProfile} compact /><Field label="输出文件路径" hint="留空时保存到项目的输出目录。"><PathPicker label="输出文件路径" mode="save" value={destination} onChange={setDestination} extensions={['mp4']} disabled={active} placeholder="D:\Videos\我的视频.mp4" /></Field>{project.shots.every(shot => !shot.audioAssetId && !usesVideoAudio(shot)) && !project.musicClips?.length && <Notice>当前项目尚未添加旁白音频，将导出静音画面小样。</Notice>}{run && <div className="export-run"><Status value={run.status} /><p className="tiny-meta">{'导出任务已保存，可关闭此窗口后在制作记录中继续查看。'}</p>{run.error && <Notice kind="error">{run.error}</Notice>}</div>}{result && <Notice kind="success">文件已保存：{result}{nativeDesktop && <Button variant="ghost" onClick={() => void revealFile(result).catch(error => notify(error instanceof Error ? error.message : String(error), true))}><FolderOpen size={14} />在文件夹中显示</Button>}</Notice>}<div className="export-secondary"><Button disabled={active} onClick={onBatch}><Layers size={14} />多比例批量导出</Button><Button onClick={() => { downloadText(`${project.title}.srt`, createSrt(project.shots, project)); notify('字幕文件已导出'); }}><FileText size={14} />导出字幕</Button><Button onClick={() => { downloadText(`${project.title}-分镜.json`, JSON.stringify(project, null, 2), 'application/json'); notify('分镜文件已导出'); }}><Download size={14} />导出分镜</Button></div></div><div className="dialog__footer"><Button onClick={onClose}>关闭</Button>{active && run ? <Button onClick={() => void action('run.cancel', { runId: run.id }, '已请求停止导出')}><Square size={14} />停止导出</Button> : <Button variant="primary" busy={busy} disabled={!videoProfileSchema.safeParse(profile).success || !project.shots.length} onClick={() => { setBusy(true); setResult(undefined); void action<{ runId?: string; id?: string; path?: string; outputPath?: string }>('render.export', { projectId: project.id, profile, ...(destination ? { destination } : {}) }).then(value => { setBusy(false); if (value) { const id = value.runId ?? value.id; if (id) setRunId(id); else if (value.path || value.outputPath) setResult(value.path ?? value.outputPath); } }); }}><ArrowDownToLine size={15} />导出 MP4</Button>}</div></Dialog>;
}
