import { useEffect, useRef, useState, type ReactNode } from 'react';
import { RotateCcw, Trash2, Users, Plus, ChevronDown, Upload, Sparkles, Pencil } from 'lucide-react';
import { assetListItemSchema, assetSchema, CHARACTER_REFERENCE_VIEW_LABELS, characterProfileSchema, getMediaAdapters, recordPageSchema, type AssetRecord, type CharacterProfile, type ModelProfile } from '@video-quickly/contracts';
import { Button, Dialog, EmptyState, Field, IconButton, Notice, Select } from '../components/Primitives';
import { useChargeRpc, useConfirmation } from '../components/ConfirmationDialog';
import PathPicker from '../components/PathPicker';
import { getAssetUrl, rpc } from '../lib/client';
import { useRecordPage } from '../lib/use-record-page';
import type { Action, WorkspaceView } from '../lib/types';
import './characters.css';

const characterPage = recordPageSchema(characterProfileSchema);
const imagePage = recordPageSchema(assetListItemSchema);

export default function CharactersPage({ workspace, action }: { workspace: WorkspaceView; action: Action }) {
  const confirm = useConfirmation();
  const [archived, setArchived] = useState(false);
  const library = useRecordPage('character.list', { archived, limit: 20 }, workspace.version, characterPage);
  const characters = library.stale ? [] : library.items;
  const loading = !characters.length && !library.error && (library.busy || !library.hasLoaded);
  const [editing, setEditing] = useState<CharacterProfile | 'new'>();
  const [error, setError] = useState('');
  async function changeArchive(character: CharacterProfile) {
    if (!archived && !await confirm({ title: '归档角色？', description: `“${character.name}”将移入已归档角色，已有项目中的角色关联会保留，之后可恢复。`, confirmLabel: '确认归档' })) return;
    setError('');
    try { await rpc(archived ? 'character.restore' : 'character.archive', { characterId: character.id, revision: character.revision }); library.refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  return <div className="content-page"><div className="page-heading"><h1>角色参考库</h1><Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} />新建角色</Button></div>
    <div className="page-toolbar"><div className="tabs"><button aria-label="可用角色" aria-pressed={!archived} type="button" className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>可用</button><button aria-pressed={archived} type="button" className={archived ? 'active' : ''} onClick={() => setArchived(true)}>已归档</button></div></div>
    {library.error ? <Notice kind="error">{library.error}<Button aria-label="重试读取角色" onClick={library.refresh}>重试</Button></Notice> : error && <Notice kind="error">{error}</Notice>}
    {loading && <p role="status" className="muted">正在读取角色…</p>}
    <div className="character-cards">{characters.map(character => <article className="character-card" key={character.id}><CharacterThumbnail character={character} /><div className="character-card__body"><h3>{character.name}</h3><p>{character.description || '尚未填写角色设定'}</p><span className="tiny-meta">{character.referenceAssetIds.length} 张参考图 · 修订 {character.revision}</span><div className="character-card__actions">
      <IconButton label="编辑角色" onClick={() => setEditing(character)}><Pencil size={16} aria-hidden="true" /></IconButton>
      <IconButton label={`${archived ? '恢复' : '归档'}角色：${character.name}`} onClick={() => void changeArchive(character)}>{archived ? <RotateCcw size={15} /> : <Trash2 size={15} />}</IconButton>
    </div></div></article>)}</div>
    {!characters.length && !loading && !library.error && <EmptyState icon={<Users size={25} />} title={archived ? '没有归档角色' : '还没有角色参考'} description={archived ? '归档的角色可在这里恢复。' : '添加角色设定和参考图，供不同项目复用。'} />}
    {!library.stale && library.nextCursor !== null && <Button aria-label="加载更多角色" busy={library.loadingMore} disabled={!library.canLoadMore} onClick={() => void library.loadMore()}><ChevronDown size={15} />加载更多</Button>}
    {editing && <CharacterEditor character={editing === 'new' ? undefined : editing} version={workspace.version} models={workspace.models} action={action} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); library.refresh(); }} />}
  </div>;
}

