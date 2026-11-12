import { Suspense, lazy, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, FolderOpen, Layers, Palette, Sparkles, RefreshCw } from 'lucide-react';
import { DEFAULT_VIDEO_PROFILE, projectSchema, projectDetailSchema, workspaceSummarySchema, type ProjectDocument, type ProjectDetail } from '@video-quickly/contracts';
import { createRefreshQueue } from './lib/refresh-queue';
import { Button, Dialog, Field, Notice, Select } from './components/Primitives';
import WorkspaceSidebar, { type Page, type SidebarNavigationItem } from './components/WorkspaceSidebar';
import WorkspaceSettings from './components/WorkspaceSettings';
import BrandMark from './components/BrandMark';
import RuntimeConnectionNotice from './components/RuntimeConnectionNotice';
import ToastNotice, { type ToastMessage } from './components/ToastNotice';
import PageCache from './components/PageCache';
import { runtimeConnectionSchema, type RuntimeConnection } from '@video-quickly/contracts';
import SkillPicker from './components/SkillPicker';
import SkillImportStatus from './components/SkillImportStatus';
import { ModelsPage } from './features/ModelsPage';
import { ProjectsPage } from './features/ProjectsPage';
import SkillsPage from './features/SkillStudio';
import AssetLibraryPage, { type AssetLibraryTab } from './features/AssetLibraryPage';
import { rpc, subscribe } from './lib/client';
import type { Action, StepOutputSelection, WorkspaceView } from './lib/types';
import { useButtonFocus } from './lib/use-button-focus';
import CostsPage from './features/CostsPage';
import { recordPageSchema, seriesTemplateSchema, type SeriesTemplate } from '@video-quickly/contracts';
import { useRecordPage } from './lib/use-record-page';
import { beginGuideAction } from './lib/guide-actions';
import { useChargeRpc } from './components/ConfirmationDialog';
import { isChargeAction } from '@video-quickly/contracts';
import Workbench, { type WorkbenchRepairDestination } from './features/Workbench';

const SeriesTemplatesPage = lazy(() => import('./features/SeriesTemplatesPage'));
const seriesTemplatesPageSchema = recordPageSchema(seriesTemplateSchema);
const GettingStartedGuide = lazy(() => import('./components/GettingStartedGuide'));

const pages: SidebarNavigationItem[] = [
  { id: 'projects', label: '我的项目', icon: FolderOpen, group: 'main' },
  { id: 'assets', label: '素材库', icon: Layers, group: 'resources' },
  { id: 'templates', label: '系列模板', icon: Palette, group: 'resources' },
  { id: 'models', label: '模型连接', icon: Sparkles, group: 'tools' },
  { id: 'skills', label: 'Skill 工作室', icon: BookOpen, group: 'tools' },
];

type NavigationState = { page: Page; visited: Page[]; assetTab: AssetLibraryTab };
function visitPage(current: NavigationState, page: Page, assetTab = current.assetTab): NavigationState {
  return { page, visited: current.visited.includes(page) ? current.visited : [...current.visited, page], assetTab };
}

