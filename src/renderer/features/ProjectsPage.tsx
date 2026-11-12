import { desktopBridge, nativeDesktop, revealFile } from '../lib/desktop';
import { useEffect, useRef, useState } from 'react';
import { FolderOpen, ListChecks, Search, Trash2, Plus, RotateCcw, Download } from 'lucide-react';
import { isRunActive, runSummarySchema, type ProjectSummary } from '@video-quickly/contracts';
import { Button, EmptyState, IconButton, Notice } from '../components/Primitives';
import { ScenePreview } from '../components/ScenePreview';
import type { Action, WorkspaceView } from '../lib/types';
import { useRuntimeRead } from '../lib/use-runtime-read';
import { useConfirmation } from '../components/ConfirmationDialog';
import { getAssetUrl, rpc } from '../lib/client';
import { deleteProjectDrafts } from '../lib/draft-storage';

const projectChangeMessages = { archive: '已移入回收站', restore: '已恢复', delete: '已彻底删除' };
type ProjectListAction = keyof typeof projectChangeMessages;


export function ProjectsPage({ workspace, action, notify, onOpen, onCreate }: {
  workspace: WorkspaceView;
  action: Action;
  notify: (message: string, error?: boolean) => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const confirm = useConfirmation();
  const [search, setSearch] = useState('');
  const projectSearch = useRef<HTMLInputElement>(null);
  const [archived, setArchived] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>();
  const [pendingChange, setPendingChange] = useState<{ operation: ProjectListAction; projectId?: string }>();
  const selectionButton = useRef<HTMLButtonElement>(null);
  const changeInFlight = useRef(false);
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
  const projectsInView = workspace.projects.filter(project => project.archived === archived)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const query = search.trim().toLocaleLowerCase();
  const projects = projectsInView.filter(project => `${project.title} ${project.brief}`.toLocaleLowerCase().includes(query));
  const selecting = selectedIds !== undefined;
  const selected = selecting ? projects.filter(project => selectedIds.has(project.id)) : [];
  const allSelected = projects.length > 0 && selected.length === projects.length;
  const noMatches = Boolean(query && projectsInView.length && !projects.length);
  const changeBusy = pendingChange !== undefined;
  const pendingBatch = pendingChange?.projectId === undefined ? pendingChange?.operation : undefined;
  const moveAction = archived ? 'restore' : 'archive';
  const BatchActionIcon = archived ? RotateCcw : Trash2;
  function changeProjectView(value: boolean) {
    if (value === archived) return;
    setSelectedIds(undefined);
    setArchived(value);
  }
  function changeSearch(value: string) {
    setSearch(value);
    setSelectedIds(ids => ids && new Set());
  }
  function clearSearch() {
    changeSearch('');
    projectSearch.current?.focus();
  }
  async function changeProjects(operation: ProjectListAction, project?: ProjectSummary) {
    const targets = project ? [project] : selected;
    if (changeInFlight.current || !targets.length) return;
    changeInFlight.current = true;
    try {
      if (operation === 'archive' && !await confirm({ title: '批量删除项目？', description: `将 ${targets.length} 个项目移入回收站。项目与素材会保留，可在回收站恢复。`, confirmLabel: '移入回收站' })) return;
      if (operation === 'delete' && !await confirm({
        title: project ? '彻底删除项目？' : '批量彻底删除项目？',
        description: `将彻底删除${project ? `“${project.title}”` : ` ${targets.length} 个项目`}，并清理项目独占的本地素材和缓存。此操作无法撤销。`,
        confirmLabel: '彻底删除',
      })) return;
      setPendingChange({ operation, projectId: project?.id });
      const message = `${project ? '项目' : '所选项目'}${projectChangeMessages[operation]}`;
      const projectIds = targets.map(value => value.id);
      if (operation === 'delete') {
        const result = await action<{ deleted: number; cleanupPending?: number }>('project.deleteMany', { projectIds });
        if (result === null) return;
        const warnings = [];
        if (result.cleanupPending) warnings.push(`有 ${result.cleanupPending} 个本地文件待清理，应用重启后会重试。`);
        try { await deleteProjectDrafts(workspace.system.dataDirectory, projectIds); }
        catch { warnings.push('本机项目草稿未能清理。'); }
        notify(warnings.length ? `${message}。${warnings.join('')}` : message, Boolean(warnings.length));
      } else {
        const result = operation === 'restore' && project
          ? await action('project.restore', { projectId: project.id }, message)
          : await action(`project.${operation}Many`, { projectIds }, message);
        if (result === null) return;
      }
      if (!project) setSelectedIds(new Set());
    } finally {
      changeInFlight.current = false;
      setPendingChange(undefined);
      requestAnimationFrame(() => {
        if (document.activeElement !== document.body) return;
        const button = selectionButton.current;
        (button?.disabled ? projectSearch.current : button)?.focus({ preventScroll: true });
      });
    }
  }
  return <div className="content-page">
    <div className="page-heading">
      <div><h1>我的项目</h1></div>
      <div className="heading-actions">
        <Button variant="primary" onClick={onCreate}><Plus size={16} />新建项目</Button>
      </div>
    </div>
    <div className={`page-toolbar library-toolbar project-library-toolbar${selecting ? ' library-toolbar--selecting' : ''}`}>
      <div className="search-field">
        <Search size={16} aria-hidden="true" />
        <input ref={projectSearch} aria-label="搜索项目" placeholder="搜索项目" value={search} disabled={changeBusy} onChange={event => changeSearch(event.target.value)} />
      </div>
      <div className="tabs" role="group" aria-label="项目筛选">
        <button type="button" aria-label="全部项目" aria-pressed={!archived} className={!archived ? 'active' : ''} disabled={changeBusy} onClick={() => changeProjectView(false)}>
          全部 <small>{workspace.projects.filter(project => !project.archived).length}</small>
        </button>
        <button type="button" aria-pressed={archived} className={archived ? 'active' : ''} disabled={changeBusy} onClick={() => changeProjectView(true)}><Trash2 size={13} aria-hidden="true" />回收站</button>
      </div>
      <div className="library-toolbar__actions">
        {selecting && <>
          <label className="library-toolbar__select-all">
            <input type="checkbox" checked={allSelected} disabled={changeBusy || !projects.length} ref={input => {
              if (input) input.indeterminate = selected.length > 0 && !allSelected;
            }} onChange={event => setSelectedIds(new Set(event.target.checked ? projects.map(project => project.id) : []))} />
            全选
          </label>
          <span className="tiny-meta" role="status">已选 {selected.length} 项</span>
          <Button variant={archived ? 'default' : 'danger'} busy={pendingBatch === moveAction} disabled={changeBusy || !selected.length} onClick={() => void changeProjects(moveAction)}>
            {pendingBatch !== moveAction && <BatchActionIcon size={16} aria-hidden="true" />}{archived ? '批量恢复' : '删除'}
          </Button>
          {archived && <Button variant="danger" busy={pendingBatch === 'delete'} disabled={changeBusy || !selected.length} onClick={() => void changeProjects('delete')}>
            {pendingBatch !== 'delete' && <Trash2 size={16} aria-hidden="true" />}批量彻底删除
          </Button>}
        </>}
        <Button ref={selectionButton} disabled={changeBusy || (!selecting && !projects.length)} onClick={() => setSelectedIds(selecting ? undefined : new Set())}>
          <ListChecks size={15} aria-hidden="true" />{selecting ? '退出多选' : '多选'}
        </Button>
      </div>
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
          {project.templateId === 'history-handdrawn' && <span className="pill">历史手绘</span>}
          {selecting && <label className="library-card-choice project-card-choice">
            <input type="checkbox" aria-label={`选择“${project.title}”`} checked={selectedIds.has(project.id)} disabled={changeBusy} onChange={event => {
              const next = new Set(selectedIds);
              if (event.target.checked) next.add(project.id);
              else next.delete(project.id);
              setSelectedIds(next);
            }} />
          </label>}
        </div>
        <div className="project-card-body">
          <h3>{project.title}</h3>
          <div className="project-card-footer">
            <time className="tiny-meta" dateTime={project.createdAt}>{new Date(project.createdAt).toLocaleDateString('zh-CN')}</time>
            {!selecting && (archived ? <>
              <IconButton label="恢复项目" busy={pendingChange?.projectId === project.id && pendingChange.operation === 'restore'} disabled={changeBusy} onClick={() => void changeProjects('restore', project)}><RotateCcw size={16} aria-hidden="true" /></IconButton>
              <IconButton label={`彻底删除“${project.title}”`} title="彻底删除项目" busy={pendingChange?.projectId === project.id && pendingChange.operation === 'delete'} disabled={changeBusy} onClick={() => void changeProjects('delete', project)}><Trash2 size={16} aria-hidden="true" /></IconButton>
            </> : <>
              <IconButton label="继续创作" data-guide="project-open" onClick={() => onOpen(project.id)}><FolderOpen size={16} aria-hidden="true" /></IconButton>
              <IconButton label={`下载“${project.title}”的完整视频`} title={project.shotCount ? '下载完整视频（MP4）' : '添加镜头后可下载完整视频'} busy={downloadingId === project.id} disabled={Boolean(downloadingId) || !project.shotCount} onClick={() => void downloadProject(project)}>
                <Download size={16} aria-hidden="true" />
              </IconButton>
              <IconButton label={`将“${project.title}”移入回收站`} onClick={() => void archiveProject(project)}><Trash2 size={16} aria-hidden="true" /></IconButton>
            </>)}
          </div>
        </div>
      </article>)}
      {!projects.length && <EmptyState icon={<FolderOpen size={25} />}
        title={noMatches ? '没有匹配的项目' : archived ? '回收站为空' : '还没有视频项目'}
        description={noMatches ? '换个关键词，或清除搜索。' : archived ? '移入回收站的项目可在这里恢复。' : '新建项目后即可开始创作。'}>
        {noMatches && <Button onClick={clearSearch}>清除搜索</Button>}
      </EmptyState>}
    </section>
  </div>;
}
