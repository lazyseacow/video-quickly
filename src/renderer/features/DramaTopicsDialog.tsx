import { useDeferredValue, useId, useRef, useState } from 'react';
import { Archive, ChevronDown, Pencil, Plus, RotateCcw, Search } from 'lucide-react';
import { dramaTopicSchema, recordPageSchema, type DramaTopic } from '@video-quickly/contracts';
import { Button, Dialog, EmptyState, Field, IconButton, Notice } from '../components/Primitives';
import { useRecordPage } from '../lib/use-record-page';
import type { Action } from '../lib/types';

const topicPageSchema = recordPageSchema(dramaTopicSchema);

export default function DramaTopicsDialog({ value, version, action, onClose, onChange }: {
  value: DramaTopic[]; version: number; action: Action; onClose(): void; onChange(topics: DramaTopic[]): void;
}) {
  const id = useId();
  const [selection, setSelection] = useState(value);
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search.trim());
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<DramaTopic | 'new'>();
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);
  const library = useRecordPage('dramaTopic.list', { archived, search: query, limit: 30 }, version, topicPageSchema);
  const items = library.stale ? [] : library.items;
  function toggle(topic: DramaTopic) {
    setError('');
    if (selection.some(item => item.id === topic.id)) setSelection(selection.filter(item => item.id !== topic.id));
    else if (selection.length < 20) setSelection([...selection, topic]);
    else setError('每部作品最多选择 20 个选题，请先移除一个选题。');
  }
  async function changeArchive(topic: DramaTopic) {
    if (pending.current) return;
    pending.current = true; setBusyId(topic.id); setError('');
    try {
      const result = await action<DramaTopic>(topic.archived ? 'dramaTopic.restore' : 'dramaTopic.archive', { topicId: topic.id, revision: topic.revision }, topic.archived ? '选题已恢复' : '选题已归档');
      if (result) { library.refresh(); if (!topic.archived) setSelection(current => current.filter(item => item.id !== topic.id)); }
      else setError('选题尚未更新，请核对提示后重试。');
    } finally { pending.current = false; setBusyId(''); }
  }
  return <>
    <Dialog title="选题库" className="drama-topics-dialog" onClose={onClose} dismissDisabled={Boolean(busyId)}>
      <div className="dialog__body form-stack">
        <div className="drama-topic-toolbar">
          <Field label="搜索选题">{field => <span className="search-field"><Search size={16} aria-hidden="true" /><input {...field} name="topic-search" type="search" maxLength={200} value={search} onChange={event => setSearch(event.target.value)} placeholder="名称、故事梗概或标签" /></span>}</Field>
          <Button onClick={() => setEditing('new')}><Plus size={15} aria-hidden="true" />新建选题</Button>
        </div>
        <div className="tabs" role="group" aria-label="选题筛选">
          <button type="button" aria-pressed={!archived} className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>可用选题</button>
          <button type="button" aria-pressed={archived} className={archived ? 'active' : ''} onClick={() => setArchived(true)}>已归档</button>
        </div>
        {selection.length > 0 && <div className="drama-topic-selection" role="group" aria-label="已选选题">{selection.map(topic => <Button key={topic.id} variant="ghost" aria-label={`移除选题：${topic.title}`} onClick={() => setSelection(selection.filter(item => item.id !== topic.id))}>{topic.title} ×</Button>)}</div>}
        {error && <Notice kind="error">{error}</Notice>}
        {library.error && <Notice kind="error">{library.error}<Button onClick={library.refresh}>重试读取选题</Button></Notice>}
        {library.busy && !library.hasLoaded && <p role="status">正在读取选题…</p>}
        <div className="drama-topic-list" aria-busy={library.busy || search.trim() !== query}>
          {items.map((topic, index) => <article key={topic.id} className="drama-topic-card">
            <label className="drama-topic-choice">
              <input type="checkbox" aria-labelledby={`${id}-title-${index}`} aria-describedby={`${id}-logline-${index}`} checked={selection.some(item => item.id === topic.id)} disabled={archived || Boolean(busyId)} onChange={() => toggle(topic)} />
              <span><strong id={`${id}-title-${index}`}>{topic.title}</strong><span id={`${id}-logline-${index}`} className="drama-topic-logline">{topic.logline}</span></span>
            </label>
            {topic.description && <details><summary>故事设定</summary><p>{topic.description}</p></details>}
            {topic.tags.length > 0 && <div className="pill-row">{topic.tags.map(tag => <span key={tag} className="pill">{tag}</span>)}</div>}
            <div className="drama-topic-actions">{!archived && <IconButton label={`编辑选题：${topic.title}`} disabled={Boolean(busyId)} onClick={() => setEditing(topic)}><Pencil size={15} /></IconButton>}<IconButton label={`${archived ? '恢复' : '归档'}选题：${topic.title}`} busy={busyId === topic.id} disabled={Boolean(busyId)} onClick={() => void changeArchive(topic)}>{archived ? <RotateCcw size={15} /> : <Archive size={15} />}</IconButton></div>
          </article>)}
        </div>
        {!items.length && library.hasLoaded && !library.error && !library.busy && <EmptyState icon={<Search size={23} />} title={search.trim() ? '没有匹配的选题' : archived ? '没有归档选题' : '选题库还是空的'} description={search.trim() ? '换一个关键词，或清空搜索查看全部选题。' : undefined} />}
        {library.nextCursor !== null && <Button busy={library.loadingMore} disabled={!library.canLoadMore} onClick={() => void library.loadMore()}><ChevronDown size={15} />加载更多选题</Button>}
      </div>
      <div className="dialog__footer"><span className="tiny-meta">已选 {selection.length} / 20</span><Button disabled={Boolean(busyId)} onClick={onClose}>取消</Button><Button variant="primary" disabled={Boolean(busyId)} onClick={() => { onChange(selection); onClose(); }}>使用所选选题</Button></div>
    </Dialog>
    {editing && <TopicEditor topic={editing === 'new' ? undefined : editing} action={action} onClose={() => setEditing(undefined)} onSaved={topic => { library.refresh(); setEditing(undefined); setSelection(current => current.some(item => item.id === topic.id) ? current.map(item => item.id === topic.id ? topic : item) : current); }} />}
  </>;
}

