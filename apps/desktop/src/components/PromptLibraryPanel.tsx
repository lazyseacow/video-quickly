import { useEffect, useRef, useState } from 'react';
import { applyPromptLibraryItem, promptLibraryItemSchema, recordPageSchema, type PromptLibraryItem, type WorkflowNode } from '@video-quickly/contracts';
import { rpc } from '../lib/client';
import { Button, Field, Notice, Select } from './Primitives';

const kinds = [{ id: 'brief', name: '简报' }, { id: 'style', name: '风格' }, { id: 'script', name: '分镜' }, { id: 'assets', name: '图片' }, { id: 'animation', name: '视频' }] as const;
export default function PromptLibraryPanel({ node, readNode, onChange, version }: { node: WorkflowNode; readNode(): WorkflowNode; onChange(node: WorkflowNode): void; version: number }) {
  const [items, setItems] = useState<PromptLibraryItem[]>([]), [cursor, setCursor] = useState<number | null>(null);
  const [selected, setSelected] = useState<PromptLibraryItem>(), [name, setName] = useState(''), [kind, setKind] = useState<'template' | 'snippet'>('template');
  const [nodeKinds, setNodeKinds] = useState<WorkflowNode['kind'][]>([node.kind]);
  const [favorite, setFavorite] = useState(false), [archived, setArchived] = useState(false), [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const inFlight = useRef(false);
  useEffect(() => {
    let current = true; setError('');
    void rpc('promptLibrary.list', { nodeKind: node.kind, favorite: favorite || undefined, archived, limit: 50 }).then(value => {
      const page = recordPageSchema(promptLibraryItemSchema).parse(value);
      if (current) { setItems(page.items); setCursor(page.nextCursor); }
    }).catch(error => { if (current) setError(error instanceof Error ? error.message : String(error)); });
    return () => { current = false; };
  }, [node.kind, favorite, archived, version, refresh]);
  async function perform(work: () => Promise<void>) {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function save(update: boolean) {
    const value = readNode();
    const next = promptLibraryItemSchema.parse(await rpc('promptLibrary.save', { id: update ? selected?.id : undefined, revision: update ? items.find(item => item.id === selected?.id)?.revision : undefined, name, kind, prompt: value.prompt, bindings: value.promptBindings, nodeKinds }));
    setSelected(next); setRefresh(value => value + 1); setNotice(`已保存${kind === 'template' ? '模板' : '片段'} v${next.version}。`);
  }
  function select(item?: PromptLibraryItem) { setSelected(item); if (item) { setName(item.name); setKind(item.kind); setNodeKinds(item.nodeKinds); } setError(''); setNotice(''); }
  const latest = items.find(item => item.id === selected?.id);
  return <div className="prompt-workbench__columns"><section aria-label="提示词库">
    <div className="prompt-workbench__actions"><label><input type="checkbox" checked={favorite} onChange={event => { setFavorite(event.target.checked); setSelected(undefined); }} />仅收藏</label><label><input type="checkbox" checked={archived} onChange={event => { setArchived(event.target.checked); setSelected(undefined); }} />已归档</label></div>
    <Field label="模板或快捷片段"><Select value={selected?.id ?? ''} onChange={event => select(items.find(item => item.id === event.target.value))}><option value="">选择或新建</option>{items.map(item => <option key={item.id} value={item.id}>{item.favorite ? '★ ' : ''}{item.kind === 'template' ? '模板' : '片段'} · {item.name} · v{item.version}</option>)}</Select></Field>
    {cursor !== null && <Button busy={busy} onClick={() => void perform(async () => { const page = recordPageSchema(promptLibraryItemSchema).parse(await rpc('promptLibrary.list', { nodeKind: node.kind, favorite: favorite || undefined, archived, before: cursor, limit: 50 })); setItems(items => [...items, ...page.items]); setCursor(page.nextCursor); })}>加载更多提示词</Button>}
    {selected && <><Field label="固定版本"><Select value={selected.version} onChange={event => void perform(async () => { setSelected(promptLibraryItemSchema.parse(await rpc('promptLibrary.get', { id: selected.id, version: Number(event.target.value) }))); })}>{Array.from({ length: latest?.version ?? selected.version }, (_, index) => <option key={index + 1} value={index + 1}>v{index + 1}</option>)}</Select></Field><pre className="prompt-library__content" tabIndex={0}>{selected.prompt}</pre>
      <div className="prompt-workbench__actions"><Button disabled={busy || Boolean(latest?.archived)} onClick={() => { try { onChange(applyPromptLibraryItem(readNode(), selected, 'replace')); setNotice('已替换实验草稿。'); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } }}>替换草稿</Button><Button disabled={busy || Boolean(latest?.archived)} onClick={() => { try { onChange(applyPromptLibraryItem(readNode(), selected, 'append')); setNotice('已追加到实验草稿。'); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } }}>追加到草稿</Button>
        {latest && <><Button busy={busy} onClick={() => void perform(async () => { await rpc('promptLibrary.update', { id: latest.id, revision: latest.revision, favorite: !latest.favorite }); setRefresh(value => value + 1); })}>{latest.favorite ? '取消收藏' : '收藏'}</Button><Button disabled={busy} onClick={() => void perform(async () => { await rpc('promptLibrary.update', { id: latest.id, revision: latest.revision, archived: !latest.archived }); setSelected(undefined); setRefresh(value => value + 1); })}>{latest.archived ? '恢复' : '归档'}</Button></>}
      </div></>}
    {!items.length && <p className="muted">当前任务还没有{favorite ? '收藏的' : ''}提示词。可将右侧草稿保存为模板或快捷片段。</p>}
  </section><section aria-label="保存可复用提示词"><h3>保存当前草稿</h3><p className="muted">模板与片段各自保留固定版本，保存后可在其他任务中选用。</p>
    <Field label="提示词名称"><input value={name} maxLength={120} onChange={event => setName(event.target.value)} /></Field><Field label="提示词类型"><Select value={kind} disabled={Boolean(selected)} onChange={event => setKind(event.target.value as typeof kind)}><option value="template">完整模板</option><option value="snippet">快捷片段</option></Select></Field>
    <fieldset className="prompt-workbench__kinds"><legend>适用任务</legend>{kinds.map(kind => <label key={kind.id}><input type="checkbox" checked={nodeKinds.includes(kind.id)} onChange={event => setNodeKinds(value => event.target.checked ? [...value, kind.id] : value.filter(id => id !== kind.id))} />{kind.name}</label>)}</fieldset>
    <div className="prompt-workbench__actions"><Button busy={busy} disabled={!name.trim() || !nodeKinds.length} onClick={() => void perform(() => save(false))}>另存为新提示词</Button>{selected && <Button disabled={busy || !name.trim() || !nodeKinds.length} onClick={() => void perform(() => save(true))}>保存新版本</Button>}</div>
    {error && <Notice kind="error">{error}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}
  </section></div>;
}