function CharacterThumbnail({ character }: { character: CharacterProfile }) {
  const container = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    const element = container.current;
    if (!character.referenceAssetIds.length) { setUrl(''); return; }
    if (!element) return;
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

function CharacterEditor({ character, version, models, action, onClose, onSaved }: { character?: CharacterProfile; version: number; models: readonly ModelProfile[]; action: Action; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(character?.name ?? '');
  const [description, setDescription] = useState(character?.description ?? '');
  const [referenceAssetIds, setReferenceAssetIds] = useState(character?.referenceAssetIds ?? []);
  const [selectedAssets, setSelectedAssets] = useState<AssetRecord[]>([]);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [imageModelId, setImageModelId] = useState('');
  const [generatedViews, setGeneratedViews] = useState<AssetRecord[]>([]);
  const [generationState, setGenerationState] = useState<'confirming' | 'generating'>();
  const [generationError, setGenerationError] = useState('');
  const chargeRpc = useChargeRpc();
  const generationRequest = useRef<{ key: string; id: string } | undefined>(undefined);
  const imageAdapters = getMediaAdapters(['image']);
  const imageModels = models.filter(model => model.enabled && model.capabilities.includes('image') && imageAdapters.some(adapter => adapter.id === model.provider));
  const imageModel = imageModels.find(model => model.id === imageModelId) ?? (imageModels.length === 1 ? imageModels[0] : undefined);
  const generating = generationState === 'generating';
  const disabled = busy || Boolean(generationState);
  const hasCharacterInput = Boolean(name.trim() && (description.trim() || referenceAssetIds.length));
  const viewsSelected = generatedViews.length > 0 && generatedViews.every((asset, index) => asset.id === referenceAssetIds[index]);
  const images = useRecordPage('asset.list', { kind: 'image', limit: 30 }, version, imagePage);
  useEffect(() => {
    if (!character) return;
    let active = true;
    void rpc<unknown>('character.references', { characterId: character.id }).then(value => assetSchema.array().parse(value)).then(values => { if (active) setSelectedAssets(values); }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [character?.id]);
  const assets = [...new Map([...selectedAssets, ...images.items.filter(asset => !asset.projectId)].map(asset => [asset.id, asset])).values()];
  function toggle(id: string) { setReferenceAssetIds(ids => ids.includes(id) ? ids.filter(value => value !== id) : ids.length < 4 ? [...ids, id] : ids); }
  async function generateViews() {
    if (disabled || !imageModel || !hasCharacterInput) return;
    const input = { name: name.trim(), description: description.trim(), modelId: imageModel.id, referenceAssetId: referenceAssetIds[0] };
    const key = JSON.stringify(input);
    const request = generationRequest.current?.key === key ? generationRequest.current : { key, id: crypto.randomUUID() };
    generationRequest.current = request;
    setGenerationState('confirming');
    try {
      const result = await chargeRpc('character.generateViews', { ...input, requestId: request.id }, () => {
        setGenerationState('generating'); setGenerationError('');
      });
      if (result === null) return;
      setGeneratedViews(assetSchema.array().length(CHARACTER_REFERENCE_VIEW_LABELS.length).parse(result));
      generationRequest.current = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGenerationError(message.replace(/^Error invoking remote method 'vq:runtime': (?:Error: )?/, ''));
    }
    finally { setGenerationState(undefined); }
  }
  function useGeneratedViews() {
    setSelectedAssets(values => [...values, ...generatedViews]);
    setReferenceAssetIds(generatedViews.map(asset => asset.id));
  }
  async function importImage() {
    setBusy(true); setError('');
    try {
      const asset = await action<AssetRecord>('asset.import', { path, kind: 'image' });
      if (!asset) { setError('参考图未导入，请核对文件路径。'); return; }
      setSelectedAssets(values => [...values, asset]); setReferenceAssetIds(ids => [...ids, asset.id]); setPath(''); images.refresh();
    } finally { setBusy(false); }
  }
  async function save() {
    if (disabled) return;
    setBusy(true); setError('');
    try { await rpc('character.save', { character: { id: character?.id, revision: character?.revision, name, description, referenceAssetIds } }); onSaved(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <Dialog title={character ? '编辑角色' : '新建角色'} onClose={onClose} className="character-editor" dismissOnBackdrop={false} dismissDisabled={disabled}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="dialog__body form-stack">
        <Field label="角色名称"><input required autoFocus maxLength={120} value={name} disabled={disabled} onChange={event => setName(event.target.value)} /></Field>
        <Field label="角色设定"><textarea maxLength={10000} rows={3} value={description} disabled={disabled} onChange={event => setDescription(event.target.value)} placeholder="外形、服饰、性格与需要保持的细节…" /></Field>

        <details className="form-disclosure character-reference-disclosure">
          <summary>
            <span>参考图（可选）</span>
            <span className="tiny-meta">{referenceAssetIds.length ? `已选 ${referenceAssetIds.length} 张` : '从素材库选择或导入'}</span>
            <ChevronDown size={16} aria-hidden="true" />
          </summary>
          <fieldset className="capability-fieldset form-disclosure__body form-stack form-stack--compact">
            <legend>参考图片（最多 4 张）</legend>
            {assets.length > 0 && <div className="character-image-picker">{assets.map(asset => <label key={asset.id}>
              <input type="checkbox" checked={referenceAssetIds.includes(asset.id)} disabled={disabled || !referenceAssetIds.includes(asset.id) && referenceAssetIds.length >= 4} onChange={() => toggle(asset.id)} />
              <ReferenceImage asset={asset} /><span>{asset.name}</span>
            </label>)}</div>}
            {images.error && <Notice kind="error">{images.error}</Notice>}
            {images.nextCursor !== null && <div><Button aria-label="加载更多公共图片" busy={images.loadingMore} disabled={!images.canLoadMore} onClick={() => void images.loadMore()}>加载更多</Button></div>}
            <Field label="角色参考图路径"><PathPicker label="角色参考图路径" value={path} onChange={setPath} extensions={['png', 'jpg', 'jpeg', 'webp']} disabled={disabled} /></Field>
            <div><Button aria-label="导入参考图片" disabled={disabled || !path || referenceAssetIds.length >= 4} busy={busy} onClick={() => void importImage()}><Upload size={14} />导入参考图</Button></div>
          </fieldset>
        </details>

        <Field label="图片模型" hint={referenceAssetIds.length ? '以已选的第一张参考图为定妆依据。' : undefined}>
          <Select value={imageModel?.id ?? ''} disabled={disabled || !imageModels.length} onChange={event => setImageModelId(event.target.value)}>
            <option value="">{imageModels.length ? '选择图片模型' : '请在模型连接启用图片模型'}</option>
            {imageModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
          </Select>
        </Field>
        <div className="character-view-actions">
          <Button aria-label="生成四视角" busy={generating} disabled={disabled || !imageModel || !hasCharacterInput} onClick={() => void generateViews()}><Sparkles size={16} />{generationState === 'confirming' ? '等待确认…' : generating ? '正在生成…' : '生成四视角'}</Button>
          {viewsSelected ? <span className="tiny-meta" role="status">已选用这组参考图</span> : generatedViews.length > 0 && <Button disabled={disabled} onClick={useGeneratedViews}>选用这组参考图</Button>}
        </div>
        {generating && <span className="tiny-meta" role="status">正在为同一个角色绘制四个视角。</span>}
        {generationError && <Notice kind="error">{generationError}</Notice>}
        {!!generatedViews.length && <div className="character-view-results" role="group" aria-label="生成的四视角参考图">{generatedViews.map((asset, index) => <figure key={asset.id}><ReferenceImage asset={asset} /><figcaption>{CHARACTER_REFERENCE_VIEW_LABELS[index]}</figcaption></figure>)}</div>}
        {error && <Notice kind="error">{error}</Notice>}
      </div>
      <div className="dialog__footer">
        <Button disabled={disabled} onClick={onClose}>取消</Button>
        <Button aria-label="保存角色" variant="primary" type="submit" disabled={disabled || !name.trim()} busy={busy}>保存</Button>
      </div>
    </form>
  </Dialog>;
}

function ReferenceImage({ asset }: { asset: AssetRecord }) {
  const [source, setSource] = useState<{ id: string; url?: string; error?: string }>();
  useEffect(() => { let active = true; void getAssetUrl(asset.path).then(url => { if (active) setSource({ id: asset.id, url }); }).catch(error => { if (active) setSource({ id: asset.id, error: error instanceof Error ? error.message : String(error) }); }); return () => { active = false; }; }, [asset.id, asset.path]);
  return source?.id === asset.id && source.url ? <img src={source.url} alt={asset.name} loading="lazy" onError={() => setSource({ id: asset.id, error: '参考图无法读取' })} /> : <span className="tiny-meta">{source?.id === asset.id && source.error ? source.error : '读取中…'}</span>;
}

type CharacterPickerProps = { value?: string[]; version: number; onChange: (ids: string[]) => void; disabled?: boolean; label?: string; maximum?: number; hideWhenEmpty?: boolean };
type CharacterPickerPage = ReturnType<typeof useRecordPage<CharacterProfile>>;

export function CharacterPickerLibrary({ version, children }: { version: number; children: (library: CharacterPickerPage) => ReactNode }) {
  const library = useRecordPage('character.list', { archived: false, limit: 20 }, version, characterPage);
  return children(library);
}

export function CharacterPicker(props: CharacterPickerProps) {
  return <CharacterPickerLibrary version={props.version}>
    {library => <CharacterPickerOptions {...props} library={library} />}
  </CharacterPickerLibrary>;
}

export function CharacterPickerOptions({ library, value = [], version, onChange, disabled = false, label = '镜头角色', maximum = 8, hideWhenEmpty = false }: CharacterPickerProps & { library: CharacterPickerPage }) {
  const [selected, setSelected] = useState<CharacterProfile[]>([]);
  const [error, setError] = useState('');
  const selectedKey = JSON.stringify(value);
  useEffect(() => {
    let active = true; setError('');
    void Promise.all(value.map(characterId => rpc<unknown>('character.get', { characterId }).then(item => characterProfileSchema.parse(item)))).then(items => { if (active) setSelected(items); }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [selectedKey, version]);
  const profilesById = new Map(library.items.map(character => [character.id, character]));
  // Keep the library order when details arrive for a selected character.
  for (const character of selected) if (!profilesById.has(character.id)) profilesById.set(character.id, character);
  const profiles = [...profilesById.values()];
  if (hideWhenEmpty && !profiles.length && !library.error && !error) return null;
  return <fieldset className="character-shot-picker capability-fieldset"><legend>{label}</legend>{profiles.map(character => <label key={character.id} className="field-inline"><input type="checkbox" checked={value.includes(character.id)} disabled={disabled || !value.includes(character.id) && (character.archived || value.length >= maximum)} onChange={event => onChange(event.target.checked ? [...value, character.id] : value.filter(id => id !== character.id))} />{character.name}{character.archived ? '（已归档）' : ''}</label>)}{!profiles.length && !library.busy && <p className="tiny-meta">在角色参考库创建角色后，可在此选择。</p>}{(library.error || error) && <Notice kind="error">{library.error || error}</Notice>}{library.nextCursor !== null && <Button aria-label="加载更多角色" busy={library.loadingMore} disabled={!library.canLoadMore} onClick={() => void library.loadMore()}>加载更多</Button>}</fieldset>;
}
