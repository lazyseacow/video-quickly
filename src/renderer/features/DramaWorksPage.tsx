import { lazy, Suspense, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Clapperboard, Film, History, Pencil, Plus, RotateCcw, Search } from 'lucide-react';
import { DEFAULT_VIDEO_PROFILE, dramaNarrativeModeLabels, dramaStylePresets, dramaTopicSchema, dramaVisualStyleLabels, dramaWorkSchema, MAX_NOVEL_SOURCE_LENGTH, projectSummarySchema, recordPageSchema, type DramaTopic, type DramaWork, type ProjectDocument, type ProjectSummary } from '@video-quickly/contracts';
import { Button, Dialog, EmptyState, Field, Notice, Select } from '../components/Primitives';
import { useConfirmation } from '../components/ConfirmationDialog';
import type { StudioMenuCommand } from '../components/WorkspaceSidebar';
import { CharacterPicker } from '../components/CharacterPicker';
import { useRecordPage } from '../lib/use-record-page';
import { useRuntimeRead } from '../lib/use-runtime-read';
import type { Action, WorkspaceView } from '../lib/types';
import SkillPicker from '../components/SkillPicker';
import DramaCreationComposer, { type DramaComposerHandle, type DramaCreationRequest, type StudioPlanningInput } from './DramaCreationComposer';
import type { CreativePlanningHandle, CreativePlanningThreadRequest } from './CreativePlanningDialog';
import DramaTopicsDialog from './DramaTopicsDialog';
import { rpc } from '../lib/client';
import './drama.css';
import './drama-library.css';

const workPage = recordPageSchema(dramaWorkSchema);
const episodesSchema = projectSummarySchema.array();
const CreativePlanningDialog = lazy(() => import('./CreativePlanningDialog'));
const WorkPreview = lazy(() => import('../components/ScenePreview').then(module => ({ default: module.ScenePreview })));
const shortDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' });

export interface DramaStudioRequest extends DramaCreationRequest { command: StudioMenuCommand; }
export interface DramaStudioMenuContext { current: StudioMenuCommand; guideLibrary: boolean; }

