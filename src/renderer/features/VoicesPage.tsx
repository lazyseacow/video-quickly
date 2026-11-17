import { useRef, useState } from 'react';
import { Archive, ChevronDown, Mic, Pencil, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { assetListItemSchema, recordPageSchema, voiceProfileSchema, type AssetRecord, type VoiceProfile } from '@video-quickly/contracts';
import { Button, Dialog, EmptyState, Field, IconButton, Notice, Select } from '../components/Primitives';
import { useConfirmation } from '../components/ConfirmationDialog';
import { useRecordPage } from '../lib/use-record-page';
import { useRuntimeRead } from '../lib/use-runtime-read';
import { desktopBridge } from '../lib/desktop';
import { rpc } from '../lib/client';
import type { Action, WorkspaceView } from '../lib/types';
import './drama.css';

const voicesPage = recordPageSchema(voiceProfileSchema);
const voicesSchema = voiceProfileSchema.array();
const audioPage = recordPageSchema(assetListItemSchema);

export function VoicePicker({ value, version, onChange, label = '音色', disabled = false }: { value?: string | null; version: number; onChange(value: string | undefined): void; label?: string; disabled?: boolean }) {
  const library = useRecordPage('voice.list', { archived: false, limit: 20 }, version, voicesPage);
  const selected = useRuntimeRead('voice.getMany', { voiceIds: value ? [value] : [] }, version, voicesSchema, Boolean(value));
  const options = [...new Map([...library.items, ...(selected.data ?? [])].map(profile => [profile.id, profile])).values()];
  return <div className="form-stack form-stack--compact"><Field label={label}><Select value={value ?? ''} disabled={disabled} onChange={event => onChange(event.target.value || undefined)}><option value="">使用默认声音要求</option>{value && !options.some(profile => profile.id === value) && <option value={value}>已选音色（正在读取）</option>}{options.map(profile => <option key={profile.id} value={profile.id}>{profile.name}{profile.archived ? '（已归档）' : ''}</option>)}</Select></Field>
    {(library.error || selected.error) && <Notice kind="error">{library.error || selected.error}<Button onClick={() => { library.refresh(); void selected.refresh(); }}>重试读取音色</Button></Notice>}
    {library.nextCursor !== null && <Button disabled={!library.canLoadMore || disabled} busy={library.loadingMore} onClick={() => void library.loadMore()}>加载更多音色</Button>}
  </div>;
}

export default function VoicesPage({ workspace, action }: { workspace: WorkspaceView; action: Action }) {
  const [archived, setArchived] = useState(false), [editing, setEditing] = useState<VoiceProfile | 'new'>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const library = useRecordPage('voice.list', { archived, limit: 20 }, workspace.version, voicesPage);
  const confirm = useConfirmation();
  async function change(voice: VoiceProfile, method: 'archive' | 'restore' | 'delete') {
    if (busy) return;
    if (method === 'delete' && !await confirm({ title: '彻底删除音色？', description: `删除“${voice.name}”的音色档案。音频素材会保留，此操作无法撤销。`, confirmLabel: '彻底删除' })) return;
    setBusy(true); setError('');
    try { await rpc(`voice.${method}`, { voiceId: voice.id, revision: voice.revision }); library.refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  const voices = library.stale ? [] : library.items;
  return <><div className="page-toolbar library-toolbar"><div className="tabs" role="group" aria-label="音色筛选"><button type="button" aria-pressed={!archived} className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>可用</button><button type="button" aria-pressed={archived} className={archived ? 'active' : ''} onClick={() => setArchived(true)}>已归档</button></div>{!archived && <Button variant="primary" onClick={() => setEditing('new')}><Plus size={15} />新建音色</Button>}</div>
    {library.error && <Notice kind="error">{library.error}<Button onClick={library.refresh}>重试读取音色</Button></Notice>}{error && <Notice kind="error">{error}</Notice>}
    {library.busy && !library.hasLoaded && <p role="status">正在读取音色…</p>}
    <div className="drama-work-list">{voices.map(voice => <article className="drama-work-card" key={voice.id}><Mic size={21} aria-hidden="true" /><h2>{voice.name}</h2><p>{voice.description || '尚未填写声音特征'}</p><span className="tiny-meta">{voice.language} · {voice.referenceAssetIds.length} 段参考音频</span><div className="heading-actions">{!archived && <IconButton label={`编辑音色：${voice.name}`} disabled={busy} onClick={() => setEditing(voice)}><Pencil size={15} /></IconButton>}<IconButton label={`${archived ? '恢复' : '归档'}音色：${voice.name}`} disabled={busy} onClick={() => void change(voice, archived ? 'restore' : 'archive')}>{archived ? <RotateCcw size={15} /> : <Archive size={15} />}</IconButton>{archived && <IconButton label={`删除音色：${voice.name}`} disabled={busy} onClick={() => void change(voice, 'delete')}><Trash2 size={15} /></IconButton>}</div></article>)}</div>
    {!voices.length && library.hasLoaded && !library.error && <EmptyState icon={<Mic size={25} />} title={archived ? '没有归档音色' : '还没有音色档案'} description="保存声音特征和参考音频，为角色对白或旁白选择声音。" />}
    {library.nextCursor !== null && <Button busy={library.loadingMore} disabled={!library.canLoadMore} onClick={() => void library.loadMore()}><ChevronDown size={15} />加载更多音色</Button>}
    {editing && <VoiceEditor voice={editing === 'new' ? undefined : editing} version={workspace.version} action={action} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); library.refresh(); }} />}
  </>;
}

