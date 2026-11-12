import { useEffect, useRef, useState } from 'react';
import { Archive, RotateCcw, Trash2, Users, Plus, ChevronDown, Upload, Sparkles, Pencil } from 'lucide-react';
import { assetListItemSchema, assetSchema, characterProfileSchema, getMediaAdapters, recordPageSchema, type AssetRecord, type CharacterProfile, type ModelProfile } from '@video-quickly/contracts';
import { Button, Dialog, EmptyState, Field, IconButton, Notice, Select } from '../components/Primitives';
import { useChargeRpc, useConfirmation } from '../components/ConfirmationDialog';
import ReferenceImage from '../components/ReferenceImage';
import { getAssetUrl, rpc } from '../lib/client';
import { desktopBridge, pathExample } from '../lib/desktop';
import { useRecordPage } from '../lib/use-record-page';
import type { Action, WorkspaceView } from '../lib/types';
import './characters.css';

const characterPage = recordPageSchema(characterProfileSchema);
const imagePage = recordPageSchema(assetListItemSchema);
const referenceImageLimit = 4;
const characterActions = {
  archive: { label: '归档角色', icon: Archive },
  restore: { label: '恢复角色', icon: RotateCcw },
  delete: { label: '删除角色', icon: Trash2 },
};
type CharacterOperation = keyof typeof characterActions;

export default function CharactersPage({ workspace, action }: { workspace: WorkspaceView; action: Action }) {
  const confirm = useConfirmation();
  const [archived, setArchived] = useState(false);
  const library = useRecordPage('character.list', { archived, limit: 20 }, workspace.version, characterPage);
  const characters = library.stale ? [] : library.items;
  const loading = !characters.length && !library.error && (library.busy || !library.hasLoaded);
  const [editing, setEditing] = useState<CharacterProfile | 'new'>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ id: string; operation: CharacterOperation }>();
  const changing = useRef(false);
  const activeFilter = useRef<HTMLButtonElement>(null);

  async function changeCharacter(character: CharacterProfile, operation: CharacterOperation, trigger: HTMLButtonElement) {
    if (changing.current) return;
    changing.current = true;
    try {
      const confirmation = operation === 'archive' ? {
        title: '归档角色？', description: `“${character.name}”将移入已归档角色，之后可恢复。`, confirmLabel: '确认归档',
      } : operation === 'delete' ? {
        title: '彻底删除角色？', description: `将永久删除“${character.name}”的角色设定和参考图关联。参考图会保留在媒体素材库。此操作无法撤销。`, confirmLabel: '彻底删除',
      } : undefined;
      if (confirmation && !await confirm(confirmation)) return;
      setError('');
      setPending({ id: character.id, operation });
      await rpc(`character.${operation}`, { characterId: character.id, revision: character.revision });
      if (document.activeElement === trigger || document.activeElement === document.body) activeFilter.current?.focus({ preventScroll: true });
      library.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      library.refresh();
    } finally {
      changing.current = false;
      setPending(undefined);
    }
  }
  return <>
    <div className="page-toolbar library-toolbar">
      <div className="tabs" role="group" aria-label="角色筛选">
        <button ref={!archived ? activeFilter : undefined} aria-label="可用角色" aria-pressed={!archived} type="button" className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>可用</button>
        <button ref={archived ? activeFilter : undefined} aria-pressed={archived} type="button" className={archived ? 'active' : ''} onClick={() => setArchived(true)}>已归档</button>
      </div>
      {!archived && <Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} aria-hidden="true" />新建角色</Button>}
    </div>
    {library.error ? <Notice kind="error">{library.error}<Button aria-label="重试读取角色" onClick={library.refresh}>重试</Button></Notice> : error && <Notice kind="error">{error}</Notice>}
    {loading && <p role="status" className="muted">正在读取角色…</p>}
    <div className="character-cards">{characters.map(character => <article className="character-card" key={character.id}><CharacterThumbnail character={character} /><div className="character-card__body"><h3>{character.name}</h3><p>{character.description || '尚未填写角色设定'}</p><span className="tiny-meta">{character.referenceAssetIds.length} 张参考图 · 修订 {character.revision}</span><div className="character-card__actions">
      {!character.archived && <IconButton label="编辑角色" disabled={Boolean(pending)} onClick={() => setEditing(character)}><Pencil size={16} aria-hidden="true" /></IconButton>}
      {(character.archived ? ['restore', 'delete'] as const : ['archive'] as const).map(operation => {
        const { label, icon: Icon } = characterActions[operation];
        return <IconButton key={operation} label={`${label}：${character.name}`} disabled={Boolean(pending)}
          busy={pending?.id === character.id && pending.operation === operation}
          onClick={event => void changeCharacter(character, operation, event.currentTarget)}><Icon size={16} aria-hidden="true" /></IconButton>;
      })}
    </div></div></article>)}</div>
    {!characters.length && !loading && !library.error && <EmptyState icon={<Users size={25} />} title={archived ? '没有归档角色' : '还没有角色参考'} description={archived ? '归档的角色可在这里恢复或删除。' : '添加角色设定和参考图，供不同项目复用。'} />}
    {!library.stale && library.nextCursor !== null && <Button aria-label="加载更多角色" busy={library.loadingMore} disabled={!library.canLoadMore} onClick={() => void library.loadMore()}><ChevronDown size={15} />加载更多</Button>}
    {editing && <CharacterEditor character={editing === 'new' ? undefined : editing} version={workspace.version} models={workspace.models} action={action} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); library.refresh(); }} />}
  </>;
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