export function DramaModeFields({ visualStyle, narrativeMode, onChange, disabled = false }: {
  visualStyle: DramaWork['visualStyle']; narrativeMode: DramaWork['narrativeMode']; disabled?: boolean;
  onChange(patch: Partial<Pick<DramaWork, 'visualStyle' | 'narrativeMode'>>): void;
}) {
  return <div className="drama-form-grid">
    <Field label="视觉风格"><Select disabled={disabled} value={visualStyle} onChange={event => onChange({ visualStyle: event.target.value as DramaWork['visualStyle'] })}>
      {Object.entries(dramaVisualStyleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </Select></Field>
    <Field label="讲述方式"><Select disabled={disabled} value={narrativeMode} onChange={event => onChange({ narrativeMode: event.target.value as DramaWork['narrativeMode'] })}>
      {Object.entries(dramaNarrativeModeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </Select></Field>
  </div>;
}

export default function DramaWorksPage({ workspace, action, onOpen, onContinue, onMenuContext, request }: {
  workspace: WorkspaceView; action: Action; request?: DramaStudioRequest;
  onOpen(id: string, editStoryboard?: boolean): void; onContinue(id: string): void; onMenuContext(context: DramaStudioMenuContext): void;
}) {
  const id = useId();
  const confirm = useConfirmation();
  const [view, setView] = useState<'dialogue' | 'works'>('dialogue');
  const [composerVersion, setComposerVersion] = useState(0);
  const [composerRequest, setComposerRequest] = useState<DramaCreationRequest>();
  const composerSequence = useRef(0);
  const forwardedRequest = useRef<number | undefined>(undefined);
  const composer = useRef<DramaComposerHandle>(null);
  const planning = useRef<CreativePlanningHandle>(null);
  const planningSequence = useRef(0);
  const [planningRequest, setPlanningRequest] = useState<CreativePlanningThreadRequest>();
  const [planningActive, setPlanningActive] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const keepDraft = useRef<HTMLButtonElement>(null);
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search.trim());
  const searchInput = useRef<HTMLInputElement>(null);
  const worksHeading = useRef<HTMLHeadingElement>(null);
  const worksPage = useRef<HTMLElement>(null);
  const returnToWork = useRef<string | undefined>(undefined);
  const [selected, setSelected] = useState<DramaWork>();
  const [editing, setEditing] = useState<DramaWork>();
  const [creatingEpisode, setCreatingEpisode] = useState(false);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!request || forwardedRequest.current === request.sequence) return;
    forwardedRequest.current = request.sequence;
    const { command } = request;
    if (command === 'new') {
      const statuses = [composer.current?.draftStatus(), planning.current?.draftStatus()];
      if (statuses.includes('busy')) return;
      if (statuses.includes('edited')) setResetOpen(true);
      else resetComposer();
      return;
    }
    if (command === 'works') { setSelected(undefined); setView('works'); return; }
    setView('dialogue');
    if (request.template) setPlanningActive(false);
    if (!planningActive || request.template) setComposerRequest({ sequence: ++composerSequence.current, template: request.template });
  }, [request, planningActive]);
  useLayoutEffect(() => {
    if (view !== 'works') return;
    const workId = returnToWork.current;
    returnToWork.current = undefined;
    const trigger = workId && worksPage.current?.querySelector<HTMLButtonElement>(
      `[data-work-id="${CSS.escape(workId)}"] .drama-library__view-work`,
    );
    if (trigger) trigger.focus();
    else worksHeading.current?.focus({ preventScroll: true });
  }, [view, selected?.id]);
  const library = useRecordPage('dramaWork.list', { archived, search: query, limit: 20 }, workspace.version, workPage);
  const detail = useRuntimeRead('dramaWork.get', { workId: selected?.id }, workspace.version, dramaWorkSchema, view === 'works' && Boolean(selected));
  const episodes = useRuntimeRead('dramaWork.episodes', { workId: selected?.id }, workspace.version, episodesSchema, view === 'works' && Boolean(selected));
  const work = selected ? detail.data ?? selected : undefined;
  const values = library.stale ? [] : library.items;
  const { episodesByWork, episodePreviews } = useMemo(() => {
    const episodesByWork = new Map<string, WorkEpisodes>();
    const episodePreviews = new Map<string, EpisodePreview>();
    for (const episode of workspace.projects) {
      if (!episode.drama) continue;
      const group = episodesByWork.get(episode.drama.workId) ?? { count: 0 };
      const preview = readEpisodePreview(episode);
      if (preview) episodePreviews.set(episode.id, preview);
      group.count += 1;
      if (!episode.archived) {
        if (!group.latest || episode.updatedAt > group.latest.updatedAt) group.latest = episode;
        if (preview && (!group.cover || episode.updatedAt > group.cover.project.updatedAt)) group.cover = preview;
      }
      episodesByWork.set(episode.drama.workId, group);
    }
    return { episodesByWork, episodePreviews };
  }, [workspace.projects]);
  const guideLibrary = view !== 'works' && !archived && !query && values.some(value => episodesByWork.get(value.id)?.latest);
  useEffect(() => { onMenuContext({ current: view, guideLibrary }); }, [view, guideLibrary, onMenuContext]);
  const nextEpisodeNumber = (episodes.data ?? []).reduce((maximum, episode) => Math.max(maximum, episode.drama?.number ?? 0), 0) + 1;
  const latestEpisodeId = work && !work.archived ? episodesByWork.get(work.id)?.latest?.id : undefined;

  function resetComposer() {
    setResetOpen(false); setComposerRequest(undefined); setView('dialogue');
    setPlanningActive(false); setPlanningRequest(undefined);
    setComposerVersion(value => value + 1);
  }
  async function openPlanning(input: StudioPlanningInput) {
    const status = planning.current?.draftStatus();
    if (status === 'busy' && (input.goal || input.history)) return false;
    if (input.goal && status === 'edited' && !await confirm({
      title: '开始新的分镜需求？', description: '当前分镜有未提交的内容。确认后会使用刚发送的需求。', confirmLabel: '使用新的需求',
    })) return false;
    if (!planningRequest || input.goal || input.history) setPlanningRequest({ ...input, sequence: ++planningSequence.current });
    setPlanningActive(true);
    return true;
  }
  function returnToComposer() {
    setPlanningActive(false);
    setComposerRequest({ sequence: ++composerSequence.current });
  }
  function openCreated(project: ProjectDocument) {
    if (project.workflow.production.novelAdaptation) onContinue(project.id);
    else onOpen(project.id);
  }
  async function archive(value: DramaWork) {
    if (busy) return;
    setBusy(true); setFailure('');
    const result = await action<DramaWork>(value.archived ? 'dramaWork.restore' : 'dramaWork.archive', { workId: value.id, revision: value.revision }, value.archived ? '作品已恢复' : '作品已归档');
    if (result) { library.refresh(); if (selected?.id === value.id) setSelected(result); }
    else setFailure('操作尚未完成，作品内容已保留，请核对提示后重试。');
    setBusy(false);
  }
  return <div className="drama-studio">
    <h1 className="drama-studio__title">短剧工作室</h1>
    <div className="drama-studio__dialogue" hidden={view !== 'dialogue'}>
      <div className="drama-studio__composer" hidden={planningActive}>
        <DramaCreationComposer key={composerVersion} ref={composer} workspace={workspace} action={action} request={composerRequest}
          focusOnMount={composerVersion > 0} onPlanning={openPlanning} onCreated={project => { library.refresh(); openCreated(project); }} />
      </div>
      {planningRequest && <div className="drama-studio__planning" hidden={!planningActive}>
        <Suspense fallback={<p role="status">正在接续分镜创作…</p>}>
          <CreativePlanningDialog ref={planning} presentation="workspace" active={view === 'dialogue' && planningActive} threadRequest={planningRequest}
            workspace={workspace} action={action} onClose={returnToComposer} onEdit={projectId => { setPlanningActive(false); onOpen(projectId, true); }} />
        </Suspense>
      </div>}
    </div>
    <section ref={worksPage} className="content-page drama-library" aria-labelledby={`${id}-works-heading`} hidden={view !== 'works'}>
      {work ? <>
        <header className="drama-library__detail-header">
          <Button static variant="ghost" className="drama-library__back" aria-label="返回作品列表" onClick={() => {
            returnToWork.current = work.id;
            setSelected(undefined);
          }}><ArrowLeft size={16} aria-hidden="true" />我的作品</Button>
          <div className="drama-library__detail-title">
            <h2 ref={worksHeading} id={`${id}-works-heading`} tabIndex={-1}>{work.title}</h2>
            <div className="heading-actions">
              <Button onClick={() => setEditing(work)} disabled={busy || work.archived}><Pencil size={16} aria-hidden="true" />编辑作品</Button>
              <Button variant="primary" onClick={() => setCreatingEpisode(true)} disabled={work.archived || !episodes.data}><Plus size={16} aria-hidden="true" />新建分集</Button>
            </div>
          </div>
          <div className="drama-library__detail-meta" data-guide-loading={(!episodes.data || episodes.busy) && !episodes.error || undefined}>
            {work.description && <p>{work.description}</p>}
            <div className="drama-library__facts">
              <span>{dramaVisualStyleLabels[work.visualStyle]}</span>
              <span>{dramaNarrativeModeLabels[work.narrativeMode]}</span>
              {work.characterIds.length > 0 && <span>{work.characterIds.length} 个共享角色</span>}
              {work.archived && <span>已归档</span>}
            </div>
          </div>
        </header>
        {failure && <Notice kind="error">{failure}</Notice>}
        {detail.error && <Notice kind="error">{detail.error}<Button onClick={detail.refresh}>重试读取作品</Button></Notice>}
        <section className="drama-library__episodes" aria-labelledby={`${id}-episodes-title`}>
          <header className="drama-library__episodes-heading">
            <h3 id={`${id}-episodes-title`}>分集</h3>
            {episodes.data && <span className="drama-library__count">{episodes.data.length} 集</span>}
            <Button static variant="ghost" disabled={busy} onClick={() => void archive(work)}>
              {work.archived ? <RotateCcw size={16} aria-hidden="true" /> : <Archive size={16} aria-hidden="true" />}
              {work.archived ? '恢复作品' : '归档作品'}
            </Button>
          </header>
          {episodes.error && <Notice kind="error">{episodes.error}<Button onClick={episodes.refresh}>重试读取分集</Button></Notice>}
          {episodes.busy && !episodes.data && <p className="drama-library__reading" role="status">正在读取分集…</p>}
          {Boolean(episodes.data?.length) && <ol className="drama-episode-list" role="list">
            {episodes.data?.map(episode => <EpisodeRow key={episode.id} episode={episode} preview={episodePreviews.get(episode.id)}
              latest={episode.id === latestEpisodeId} onContinue={onContinue} />)}
          </ol>}
          {episodes.data?.length === 0 && <EmptyState icon={<Film size={20} strokeWidth={1.75} />} title="还没有分集" />}
        </section>
      </> : <>
        <header className="drama-library-heading">
          <h2 ref={worksHeading} id={`${id}-works-heading`} tabIndex={-1}>我的作品</h2>
          <search className="drama-library-controls" aria-label="作品搜索">
            <Field label="搜索作品">{field => <span className="search-field">
              <Search size={16} strokeWidth={1.5} aria-hidden="true" />
              <input {...field} ref={searchInput} type="search" maxLength={200} value={search} onChange={event => setSearch(event.target.value)} placeholder="作品名称或故事设定" />
            </span>}</Field>
            <div className="tabs" role="group" aria-label="作品筛选">
              <button type="button" aria-pressed={!archived} className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>可用</button>
              <button type="button" aria-pressed={archived} className={archived ? 'active' : ''} onClick={() => setArchived(true)}>已归档</button>
            </div>
          </search>
        </header>
        {library.error && <Notice kind="error">{library.error}<Button onClick={library.refresh}>重试读取作品</Button></Notice>}
        {library.busy && (!library.hasLoaded || library.stale) && <p className="drama-library__reading" role="status">正在读取作品…</p>}
        {values.length > 0 && <ul className="drama-work-list drama-library__works" role="list">
          {values.map(value => <WorkCard key={value.id} work={value} episodes={episodesByWork.get(value.id)}
            onOpen={() => setSelected(value)} onContinue={onContinue} />)}
        </ul>}
        {!values.length && library.hasLoaded && !library.error && !library.busy && <div className="drama-library__empty">
          <EmptyState icon={query ? <Search size={24} strokeWidth={1.75} /> : archived ? <Archive size={24} strokeWidth={1.75} /> : <Clapperboard size={24} strokeWidth={1.75} />}
            title={query ? '没有匹配的作品' : archived ? '没有归档作品' : '还没有作品'}>
            {query
              ? <Button onClick={() => { setSearch(''); searchInput.current?.focus(); }}>清除搜索作品</Button>
              : !archived && <Button variant="primary" onClick={() => { setView('dialogue'); returnToComposer(); }}>开始创作<ArrowRight size={16} aria-hidden="true" /></Button>}
          </EmptyState>
        </div>}
        {library.nextCursor !== null && !library.stale && <Button busy={library.loadingMore} disabled={!library.canLoadMore} onClick={() => void library.loadMore()}>
          <ChevronDown size={16} aria-hidden="true" />加载更多作品
        </Button>}
      </>}
    </section>
    {editing && <WorkEditor work={editing} workspace={workspace} action={action} onClose={() => setEditing(undefined)} onSaved={value => { setEditing(undefined); library.refresh(); setSelected(value); }} />}
    {creatingEpisode && work && <EpisodeCreator work={work} action={action} number={nextEpisodeNumber} onClose={() => setCreatingEpisode(false)} onCreated={project => { setCreatingEpisode(false); openCreated(project); }} />}
    {resetOpen && <Dialog title="新建对话" role="alertdialog" descriptionId={`${id}-reset`} initialFocus={keepDraft} onClose={() => setResetOpen(false)}>
      <div className="dialog__body"><p id={`${id}-reset`}>开始新对话会清空当前未创建的内容和创作设置。</p></div>
      <div className="dialog__footer">
        <Button ref={keepDraft} onClick={() => setResetOpen(false)}>保留当前草稿</Button>
        <Button variant="primary" onClick={resetComposer}>开始新对话</Button>
      </div>
    </Dialog>}
  </div>;
}

