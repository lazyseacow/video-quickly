import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Layers, Plus, RefreshCw } from 'lucide-react';
import { formatFrameRate, projectDetailSchema, projectSchema, productionQueueEnqueueResultSchema, recordPageSchema, workDefaultsSchema, workSchema, type ProjectDocument, type ProjectSummary, type StoryWork } from '@video-quickly/contracts';
import { rpc } from '../lib/client';
import { useRecordPage } from '../lib/use-record-page';
import { useRuntimeRead } from '../lib/use-runtime-read';
import type { StepOutputSelection, WorkspaceView } from '../lib/types';
import { Button, Dialog, EmptyState, Field, IconButton, Notice, Select } from '../components/Primitives';
import CreativeContextEditor from '../components/CreativeContextEditor';
import { useConfirmation } from '../components/ConfirmationDialog';
import './works.css';
const QueuePanel = lazy(() => import('./ProductionQueuePanel'));
const workPage = recordPageSchema(workSchema);
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
const episodeSelectionLimit = 100;

export default function WorksPanel({ workspace, notify, onBack, onOpen, onOpenOutput }: { workspace: WorkspaceView; notify(message: string): void; onBack(): void; onOpen(id: string): void; onOpenOutput(value: StepOutputSelection): void }) {
  const [archived, setArchived] = useState(false), [selected, setSelected] = useState<StoryWork>(), [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const library = useRecordPage('work.list', { archived, limit: 30 }, workspace.version, workPage);
  const works = library.stale ? [] : library.items;
  const loading = library.busy || !library.hasLoaded;
  const confirm = useConfirmation();
  function changeArchive(value: boolean) { setError(''); setArchived(value); }
  async function archive(work: StoryWork) {
    if (!await confirm({ title: work.archived ? '恢复作品？' : '归档作品？', description: `“${work.title}”的分集项目与制作记录会保留。`, confirmLabel: work.archived ? '恢复作品' : '归档作品', variant: 'primary' })) return;
    setError('');
    try { await rpc(work.archived ? 'work.restore' : 'work.archive', { workId: work.id, revision: work.revision }); library.refresh(); }
    catch (error) { setError(failure(error)); }
  }
  if (selected) return <SelectedWork key={selected.id} initial={selected} workspace={workspace} notify={notify} onOpen={onOpen} onOpenOutput={onOpenOutput}
    onBack={() => { setSelected(undefined); library.refresh(); }} />;
  return <div className="content-page works-panel">
    <WorksHeading onBack={onBack}>
      <div className="heading-actions">
        <Button variant="ghost" aria-label="刷新作品" busy={library.busy && !library.loadingMore} onClick={library.refresh}><RefreshCw size={15} aria-hidden="true" />刷新</Button>
        {!archived && <Button variant="primary" onClick={() => setEditing(true)}><Plus size={15} aria-hidden="true" />新建作品</Button>}
      </div>
    </WorksHeading>
    {(library.error || error) && <Notice kind="error">{library.error || error}</Notice>}
    <div className="page-toolbar"><div className="tabs" role="group" aria-label="作品筛选">
      <button type="button" className={!archived ? 'active' : ''} aria-pressed={!archived} onClick={() => changeArchive(false)}>全部</button>
      <button type="button" className={archived ? 'active' : ''} aria-pressed={archived} onClick={() => changeArchive(true)}>已归档</button>
    </div></div>
    {works.length > 0 && <div className="work-cards">{works.map(work => <article className="section-card work-card" key={work.id}>
      <h2>{work.title}</h2>{work.description && <p className="work-card__description">{work.description}</p>}
      <p className="tiny-meta">{workspace.projects.filter(project => project.episode?.workId === work.id).length} 集</p>
      <div className="work-actions"><Button onClick={() => setSelected(work)}>查看分集</Button><Button variant="ghost" onClick={() => void archive(work)}>{work.archived ? '恢复作品' : '归档作品'}</Button></div>
    </article>)}</div>}
    {!works.length && !library.error && (loading
      ? <p className="muted" role="status">正在读取作品…</p>
      : <EmptyState icon={<Layers size={24} />} title={archived ? '没有归档作品' : '还没有作品'} description={archived ? '归档的作品可在这里恢复。' : '用作品组织分集，共用角色、风格和制作设置。'} />)}
    {!library.stale && library.nextCursor !== null && <Button busy={library.loadingMore} disabled={!library.canLoadMore} onClick={() => void library.loadMore()}>加载更多作品</Button>}
    {editing && <WorkEditor workspace={workspace} onClose={() => setEditing(false)} onSaved={work => { setEditing(false); setSelected(work); setArchived(work.archived); library.refresh(); }} />}
  </div>;
}

function WorksHeading({ work, onBack, children }: { work?: StoryWork; onBack(): void; children: ReactNode }) {
  return <div className="page-heading">
    <div className="works-heading__title">
      <IconButton label={work ? '全部作品' : '全部项目'} onClick={onBack}><ArrowLeft size={16} aria-hidden="true" /></IconButton>
      <div><h1>{work?.title ?? '作品与分集'}</h1>{work?.description && <p>{work.description}</p>}</div>
    </div>
    {children}
  </div>;
}

function SelectedWork({ initial, workspace, notify, onBack, onOpen, onOpenOutput }: {
  initial: StoryWork; workspace: WorkspaceView; notify(message: string): void; onBack(): void; onOpen(id: string): void; onOpenOutput(value: StepOutputSelection): void;
}) {
  const detail = useRuntimeRead('work.get', { workId: initial.id }, workspace.version, workSchema);
  const [saved, setSaved] = useState(initial);
  const [editing, setEditing] = useState<StoryWork>();
  const work = detail.data && detail.data.revision >= saved.revision ? detail.data : saved;
  return <div className="content-page works-panel">
    <WorksHeading work={work} onBack={onBack}><div className="heading-actions">
      <Button aria-label="编辑作品默认设置" onClick={() => setEditing(work)}>作品设置</Button>
    </div></WorksHeading>
    {detail.error && <Notice kind="error"><span>{detail.error}</span><Button busy={detail.busy} onClick={detail.refresh}>重试读取作品</Button></Notice>}
    <WorkEpisodes work={work} workspace={workspace} notify={notify} onOpen={onOpen} onOpenOutput={onOpenOutput} />
    {editing && <WorkEditor work={editing} workspace={workspace} onClose={() => setEditing(undefined)} onSaved={next => { setSaved(next); setEditing(undefined); detail.refresh(); }} />}
  </div>;
}

function WorkEditor({ work, workspace, onClose, onSaved }: { work?: StoryWork; workspace: WorkspaceView; onClose(): void; onSaved(work: StoryWork): void }) {
  const [title, setTitle] = useState(work?.title ?? ''), [description, setDescription] = useState(work?.description ?? '');
  const [defaults, setDefaults] = useState(() => work?.defaults ?? workDefaultsSchema.parse({}));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const inFlight = useRef(false);
  async function fromProject(id: string) {
    if (!id || inFlight.current) return; inFlight.current = true; setBusy(true); setError('');
    try {
      const project = projectDetailSchema.parse(await rpc('project.get', { projectId: id })).project;
      if (!project) throw new Error('项目不可用。');
      const { referenceAudioAssetIds: _audio, ...production } = project.workflow.production;
      setDefaults(workDefaultsSchema.parse({ style: project.style, creativeContext: project.creativeContext, profile: project.profile, production }));
    } catch (error) { setError(failure(error)); } finally { inFlight.current = false; setBusy(false); }
  }
  async function submit() {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError('');
    try { onSaved(workSchema.parse(await rpc('work.save', { id: work?.id, revision: work?.revision, title, description, defaults }))); }
    catch (error) { setError(failure(error)); } finally { inFlight.current = false; setBusy(false); }
  }
  return <Dialog title={work ? '作品默认设置' : '新建作品'} className="dialog--wide" onClose={onClose}><form onSubmit={event => { event.preventDefault(); void submit(); }}><div className="dialog__body"><fieldset disabled={busy} className="work-fieldset">
    <Field label="作品名称"><input required maxLength={160} autoFocus value={title} onChange={event => setTitle(event.target.value)} /></Field><Field label="作品说明"><textarea rows={2} maxLength={10000} value={description} onChange={event => setDescription(event.target.value)} /></Field>
    <Field label="沿用项目的默认设置" hint="复制风格、角色、成片规格和统一模型；参考音频由每集独立选择。"><Select value="" onChange={event => void fromProject(event.target.value)}><option value="">选择项目以复制设置</option>{workspace.projects.filter(project => !project.archived).map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</Select></Field>
    <Field label="作品默认风格"><textarea rows={3} maxLength={30000} value={defaults.style} onChange={event => setDefaults(value => ({ ...value, style: event.target.value }))} /></Field>
    <CreativeContextEditor label="作品默认角色池" value={defaults.creativeContext} version={workspace.version} usedEntityKeys={[]} onChange={creativeContext => setDefaults(value => ({ ...value, creativeContext }))} />
    <details><summary>默认模型与声音</summary>{(['text', 'image', 'video'] as const).map(kind => <Field key={kind} label={`作品${{ text: '文本', image: '图片', video: '视频' }[kind]}模型`}><Select value={defaults.production[`${kind}ModelId`] ?? ''} onChange={event => setDefaults(value => ({ ...value, production: { ...value.production, [`${kind}ModelId`]: event.target.value || undefined } }))}><option value="">稍后配置</option>{workspace.models.filter(model => model.enabled && model.capabilities.includes(kind)).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</Select></Field>)}
      <Field label="作品参考图方式"><Select value={defaults.production.referenceMode} onChange={event => setDefaults(value => ({ ...value, production: { ...value.production, referenceMode: event.target.value as typeof value.production.referenceMode } }))}><option value="none">直接文生视频</option><option value="existing">每集选择已有参考图</option><option value="generate">先生成参考图</option></Select></Field><Field label="作品声音要求"><textarea rows={2} value={defaults.production.soundPrompt} onChange={event => setDefaults(value => ({ ...value, production: { ...value.production, soundPrompt: event.target.value } }))} /></Field>
    </details><p className="tiny-meta">保存后用于新分集。已有分集可选择后显式同步。</p></fieldset>{error && <Notice kind="error">{error}</Notice>}</div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={busy}>保存作品</Button></div></form></Dialog>;
}

function WorkEpisodes({ work, workspace, notify, onOpen, onOpenOutput }: { work: StoryWork; workspace: WorkspaceView; notify(message: string): void; onOpen(id: string): void; onOpenOutput(value: StepOutputSelection): void }) {
  const [tab, setTab] = useState<'episodes' | 'queue'>('episodes'), [creating, setCreating] = useState(false), [attaching, setAttaching] = useState<ProjectSummary | 'new'>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]), [showArchived, setShowArchived] = useState(false), [sync, setSync] = useState<ProjectSummary[]>();
  const [queueId, setQueueId] = useState<string>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const inFlight = useRef(false), enqueueIdentity = useRef<{ key: string; id: string } | undefined>(undefined), confirm = useConfirmation();
  const episodesTab = useRef<HTMLButtonElement>(null), queueTab = useRef<HTMLButtonElement>(null);
  const selectAll = useRef<HTMLInputElement>(null);
  const episodes = workspace.projects.filter(project => project.episode?.workId === work.id).sort((a, b) => a.episode!.number - b.episode!.number);
  const visibleEpisodes = showArchived ? episodes : episodes.filter(project => !project.archived);
  const eligible = work.archived ? [] : episodes.filter(project => !project.archived);
  const selected = eligible.filter(project => selectedIds.includes(project.id));
  const bulkSelection = eligible.slice(0, episodeSelectionLimit);
  const allSelected = bulkSelection.length > 0 && bulkSelection.every(project => selectedIds.includes(project.id));
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selected.length > 0 && !allSelected;
  }, [tab, selected.length, allSelected]);
  function selectTab(value: typeof tab) {
    setError('');
    setTab(value);
  }
  async function enqueue() {
    if (inFlight.current || !selected.length || selected.length > episodeSelectionLimit) return; inFlight.current = true; setBusy(true); setError('');
    const projects = selected.map(project => ({ projectId: project.id, revision: project.revision })), key = JSON.stringify({ workId: work.id, workRevision: work.revision, projects });
    if (enqueueIdentity.current?.key !== key) enqueueIdentity.current = { key, id: crypto.randomUUID() };
    try {
      const result = productionQueueEnqueueResultSchema.parse(await rpc('productionQueue.enqueue', { workId: work.id, workRevision: work.revision, projects, requestId: enqueueIdentity.current.id }));
      enqueueIdentity.current = undefined;
      setQueueId(result.queue?.id ?? result.reused[0]?.queueId);
      setTab('queue');
      notify([result.items.length > 0 && `已将 ${result.items.length} 集加入队列。`, result.reused.length > 0 && `${result.reused.length} 集已在队列中。`].filter(Boolean).join(''));
      queueTab.current?.focus({ preventScroll: true });
    } catch (error) { setError(failure(error)); } finally { inFlight.current = false; setBusy(false); }
  }
  async function detach(project: ProjectSummary) {
    if (!await confirm({ title: '将分集移出作品？', description: `“${project.title}”会保留为独立项目，分集来源仍可追溯。`, confirmLabel: '移出作品', variant: 'primary' })) return;
    try { await rpc('work.episode.detach', { projectId: project.id, revision: project.revision }); } catch (error) { setError(failure(error)); }
  }
  return <>
    <nav className="tabs works-content-tabs" aria-label="作品内容">
      {([['episodes', '分集'], ['queue', '生产队列']] as const).map(([id, label]) => <button key={id} ref={id === 'episodes' ? episodesTab : queueTab} type="button" className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => selectTab(id)}>{label}</button>)}
    </nav>
    {error && <Notice kind="error">{error}</Notice>}
    {tab === 'episodes' ? <>
      <div className="episode-toolbar">
        {!work.archived && <div className="work-actions">
          {selected.length > 0 ? <>
            <Button variant="primary" busy={busy} disabled={selected.length > episodeSelectionLimit} aria-label={`所选分集入队（${selected.length}）`} onClick={() => void enqueue()}>加入队列（{selected.length}）</Button>
            <Button disabled={busy || selected.length > episodeSelectionLimit} aria-label="同步作品默认设置" onClick={() => setSync(selected)}>同步设置</Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setSelectedIds([]); episodesTab.current?.focus(); }}>清除选择</Button>
          </> : <>
            <Button variant="primary" onClick={() => setCreating(true)}>批量新建分集</Button>
            <Button onClick={() => setAttaching('new')}>加入已有项目</Button>
          </>}
        </div>}
        <div className="episode-filters">
          {bulkSelection.length > 0 && <label className="field-inline"><input ref={selectAll} type="checkbox" aria-label={eligible.length > episodeSelectionLimit ? `选择前 ${episodeSelectionLimit} 集` : '全选分集'} checked={allSelected} disabled={busy}
            onChange={event => setSelectedIds(event.target.checked ? bulkSelection.map(project => project.id) : [])} />
            {eligible.length > episodeSelectionLimit ? `选择前 ${episodeSelectionLimit} 集` : '全选分集'}
          </label>}
          {episodes.some(project => project.archived) && <label className="field-inline"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />显示回收站分集</label>}
        </div>
      </div>
      {selected.length >= episodeSelectionLimit && <p className="tiny-meta" role="status">每批最多选择 {episodeSelectionLimit} 集。</p>}
      {visibleEpisodes.length > 0 ? <div className="episode-list">{visibleEpisodes.map(project => {
        const number = `第 ${project.episode!.number} 集`;
        const canSelect = !project.archived && !work.archived;
        return <article className="episode-row" key={project.id} data-project-id={project.id}>
          <div className="episode-identity">
            {canSelect && <label className="episode-choice"><input type="checkbox" aria-label={`选择${number}`} disabled={busy || selected.length >= episodeSelectionLimit && !selectedIds.includes(project.id)} checked={selectedIds.includes(project.id)} onChange={event => setSelectedIds(ids => event.target.checked ? [...ids, project.id] : ids.filter(id => id !== project.id))} /></label>}
            <div className="episode-content">
              {project.title !== number && <span className="tiny-meta">{number}</span>}
              <h3>{project.title}</h3>
              <p className="tiny-meta">项目修订 {project.revision} · {project.archived ? '回收站' : `${project.shotCount} 个镜头`}</p>
            </div>
          </div>
          <div className="work-actions">
            <Button onClick={() => onOpen(project.id)}>打开分集</Button>
            {canSelect && <Button variant="ghost" onClick={() => setAttaching(project)}>编辑分集</Button>}
            {!work.archived && <Button variant="ghost" onClick={() => void detach(project)}>移出作品</Button>}
          </div>
        </article>;
      })}</div> : <EmptyState icon={<Layers size={24} />}
        title={episodes.length ? '分集都在回收站' : '还没有分集'}
        description={episodes.length ? '开启“显示回收站分集”可查看。' : work.archived ? '此作品归档前没有分集。' : '可批量新建分集，也可加入已有项目。'} />}
    </> : <Suspense fallback={<p role="status">正在读取生产队列…</p>}><QueuePanel work={work} version={workspace.version} selectedQueueId={queueId} onSelectQueue={setQueueId}
      onSelectEpisodes={() => { selectTab('episodes'); episodesTab.current?.focus(); }} onOpen={onOpen} onOpenOutput={onOpenOutput} /></Suspense>}
    {creating && <BatchEpisodesDialog work={work} nextNumber={Math.max(0, ...episodes.map(project => project.episode!.number)) + 1} onClose={() => setCreating(false)} onSaved={projects => { setCreating(false); setSelectedIds(projects.map(project => project.id)); }} />}
    {attaching && <AttachEpisodeDialog work={work} project={attaching === 'new' ? undefined : attaching} workspace={workspace} onClose={() => setAttaching(undefined)} onSaved={() => setAttaching(undefined)} />}
    {sync && <SyncDefaultsDialog work={work} projects={sync} models={workspace.models} onClose={() => setSync(undefined)} onSaved={() => setSync(undefined)} />}
  </>;
}

