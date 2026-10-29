import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { PanelLeft, PanelRight, PanelRightClose, ScanLine, ArrowDownToLine, ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, CircleAlert, Clapperboard, Download, FileText, Film, FolderOpen, GitBranch, History, Image, Layers, LockKeyhole, Maximize2, Mic, Play, Plus, RefreshCw, Save, ShieldCheck, Sparkles, Square, UnlockKeyhole, Upload, WandSparkles, X } from 'lucide-react';
import { DEFAULT_VIDEO_PROFILE, formatFrameRate, shotSchema, videoProfileSchema, workspaceSnapshotSchema, type ProjectDocument, type Shot, type VideoProfile, type WorkspaceSnapshot, type WorkflowNode } from '@video-quickly/contracts';
import { buildTimeline, createSrt } from '@video-quickly/video';
import { Button, Dialog, EmptyState, Field, IconButton, Notice, Status, formatTime } from './components/Primitives';
import VideoSettings from './components/VideoSettings';
import PlaybackPreview from './components/PlaybackPreview';
import Timeline from './components/Timeline';
import { PlaybackClock } from './lib/playback';
import WorkspaceSidebar, { type Page } from './components/WorkspaceSidebar';
import ProjectOutline from './components/ProjectOutline';
import { PanelResizeHandle } from './components/PanelResizeHandle';
import ToolBindings from './components/ToolBindings';
import PathPicker, { nativeDesktop, revealFile } from './components/PathPicker';
import { AssetsPage, ModelsPage, ProjectsPage, RunsPage, SkillsPage } from './features/LibraryPages';
import { rpc, subscribe } from './lib/client';
import type { Action } from './lib/types';

const WorkflowCanvas = lazy(() => import('./features/WorkflowCanvas'));
type Toast = { text: string; error?: boolean };
const pages: Array<{ id: Page; label: string; icon: typeof Film }> = [
  { id: 'projects', label: '我的项目', icon: FolderOpen },
  { id: 'workbench', label: '创作工作台', icon: Clapperboard },
  { id: 'assets', label: '素材库', icon: Layers },
  { id: 'models', label: '模型连接', icon: Sparkles },
  { id: 'skills', label: 'Skill 工作室', icon: BookOpen },
  { id: 'runs', label: '制作记录', icon: History },
];