function UpdatedDate({ value }: { value: string }) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return <time dateTime={date.toISOString()}>更新于 {shortDate.format(date)}</time>;
}

type EpisodePreview = {
  project: ProjectSummary;
  shot: NonNullable<ProjectSummary['thumbnailShot']>;
  assets: NonNullable<ProjectSummary['thumbnailAsset']>[];
};

type WorkEpisodes = { count: number; latest?: ProjectSummary; cover?: EpisodePreview };

function readEpisodePreview(project: ProjectSummary): EpisodePreview | undefined {
  const shot = project.thumbnailShot;
  const asset = project.thumbnailAsset;
  if (!shot || shot.clipEdit || shot.sceneTemplate || !asset?.active || (asset.kind !== 'image' && asset.kind !== 'video')) return;
  return { project, shot, assets: [asset] };
}

function EpisodeFrame({ preview }: { preview: EpisodePreview }) {
  return <Suspense fallback={null}><WorkPreview {...preview} shotIndex={0} thumbnail hideTitle /></Suspense>;
}

function WorkCard({ work, episodes, onOpen, onContinue }: {
  work: DramaWork;
  episodes?: WorkEpisodes;
  onOpen(): void;
  onContinue(id: string): void;
}) {
  const id = useId();
  const { count = 0, latest, cover } = episodes ?? {};
  const episodeLabel = latest?.drama && `第 ${latest.drama.number} 集`;
  const episodeTitle = latest && episodeLabel && ![work.title, episodeLabel, `${work.title} · ${episodeLabel}`].includes(latest.title) ? latest.title : undefined;
  return <li>
    <article className="drama-work-card drama-library__card" aria-labelledby={id} data-work-id={work.id}>
      <div className="drama-library__cover">
        {cover ? <>
          <EpisodeFrame preview={cover} />
          {cover.project.id !== latest?.id && cover.project.drama &&
            <span className="drama-library__cover-label">第 {cover.project.drama.number} 集</span>}
        </> : <div className="drama-library__cover-empty">
          <Clapperboard size={26} strokeWidth={1.5} aria-hidden="true" />
          <span>暂无封面</span>
        </div>}
      </div>
      <header>
        <h3 id={id}>{work.title}</h3>
        <div className="drama-library__facts">
          <span>{count} 集</span>
          <span>{dramaVisualStyleLabels[work.visualStyle]}</span>
          <span>{dramaNarrativeModeLabels[work.narrativeMode]}</span>
        </div>
      </header>
      {(work.description || episodeLabel) && <div className="drama-library__card-content">
        {episodeLabel && <p className="drama-library__latest"><History size={14} aria-hidden="true" /><span>最近编辑 · {episodeLabel}</span>
          {episodeTitle && <strong>{episodeTitle}</strong>}
        </p>}
        {work.description && <p className="drama-library__summary">{work.description}</p>}
      </div>}
      <footer>
        <UpdatedDate value={latest && latest.updatedAt > work.updatedAt ? latest.updatedAt : work.updatedAt} />
        <div className="drama-library__card-actions">
          <Button static variant="ghost" className="drama-library__view-work" data-guide="project-open" aria-describedby={id} onClick={onOpen}>
            查看分集<ChevronRight size={16} aria-hidden="true" />
          </Button>
          {latest && !work.archived && <Button static className="drama-library__continue-work" aria-describedby={id} onClick={() => onContinue(latest.id)}>
            继续创作<ArrowRight size={16} aria-hidden="true" />
          </Button>}
        </div>
      </footer>
    </article>
  </li>;
}

