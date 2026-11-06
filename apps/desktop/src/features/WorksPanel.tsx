import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Layers, Plus, RefreshCw } from 'lucide-react';
import { projectDetailSchema, projectSchema, productionQueueEnqueueResultSchema, recordPageSchema, workDefaultsSchema, workSchema, type ProjectDocument, type ProjectSummary, type StoryWork } from '@video-quickly/contracts';
import { rpc } from '../lib/client';
import { useRecordPage } from '../lib/use-record-page';
import type { StepOutputSelection, WorkspaceView } from '../lib/types';
import { Button, Dialog, EmptyState, Field, Notice, Select } from '../components/Primitives';
import CreativeContextEditor from '../components/CreativeContextEditor';
import { useConfirmation } from '../components/ConfirmationDialog';
import './works.css';
const QueuePanel = lazy(() => import('./ProductionQueuePanel'));
const workPage = recordPageSchema(workSchema);
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function WorksPanel({ workspace, onBack, onOpen, onOpenOutput }: { workspace: WorkspaceView; onBack(): void; onOpen(id: string): void; onOpenOutput(value: StepOutputSelection): void }) {
  const [archived, setArchived] = useState(false), [selectedId, setSelectedId] = useState<string>(), [editing, setEditing] = useState<StoryWork | 'new'>();
  const [error, setError] = useState('');
  const library = useRecordPage('work.list', { archived, limit: 30 }, workspace.version, workPage);
  const selected = library.items.find(work => work.id === selectedId);
  const confirm = useConfirmation();
  async function archive(work: StoryWork) {
    if (!await confirm({ title: work.archived ? '恢复作品？' : '归档作品？', description: `“${work.title}”的分集项目与制作记录会保留。`, confirmLabel: work.archived ? '恢复作品' : '归档作品', variant: 'primary' })) return;
    try { await rpc(work.archived ? 'work.restore' : 'work.archive', { workId: work.id, revision: work.revision }); setSelectedId(undefined); library.refresh(); }
    catch (error) { setError(failure(error)); }
  }
  return <div className="content-page works-panel">
    <div className="page-heading"><div><Button variant="ghost" onClick={selected ? () => setSelectedId(undefined) : onBack}><ArrowLeft size={15} />{selected ? '全部作品' : '全部项目'}</Button><h1>{selected?.title ?? '作品与分集'}</h1><p>{selected ? selected.description : '按作品组织分集，选择顺序后排队制作。'}</p></div><div className="heading-actions"><Button aria-label="刷新作品" onClick={library.refresh}><RefreshCw size={15} />刷新</Button><Button variant="primary" onClick={() => setEditing(selected ?? 'new')}>{selected ? '编辑作品默认设置' : <><Plus size={15} />新建作品</>}</Button></div></div>
    {(library.error || error) && <Notice kind="error">{library.error || error}</Notice>}
    {selected ? <WorkEpisodes key={`episodes:${selected.id}`} work={selected} workspace={workspace} onOpen={onOpen} onOpenOutput={onOpenOutput} /> : <>
      <div className="page-toolbar"><label className="field-inline"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />已归档作品</label></div>
      <div className="work-cards">{library.items.map(work => <article className="section-card work-card" key={work.id}><h2>{work.title}</h2><p>{work.description || '尚未填写作品说明'}</p><p className="tiny-meta">{workspace.projects.filter(project => project.episode?.workId === work.id).length} 集 · 默认设置 v{work.revision}</p><div className="work-actions"><Button onClick={() => setSelectedId(work.id)}>查看分集</Button><Button variant="ghost" onClick={() => void archive(work)}>{work.archived ? '恢复作品' : '归档作品'}</Button></div></article>)}</div>
      {!library.items.length && !library.busy && <EmptyState icon={<Layers size={24} />} title="创建一部作品" description="作品保存角色、风格及制作默认设置，每集拥有独立项目。" />}
      {library.nextCursor !== null && <Button busy={library.loadingMore} onClick={() => void library.loadMore()}>加载更多作品</Button>}
    </>}
    {editing && <WorkEditor key={editing === 'new' ? 'new' : `edit:${editing.id}`} work={editing === 'new' ? undefined : editing} workspace={workspace} onClose={() => setEditing(undefined)} onSaved={work => { setEditing(undefined); setSelectedId(work.id); setArchived(work.archived); library.refresh(); }} />}
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

function WorkEpisodes({ work, workspace, onOpen, onOpenOutput }: { work: StoryWork; workspace: WorkspaceView; onOpen(id: string): void; onOpenOutput(value: StepOutputSelection): void }) {
  const [tab, setTab] = useState<'episodes' | 'queue'>('episodes'), [creating, setCreating] = useState(false), [attaching, setAttaching] = useState<ProjectSummary | 'new'>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]), [showArchived, setShowArchived] = useState(false), [sync, setSync] = useState<ProjectSummary[]>();
  const [queueId, setQueueId] = useState<string>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const inFlight = useRef(false), enqueueIdentity = useRef<{ key: string; id: string } | undefined>(undefined), confirm = useConfirmation();
  const episodes = workspace.projects.filter(project => project.episode?.workId === work.id).sort((a, b) => a.episode!.number - b.episode!.number);
  const selected = episodes.filter(project => !project.archived && selectedIds.includes(project.id));
  async function enqueue() {
    if (inFlight.current || !selected.length) return; inFlight.current = true; setBusy(true); setError(''); setNotice('');
    const projects = selected.map(project => ({ projectId: project.id, revision: project.revision })), key = JSON.stringify({ workId: work.id, workRevision: work.revision, projects });
    if (enqueueIdentity.current?.key !== key) enqueueIdentity.current = { key, id: crypto.randomUUID() };
    try {
      const result = productionQueueEnqueueResultSchema.parse(await rpc('productionQueue.enqueue', { workId: work.id, workRevision: work.revision, projects, requestId: enqueueIdentity.current.id }));
      enqueueIdentity.current = undefined;
      setQueueId(result.queue?.id ?? result.reused[0]?.queueId); setTab('queue'); setNotice(`已加入 ${result.items.length} 集，${result.reused.length} 集沿用已有排队项。`);
    } catch (error) { setError(failure(error)); } finally { inFlight.current = false; setBusy(false); }
  }
  async function detach(project: ProjectSummary) {
    if (!await confirm({ title: '将分集移出作品？', description: `“${project.title}”会保留为独立项目，分集来源仍可追溯。`, confirmLabel: '移出作品', variant: 'primary' })) return;
    try { await rpc('work.episode.detach', { projectId: project.id, revision: project.revision }); } catch (error) { setError(failure(error)); }
  }
  return <><nav className="tabs" aria-label="作品内容">{([['episodes', '分集'], ['queue', '生产队列']] as const).map(([id, label]) => <button key={id} type="button" className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}</nav>
    {error && <Notice kind="error">{error}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}
    {tab === 'episodes' ? <><div className="work-actions"><Button variant="primary" disabled={work.archived} onClick={() => setCreating(true)}>批量新建分集</Button><Button disabled={work.archived} onClick={() => setAttaching('new')}>加入已有项目</Button><Button disabled={!selected.length || work.archived} onClick={() => setSync(selected)}>同步作品默认设置</Button><Button disabled={!selected.length || work.archived} busy={busy} onClick={() => void enqueue()}>所选分集入队（{selected.length}）</Button><label><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />显示回收站分集</label></div><p className="tiny-meta">按集数从小到大入队。入队后核对列表，再开始顺序制作。</p>
      <div className="episode-list">{episodes.filter(project => showArchived || !project.archived).map(project => <article className="section-card episode-row" key={project.id} data-project-id={project.id}><label className="episode-choice"><input type="checkbox" aria-label={`选择第 ${project.episode!.number} 集`} disabled={project.archived || work.archived} checked={selectedIds.includes(project.id)} onChange={event => setSelectedIds(ids => event.target.checked ? [...ids, project.id] : ids.filter(id => id !== project.id))} /><span>第 {project.episode!.number} 集</span></label><div className="episode-content"><h3>{project.title}</h3><p className="tiny-meta">项目修订 {project.revision} · {project.archived ? '回收站' : `${project.shotCount} 个镜头`}</p></div><div className="work-actions"><Button onClick={() => onOpen(project.id)}>打开分集</Button><Button variant="ghost" disabled={project.archived || work.archived} onClick={() => setAttaching(project)}>编辑分集</Button><Button variant="ghost" disabled={work.archived} onClick={() => void detach(project)}>移出作品</Button></div></article>)}</div>
      {!episodes.length && <EmptyState icon={<Layers size={24} />} title="添加第一批分集" description="输入每集标题和原始文案，原子创建独立项目。" />}
    </> : <Suspense fallback={<p role="status">正在读取生产队列…</p>}><QueuePanel work={work} version={workspace.version} selectedQueueId={queueId} onOpen={onOpen} onOpenOutput={onOpenOutput} /></Suspense>}
    {creating && <BatchEpisodesDialog work={work} nextNumber={Math.max(0, ...episodes.map(project => project.episode!.number)) + 1} onClose={() => setCreating(false)} onSaved={projects => { setCreating(false); setSelectedIds(projects.map(project => project.id)); }} />}
    {attaching && <AttachEpisodeDialog work={work} project={attaching === 'new' ? undefined : attaching} workspace={workspace} onClose={() => setAttaching(undefined)} onSaved={() => setAttaching(undefined)} />}
    {sync && <SyncDefaultsDialog work={work} projects={sync} onClose={() => setSync(undefined)} onSaved={() => setSync(undefined)} />}
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

function SyncDefaultsDialog({ work, projects, onClose, onSaved }: { work: StoryWork; projects: ProjectSummary[]; onClose(): void; onSaved(): void }) {
  const [fields, setFields] = useState(['style', 'creativeContext']), [busy, setBusy] = useState(false), [error, setError] = useState(''); const inFlight = useRef(false);
  async function submit() {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError('');
    try { await rpc('work.defaults.apply', { workId: work.id, revision: work.revision, projects: projects.map(project => ({ projectId: project.id, revision: project.revision })), fields }); onSaved(); }
    catch (error) { setError(failure(error)); } finally { inFlight.current = false; setBusy(false); }
  }
  return <Dialog title="同步作品默认设置" onClose={onClose}><div className="dialog__body"><p>将作品默认设置 v{work.revision} 应用到 {projects.length} 个分集。</p><ul>{projects.map(project => <li key={project.id}>{project.title} · 项目修订 {project.revision}</li>)}</ul><p className="tiny-meta">风格：{work.defaults.style || '未填写'} · 角色：{work.defaults.creativeContext?.characterIds.length ?? 0} 个</p><div className="work-checks">{[['style', '视觉风格'], ['creativeContext', '角色与创作设定'], ['profile', '成片规格'], ['production', '统一模型与声音设置']].map(([id, label]) => <label key={id}><input type="checkbox" disabled={busy} checked={fields.includes(id)} onChange={event => setFields(value => event.target.checked ? [...value, id] : value.filter(field => field !== id))} />{label}</label>)}</div>{error && <Notice kind="error">{error}</Notice>}</div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button variant="primary" busy={busy} disabled={!fields.length} onClick={() => void submit()}>同步到所选分集</Button></div></Dialog>;
}