export default function App() {
  const chargeRpc = useChargeRpc();
  useButtonFocus();
  const [workspace, setWorkspace] = useState<WorkspaceView>();
  const [project, setProject] = useState<ProjectDocument>();
  const detail = useRef<ProjectDetail | undefined>(undefined);
  const currentProjectId = useRef<string | undefined>(undefined);
  const [loadError, setLoadError] = useState('');
  const [projectLoadError, setProjectLoadError] = useState('');
  const [connection, setConnection] = useState<RuntimeConnection>({ state: 'ready', generation: 0 });
  const [outputRequest, setOutputRequest] = useState<StepOutputSelection>();
  const consumeOutputRequest = useCallback(() => setOutputRequest(undefined), []);
  const [repairModelId, setRepairModelId] = useState<string>();
  const consumeRepairModel = useCallback(() => setRepairModelId(undefined), []);
  const [{ page, visited, assetTab }, setNavigation] = useState<NavigationState>({ page: 'projects', visited: ['projects'], assetTab: 'media' });
  const pageBody = useRef<HTMLElement>(null);
  const pageScroll = useRef(new Map<Page, number>());
  const navigationGuide = useRef<{ page: Page; complete: () => void } | undefined>(undefined);
  const [projectId, setProjectId] = useState<string>();
  const [theme, setTheme] = useState<'light' | 'dark'>(() => localStorage.getItem('vq-theme') === 'dark' ? 'dark' : 'light');
  const [toast, setToast] = useState<ToastMessage>();
  const [creation, setCreation] = useState<{ template?: SeriesTemplate }>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsAnchor = useRef<HTMLButtonElement>(null);
  const [showGettingStarted, setShowGettingStarted] = useState(() => localStorage.getItem('vq-onboarding-v1') !== 'done');
  const closeGettingStarted = useCallback(() => {
    localStorage.setItem('vq-onboarding-v1', 'done');
    setShowGettingStarted(false);
  }, []);
  const toastSequence = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const snapshotRequest = useRef(0);
  const appliedSnapshot = useRef(0);
  const saveBeforeLeave = useRef<(() => Promise<boolean>) | null>(null);
  const notify = useCallback((text: string, error = false) => setToast({ id: ++toastSequence.current, text, error }), []);
  const projectReads = useRef(new Map<string, () => Promise<ProjectDetail | undefined>>());
  const failedProjectReads = useRef(new Set<string>());
  const readProject = useCallback(async (id: string) => {
    if (currentProjectId.current !== id || failedProjectReads.current.has(id)) return undefined;
    const previousDetail = detail.current?.id === id ? detail.current : undefined;
    setProjectLoadError('');
    try {
      const loaded = projectDetailSchema.parse(await rpc('project.get', { projectId: id, revision: previousDetail?.revision, assetsVersion: previousDetail?.assetsVersion, videoPreviewKey: previousDetail?.videoPreview?.key ?? '' }));
      if (currentProjectId.current !== id) return loaded;
      const previousPreview = previousDetail?.videoPreview;
      const preview = loaded.videoPreview;
      const videoPreview = preview?.project ? { ...preview, project: { ...preview.project, shots: retainRecords(previousPreview?.project?.shots ?? [], preview.project.shots) } }
        : preview && preview.key === previousPreview?.key ? previousPreview : undefined;
      const merged = { ...loaded, project: loaded.project ?? previousDetail?.project, assets: loaded.assets ?? previousDetail?.assets ?? [], videoPreview };
      detail.current = merged;
      setProject(current => merged.project && current?.id === merged.project.id && current.revision === merged.project.revision ? current : merged.project);
      setWorkspace(previous => previous ? { ...previous, assets: retainRecords(previous.assets, merged.assets), runs: [...(loaded.activeRun ? [loaded.activeRun] : []), ...(loaded.latestRun ? [loaded.latestRun] : [])], videoPreview } : previous);
      return loaded;
    } catch (error) {
      if (currentProjectId.current === id) {
        failedProjectReads.current.add(id);
        setProjectLoadError(error instanceof Error ? error.message : String(error));
      }
      return undefined;
    }
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
      if (request < appliedSnapshot.current) return result;
      appliedSnapshot.current = request;
      let id = currentProjectId.current;
      if (id && id === selectedAtStart && !result.projects.some(item => item.id === id && !item.archived)) {
        id = undefined;
        currentProjectId.current = undefined;
        setProjectId(undefined);
      }
      if (!id) {
        detail.current = undefined;
        setProject(undefined);
        setNavigation(current => current.page === 'workbench' ? visitPage(current, 'projects') : current);
      }
      setWorkspace(previous => ({
        ...result,
        projects: previous ? retainRecords(previous.projects, result.projects) : result.projects,
        models: previous ? retainRecords(previous.models, result.models) : result.models,
        skills: previous ? retainRecords(previous.skills, result.skills) : result.skills,
        assets: id ? previous?.assets ?? [] : [],
        runs: id ? previous?.runs ?? [] : [],
        videoPreview: previous?.videoPreview?.project?.id === id ? previous?.videoPreview : undefined,
      }));
      setLoadError('');
      return result;
    } catch (error) { setLoadError(error instanceof Error ? error.message : String(error)); return undefined; }
  }, []);
  const refreshWorkspace = useMemo(() => createRefreshQueue(readWorkspace), [readWorkspace]);
  const refresh = useCallback(async () => {
    const id = currentProjectId.current;
    const [summary] = await Promise.all([refreshWorkspace(), id ? refreshProject(id) : undefined]);
    return summary;
  }, [refreshProject, refreshWorkspace]);
  const retryProject = useCallback(() => {
    if (currentProjectId.current) failedProjectReads.current.delete(currentProjectId.current);
    void refresh();
  }, [refresh]);
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
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--background').trim());
    localStorage.setItem('vq-theme', theme);
  }, [theme]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(current => current === toast ? undefined : current), 2000);
    return () => clearTimeout(timer);
  }, [toast]);
  const latestRun = workspace?.runs.find(run => run.projectId === projectId && !run.regenerationSource && (!run.purpose || run.purpose === 'production'));
  const runStatus = latestRun?.status;
  const runError = latestRun?.error;
  const stepRetryCompleted = runStatus === 'needs_attention' && latestRun?.stepRetry?.status === 'completed';
  // Keep task notifications outside cached pages so visibility changes do not replay them.
  useEffect(() => {
    if (runStatus === 'needs_attention' || runStatus === 'failed') {
      const message = runError ?? (stepRetryCompleted ? '此步骤已完成重试，后续步骤尚未执行。可继续原制作。' : '有一项任务需要核对。');
      const needsAttention = Boolean(runError) || !stepRetryCompleted;
      notify(needsAttention ? `${message} 请在“本次制作”查看详情。` : message, needsAttention);
    }
  }, [latestRun?.id, latestRun?.currentNodeId, latestRun?.updatedAt, runStatus, runError, stepRetryCompleted, notify]);
  const action: Action = useCallback(async <T,>(method: string, params?: unknown, message?: string): Promise<T | null> => {
    try {
      const result = await chargeRpc<T>(method, params);
      if (result === null && isChargeAction(method)) return null;
      if (method === 'project.update') {
        const saved = projectSchema.safeParse(result), previous = detail.current;
        const requestedId = params && typeof params === 'object' && 'projectId' in params ? params.projectId : undefined;
        // A pending read captured its own baseline; let it finish before reusing a save reply.
        if (saved.success && requestedId === saved.data.id && currentProjectId.current === saved.data.id && previous?.id === saved.data.id && saved.data.revision > previous.revision && !projectReads.current.has(saved.data.id) && !failedProjectReads.current.has(saved.data.id)) {
          detail.current = { ...previous, project: saved.data, revision: saved.data.revision };
        }
      }
      if (!['node.result', 'run.replay', 'asset.read', 'project.backup'].includes(method)) await refresh();
      if (message) notify(message);
      return result;
    }
    catch (error) { notify(error instanceof Error ? error.message : String(error), true); if (method === 'project.update') await refresh(); return null; }
  }, [chargeRpc, notify, refresh]);
  useEffect(() => { if (projectId && detail.current?.id !== projectId) void refresh(); }, [projectId, refresh]);
  function activatePage(next: Page, nextAssetTab?: AssetLibraryTab) {
    pageScroll.current.set(page, pageBody.current?.scrollTop ?? 0);
    if (nextAssetTab && nextAssetTab !== assetTab) pageScroll.current.delete('assets');
    startTransition(() => setNavigation(current => visitPage(current, next, nextAssetTab)));
  }
  useLayoutEffect(() => {
    if (pageBody.current) pageBody.current.scrollTop = pageScroll.current.get(page) ?? 0;
    if (navigationGuide.current?.page === page) {
      const pending = navigationGuide.current; navigationGuide.current = undefined; pending.complete();
    }
  }, [page]);
  async function navigate(next: Page, nextAssetTab?: AssetLibraryTab) {
    const complete = next === 'models' ? beginGuideAction('models-opened') : next === 'projects' ? beginGuideAction('projects-opened') : undefined;
    if (page === 'workbench' && next !== page && saveBeforeLeave.current && !await saveBeforeLeave.current()) return false;
    if (complete && next !== page) navigationGuide.current = { page: next, complete };
    activatePage(next, nextAssetTab);
    if (next === page) complete?.();
    return true;
  }
  async function navigateToRepair(next: WorkbenchRepairDestination, modelId?: string) {
    if (next === 'characters') return navigate('assets', 'characters');
    if (!await navigate(next)) return false;
    if (next === 'models') setRepairModelId(modelId);
    return true;
  }
  function registerSave(callback: (() => Promise<boolean>) | null) { saveBeforeLeave.current = callback; }
  async function openProject(id: string) { if (page === 'workbench' && id !== projectId && saveBeforeLeave.current && !await saveBeforeLeave.current()) return false; const complete = beginGuideAction('workbench-opened'); if (page !== 'workbench') navigationGuide.current = { page: 'workbench', complete }; else complete(); const retry = failedProjectReads.current.delete(id); currentProjectId.current = id; setProjectId(id); activatePage('workbench'); if (retry) void refreshProject(id); return true; }
  async function openStepOutput(selection: StepOutputSelection) { if (await openProject(selection.projectId)) setOutputRequest(selection); }
  async function createProject() { if (page === 'workbench' && saveBeforeLeave.current && !await saveBeforeLeave.current()) return; setCreation({}); }
  if (!workspace) return <div className="welcome-loading"><BrandMark size={34} /><strong>Video Quickly</strong><RuntimeConnectionNotice connection={connection} onReconnect={() => void reconnectRuntime()} />{connection.state === 'ready' && <p>{loadError || '正在打开本地工作区…'}</p>}{loadError && connection.state === 'ready' && <Button onClick={() => void refresh()}><RefreshCw size={15} />重新连接</Button>}</div>;
  return <div className="app workspace-shell">
    <WorkspaceSidebar page={page} navigation={pages} settingsOpen={settingsOpen} settingsRef={settingsAnchor}
      onNavigate={next => void navigate(next)} onCreate={() => void createProject()}
      onSettings={() => { if (showGettingStarted) closeGettingStarted(); setSettingsOpen(value => !value); }} />
    <div className="main-shell">
      <SkillImportStatus jobs={workspace.skillImports} groups={workspace.skillGroups} action={action} />
      <main ref={pageBody} className="page-body">
        <RuntimeConnectionNotice connection={connection} onReconnect={() => void reconnectRuntime()} />
        {loadError && connection.state === 'ready' && <div className="run-notice"><Notice kind="error">{loadError}</Notice></div>}
        {page === 'workbench' && project && project.id === projectId && projectLoadError && <div className="run-notice">
          <Notice kind="error"><span>{projectLoadError}</span><Button onClick={retryProject}>重新读取项目</Button></Notice>
        </div>}
        <PageCache key={workspace.system.dataDirectory} active={page} pages={visited}>{cachedPage => {
          if (cachedPage === 'workbench') {
            if (project && project.id === projectId) return <Workbench key={project.id} project={project} workspace={workspace}
              outputRequest={outputRequest} onOutputConsumed={consumeOutputRequest} onOpenOutput={selection => void openStepOutput(selection)}
              action={action} notify={notify} onRegisterSave={registerSave} onNavigate={navigateToRepair} />;
            if (!projectId) return null;
            const error = projectLoadError || loadError;
            return <div className="empty-state" data-guide-loading={!error || undefined} role={error ? 'alert' : 'status'}>
              {error ? <><p>{error}</p><Button aria-label="重试项目" onClick={retryProject}>重试</Button></> : '正在读取项目…'}
            </div>;
          }
          if (cachedPage === 'projects') return <ProjectsPage workspace={workspace} action={action} notify={notify} onOpen={openProject} onCreate={() => setCreation({})} />;
          if (cachedPage === 'templates') return <SeriesTemplatesPage workspace={workspace} action={action} onCreate={template => setCreation({ template })} />;
          if (cachedPage === 'costs') return <CostsPage workspace={workspace} />;
          if (cachedPage === 'models') return <ModelsPage workspace={workspace} action={action} repairModelId={repairModelId} onRepairConsumed={consumeRepairModel} />;
          if (cachedPage === 'skills') return <SkillsPage workspace={workspace} action={action} onOpenOutput={openStepOutput} />;
          return <AssetLibraryPage workspace={workspace} action={action} project={project} notify={notify} tab={assetTab}
            onTabChange={tab => setNavigation(current => ({ ...current, assetTab: tab }))} />;
        }}</PageCache>
      </main>
    </div>
    <ToastNotice toast={toast} onDismiss={() => setToast(undefined)} />
    {settingsOpen && <WorkspaceSettings anchor={settingsAnchor.current} theme={theme} onTheme={setTheme} onClose={() => setSettingsOpen(false)}
      onCosts={() => { void navigate('costs').then(opened => { if (opened) setSettingsOpen(false); }); }}
      onGuide={() => { setSettingsOpen(false); settingsAnchor.current?.focus({ preventScroll: true }); setShowGettingStarted(true); beginGuideAction('help-used')(); }} />}
    {showGettingStarted && <Suspense fallback={null}><GettingStartedGuide onClose={closeGettingStarted} /></Suspense>}
    {creation && <CreateProjectDialog action={action} workspace={workspace} initialTemplate={creation.template} onClose={() => setCreation(undefined)} onCreated={project => { setCreation(undefined); openProject(project.id); }} />}
  </div>;
}