function EpisodeRow({ episode, preview, latest, onContinue }: { episode: ProjectSummary; preview?: EpisodePreview; latest: boolean; onContinue(id: string): void }) {
  const id = useId();
  const number = episode.drama ? `第 ${episode.drama.number} 集` : undefined;
  return <li>
    <article className="drama-episode-row" data-project-id={episode.id} data-latest={latest || undefined}>
      <div className="drama-library__episode-main">
        {preview && <div className="drama-library__episode-preview"><EpisodeFrame preview={preview} /></div>}
        <div className="drama-library__episode-content">
          {number && episode.title !== number && <span className="drama-library__episode-number">{number}</span>}
          <div className="drama-library__episode-heading">
            <h4 id={id}>{episode.title}</h4>
            {latest && <span className="drama-library__episode-latest"><History size={13} aria-hidden="true" />最近编辑</span>}
          </div>
          {episode.brief && <p className="drama-library__summary">{episode.brief}</p>}
        </div>
      </div>
      <div className="drama-library__facts drama-library__episode-meta">
        {episode.archived && <span>已归档</span>}
        <span className="drama-library__shot-count"><Film size={14} strokeWidth={1.5} aria-hidden="true" />{episode.shotCount ? `${episode.shotCount} 镜` : '待分镜'}</span>
        {episode.drama && <>
          <span>{dramaVisualStyleLabels[episode.drama.visualStyle]}</span>
          <span>{dramaNarrativeModeLabels[episode.drama.narrativeMode]}</span>
        </>}
        <UpdatedDate value={episode.updatedAt} />
      </div>
      <Button static variant="ghost" data-guide="project-open" aria-describedby={id} disabled={episode.archived} onClick={() => onContinue(episode.id)}>
        打开分集<ChevronRight size={16} aria-hidden="true" />
      </Button>
    </article>
  </li>;
}