export function CharacterEditor({ character, initialReference, version, models, action, onClose, onSaved }: {
  character?: CharacterProfile;
  initialReference?: AssetRecord;
  version: number;
  models: readonly ModelProfile[];
  action: Action;
  onClose(): void;
  onSaved(): void;
}) {
  const [name, setName] = useState(character?.name ?? '');
  const [description, setDescription] = useState(character?.description ?? '');
  const [referenceAssetIds, setReferenceAssetIds] = useState(character?.referenceAssetIds ?? (initialReference ? [initialReference.id] : []));
  const [selectedAssets, setSelectedAssets] = useState<AssetRecord[]>(initialReference ? [initialReference] : []);
  const [referencePickerOpen, setReferencePickerOpen] = useState(Boolean(initialReference));
  const [path, setPath] = useState('');
  const [pendingAction, setPendingAction] = useState<'uploading' | 'saving'>();
  const [error, setError] = useState('');
  const [imageModelId, setImageModelId] = useState('');
  const [editedPrompt, setEditedPrompt] = useState<string>();
  const [generatedImage, setGeneratedImage] = useState<AssetRecord>();
  const [generationState, setGenerationState] = useState<'confirming' | 'generating'>();
  const [generationError, setGenerationError] = useState('');
  const chargeRpc = useChargeRpc();
  const generationRequest = useRef<{ key: string; id: string } | undefined>(undefined);
  const desktop = desktopBridge();
  const imageAdapters = getMediaAdapters(['image']);
  const imageModels = models.filter(model => model.enabled && model.capabilities.includes('image') && imageAdapters.some(adapter => adapter.id === model.provider));
  const imageModel = imageModels.find(model => model.id === imageModelId) ?? (imageModels.length === 1 ? imageModels[0] : undefined);
  const generating = generationState === 'generating';
  const disabled = Boolean(pendingAction || generationState);
  const prompt = editedPrompt ?? description;
  const canGenerate = Boolean(name.trim() && (prompt.trim() || referenceAssetIds.length));
  const imageSelected = generatedImage && referenceAssetIds.includes(generatedImage.id);
  const referencesFull = referenceAssetIds.length >= referenceImageLimit;
  const images = useRecordPage('asset.list', { kind: 'image', limit: 30 }, version, imagePage);
  useEffect(() => {
    if (!character) return;
    let active = true;
    void rpc<unknown>('character.references', { characterId: character.id }).then(value => assetSchema.array().parse(value)).then(values => { if (active) setSelectedAssets(values); }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [character?.id]);
  const assets = [...new Map([...selectedAssets, ...images.items.filter(asset => !asset.projectId)].map(asset => [asset.id, asset])).values()];
  function toggle(id: string) { setReferenceAssetIds(ids => ids.includes(id) ? ids.filter(value => value !== id) : ids.length < referenceImageLimit ? [...ids, id] : ids); }
  function selectReference(asset: AssetRecord) {
    setSelectedAssets(values => values.some(value => value.id === asset.id) ? values : [...values, asset]);
    setReferenceAssetIds(ids => ids.includes(asset.id) || ids.length >= referenceImageLimit ? ids : [...ids, asset.id]);
  }
  async function generateImage() {
    if (disabled || !imageModel || !canGenerate) return;
    const input = { name: name.trim(), prompt: prompt.trim(), modelId: imageModel.id, referenceAssetId: referenceAssetIds[0] };
    const key = JSON.stringify(input);
    const request = generationRequest.current?.key === key ? generationRequest.current : { key, id: crypto.randomUUID() };
    generationRequest.current = request;
    setGenerationState('confirming');
    try {
      const result = await chargeRpc('character.generateImage', { ...input, requestId: request.id }, () => {
        setGenerationState('generating'); setGenerationError('');
      });
      if (result === null) return;
      setGeneratedImage(assetSchema.parse(result));
      generationRequest.current = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGenerationError(message.replace(/^Error invoking remote method 'vq:runtime': (?:Error: )?/, ''));
    }
    finally { setGenerationState(undefined); }
  }
  async function importImage() {
    if (disabled || referencesFull) return;
    setPendingAction('uploading'); setError('');
    try {
      const source = desktop
        ? await desktop.pickPath({ mode: 'file', title: '上传角色参考图', extensions: ['png', 'jpg', 'jpeg', 'webp'] })
        : path.trim();
      if (!source) return;
      const asset = await action<AssetRecord>('asset.import', { path: source, kind: 'image' });
      if (!asset) { setError('参考图上传失败，请检查文件后重试。'); return; }
      selectReference(asset);
      setPath('');
      images.refresh();
      setReferencePickerOpen(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally { setPendingAction(undefined); }
  }
  async function save() {
    if (disabled) return;
    setPendingAction('saving'); setError('');
    try { await rpc('character.save', { character: { id: character?.id, revision: character?.revision, name, description, referenceAssetIds } }); onSaved(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setPendingAction(undefined); }
  }
  return <Dialog title={character ? '编辑角色' : '新建角色'} onClose={onClose} className="character-editor" dismissOnBackdrop={false} dismissDisabled={disabled}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="dialog__body form-stack">
        <Field label="角色名称"><input required autoFocus maxLength={120} value={name} disabled={disabled} onChange={event => setName(event.target.value)} /></Field>
        <Field label="角色设定"><textarea maxLength={10000} rows={3} value={description} disabled={disabled} onChange={event => setDescription(event.target.value)} placeholder="外形、服饰、性格与需要保持的细节…" /></Field>

        <details className="form-disclosure character-reference-disclosure" open={referencePickerOpen}
          onToggle={event => setReferencePickerOpen(event.currentTarget.open)}>
          <summary>
            <span>参考图（可选）</span>
            <span className="tiny-meta">{referenceAssetIds.length ? `已选 ${referenceAssetIds.length} 张` : '从素材库选择'}</span>
            <ChevronDown size={16} aria-hidden="true" />
          </summary>
          <fieldset className="capability-fieldset form-disclosure__body form-stack form-stack--compact">
            <legend>参考图片（最多 {referenceImageLimit} 张）</legend>
            {assets.length > 0 && <div className="character-image-picker">{assets.map(asset => <label key={asset.id}>
              <input type="checkbox" checked={referenceAssetIds.includes(asset.id)} disabled={disabled || !referenceAssetIds.includes(asset.id) && referencesFull} onChange={() => toggle(asset.id)} />
              <ReferenceImage asset={asset} context="character" /><span>{asset.name}</span>
            </label>)}</div>}
            {referenceAssetIds.length > 1 && <Field label="主参考图" hint="视频连接只接收一张图时，优先使用主参考图。">
              <Select value={referenceAssetIds[0]} disabled={disabled} onChange={event => {
                const id = event.target.value;
                setReferenceAssetIds(ids => [id, ...ids.filter(value => value !== id)]);
              }}>
                {referenceAssetIds.map((id, index) => <option key={id} value={id}>{assets.find(asset => asset.id === id)?.name ?? `参考图 ${index + 1}`}</option>)}
              </Select>
            </Field>}
            {images.error && <Notice kind="error">{images.error}</Notice>}
            {images.nextCursor !== null && <div><Button aria-label="加载更多公共图片" busy={images.loadingMore} disabled={!images.canLoadMore} onClick={() => void images.loadMore()}>加载更多</Button></div>}
          </fieldset>
        </details>
        <div className="character-reference-upload">
          {!desktop && <Field label="角色参考图路径"><input value={path} disabled={disabled || referencesFull} placeholder={pathExample('image')} onChange={event => setPath(event.target.value)} /></Field>}
          <div><Button busy={pendingAction === 'uploading'} disabled={disabled || referencesFull || (!desktop && !path.trim())} onClick={() => void importImage()}><Upload size={16} aria-hidden="true" />上传参考图</Button></div>
        </div>
        <details className="form-disclosure character-ai-disclosure">
          <summary><span>AI 生成参考图（可选）</span><ChevronDown size={16} aria-hidden="true" /></summary>
          <div className="form-disclosure__body form-stack">
            <Field label="生成提示词" hint="默认使用角色设定，可单独修改构图、视角和风格。">
              <textarea className="character-image-prompt" maxLength={10000} rows={3} value={prompt} disabled={disabled} onChange={event => setEditedPrompt(event.target.value)} placeholder="描述想要生成的画面…" />
            </Field>
            <Field label="图片模型" hint={referenceAssetIds.length ? '生成时会使用主参考图。' : undefined}>
              <Select value={imageModel?.id ?? ''} disabled={disabled || !imageModels.length} onChange={event => setImageModelId(event.target.value)}>
                <option value="">{imageModels.length ? '选择图片模型' : '请在模型连接启用图片模型'}</option>
                {imageModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
              </Select>
            </Field>
            <div><Button aria-label="生成参考图" busy={generating} disabled={disabled || !imageModel || !canGenerate} onClick={() => void generateImage()}>
              {!generating && <Sparkles size={16} aria-hidden="true" />}
              {generationState === 'confirming' ? '等待确认…' : generating ? '正在生成…' : '生成参考图'}
            </Button></div>
            {generationError && <Notice kind="error">{generationError}</Notice>}
            {generatedImage && <div className="character-generated-image form-stack form-stack--compact" role="group" aria-label="生成的参考图">
              {imageSelected ? <span className="field__hint" role="status">已选用这张参考图</span>
                : <div>
                  <Button disabled={disabled || referencesFull} onClick={() => selectReference(generatedImage)}>选用这张图</Button>
                  {referencesFull && <p className="field__hint">请先移除一张已选参考图。</p>}
                </div>}
              <ReferenceImage asset={generatedImage} context="character" />
            </div>}
          </div>
        </details>
        {error && <Notice kind="error">{error}</Notice>}
      </div>
      <div className="dialog__footer">
        <Button disabled={disabled} onClick={onClose}>取消</Button>
        <Button aria-label="保存角色" variant="primary" type="submit" disabled={disabled || !name.trim()} busy={pendingAction === 'saving'}>保存</Button>
      </div>
    </form>
  </Dialog>;
}
