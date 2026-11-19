import { lazy, Suspense, useDeferredValue, useEffect, useRef, useState } from 'react';
import { Archive, ArrowLeft, ChevronDown, Clapperboard, Pencil, Plus, RotateCcw, Sparkles } from 'lucide-react';
import { DEFAULT_VIDEO_PROFILE, dramaNarrativeModeLabels, dramaStylePresets, dramaTopicSchema, dramaVisualStyleLabels, dramaWorkSchema, projectSummarySchema, recordPageSchema, type DramaTopic, type DramaWork, type ProjectDocument } from '@video-quickly/contracts';
import { Button, Dialog, EmptyState, Field, Notice, Select } from '../components/Primitives';
import { CharacterPicker } from '../components/CharacterPicker';
import { useRecordPage } from '../lib/use-record-page';
import { useRuntimeRead } from '../lib/use-runtime-read';
import type { Action, WorkspaceView } from '../lib/types';
import SkillPicker from '../components/SkillPicker';
import DramaCreationComposer, { type DramaCreationRequest } from './DramaCreationComposer';
import DramaTopicsDialog from './DramaTopicsDialog';
import { rpc } from '../lib/client';
import './drama.css';

const workPage = recordPageSchema(dramaWorkSchema);
const episodesSchema = projectSummarySchema.array();
const CreativePlanningDialog = lazy(() => import('./CreativePlanningDialog'));

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

