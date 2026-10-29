import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Pencil, Plus, RotateCcw, Trash2, Upload, Users } from 'lucide-react';
import { assetListItemSchema, assetSchema, characterProfileSchema, recordPageSchema, type AssetRecord, type CharacterProfile } from '@video-quickly/contracts';
import { Button, Dialog, EmptyState, Field, IconButton, Notice } from '../components/Primitives';
import PathPicker from '../components/PathPicker';
import { getAssetUrl, rpc } from '../lib/client';
import { useRecordPage } from '../lib/use-record-page';
import type { Action, WorkspaceView } from '../lib/types';
import './characters.css';

const characterPage = recordPageSchema(characterProfileSchema);
const imagePage = recordPageSchema(assetListItemSchema);

export default function CharactersPage({ workspace, action }: { workspace: WorkspaceView; action: Action }) {
  const [archived, setArchived] = useState(false);
  const library = useRecordPage('character.list', { archived, limit: 20 }, workspace.version, characterPage);
  const [editing, setEditing] = useState<CharacterProfile | 'new'>();
  const [error, setError] = useState('');
  async function changeArchive(character: CharacterProfile) {
    setError('');
    try { await rpc(archived ? 'character.restore' : 'character.archive', { characterId: character.id, revision: character.revision }); library.refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  return <div className="content-page"><div className="page-heading"><div><h1>角色参考库</h1><p>保存人物设定与参考图，在镜头中选择后用于生成。</p></div><Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} />新建角色</Button></div>
    <div className="page-toolbar"><div className="tabs"><button type="button" className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>可用角色</button><button type="button" className={archived ? 'active' : ''} onClick={() => setArchived(true)}>已归档</button></div></div>
    {(library.error || error) && <Notice kind="error">{library.error || error}</Notice>}
    <div className="character-cards">{library.items.map(character => <article className="character-card" key={character.id}><CharacterThumbnail character={character} /><div className="character-card__body"><h3>{character.name}</h3><p>{character.description || '尚未填写角色设定'}</p><span className="tiny-meta">{character.referenceAssetIds.length} 张参考图 · 修订 {character.revision}</span><div className="character-card__actions"><Button onClick={() => setEditing(character)}><Pencil size={14} />编辑角色</Button><IconButton label={`${archived ? '恢复' : '归档'}角色：${character.name}`} onClick={() => void changeArchive(character)}>{archived ? <RotateCcw size={15} /> : <Trash2 size={15} />}</IconButton></div></div></article>)}</div>
    {!library.items.length && !library.busy && !library.error && <EmptyState icon={<Users size={25} />} title={archived ? '没有归档角色' : '建立你的角色参考'} description="填写外形、服饰与性格，最多添加四张公共参考图。角色可以在多个项目中复用。" />}
    {library.nextCursor !== null && <Button busy={library.busy} onClick={() => void library.loadMore()}><ChevronDown size={15} />加载更多角色</Button>}
    {editing && <CharacterEditor character={editing === 'new' ? undefined : editing} version={workspace.version} action={action} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); library.refresh(); }} />}
  </div>;
}

function CharacterThumbnail({ character }: { character: CharacterProfile }) {
  const container = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setUrl(''); setError('');
    const element = container.current;
    if (!element || !character.referenceAssetIds.length) return;
    let active = true, requested = false;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting) || requested) return;
      requested = true; observer.disconnect();
      void rpc<unknown>('character.references', { characterId: character.id }).then(value => assetSchema.array().parse(value)).then(assets => assets[0] ? getAssetUrl(assets[0].path) : '')
        .then(value => { if (active) setUrl(value); }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    }, { rootMargin: '160px' });
    observer.observe(element);
    return () => { active = false; observer.disconnect(); };
  }, [character.id, character.revision]);
  return <div ref={container} className="character-card__thumbnail">{url ? <img src={url} alt={`${character.name}参考图`} onError={() => { setUrl(''); setError('参考图无法读取'); }} /> : <Users size={28} aria-hidden="true" />}{error && <span className="field-error">{error}</span>}</div>;
}