function TopicEditor({ topic, action, onClose, onSaved }: { topic?: DramaTopic; action: Action; onClose(): void; onSaved(topic: DramaTopic): void }) {
  const [title, setTitle] = useState(topic?.title ?? '');
  const [logline, setLogline] = useState(topic?.logline ?? '');
  const [description, setDescription] = useState(topic?.description ?? '');
  const [tags, setTags] = useState(topic?.tags.join('，') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  async function save() {
    if (pending.current) return;
    const values = [...new Set(tags.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean))];
    if (values.length > 20 || values.some(tag => tag.length > 40)) { setError('最多填写 20 个标签，每个标签不超过 40 个字符。'); return; }
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await action<DramaTopic>('dramaTopic.save', { topic: { ...(topic ? { id: topic.id, revision: topic.revision } : {}), title, logline, description, tags: values } }, '选题已保存');
      if (result) onSaved(dramaTopicSchema.parse(result)); else setError('选题尚未保存，请核对提示后重试。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Dialog title={topic ? '编辑选题' : '新建选题'} className="drama-editor" onClose={onClose} dismissDisabled={busy} dismissOnBackdrop={false}><form onSubmit={event => { event.preventDefault(); void save(); }}><div className="dialog__body form-stack">
    <Field label="选题名称" required><input name="title" required maxLength={160} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></Field>
    <Field label="一句话故事" required><textarea name="logline" required rows={3} maxLength={1000} value={logline} disabled={busy} onChange={event => setLogline(event.target.value)} /></Field>
    <Field label="故事设定"><textarea name="description" rows={5} maxLength={20000} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} /></Field>
    <Field label="标签" hint="逗号分隔；最多 20 个，每个不超过 40 字符。"><input name="tags" maxLength={1000} value={tags} disabled={busy} onChange={event => setTags(event.target.value)} /></Field>
    {error && <Notice kind="error">{error}</Notice>}
  </div><div className="dialog__footer"><Button disabled={busy} onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={busy}>保存选题</Button></div></form></Dialog>;
}