function WorkEditor({ work, workspace, action, onClose, onSaved }: { work: DramaWork; workspace: WorkspaceView; action: Action; onClose(): void; onSaved(work: DramaWork): void }) {
  const [value, setValue] = useState(() => ({ title: work.title, description: work.description, visualStyle: work.visualStyle, narrativeMode: work.narrativeMode, characterIds: work.characterIds, topicIds: work.topicIds, stylePresetId: work.stylePresetId, skillIds: work.skillIds }));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false);
  const [topicRecords, setTopicRecords] = useState<DramaTopic[]>([]);
  const [topicsOpen, setTopicsOpen] = useState(false), [topicsLoading, setTopicsLoading] = useState(Boolean(work.topicIds.length));
  const [topicError, setTopicError] = useState(''), [topicRead, setTopicRead] = useState(0);
  useEffect(() => {
    let active = true; setTopicsLoading(true); setTopicError('');
    void Promise.all(work.topicIds.map(topicId => rpc('dramaTopic.get', { topicId }).then(value => dramaTopicSchema.parse(value))))
      .then(values => { if (active) setTopicRecords(values); })
      .catch(reason => { if (active) setTopicError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setTopicsLoading(false); });
    return () => { active = false; };
  }, [work, topicRead]);
  const selectedTopics = topicRecords.filter(topic => value.topicIds.includes(topic.id));
  async function save() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { const result = await action<DramaWork>('dramaWork.save', { work: { ...value, ...(work ? { id: work.id, revision: work.revision } : {}) } }, '作品已保存'); if (result) onSaved(dramaWorkSchema.parse(result)); else setError('作品尚未保存，请核对提示后重试。'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <><Dialog title="编辑短剧作品" onClose={onClose} dismissDisabled={busy} dismissOnBackdrop={false} className="drama-editor"><form onSubmit={event => { event.preventDefault(); void save(); }}><div className="dialog__body form-stack">
    <Field label="作品名称" required><input name="title" required maxLength={160} value={value.title} disabled={busy} onChange={event => setValue({ ...value, title: event.target.value })} /></Field>
    <Field label="故事设定"><textarea name="description" rows={4} maxLength={30000} value={value.description} disabled={busy} onChange={event => setValue({ ...value, description: event.target.value })} /></Field>
    <Field label="画风"><Select value={value.stylePresetId ?? ''} disabled={busy} onChange={event => { const style = dramaStylePresets.find(style => style.id === event.target.value); setValue({ ...value, stylePresetId: style?.id, ...(style ? { visualStyle: style.visualStyle } : {}) }); }}><option value="">自由画风</option>{dramaStylePresets.map(style => <option key={style.id} value={style.id}>{style.name}</option>)}</Select></Field>
    <DramaModeFields {...value} disabled={busy} onChange={patch => setValue({ ...value, ...patch, ...(patch.visualStyle && dramaStylePresets.find(style => style.id === value.stylePresetId)?.visualStyle !== patch.visualStyle ? { stylePresetId: undefined } : {}) })} />
    <CharacterPicker label="作品共享角色" maximum={50} version={workspace.version} value={value.characterIds} disabled={busy} onChange={characterIds => setValue({ ...value, characterIds })} />
    <section className="drama-composer-topics"><div className="drama-section__heading"><h3>作品选题</h3><Button disabled={busy || topicsLoading || Boolean(topicError)} onClick={() => setTopicsOpen(true)}>打开作品选题库</Button></div><div className="drama-topic-selection">{selectedTopics.map(topic => <Button key={topic.id} variant="ghost" disabled={busy} aria-label={`移除作品选题：${topic.title}`} onClick={() => setValue({ ...value, topicIds: value.topicIds.filter(id => id !== topic.id) })}>{topic.title}{topic.archived && '（已归档）'} ×</Button>)}</div>{selectedTopics.some(topic => topic.archived) && <p className="field__hint">移除已归档选题，或在选题库恢复后继续使用。</p>}{topicError && <Notice kind="error">{topicError}<Button onClick={() => setTopicRead(current => current + 1)}>重试读取作品选题</Button></Notice>}</section>
    <SkillPicker label="作品创作 Skill" skills={workspace.skills} groups={workspace.skillGroups} value={value.skillIds} disabled={busy} onChange={skillIds => setValue({ ...value, skillIds })} />
    <p className="field__hint">用于新分集；已有分集保留原设置。</p>
    {error && <Notice kind="error">{error}</Notice>}
  </div><div className="dialog__footer"><Button disabled={busy} onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={busy}>保存作品</Button></div></form></Dialog>{topicsOpen && <DramaTopicsDialog value={selectedTopics} version={workspace.version} action={action} onClose={() => setTopicsOpen(false)} onChange={topics => { setTopicRecords(topics); setValue({ ...value, topicIds: topics.map(topic => topic.id) }); }} />}</>;
}

function EpisodeCreator({ work, number, action, onClose, onCreated }: { work: DramaWork; number: number; action: Action; onClose(): void; onCreated(project: ProjectDocument): void }) {
  const [title, setTitle] = useState(`第 ${Math.min(number, 100000)} 集`), [brief, setBrief] = useState(''), [episodeNumber, setEpisodeNumber] = useState(Math.min(number, 100000));
  const [novelSource, setNovelSource] = useState('');
  const [modes, setModes] = useState({ visualStyle: work.visualStyle, narrativeMode: work.narrativeMode });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const pending = useRef(false);
  async function create() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await action<ProjectDocument>('project.create', { title, brief, novelSource: novelSource.trim() || undefined,
        profile: { ...DEFAULT_VIDEO_PROFILE, width: 1080, height: 1920 }, drama: { workId: work.id, number: episodeNumber, ...modes, scenes: [] } }, '分集已创建');
      if (result) onCreated(result);
      else setError('分集尚未创建，请核对集数和提示后重试。');
    } finally { pending.current = false; setBusy(false); }
  }
  return <Dialog title="新建分集" onClose={onClose} dismissDisabled={busy} dismissOnBackdrop={false} className="drama-editor">
    <form onSubmit={event => { event.preventDefault(); void create(); }}>
      <div className="dialog__body form-stack">
        <Field label="分集名称" required><input name="title" required maxLength={160} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></Field>
        <Field label="集数" required hint={number > 100000 ? '默认序号已达上限，请填写一个未使用的集数。' : '同一作品中的集数不能重复，已归档分集也保留集数。'}><input name="number" type="number" required min={1} max={100000} step={1} value={episodeNumber} disabled={busy} onChange={event => setEpisodeNumber(Number(event.target.value))} /></Field>
        <Field label="本集故事"><textarea name="brief" rows={3} maxLength={30000} value={brief} disabled={busy} onChange={event => setBrief(event.target.value)} /></Field>
        <Field label="小说原文" hint="粘贴要改编的章节，即可用导演剧本流程制作本集。">{field => <textarea {...field} name="novelSource" rows={5} maxLength={MAX_NOVEL_SOURCE_LENGTH} value={novelSource} disabled={busy} onChange={event => setNovelSource(event.target.value)} />}</Field>
        <DramaModeFields {...modes} disabled={busy} onChange={patch => setModes({ ...modes, ...patch })} />
        {error && <Notice kind="error">{error}</Notice>}
      </div>
      <div className="dialog__footer"><Button disabled={busy} onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={busy}>创建分集</Button></div>
    </form>
  </Dialog>;
}