function downloadText(name: string, content: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>();
  const [loadError, setLoadError] = useState('');
  const [page, setPage] = useState<Page>('workbench');
  const [projectId, setProjectId] = useState<string>();
  const [theme, setTheme] = useState(() => localStorage.getItem('vq-theme') === 'light' ? 'light' : 'dark');
  const [toast, setToast] = useState<Toast>();
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth <= 1200 || localStorage.getItem('vq-sidebar-collapsed') === 'true');
  const toggleSidebar = useCallback(() => setSidebarCollapsed(value => { localStorage.setItem('vq-sidebar-collapsed', String(!value)); return !value; }), []);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const snapshotRequest = useRef(0);
  const appliedSnapshot = useRef(0);
  const saveBeforeLeave = useRef<(() => Promise<boolean>) | null>(null);
  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const refresh = useCallback(async () => {
    const request = ++snapshotRequest.current;
    try {
      const result = workspaceSnapshotSchema.parse(await rpc('workspace.snapshot'));
      if (request < appliedSnapshot.current) return result;
      appliedSnapshot.current = request;
      setWorkspace(previous => previous ? {
        ...result,
        projects: retainRecords(previous.projects, result.projects),
        assets: retainRecords(previous.assets, result.assets),
        models: retainRecords(previous.models, result.models),
        skills: retainRecords(previous.skills, result.skills),
      } : result); setLoadError('');
      setProjectId(current => current && result.projects.some(project => project.id === current && !project.archived) ? current : result.projects.find(project => !project.archived)?.id);
      return result;
    } catch (error) { setLoadError(error instanceof Error ? error.message : String(error)); return undefined; }
  }, []);
  useEffect(() => { void refresh(); const unsubscribe = subscribe(() => { if (refreshTimer.current) return; refreshTimer.current = setTimeout(() => { refreshTimer.current = undefined; void refresh(); }, 150); }); return () => { unsubscribe(); if (refreshTimer.current) clearTimeout(refreshTimer.current); }; }, [refresh]);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('vq-theme', theme); }, [theme]);
  useEffect(() => { const media = matchMedia('(max-width: 1200px)'); const update = () => setSidebarCollapsed(media.matches || localStorage.getItem('vq-sidebar-collapsed') === 'true'); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(undefined), toast.error ? 8000 : 3500); return () => clearTimeout(timer); }, [toast]);
  const action: Action = useCallback(async <T,>(method: string, params?: unknown, message?: string): Promise<T | null> => {
    setSaving(value => value + 1);
    try { const result = await rpc<T>(method, params); await refresh(); if (message) notify(message); return result; }
    catch (error) { notify(error instanceof Error ? error.message : String(error), true); return null; }
    finally { setSaving(value => Math.max(0, value - 1)); }
  }, [notify, refresh]);
  const project = workspace?.projects.find(item => item.id === projectId && !item.archived);
  async function navigate(next: Page) { if (page === 'workbench' && next !== page && saveBeforeLeave.current && !await saveBeforeLeave.current()) return; setPage(next); }
  function registerSave(callback: (() => Promise<boolean>) | null) { saveBeforeLeave.current = callback; }
  async function openProject(id: string) { if (page === 'workbench' && id !== projectId && saveBeforeLeave.current && !await saveBeforeLeave.current()) return; setProjectId(id); setPage('workbench'); }
  async function createProject() { if (page === 'workbench' && saveBeforeLeave.current && !await saveBeforeLeave.current()) return; setCreating(true); }
  if (!workspace) return <div className="welcome-loading"><Clapperboard size={34} /><strong>Video Quickly</strong><p>{loadError || '正在打开本地工作区…'}</p>{loadError && <Button onClick={() => void refresh()}><RefreshCw size={15} />重新连接</Button>}</div>;
  return <div className={`app workspace-shell ${sidebarCollapsed ? 'workspace-shell--collapsed' : ''}`}><WorkspaceSidebar page={page} projectId={projectId} projects={workspace.projects} navigation={pages} collapsed={sidebarCollapsed} theme={theme} onToggle={toggleSidebar} onTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} onNavigate={next => void navigate(next)} onOpen={id => void openProject(id)} onCreate={() => void createProject()} /><div className="main-shell">{(page !== 'workbench' || !project) && <header className="topbar"><IconButton label="切换工作空间导航" onClick={toggleSidebar}><PanelLeft size={17} /></IconButton><div className="breadcrumb"><FolderOpen size={15} /><span>工作空间</span><ChevronRight size={12} /><strong>{pages.find(item => item.id === page)?.label}</strong>{page === 'workbench' && project && <><ChevronRight size={12} /><strong>{project.title}</strong></>}</div><div className="topbar-right"><span className="save-indicator">{saving ? <RefreshCw size={12} /> : <Check size={12} />}{saving ? '正在保存' : '已连接本机'}</span><IconButton label="新建项目" onClick={() => setCreating(true)}><Plus size={17} /></IconButton><div className="avatar" aria-label="本地创作者">创</div></div></header>}<main className="page-body">{loadError && <div className="run-notice"><Notice kind="error">{loadError}</Notice></div>}{page === 'workbench' ? project ? <Workbench key={project.id} project={project} workspace={workspace} action={action} notify={notify} onToggleSidebar={toggleSidebar} onRegisterSave={registerSave} onRuns={() => void navigate('runs')} /> : <EmptyState icon={<Clapperboard size={28} />} title="开始一段新的创作" description="创建项目，记录你的主题，再把想法展开成镜头。"><Button variant="primary" onClick={() => setCreating(true)}><Plus size={16} />新建项目</Button></EmptyState> : page === 'projects' ? <ProjectsPage workspace={workspace} action={action} onOpen={openProject} onCreate={() => setCreating(true)} /> : page === 'models' ? <ModelsPage workspace={workspace} action={action} /> : page === 'skills' ? <SkillsPage workspace={workspace} action={action} /> : page === 'assets' ? <AssetsPage workspace={workspace} action={action} project={project} /> : <RunsPage workspace={workspace} action={action} onOpen={openProject} />}</main><footer className="statusbar"><ShieldCheck size={12} /><span>项目与执行进度保存在本机</span><div className="statusbar-right"><span>{workspace.system.ffmpegAvailable ? '媒体引擎已就绪' : '媒体引擎待配置'}</span><span className="shortcut"><kbd>Space</kbd> 播放 / 暂停</span><span className="shortcut"><kbd>Ctrl</kbd><kbd>S</kbd> 保存</span></div></footer></div>{toast && <div className={`toast ${toast.error ? 'toast--error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <CircleAlert size={16} /> : <Check size={16} />}{toast.text}<IconButton label="关闭提示" onClick={() => setToast(undefined)}><X size={14} /></IconButton></div>}{creating && <CreateProjectDialog action={action} onClose={() => setCreating(false)} onCreated={project => { setCreating(false); openProject(project.id); }} />}</div>;
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
  const [busy, setBusy] = useState(false);
  return <Dialog title="新建视频项目" onClose={onClose}><form onSubmit={event => { event.preventDefault(); setBusy(true); void action<ProjectDocument>('project.create', { title, brief, profile }, '项目已创建').then(result => { setBusy(false); if (result) onCreated(result); }); }}><div className="dialog__body"><Field label="项目名称"><input autoFocus required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} placeholder="给这段创作起个名字" /></Field><Field label="创意简报"><textarea value={brief} onChange={event => setBrief(event.target.value)} placeholder="主题、目标观众，以及你想讲清楚的一个问题…" /></Field><details className="creation-settings"><summary>视频规格 · {profile.width} × {profile.height} · {formatFrameRate(profile.frameRate)} fps</summary><VideoSettings profile={profile} onChange={setProfile} compact /></details></div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={busy} disabled={!title.trim() || !videoProfileSchema.safeParse(profile).success}>创建项目</Button></div></form></Dialog>;
}

function Workbench({ project, workspace, action, notify, onRuns, onRegisterSave, onToggleSidebar }: { project: ProjectDocument; workspace: WorkspaceSnapshot; action: Action; notify: (message: string, error?: boolean) => void; onRuns: () => void; onRegisterSave: (callback: (() => Promise<boolean>) | null) => void; onToggleSidebar: () => void }) {
  const [view, setView] = useState<'steps' | 'flow'>('steps');
  const [selectedShotId, setSelectedShotId] = useState(project.shots[0]?.id);
  const [selectedNodeId, setSelectedNodeId] = useState('script');
  const [inspectorTab, setInspectorTab] = useState<'shot' | 'project'>('shot');
  const [title, setTitle] = useState(project.title);
  const [draft, setDraft] = useState<Shot | undefined>(project.shots[0]);
  const [profile, setProfile] = useState(project.profile);
  const [brief, setBrief] = useState(project.brief);
  const [style, setStyle] = useState(project.style);
  const [exporting, setExporting] = useState(false);
  const [stepEditor, setStepEditor] = useState<WorkflowNode>();
  const [showClaimDialog, setShowClaimDialog] = useState(false);
  const [assetDialog, setAssetDialog] = useState(false);
  const [assetKind, setAssetKind] = useState<'image' | 'video'>('image');
  const [assetPath, setAssetPath] = useState('');
  const [output, setOutput] = useState<{ nodeId: string; data: unknown; runId: string }>();
  const revision = useRef(project.revision);
  const sourceProject = useRef({ project, selectedShotId });
  const saveInFlight = useRef<Promise<boolean> | undefined>(undefined);
  const flowSave = useRef<(() => Promise<boolean>) | null>(null);
  const registerFlowSave = useCallback((callback: (() => Promise<boolean>) | null) => { flowSave.current = callback; }, []);
  const [savingEdits, setSavingEdits] = useState(false);
  const [outlineWidth, setOutlineWidth] = useState(() => panelWidth('vq-outline-width', 224, 184, 320));
  const [inspectorWidth, setInspectorWidth] = useState(() => panelWidth('vq-inspector-width', 304, 280, 400));
  const [outlineOpen, setOutlineOpen] = useState(() => localStorage.getItem('vq-outline-open') !== 'false');
  const [inspectorOpen, setInspectorOpen] = useState(() => localStorage.getItem('vq-inspector-open') !== 'false');
  const [focusPreview, setFocusPreview] = useState(false);
  const outlineVisible = outlineOpen && !focusPreview;
  const inspectorVisible = inspectorOpen && !focusPreview;
  const editor = useRef<HTMLDivElement>(null);
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
  }, [view]);
  const totalUs = project.shots.reduce((sum, shot) => sum + shot.durationUs, 0);
  const [clock] = useState(() => new PlaybackClock(totalUs, project.profile.frameRate));
  const timeline = useMemo(() => buildTimeline(project.shots), [project.shots]);
  const selectedIndex = Math.max(0, project.shots.findIndex(shot => shot.id === selectedShotId));
  const selectedShot = project.shots[selectedIndex];
  const latestRun = workspace.runs.find(run => run.projectId === project.id);
  const busy = latestRun && ['running', 'queued', 'waiting_external', 'retry_scheduled'].includes(latestRun.status);
  const dirtyShot = draft && selectedShot && JSON.stringify(draft) !== JSON.stringify(selectedShot);
  const dirtyProject = title !== project.title || brief !== project.brief || style !== project.style || JSON.stringify(profile) !== JSON.stringify(project.profile);
  useEffect(() => {
    const previous = sourceProject.current;
    revision.current = project.revision;
    const shot = project.shots.find(item => item.id === selectedShotId) ?? project.shots[0];
    const previousShot = previous.project.shots.find(item => item.id === previous.selectedShotId);
    setDraft(current => previous.selectedShotId !== selectedShotId || !project.shots.some(item => item.id === current?.id) || JSON.stringify(current) === JSON.stringify(previousShot) ? shot : current);
    setTitle(current => current === previous.project.title ? project.title : current);
    setBrief(current => current === previous.project.brief ? project.brief : current);
    setStyle(current => current === previous.project.style ? project.style : current);
    setProfile(current => JSON.stringify(current) === JSON.stringify(previous.project.profile) ? project.profile : current);
    sourceProject.current = { project, selectedShotId };
    if (selectedShotId && !project.shots.some(item => item.id === selectedShotId)) setSelectedShotId(shot?.id);
  }, [project.revision, selectedShotId]);
  useEffect(() => { clock.configure(totalUs, profile.frameRate); }, [clock, totalUs, profile.frameRate]);
  useEffect(() => () => clock.dispose(), [clock]);
  useEffect(() => { if (view === 'flow') clock.pause(); }, [view, clock]);
  useEffect(() => { if (stepEditor || exporting || assetDialog || showClaimDialog || output) clock.pause(); }, [clock, stepEditor, exporting, assetDialog, showClaimDialog, output]);
  const save = useCallback(async () => {
    if (saveInFlight.current) return saveInFlight.current;
    const operation = async () => {
      setSavingEdits(true);
      try {
        if (dirtyProject) { const result = await action<ProjectDocument>('project.update', { projectId: project.id, revision: revision.current, patch: { title, brief, profile, style } }); if (!result) return false; revision.current = result.revision; }
        if (dirtyShot && draft) { const result = await action<ProjectDocument>('project.saveShot', { projectId: project.id, revision: revision.current, shot: draft }); if (!result) return false; revision.current = result.revision; }
        if (flowSave.current && !await flowSave.current()) return false;
        if (dirtyProject || dirtyShot) notify('修改已保存');
        return true;
      } finally { setSavingEdits(false); }
    };
    saveInFlight.current = operation();
    try { return await saveInFlight.current; } finally { saveInFlight.current = undefined; }
  }, [action, brief, dirtyProject, dirtyShot, draft, notify, profile, project.id, project.revision, style, title]);
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
      if (document.querySelector('dialog[open]') || view !== 'steps' || event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); return; }
      const target = event.target;
      if (target instanceof HTMLElement && (target.closest('input,textarea,select,button,[role="slider"]') || target.isContentEditable)) return;
      if (event.code === 'Space') { event.preventDefault(); if (!event.repeat) clock.toggle(); }
      if (event.code === 'ArrowRight') { event.preventDefault(); clock.step(event.shiftKey ? 10 : 1); }
      if (event.code === 'ArrowLeft') { event.preventDefault(); clock.step(event.shiftKey ? -10 : -1); }
      if (event.code === 'Home') { event.preventDefault(); clock.seek(0); }
      if (event.code === 'End') { event.preventDefault(); clock.seek(totalUs); }
    }
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [clock, save, totalUs, view]);
  async function selectShot(id: string) { if ((dirtyShot || dirtyProject) && !await save()) return; setSelectedShotId(id); setInspectorTab('shot'); const clip = timeline.find(item => item.shotId === id); if (clip) clock.seek(clip.startUs); }
  async function addShot() {
    if ((dirtyShot || dirtyProject) && !await save()) return;
    const shot = shotSchema.parse({ id: crypto.randomUUID(), title: `镜头 ${project.shots.length + 1}`, narration: '', visualPrompt: '', durationUs: 6_000_000 });
    const shots = project.shots.map(item => dirtyShot && draft?.id === item.id ? draft : item);
    const result = await action<ProjectDocument>('project.update', { projectId: project.id, revision: revision.current, patch: { shots: [...shots, shot] } }, '新镜头已添加');
    if (result) { setSelectedShotId(shot.id); clock.seek(buildTimeline(result.shots).find(clip => clip.shotId === shot.id)?.startUs ?? 0); }
  }
  async function moveShot(offset: number) {
    const target = selectedIndex + offset;
    if (target < 0 || target >= project.shots.length) return;
    if ((dirtyShot || dirtyProject) && !await save()) return;
    const shots = project.shots.map(item => dirtyShot && draft?.id === item.id ? draft : item); [shots[selectedIndex], shots[target]] = [shots[target], shots[selectedIndex]];
    clock.pause();
    const result = await action<ProjectDocument>('project.update', { projectId: project.id, revision: revision.current, patch: { shots } }, '镜头顺序已更新');
    if (result) clock.seek(buildTimeline(result.shots).find(clip => clip.shotId === selectedShotId)?.startUs ?? 0);
  }
  async function duplicateShot() {
    if (!draft || !await save()) return;
    const shot = { ...draft, id: crypto.randomUUID(), title: `${draft.title} · 副本` };
    const shots = project.shots.map(item => item.id === draft.id ? draft : item);
    const result = await action<ProjectDocument>('project.update', { projectId: project.id, revision: revision.current, patch: { shots: [...shots.slice(0, selectedIndex + 1), shot, ...shots.slice(selectedIndex + 1)] } }, '镜头已复制');
    if (result) { clock.pause(); setSelectedShotId(shot.id); clock.seek(buildTimeline(result.shots).find(clip => clip.shotId === shot.id)?.startUs ?? 0); }
  }
  async function removeShot() {
    if (!selectedShot || !await save()) return;
    clock.pause();
    const result = await action<ProjectDocument>('project.update', { projectId: project.id, revision: revision.current, patch: { shots: project.shots.filter(shot => shot.id !== selectedShot.id) } }, '镜头已移除');
    if (result) { const selected = result.shots[Math.min(selectedIndex, result.shots.length - 1)]; setSelectedShotId(selected?.id); clock.seek(buildTimeline(result.shots).find(clip => clip.shotId === selected?.id)?.startUs ?? 0); }
  }
  async function changeView(next: 'steps' | 'flow') {
    if (next === view || !await save()) return;
    clock.pause(); setView(next);
  }
  async function start(nodeId?: string) {
    if (!await save()) return;
    await action('run.start', { projectId: project.id, ...(nodeId ? { nodeId } : {}) }, nodeId ? '步骤已开始执行' : '制作已开始');
  }
  const displayedProject = useMemo(() => ({ ...project, profile }), [project, profile]);
  const completedNodeIds = useMemo(() => [...new Set(latestRun?.activities.filter(activity => activity.status === 'completed').map(activity => activity.nodeId) ?? [])], [latestRun?.activities]);
  function toggleOutline() { setFocusPreview(false); setOutlineOpen(value => { localStorage.setItem('vq-outline-open', String(!value)); return !value; }); }
  function toggleInspector() { setFocusPreview(false); setInspectorOpen(value => { localStorage.setItem('vq-inspector-open', String(!value)); return !value; }); if (document.activeElement?.closest('#project-inspector')) document.querySelector<HTMLButtonElement>('[data-inspector-toggle]')?.focus(); }
  function openSettings() { setFocusPreview(false); setInspectorOpen(true); setInspectorTab('project'); }
  return <div className="workbench"><div className="project-heading"><IconButton className="editor-sidebar-toggle" label="切换工作空间导航" onClick={onToggleSidebar}><PanelLeft size={17} /></IconButton><div className="project-heading-copy"><input className="project-title-input" aria-label="项目名称" value={title} onChange={event => setTitle(event.target.value)} /><p><span>{project.templateId === 'history-handdrawn' ? '历史手绘' : '视频项目'}</span><span>{project.shots.length} 个镜头</span><span>·</span><span>{profile.width} × {profile.height}</span>{(dirtyShot || dirtyProject) && <span className="unsaved-dot">未保存</span>}</p></div><div className="project-heading-actions">{view === 'steps' && <div className="editor-layout-actions"><IconButton label={outlineVisible ? '收起镜头导航' : '显示镜头导航'} aria-pressed={outlineVisible} onClick={toggleOutline}><PanelLeft size={16} /></IconButton><IconButton data-inspector-toggle label="切换属性面板" aria-pressed={inspectorVisible} onClick={toggleInspector}><PanelRight size={16} /></IconButton><IconButton label={focusPreview ? '退出专注预览' : '专注预览'} aria-pressed={focusPreview} onClick={() => setFocusPreview(value => !value)}><ScanLine size={16} /></IconButton></div>}<div className="tabs" aria-label="工作区视图"><button className={view === 'steps' ? 'active' : ''} onClick={() => void changeView('steps')}><Film size={13} />分镜</button><button className={view === 'flow' ? 'active' : ''} onClick={() => void changeView('flow')}><GitBranch size={13} />流程</button></div><IconButton label={savingEdits ? '正在保存修改' : '保存修改'} disabled={savingEdits || !(dirtyShot || dirtyProject) && view !== 'flow'} onClick={() => void save()}><Save size={16} /></IconButton><Button disabled={Boolean(busy)} onClick={() => void start()}><WandSparkles size={15} />开始制作</Button><Button variant="primary" onClick={() => void save().then(saved => { if (saved) setExporting(true); })}><ArrowDownToLine size={15} />导出</Button></div></div>{latestRun && ['waiting_review', 'needs_attention', 'failed'].includes(latestRun.status) && <div className="run-notice"><Notice kind={latestRun.status === 'failed' ? 'error' : 'info'}><span>{latestRun.status === 'waiting_review' ? `${project.workflow.nodes.find(node => node.id === latestRun.currentNodeId)?.label ?? '当前步骤'}已准备好，等待你的审阅。` : latestRun.error ?? '有一项任务需要核对。'}</span><button className="inline-action" onClick={onRuns}>查看制作记录 <ChevronRight size={12} /></button></Notice></div>}{view === 'flow' ? <Suspense fallback={<div className="empty-state">正在打开流程画布…</div>}><WorkflowCanvas key={project.id} onRegisterSave={registerFlowSave} workflow={project.workflow} models={workspace.models} onSave={async workflow => { const result = await action('workflow.save', { projectId: project.id, revision: project.revision, workflow }, '流程已保存'); if (result === null) throw new Error('流程保存失败，请检查提示。'); }} /></Suspense> : <div className={`workbench-grid ${!outlineVisible ? 'outline-collapsed' : ''} ${!inspectorVisible ? 'inspector-collapsed' : ''}`} style={layoutStyle} ref={editor}><aside className="story-panel" id="project-outline" hidden={!outlineVisible}><ProjectOutline project={project} assets={workspace.assets} selectedShotId={selectedShotId} selectedNodeId={selectedNodeId} completedNodeIds={completedNodeIds} onSelectShot={selectShot} onSelectNode={node => { setSelectedNodeId(node.id); setStepEditor(node); }} onAddShot={addShot} onOpenFlow={() => void changeView('flow')} /><PanelResizeHandle id="outline-resize" label="调整镜头导航宽度" side="left" value={actualOutline} min={184} max={maxOutline} defaultValue={224} onChange={setOutlineWidth} onCommit={value => localStorage.setItem('vq-outline-width', String(value))} /></aside><PlaybackPreview project={displayedProject} draft={draft} assets={workspace.assets} timeline={timeline} clock={clock} onSettings={openSettings} onRepair={shot => { setSelectedShotId(shot.id); setAssetKind(shot.videoAssetId ? 'video' : 'image'); setAssetDialog(true); }} onSelect={selectShot} onAdd={addShot} onError={notify} /><aside className="inspector" id="project-inspector" hidden={!inspectorVisible}><PanelResizeHandle id="inspector-resize" label="调整属性面板宽度" side="right" value={actualInspector} min={280} max={maxInspector} defaultValue={304} onChange={setInspectorWidth} onCommit={value => localStorage.setItem('vq-inspector-width', String(value))} /><div className="panel-heading"><div className="tabs"><button className={inspectorTab === 'shot' ? 'active' : ''} onClick={() => setInspectorTab('shot')}>镜头属性</button><button className={inspectorTab === 'project' ? 'active' : ''} onClick={() => setInspectorTab('project')}>项目设置</button></div><IconButton label="收起属性面板" onClick={toggleInspector}><PanelRightClose size={15} /></IconButton></div><div className="inspector-body">{inspectorTab === 'shot' && draft ? <><section className="inspector-section"><div className="section-heading"><Film size={14} /><h3>镜头 {(selectedIndex + 1).toString().padStart(2, '0')}</h3><IconButton label={draft.locked ? '解锁镜头' : '锁定镜头'} aria-pressed={draft.locked} onClick={() => setDraft({ ...draft, locked: !draft.locked })}>{draft.locked ? <LockKeyhole size={13} /> : <UnlockKeyhole size={13} />}</IconButton></div><Field label="镜头标题"><input value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></Field><Field label="旁白"><textarea value={draft.narration} onChange={event => setDraft({ ...draft, narration: event.target.value })} placeholder="这一镜头想讲什么？" /></Field><div className="field-row"><Field label="时长（秒）"><input type="number" min="0.5" max="600" step="0.1" value={draft.durationUs / 1_000_000} onChange={event => setDraft({ ...draft, durationUs: Math.round((event.target.valueAsNumber || .5) * 1_000_000) })} /></Field><Field label="转场"><select value={draft.animation.transition} onChange={event => setDraft({ ...draft, animation: { ...draft.animation, transition: event.target.value as Shot['animation']['transition'] } })}><option value="cut">直接切换</option><option value="fade">柔和叠化</option><option value="wipe">擦除显现</option></select></Field></div><div className="inspector-actions"><Button variant="primary" busy={savingEdits} disabled={!dirtyShot} onClick={() => void save()}><Save size={13} />保存镜头</Button><Button onClick={() => { setStepEditor(project.workflow.nodes.find(node => node.kind === 'script')); }}><WandSparkles size={13} />AI 微调</Button></div></section><section className="inspector-section"><div className="section-heading"><Image size={14} /><h3>画面与素材</h3></div><Field label="画面要求"><textarea value={draft.visualPrompt} onChange={event => setDraft({ ...draft, visualPrompt: event.target.value })} placeholder="场景、角色、构图和动作…" /></Field><Field label="画面素材"><select value={draft.assetId ?? ''} onChange={event => setDraft({ ...draft, assetId: event.target.value || undefined })}><option value="">使用示例画面</option>{workspace.assets.filter(asset => asset.active && asset.kind === 'image' && (!asset.projectId || asset.projectId === project.id)).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field><Field label="镜头视频"><select value={draft.videoAssetId ?? ''} onChange={event => setDraft({ ...draft, videoAssetId: event.target.value || undefined })}><option value="">使用二维画面与运镜</option>{workspace.assets.filter(asset => asset.active && asset.kind === 'video' && (!asset.projectId || asset.projectId === project.id)).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field><Button className="button-full" variant="ghost" onClick={() => { setAssetKind('image'); setAssetDialog(true); }}><Upload size={13} />导入本地画面</Button></section><section className="inspector-section"><div className="section-heading"><Layers size={14} /><h3>运镜</h3></div><Field label={`缩放 ${draft.animation.zoom.toFixed(2)}×`}><input type="range" min="1" max="1.5" step="0.01" value={draft.animation.zoom} onChange={event => setDraft({ ...draft, animation: { ...draft.animation, zoom: Number(event.target.value) } })} /></Field><div className="field-row"><Field label="水平移动"><input type="number" min="-1000" max="1000" value={draft.animation.panX} onChange={event => setDraft({ ...draft, animation: { ...draft.animation, panX: event.target.valueAsNumber || 0 } })} /></Field><Field label="垂直移动"><input type="number" min="-1000" max="1000" value={draft.animation.panY} onChange={event => setDraft({ ...draft, animation: { ...draft.animation, panY: event.target.valueAsNumber || 0 } })} /></Field></div></section><section className="inspector-section"><div className="section-heading"><Mic size={14} /><h3>配音</h3></div><Field label="旁白音频"><select value={draft.audioAssetId ?? ''} onChange={event => setDraft({ ...draft, audioAssetId: event.target.value || undefined })}><option value="">尚未添加配音</option>{workspace.assets.filter(asset => asset.active && asset.kind === 'audio' && (!asset.projectId || asset.projectId === project.id)).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field><p className="tiny-meta">生成配音可在“配音与字幕”步骤中选择模型后执行。</p></section></> : <><section className="inspector-section"><div className="section-heading"><Maximize2 size={14} /><h3>视频规格</h3></div><VideoSettings profile={profile} onChange={setProfile} /><div className="inspector-actions"><Button variant="primary" busy={savingEdits} disabled={!dirtyProject || !videoProfileSchema.safeParse(profile).success} onClick={() => void save()}><Save size={13} />保存设置</Button></div></section><section className="inspector-section"><div className="section-heading"><FileText size={14} /><h3>创意简报</h3></div><Field label="主题与核心问题"><textarea value={brief} onChange={event => setBrief(event.target.value)} /></Field><Field label="系列风格"><textarea value={style} onChange={event => setStyle(event.target.value)} /></Field><Button className="button-full" onClick={() => setShowClaimDialog(true)}><BookOpen size={13} />资料与事实主张</Button></section><section className="inspector-section"><div className="section-heading"><ShieldCheck size={14} /><h3>项目备份</h3></div><Button className="button-full" onClick={() => void action<{ path: string }>('project.backup', { projectId: project.id }).then(result => { if (result) notify(`备份已保存：${result.path}`); })}><Download size={13} />备份项目与素材</Button></section></>}</div></aside><Timeline shots={project.shots} timeline={timeline} selectedId={selectedShotId} rate={profile.frameRate} clock={clock} onSelect={selectShot} onMove={moveShot} onDuplicate={duplicateShot} onRemove={removeShot} /></div>}{stepEditor && <StepEditor node={stepEditor} project={project} workspace={workspace} action={action} onClose={() => setStepEditor(undefined)} onExecute={async nodeId => { setStepEditor(undefined); await start(nodeId); }} onResult={async nodeId => { if (!latestRun) { notify('请先执行这个步骤'); return; } const data = await action('node.result', { runId: latestRun.id, nodeId }); if (data !== null) setOutput({ nodeId, runId: latestRun.id, data }); }} />}{exporting && <ExportDialog project={{ ...project, profile }} workspace={workspace} action={action} onClose={() => setExporting(false)} notify={notify} />}{showClaimDialog && <ClaimsDialog project={project} action={action} onClose={() => setShowClaimDialog(false)} />}{assetDialog && <Dialog title={assetKind === 'video' ? '重新导入镜头视频' : '导入镜头画面'} onClose={() => setAssetDialog(false)}><form onSubmit={event => { event.preventDefault(); void action<{ id: string }>('asset.import', { projectId: project.id, shotId: draft?.id, path: assetPath, kind: assetKind }, '画面已导入').then(result => { if (result && draft) { setDraft({ ...draft, ...(assetKind === 'video' ? { videoAssetId: result.id } : { assetId: result.id }) }); setAssetDialog(false); setAssetPath(''); } }); }}><div className="dialog__body"><Field label={assetKind === 'video' ? '视频文件路径' : '图片文件路径'}><PathPicker label={assetKind === 'video' ? '视频文件路径' : '图片文件路径'} value={assetPath} onChange={setAssetPath} extensions={assetKind === 'video' ? ['mp4', 'mov', 'webm'] : ['png', 'jpg', 'jpeg', 'webp', 'svg']} required autoFocus placeholder={assetKind === 'video' ? 'D:\materials\scene.mp4' : 'D:\materials\scene.png'} /></Field></div><div className="dialog__footer"><Button onClick={() => setAssetDialog(false)}>取消</Button><Button variant="primary" type="submit">导入素材</Button></div></form></Dialog>}{output && <Dialog title="步骤产物" onClose={() => setOutput(undefined)} className="dialog--wide"><div className="dialog__body"><pre className="run-log">{typeof output.data === 'string' ? output.data : JSON.stringify(output.data, null, 2)}</pre></div><div className="dialog__footer"><Button onClick={() => setOutput(undefined)}>关闭</Button><Button variant="primary" onClick={() => void action('node.apply', { runId: output.runId, nodeId: output.nodeId, revision: project.revision }, '步骤产物已应用').then(result => { if (result !== null) setOutput(undefined); })}>应用到项目</Button></div></Dialog>}</div>;
}

function panelWidth(key: string, fallback: number, min: number, max: number) {
  const stored = localStorage.getItem(key);
  const value = stored ? Number(stored) : fallback;
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function StepEditor({ node, project, workspace, action, onClose, onExecute, onResult }: { node: WorkflowNode; project: ProjectDocument; workspace: WorkspaceSnapshot; action: Action; onClose: () => void; onExecute: (nodeId: string) => Promise<void>; onResult: (nodeId: string) => Promise<void> }) {
  const [draft, setDraft] = useState(node);
  const [busy, setBusy] = useState(false);
  async function save(execute = false) { setBusy(true); const result = await action('workflow.save', { projectId: project.id, revision: project.revision, workflow: { ...project.workflow, version: project.workflow.version + 1, nodes: project.workflow.nodes.map(item => item.id === node.id ? draft : item) } }, execute ? undefined : '步骤设置已保存'); setBusy(false); if (result !== null) { if (execute) await onExecute(node.id); else onClose(); } }
  return <Dialog title={node.label} onClose={onClose}><div className="dialog__body"><p>{node.description}</p><Field label="提示词与补充要求"><textarea value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} placeholder="为这个步骤补充规则、风格或修改要求…" rows={5} /></Field><Field label="使用模型"><select value={draft.modelId ?? ''} onChange={event => setDraft({ ...draft, modelId: event.target.value || undefined })}><option value="">本地素材 / 手动制作</option>{workspace.models.filter(model => model.enabled).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></Field><fieldset className="capability-fieldset"><legend>应用 Skill</legend>{workspace.skills.filter(skill => skill.enabled).length ? workspace.skills.filter(skill => skill.enabled).map(skill => <label className="field-inline" key={skill.id}><input type="checkbox" checked={draft.skillIds.includes(skill.id)} onChange={event => setDraft({ ...draft, skillIds: event.target.checked ? [...draft.skillIds, skill.id] : draft.skillIds.filter(id => id !== skill.id) })} />{skill.name}</label>) : <p className="tiny-meta">在 Skill 工作室导入创作规范后，即可绑定到这个步骤。</p>}</fieldset>{draft.kind === 'agent' && <ToolBindings node={draft} onChange={setDraft} />}<label className="field-inline"><input type="checkbox" checked={draft.requiresReview} onChange={event => setDraft({ ...draft, requiresReview: event.target.checked })} />完成后等待人工审阅</label><Button variant="ghost" className="button-full" onClick={() => void onResult(node.id)}><FileText size={14} />查看最近产物</Button></div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button busy={busy} onClick={() => void save()}>保存设置</Button><Button variant="primary" busy={busy} onClick={() => void save(true)}><Play size={14} />执行这一步</Button></div></Dialog>;
}

function ExportDialog({ project, workspace, action, onClose, notify }: { project: ProjectDocument; workspace: WorkspaceSnapshot; action: Action; onClose: () => void; notify: (message: string, error?: boolean) => void }) {
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
  return <Dialog title="导出视频" onClose={onClose}><div className="dialog__body"><VideoSettings profile={profile} onChange={setProfile} compact /><Field label="输出文件路径" hint="留空时保存到项目的输出目录。"><PathPicker label="输出文件路径" mode="save" value={destination} onChange={setDestination} extensions={['mp4']} disabled={active} placeholder="D:\Videos\我的视频.mp4" /></Field>{project.shots.every(shot => !shot.audioAssetId) && <Notice>当前项目尚未添加旁白音频，将导出静音画面小样。</Notice>}{run && <div className="export-run"><Status value={run.status} /><p className="tiny-meta">{run.events.at(-1)?.message ?? '导出任务已保存，可关闭此窗口后在制作记录中继续查看。'}</p>{run.error && <Notice kind="error">{run.error}</Notice>}</div>}{result && <Notice kind="success">文件已保存：{result}{nativeDesktop && <Button variant="ghost" onClick={() => void revealFile(result).catch(error => notify(error instanceof Error ? error.message : String(error), true))}><FolderOpen size={14} />在文件夹中显示</Button>}</Notice>}<div className="export-secondary"><Button onClick={() => { downloadText(`${project.title}.srt`, createSrt(project.shots)); notify('字幕文件已导出'); }}><FileText size={14} />导出字幕</Button><Button onClick={() => { downloadText(`${project.title}-分镜.json`, JSON.stringify(project, null, 2), 'application/json'); notify('分镜文件已导出'); }}><Download size={14} />导出分镜</Button></div></div><div className="dialog__footer"><Button onClick={onClose}>关闭</Button>{active && run ? <Button onClick={() => void action('run.cancel', { runId: run.id }, '已请求停止导出')}><Square size={14} />停止导出</Button> : <Button variant="primary" busy={busy} disabled={!videoProfileSchema.safeParse(profile).success || !project.shots.length} onClick={() => { setBusy(true); setResult(undefined); void action<{ runId?: string; id?: string; path?: string; outputPath?: string }>('render.export', { projectId: project.id, profile, ...(destination ? { destination } : {}) }).then(value => { setBusy(false); if (value) { const id = value.runId ?? value.id; if (id) setRunId(id); else if (value.path || value.outputPath) setResult(value.path ?? value.outputPath); } }); }}><ArrowDownToLine size={15} />导出 MP4</Button>}</div></Dialog>;
}
function ClaimsDialog({ project, action, onClose }: { project: ProjectDocument; action: Action; onClose: () => void }) {
  const [claims, setClaims] = useState(project.claims);
  return <Dialog title="资料与事实主张" onClose={onClose} className="dialog--wide"><div className="dialog__body"><p>记录来源、准确定位和核验状态。画面中的示意复原与已核实事实分别审阅。</p>{claims.map((claim, index) => <div className="claim-card" key={claim.id}><Field label={`主张 ${index + 1}`}><textarea value={claim.text} onChange={event => setClaims(current => current.map(item => item.id === claim.id ? { ...item, text: event.target.value } : item))} /></Field><Field label="来源"><input value={claim.source} onChange={event => setClaims(current => current.map(item => item.id === claim.id ? { ...item, source: event.target.value } : item))} /></Field><div className="field-row"><Field label="页码或定位"><input value={claim.locator} onChange={event => setClaims(current => current.map(item => item.id === claim.id ? { ...item, locator: event.target.value } : item))} /></Field><Field label="核验状态"><select value={claim.status} onChange={event => setClaims(current => current.map(item => item.id === claim.id ? { ...item, status: event.target.value as typeof claim.status } : item))}><option value="pending">待核验</option><option value="verified">已核验</option><option value="disputed">存在争议</option></select></Field></div></div>)}<Button onClick={() => setClaims(current => [...current, { id: crypto.randomUUID(), text: '', source: '', locator: '', status: 'pending' }])}><Plus size={14} />添加主张</Button></div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button variant="primary" onClick={() => void action('project.update', { projectId: project.id, revision: project.revision, patch: { claims } }, '资料与主张已保存').then(result => { if (result !== null) onClose(); })}>保存资料</Button></div></Dialog>;
}