function BatchEpisodesDialog({ work, nextNumber, onClose, onSaved }: { work: StoryWork; nextNumber: number; onClose(): void; onSaved(projects: ProjectDocument[]): void }) {
  const [start, setStart] = useState(nextNumber), [count, setCount] = useState(3), [drafts, setDrafts] = useState<Record<number, { title: string; originalText: string }>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const inFlight = useRef(false), identity = useRef<{ key: string; id: string } | undefined>(undefined);
  const rows = Array.from({ length: Number.isInteger(count) && count > 0 ? Math.min(count, 100) : 0 }, (_, index) => start + index);
  async function submit() {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError('');
    const episodes = rows.map(number => ({ number, title: drafts[number]?.title ?? `第 ${number} 集`, originalText: drafts[number]?.originalText ?? '' }));
    const key = JSON.stringify({ workId: work.id, revision: work.revision, episodes });
    if (identity.current?.key !== key) identity.current = { key, id: crypto.randomUUID() };
    try { const values = await rpc('work.episodes.create', { workId: work.id, revision: work.revision, episodes, requestId: identity.current.id }); onSaved(projectSchema.array().parse(values)); }
    catch (error) { setError(failure(error)); } finally { inFlight.current = false; setBusy(false); }
  }
  return <Dialog title="批量新建分集" className="dialog--wide" onClose={onClose}><form onSubmit={event => { event.preventDefault(); void submit(); }}><div className="dialog__body"><fieldset disabled={busy} className="work-fieldset"><p>新分集沿用“{work.title}”的默认设置 v{work.revision}。标题与原始文案逐集保存。</p><div className="work-form-grid"><Field label="起始集数"><input type="number" required min={1} max={100000} value={start || ''} onChange={event => setStart(Number(event.target.value))} /></Field><Field label="创建数量"><input type="number" required min={1} max={100} value={count || ''} onChange={event => setCount(Number(event.target.value))} /></Field></div>{rows.map(number => <section className="episode-draft" key={number} aria-label={`第 ${number} 集草稿`}><Field label={`第 ${number} 集标题`}><input required maxLength={160} value={drafts[number]?.title ?? `第 ${number} 集`} onChange={event => setDrafts(value => ({ ...value, [number]: { title: event.target.value, originalText: value[number]?.originalText ?? '' } }))} /></Field><Field label={`第 ${number} 集原始文案`}><textarea maxLength={30000} rows={3} value={drafts[number]?.originalText ?? ''} onChange={event => setDrafts(value => ({ ...value, [number]: { title: value[number]?.title ?? `第 ${number} 集`, originalText: event.target.value } }))} /></Field></section>)}</fieldset>{error && <Notice kind="error">{error}</Notice>}</div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={busy}>创建 {rows.length} 个分集</Button></div></form></Dialog>;
}
function AttachEpisodeDialog({ work, project, workspace, onClose, onSaved }: { work: StoryWork; project?: ProjectSummary; workspace: WorkspaceView; onClose(): void; onSaved(): void }) {
  const [target, setTarget] = useState<ProjectSummary>(), [number, setNumber] = useState(project?.episode?.number ?? 1), [title, setTitle] = useState(project?.title ?? ''), [originalText, setOriginalText] = useState('');
  const [busy, setBusy] = useState(Boolean(project)), [error, setError] = useState(''); const inFlight = useRef(false), readRequest = useRef(0);
  async function choose(value: ProjectSummary) {
    const request = ++readRequest.current; setTarget(undefined); setTitle(value.title); setBusy(true); setError('');
    try { const current = projectDetailSchema.parse(await rpc('project.get', { projectId: value.id })).project; if (!current) throw new Error('项目不可用，请重新读取。'); if (request === readRequest.current) { setTarget({ ...value, revision: current.revision }); setTitle(current.title); setOriginalText(current.episode?.originalText ?? current.episodeSource?.originalText ?? current.brief); } }
    catch (error) { if (request === readRequest.current) setError(failure(error)); } finally { if (request === readRequest.current) setBusy(false); }
  }
  useEffect(() => { if (project) void choose(project); return () => { readRequest.current++; }; }, [project?.id]);
  async function submit() {
    if (inFlight.current || !target) return; inFlight.current = true; setBusy(true); setError('');
    try { await rpc('work.episode.attach', { workId: work.id, workRevision: work.revision, projectId: target.id, revision: target.revision, number, title, originalText }); onSaved(); }
    catch (error) { setError(failure(error)); } finally { inFlight.current = false; setBusy(false); }
  }
  return <Dialog title={project ? '编辑分集' : '加入已有项目'} onClose={onClose}><form onSubmit={event => { event.preventDefault(); void submit(); }}><div className="dialog__body"><fieldset disabled={busy} className="work-fieldset">{!project && <Field label="已有项目"><Select value={target?.id ?? ''} onChange={event => { const value = workspace.projects.find(project => project.id === event.target.value); if (value) void choose(value); }}><option value="">选择独立项目</option>{workspace.projects.filter(project => !project.archived && !project.episode).map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</Select></Field>}<Field label="分集编号"><input type="number" min={1} max={100000} required value={number || ''} onChange={event => setNumber(Number(event.target.value))} /></Field><Field label="分集标题"><input required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></Field><Field label="分集原始文案" hint="原文独立保存，已有制作简报和分镜会保留。"><textarea rows={5} maxLength={30000} value={originalText} onChange={event => setOriginalText(event.target.value)} /></Field></fieldset>{error && <Notice kind="error">{error}</Notice>}</div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" busy={busy} disabled={!target}>保存分集关联</Button></div></form></Dialog>;
}

function SyncDefaultsDialog({ work, projects, models, onClose, onSaved }: { work: StoryWork; projects: ProjectSummary[]; models: WorkspaceView['models']; onClose(): void; onSaved(): void }) {
  const [fields, setFields] = useState(['style', 'creativeContext']), [busy, setBusy] = useState(false), [error, setError] = useState(''); const inFlight = useRef(false);
  const { style, creativeContext, profile, production } = work.defaults;
  const connections = (['text', 'image', 'video'] as const).map(kind => {
    const id = production[`${kind}ModelId`];
    return `${{ text: '文本', image: '图片', video: '视频' }[kind]} ${id ? models.find(model => model.id === id)?.name ?? '连接已不可用' : '未选择'}`;
  }).join(' · ');
  const options = [
    { id: 'style', label: '视觉风格', value: style || '未填写视觉风格' },
    { id: 'creativeContext', label: '角色与创作设定', value: `${creativeContext?.characterIds.length ?? 0} 个角色 · ${creativeContext?.entities.length ?? 0} 项设定${creativeContext?.continuity.trim() ? ' · 已填写连续性要求' : ''}` },
    { id: 'profile', label: '成片规格', value: `${profile.width} × ${profile.height} · ${formatFrameRate(profile.frameRate)} fps · ${{ contain: '完整显示', cover: '裁剪填满', blur: '模糊背景填充' }[profile.fitMode]}` },
    { id: 'production', label: '统一模型与声音设置', value: `${connections}${production.soundPrompt ? ` · 声音要求 ${production.soundPrompt}` : ' · 未填写声音要求'}` },
  ];
  async function submit() {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError('');
    try { await rpc('work.defaults.apply', { workId: work.id, revision: work.revision, projects: projects.map(project => ({ projectId: project.id, revision: project.revision })), fields }); onSaved(); }
    catch (error) { setError(failure(error)); } finally { inFlight.current = false; setBusy(false); }
  }
  return <Dialog title="同步作品默认设置" onClose={onClose} className="work-sync-dialog"><div className="dialog__body">
    <p className="work-sync__source">{work.title}</p>
    <details className="work-sync__targets"><summary>已选 {projects.length} 个分集</summary><ul>{projects.map(project => <li key={project.id}>{project.title}</li>)}</ul></details>
    <fieldset className="work-checks"><legend>同步内容</legend>{options.map(({ id, label, value }) => <label key={id}>
      <input type="checkbox" aria-label={label} disabled={busy} checked={fields.includes(id)} onChange={event => setFields(current => event.target.checked ? [...current, id] : current.filter(field => field !== id))} />
      <span className="work-sync__option-copy"><span>{label}</span><span className="work-sync__value" title={value}>{value}</span></span>
    </label>)}</fieldset>
    {error && <Notice kind="error">{error}</Notice>}
  </div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button variant="primary" busy={busy} disabled={!fields.length} onClick={() => void submit()}>同步到所选分集</Button></div></Dialog>;
}