export default function DramaWorksPage({ workspace, action, onOpen, creationRequest }: { workspace: WorkspaceView; action: Action; onOpen(id: string, editStoryboard?: boolean): void; creationRequest?: DramaCreationRequest }) {
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search.trim());
  const searchInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<DramaWork>();
  const [editing, setEditing] = useState<DramaWork>();
  const [creatingEpisode, setCreatingEpisode] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (creationRequest) setSelected(undefined); }, [creationRequest]);
  const library = useRecordPage('dramaWork.list', { archived, search: query, limit: 20 }, workspace.version, workPage);
  const detail = useRuntimeRead('dramaWork.get', { workId: selected?.id }, workspace.version, dramaWorkSchema, Boolean(selected));
  const episodes = useRuntimeRead('dramaWork.episodes', { workId: selected?.id }, workspace.version, episodesSchema, Boolean(selected));
  const work = selected ? detail.data ?? selected : undefined;
  const values = library.stale ? [] : library.items;
  const nextEpisodeNumber = (episodes.data ?? []).reduce((maximum, episode) => Math.max(maximum, episode.drama?.number ?? 0), 0) + 1;
  async function archive(value: DramaWork) {
    if (busy) return;
    setBusy(true); setFailure('');
    const result = await action<DramaWork>(value.archived ? 'dramaWork.restore' : 'dramaWork.archive', { workId: value.id, revision: value.revision }, value.archived ? '作品已恢复' : '作品已归档');
    if (result) { library.refresh(); if (selected?.id === value.id) setSelected(result); }
    else setFailure('操作尚未完成，作品内容已保留，请核对提示后重试。');
    setBusy(false);
  }
  return <div className="content-page drama-library">
    <header className="page-heading"><div>{work && <Button variant="ghost" onClick={() => setSelected(undefined)}><ArrowLeft size={15} aria-hidden="true" />短剧工作室</Button>}<h1>{work?.title ?? '短剧工作室'}</h1></div>
      {work ? <div className="heading-actions"><Button onClick={() => setEditing(work)} disabled={busy || work.archived}><Pencil size={15} aria-hidden="true" />编辑作品</Button><Button variant="primary" onClick={() => setCreatingEpisode(true)} disabled={work.archived}><Plus size={15} aria-hidden="true" />新建分集</Button></div>
        : <Button aria-haspopup="dialog" onClick={() => setPlanning(true)}><Sparkles size={16} aria-hidden="true" />创作分镜</Button>}
    </header>
    {failure && <Notice kind="error">{failure}</Notice>}
    <div hidden={Boolean(work)}><DramaCreationComposer workspace={workspace} action={action} request={work ? undefined : creationRequest} onCreated={project => { library.refresh(); onOpen(project.id); }} /></div>
    {work ? <>
      {detail.error && <Notice kind="error">{detail.error}<Button onClick={detail.refresh}>重试读取作品</Button></Notice>}
      <div className="drama-work-overview" data-guide-loading={(!episodes.data || episodes.busy) && !episodes.error || undefined}>{work.description && <p>{work.description}</p>}<div className="pill-row"><span className="pill">{dramaVisualStyleLabels[work.visualStyle]}</span><span className="pill">{dramaNarrativeModeLabels[work.narrativeMode]}</span><span className="pill">{work.characterIds.length} 个共享角色</span>{work.archived && <span className="pill">已归档</span>}</div></div>
      <div className="panel-heading"><h2>分集</h2><Button disabled={busy} onClick={() => void archive(work)}>{work.archived ? <RotateCcw size={15} /> : <Archive size={15} />}{work.archived ? '恢复作品' : '归档作品'}</Button></div>
      {episodes.error && <Notice kind="error">{episodes.error}<Button onClick={episodes.refresh}>重试读取分集</Button></Notice>}
      {episodes.busy && !episodes.data && <p role="status">正在读取分集…</p>}
      <div className="drama-episode-list">{episodes.data?.map(episode => <article className="drama-episode-row" data-project-id={episode.id} key={episode.id}><div>{episode.drama && <span className="tiny-meta">第 {episode.drama.number} 集</span>}<h3>{episode.title}</h3>{episode.brief && <p>{episode.brief}</p>}{episode.drama && <div className="pill-row"><span className="pill">{dramaVisualStyleLabels[episode.drama.visualStyle]}</span><span className="pill">{dramaNarrativeModeLabels[episode.drama.narrativeMode]}</span></div>}{episode.archived && <span className="tiny-meta">已归档</span>}</div><Button data-guide="project-open" disabled={episode.archived} onClick={() => onOpen(episode.id)}>打开分集</Button></article>)}</div>
      {episodes.data?.length === 0 && <EmptyState icon={<Clapperboard size={25} />} title="还没有分集" />}
    </> : <>
      <div className="drama-library-heading">
        <h2>我的作品</h2>
        <search className="drama-library-controls" aria-label="作品搜索">
          <Field label="搜索作品"><input ref={searchInput} type="search" maxLength={200} value={search} onChange={event => setSearch(event.target.value)} placeholder="作品名称或故事设定" /></Field>
          <div className="tabs" role="group" aria-label="作品筛选">
            <button type="button" aria-pressed={!archived} className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>可用</button>
            <button type="button" aria-pressed={archived} className={archived ? 'active' : ''} onClick={() => setArchived(true)}>已归档</button>
          </div>
        </search>
      </div>
      {library.error && <Notice kind="error">{library.error}<Button onClick={library.refresh}>重试读取作品</Button></Notice>}
      {library.busy && !library.hasLoaded && <p role="status">正在读取作品…</p>}
      <div className="drama-work-list">{values.map(value => <article className="drama-work-card" data-work-id={value.id} key={value.id}><Clapperboard size={21} aria-hidden="true" /><h2>{value.title}</h2>{value.description && <p>{value.description}</p>}<div className="pill-row"><span className="pill">{dramaVisualStyleLabels[value.visualStyle]}</span><span className="pill">{dramaNarrativeModeLabels[value.narrativeMode]}</span></div><Button data-guide="project-open" onClick={() => setSelected(value)}>查看分集</Button></article>)}</div>
      {!values.length && library.hasLoaded && !library.error && !library.busy && <EmptyState icon={<Clapperboard size={25} />} title={query ? '没有匹配的作品' : archived ? '没有归档作品' : '还没有作品'}>{query && <Button onClick={() => { setSearch(''); searchInput.current?.focus(); }}>清除搜索作品</Button>}</EmptyState>}
      {library.nextCursor !== null && <Button busy={library.loadingMore} onClick={() => void library.loadMore()}><ChevronDown size={15} />加载更多作品</Button>}
    </>}
    {editing && <WorkEditor work={editing} workspace={workspace} action={action} onClose={() => setEditing(undefined)} onSaved={value => { setEditing(undefined); library.refresh(); setSelected(value); }} />}
    {creatingEpisode && work && <EpisodeCreator work={work} action={action} number={nextEpisodeNumber} onClose={() => setCreatingEpisode(false)} onCreated={project => { setCreatingEpisode(false); onOpen(project.id); }} />}
    {planning && <Suspense fallback={<p role="status">正在打开分镜创作…</p>}>
      <CreativePlanningDialog workspace={workspace} action={action} onClose={() => setPlanning(false)} onEdit={projectId => { setPlanning(false); onOpen(projectId, true); }} />
    </Suspense>}
  </div>;
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
  const [modes, setModes] = useState({ visualStyle: work.visualStyle, narrativeMode: work.narrativeMode });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const pending = useRef(false);
  return <Dialog title="新建分集" onClose={onClose} dismissDisabled={busy} dismissOnBackdrop={false} className="drama-editor"><form onSubmit={event => {
    event.preventDefault(); if (pending.current) return; pending.current = true; setBusy(true); setError('');
    void action<ProjectDocument>('project.create', { title, brief, profile: { ...DEFAULT_VIDEO_PROFILE, width: 1080, height: 1920 }, drama: { workId: work.id, number: episodeNumber, ...modes, scenes: [] } }, '分集已创建').then(result => { if (result) onCreated(result); else setError('分集尚未创建，请核对集数和提示后重试。'); }).finally(() => { pending.current = false; setBusy(false); });
  }}><div className="dialog__body form-stack"><Field label="分集名称" required><input name="title" required maxLength={160} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></Field><Field label="集数" required hint={number > 100000 ? '默认序号已达上限，请填写一个未使用的集数。' : '同一作品中的集数不能重复，已归档分集也保留集数。'}><input name="number" type="number" required min={1} max={100000} step={1} value={episodeNumber} disabled={busy} onChange={event => setEpisodeNumber(Number(event.target.value))} /></Field><Field label="本集故事"><textarea name="brief" rows={4} maxLength={30000} value={brief} disabled={busy} onChange={event => setBrief(event.target.value)} /></Field><DramaModeFields {...modes} disabled={busy} onChange={patch => setModes({ ...modes, ...patch })} />{error && <Notice kind="error">{error}</Notice>}</div><div className="dialog__footer"><Button disabled={busy} onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={busy}>创建分集</Button></div></form></Dialog>;
}