function VoiceEditor({ voice, version, action, onClose, onSaved }: { voice?: VoiceProfile; version: number; action: Action; onClose(): void; onSaved(): void }) {
  const [name, setName] = useState(voice?.name ?? ''), [description, setDescription] = useState(voice?.description ?? ''), [language, setLanguage] = useState(voice?.language ?? 'zh-CN');
  const [providerVoiceId, setProviderVoiceId] = useState(voice?.providerVoiceId ?? ''), [references, setReferences] = useState(voice?.referenceAssetIds ?? []);
  const [path, setPath] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''); const pending = useRef(false);
  const desktop = desktopBridge();
  const audio = useRecordPage('asset.list', { kind: 'audio', limit: 30 }, version, audioPage);
  const items = audio.items.filter(asset => !asset.projectId && ['audio/wav', 'audio/x-wav', 'audio/mpeg'].includes(asset.mimeType) && asset.size > 0 && asset.size <= 15_000_000);
  async function importAudio() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const source = desktop ? await desktop.pickPath({ mode: 'file', title: '导入音色参考', extensions: ['wav', 'mp3'] }) : path.trim();
      if (!source) return;
      const result = await action<AssetRecord>('asset.import', { path: source, kind: 'audio' });
      if (!result) { setError('参考音频未能导入，请检查文件后重试。'); return; }
      setReferences(ids => ids.includes(result.id) ? ids : [...ids, result.id]); setPath(''); audio.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  async function save() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await rpc('voice.save', { voice: { ...(voice ? { id: voice.id, revision: voice.revision } : {}), name, description, language, referenceAssetIds: references, providerVoiceId: providerVoiceId.trim() || null } }); onSaved(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Dialog title={voice ? '编辑音色' : '新建音色'} onClose={onClose} dismissDisabled={busy} dismissOnBackdrop={false} className="drama-editor"><form onSubmit={event => { event.preventDefault(); void save(); }}><div className="dialog__body form-stack">
    <Field label="音色名称" required><input name="name" required maxLength={120} disabled={busy} value={name} onChange={event => setName(event.target.value)} /></Field>
    <Field label="声音特征"><textarea name="description" rows={3} maxLength={10000} disabled={busy} value={description} onChange={event => setDescription(event.target.value)} placeholder="声线、年龄感、语速和表演特点" /></Field>
    <Field label="语言" required><input name="language" required maxLength={40} disabled={busy} value={language} onChange={event => setLanguage(event.target.value)} placeholder="例如 zh-CN" /></Field>
    <fieldset className="capability-fieldset form-stack form-stack--compact"><legend>参考音频（最多 3 段）</legend><p className="field__hint">使用每段不超过 15 MB 的 WAV 或 MP3 音频。</p><div className="drama-reference-options">{items.map(asset => <label key={asset.id}><input type="checkbox" checked={references.includes(asset.id)} disabled={busy || !references.includes(asset.id) && references.length >= 3} onChange={event => setReferences(ids => event.target.checked ? [...ids, asset.id] : ids.filter(id => id !== asset.id))} />{asset.name}</label>)}</div>
      {references.filter(id => !items.some(asset => asset.id === id)).map((id, index) => <label key={id} className="field-inline"><input type="checkbox" checked disabled={busy} onChange={() => setReferences(ids => ids.filter(value => value !== id))} />已选参考音频 {index + 1}</label>)}
      {audio.error && <Notice kind="error">{audio.error}<Button onClick={audio.refresh}>重试读取音频</Button></Notice>}
      {audio.nextCursor !== null && <Button disabled={!audio.canLoadMore || busy} busy={audio.loadingMore} onClick={() => void audio.loadMore()}>加载更多公共音频</Button>}
      {!desktop && <Field label="参考音频路径"><input value={path} disabled={busy} placeholder="选择本地音频文件的完整路径" onChange={event => setPath(event.target.value)} /></Field>}
      <div><Button busy={busy} disabled={references.length >= 3 || !desktop && !path.trim()} onClick={() => void importAudio()}><Upload size={15} />导入参考音频</Button></div>
    </fieldset>
    <details className="form-disclosure"><summary>服务音色标识（可选）</summary><div className="form-disclosure__body"><Field label="服务音色标识" hint="记录供应商的音色编号，实际使用以所接服务支持为准。"><input name="providerVoiceId" maxLength={200} disabled={busy} value={providerVoiceId} onChange={event => setProviderVoiceId(event.target.value)} /></Field></div></details>
    {error && <Notice kind="error">{error}</Notice>}
  </div><div className="dialog__footer"><Button disabled={busy} onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={busy}>保存音色</Button></div></form></Dialog>;
}