function retainRecords<T extends { id: string }>(previous: T[], next: T[]): T[] {
  const records = new Map(previous.map(record => [record.id, record]));
  const result = next.map(record => { const existing = records.get(record.id); return existing && JSON.stringify(existing) === JSON.stringify(record) ? existing : record; });
  return result.length === previous.length && result.every((record, index) => record === previous[index]) ? previous : result;
}

function CreateProjectDialog({ action, workspace, initialTemplate, onClose, onCreated }: { action: Action; workspace: WorkspaceView; initialTemplate?: SeriesTemplate; onClose: () => void; onCreated: (project: ProjectDocument) => void }) {
  const closed = useRef(false);
  useEffect(() => { closed.current = false; return () => { closed.current = true; }; }, []);
  function close() { closed.current = true; onClose(); }
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const templates = useRecordPage('seriesTemplate.list', { archived: false, limit: 20 }, 0, seriesTemplatesPageSchema);
  const [libraryChoice, setLibraryChoice] = useState(initialTemplate);
  const [seriesTemplateId, setSeriesTemplateId] = useState(initialTemplate?.id ?? '');
  // The template chosen in the library can be on a later page of the picker.
  const templateOptions = libraryChoice && !templates.items.some(template => template.id === libraryChoice.id)
    ? [libraryChoice, ...templates.items] : templates.items;
  const selectedTemplate = templateOptions.find(template => template.id === seriesTemplateId);
  const builtInTemplates = templateOptions.filter(template => template.creationDefaults);
  const defaults = selectedTemplate?.creationDefaults;
  const missingTemplate = Boolean(seriesTemplateId) && !selectedTemplate;
  const [busy, setBusy] = useState(false);
  const [skillOverride, setSkillOverride] = useState<string[]>();
  const skillIds = skillOverride ?? defaults?.skillIds.filter(id => workspace.skills.some(skill => skill.id === id && skill.enabled)) ?? [];
  const canCreate = Boolean(title.trim()) && !missingTemplate;
  return <Dialog title="新建视频项目" className="project-creation-dialog" onClose={close} onDismissStart={() => { closed.current = true; }}>
    <form onSubmit={event => {
      event.preventDefault();
      if (busy || closed.current || !canCreate) return;
      const complete = beginGuideAction('project-created');
      setBusy(true);
      void action<ProjectDocument>('project.create', {
        title, brief, skillIds,
        profile: defaults?.profile ?? { ...DEFAULT_VIDEO_PROFILE, frameRate: { numerator: 60, denominator: 1 } },
        ...(selectedTemplate ? { seriesTemplateId: selectedTemplate.id, seriesTemplateRevision: selectedTemplate.revision } : {}),
      }, '项目已创建').then(result => {
        if (closed.current) return;
        setBusy(false);
        if (result) { onCreated(result); complete(); }
        else if (selectedTemplate) {
          setLibraryChoice(undefined);
          templates.refresh();
        }
      });
    }}>
      <div className="dialog__body">
        <Field label="项目名称"><input autoFocus required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} placeholder="给这段创作起个名字" /></Field>
        <Field label="创意简报"><textarea value={brief} onChange={event => setBrief(event.target.value)} placeholder="主题、目标观众，以及你想讲清楚的一个问题…" /></Field>
        <Field label="系列模板（可选）" hint={defaults ? selectedTemplate.description : '选用模板可复用视觉风格、字幕样式和新镜头画面预设。'}>
          <Select value={seriesTemplateId} disabled={busy || templates.busy} onChange={event => setSeriesTemplateId(event.target.value)}>
            <option value="">使用项目默认设置</option>
            {missingTemplate && <option value={seriesTemplateId} disabled>所选模板不可用</option>}
            {builtInTemplates.length > 0 && <optgroup label="系统内置">{builtInTemplates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</optgroup>}
            {templateOptions.filter(template => !template.creationDefaults).map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
          </Select>
        </Field>
        {templates.error && <Notice kind="error">{templates.error}<Button aria-label="重试系列模板" onClick={templates.refresh}>重试</Button></Notice>}
        {templates.nextCursor !== null && <Button aria-label="加载更多系列模板" busy={templates.loadingMore} disabled={!templates.canLoadMore} onClick={() => void templates.loadMore()}>加载更多</Button>}
        {missingTemplate && <p className="field-error">请选择可用模板，或使用项目默认设置。</p>}
        <SkillPicker label="创作 Skill（可选）" hint="所选 Skill 用于策划与分镜，也供剪辑 Agent 按需使用。" skills={workspace.skills} groups={workspace.skillGroups} value={skillIds} onChange={setSkillOverride} disabled={busy} />
      </div>
      <div className="dialog__footer"><Button onClick={close}>取消</Button><Button type="submit" variant="primary" busy={busy} disabled={!canCreate}>创建项目</Button></div>
    </form>
  </Dialog>;
}