function CharacterEditor({ character, version, action, onClose, onSaved }: { character?: CharacterProfile; version: number; action: Action; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(character?.name ?? '');
  const [description, setDescription] = useState(character?.description ?? '');
  const [referenceAssetIds, setReferenceAssetIds] = useState(character?.referenceAssetIds ?? []);
  const [selectedAssets, setSelectedAssets] = useState<AssetRecord[]>([]);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const images = useRecordPage('asset.list', { kind: 'image', limit: 30 }, version, imagePage);
  useEffect(() => {
    if (!character) return;
    let active = true;
    void rpc<unknown>('character.references', { characterId: character.id }).then(value => assetSchema.array().parse(value)).then(values => { if (active) setSelectedAssets(values); }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [character?.id]);
  const assets = [...new Map([...selectedAssets, ...images.items.filter(asset => !asset.projectId)].map(asset => [asset.id, asset])).values()];
  function toggle(id: string) { setReferenceAssetIds(ids => ids.includes(id) ? ids.filter(value => value !== id) : ids.length < 4 ? [...ids, id] : ids); }
  async function importImage() {
    setBusy(true); setError('');
    try {
      const asset = await action<AssetRecord>('asset.import', { path, kind: 'image' });
      if (!asset) { setError('参考图未导入，请核对文件路径。'); return; }
      setSelectedAssets(values => [...values, asset]); setReferenceAssetIds(ids => [...ids, asset.id]); setPath(''); images.refresh();
    } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError('');
    try { await rpc('character.save', { character: { id: character?.id, revision: character?.revision, name, description, referenceAssetIds } }); onSaved(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <Dialog title={character ? '编辑角色' : '新建角色'} onClose={onClose} className="character-editor"><form onSubmit={event => { event.preventDefault(); void save(); }}><div className="dialog__body">
    <Field label="角色名称"><input required autoFocus maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></Field>
    <Field label="角色设定"><textarea maxLength={10000} rows={4} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} placeholder="外形、服饰、性格与需要保持的细节…" /></Field>
    <fieldset className="capability-fieldset"><legend>参考图片（最多 4 张）</legend><div className="character-image-picker">{assets.map(asset => <label key={asset.id}><input type="checkbox" checked={referenceAssetIds.includes(asset.id)} disabled={busy || !referenceAssetIds.includes(asset.id) && referenceAssetIds.length >= 4} onChange={() => toggle(asset.id)} /><ReferenceImage asset={asset} /><span>{asset.name}</span></label>)}</div>
      {images.error && <Notice kind="error">{images.error}</Notice>}{images.nextCursor !== null && <Button busy={images.busy} onClick={() => void images.loadMore()}>加载更多公共图片</Button>}
      <p className="tiny-meta">角色使用公共素材，可跨项目复用；项目私有图片请通过下方重新导入。</p>
      <Field label="角色参考图路径"><PathPicker label="角色参考图路径" value={path} onChange={setPath} extensions={['png', 'jpg', 'jpeg', 'webp']} disabled={busy} /></Field><Button disabled={!path || referenceAssetIds.length >= 4} busy={busy} onClick={() => void importImage()}><Upload size={14} />导入参考图片</Button>
    </fieldset>{error && <Notice kind="error">{error}</Notice>}
  </div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={!name.trim()} busy={busy}>保存角色</Button></div></form></Dialog>;
}

function ReferenceImage({ asset }: { asset: AssetRecord }) {
  const [source, setSource] = useState<{ id: string; url?: string; error?: string }>();
  useEffect(() => { let active = true; void getAssetUrl(asset.path).then(url => { if (active) setSource({ id: asset.id, url }); }).catch(error => { if (active) setSource({ id: asset.id, error: error instanceof Error ? error.message : String(error) }); }); return () => { active = false; }; }, [asset.id, asset.path]);
  return source?.id === asset.id && source.url ? <img src={source.url} alt={asset.name} loading="lazy" onError={() => setSource({ id: asset.id, error: '参考图无法读取' })} /> : <span className="tiny-meta">{source?.id === asset.id && source.error ? source.error : '读取中…'}</span>;
}

export function CharacterPicker({ value = [], version, onChange, disabled = false }: { value?: string[]; version: number; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const library = useRecordPage('character.list', { archived: false, limit: 20 }, version, characterPage);
  const [selected, setSelected] = useState<CharacterProfile[]>([]);
  const [error, setError] = useState('');
  const selectedKey = JSON.stringify(value);
  useEffect(() => {
    let active = true; setError('');
    void Promise.all(value.map(characterId => rpc<unknown>('character.get', { characterId }).then(item => characterProfileSchema.parse(item)))).then(items => { if (active) setSelected(items); }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [selectedKey, version]);
  const profiles = [...new Map([...selected, ...library.items].map(character => [character.id, character])).values()];
  return <fieldset className="character-shot-picker capability-fieldset"><legend>镜头角色</legend>{profiles.map(character => <label key={character.id} className="field-inline"><input type="checkbox" checked={value.includes(character.id)} disabled={disabled || !value.includes(character.id) && (character.archived || value.length >= 8)} onChange={event => onChange(event.target.checked ? [...value, character.id] : value.filter(id => id !== character.id))} />{character.name}{character.archived ? '（已归档）' : ''}</label>)}{!profiles.length && !library.busy && <p className="tiny-meta">在角色参考库创建角色后，可在此选择。</p>}{(library.error || error) && <Notice kind="error">{library.error || error}</Notice>}{library.nextCursor !== null && <Button busy={library.busy} onClick={() => void library.loadMore()}>加载更多角色</Button>}</fieldset>;
}
