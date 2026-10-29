import { useEffect, useState } from 'react';
import { Music2, Plus, Trash2 } from 'lucide-react';
import { musicClipSchema, type AssetRecord, type MusicClip } from '@video-quickly/contracts';
import { useSourceDuration } from '../lib/source-duration';
import { Button, Dialog, Field, IconButton, Notice } from './Primitives';
import PathPicker from './PathPicker';
import './music-editor.css';

export default function MusicEditor({ clips, assets, durationUs, onClose, onApply, onImport, onSeek }: {
  clips: MusicClip[]; assets: AssetRecord[]; durationUs: number; onClose: () => void;
  onApply: (clips: MusicClip[], baseline: MusicClip[]) => Promise<boolean>;
  onImport: (path: string) => Promise<AssetRecord | undefined>; onSeek: (timeUs: number) => void;
}) {
  const [draft, setDraft] = useState(clips);
  const [initial] = useState(clips);
  const [imported, setImported] = useState<AssetRecord[]>([]);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [validity, setValidity] = useState<Record<string, boolean>>({});
  const audio = [...new Map([...assets, ...imported].filter(asset => asset.kind === 'audio' && asset.active).map(asset => [asset.id, asset])).values()];
  const valid = draft.every(clip => validity[clip.id]);
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  function add(assetId: string) {
    setDraft(current => [...current, musicClipSchema.parse({ id: crypto.randomUUID(), assetId, durationUs: Math.max(1, durationUs), loop: true })]);
  }
  async function importAudio() {
    setBusy(true); setError('');
    try {
      const asset = await onImport(path);
      if (!asset) { setError('音乐导入失败，请检查文件路径与格式。'); return; }
      setImported(current => [...current, asset]); add(asset.id); setPath('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true); setError('');
    try {
      const parsed = draft.map(clip => musicClipSchema.parse(clip));
      if (await onApply(parsed, initial)) onClose();
      else setError('音乐修改尚未保存，草稿已保留，可重试。');
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  return <Dialog title="背景音乐" onClose={onClose} className="dialog--wide"><div className="dialog__body music-editor">
    <div className="music-editor__add"><Field label="从素材库添加音乐"><select value="" disabled={busy} onChange={event => { if (event.target.value) add(event.target.value); }}><option value="">选择音频素材…</option>{audio.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field><span className="tiny-meta">音乐按项目时间播放；镜头重排不会移动音乐。</span></div>
    <details className="music-editor__import"><summary>导入音乐文件</summary><Field label="音乐文件路径"><PathPicker label="音乐文件路径" value={path} onChange={setPath} extensions={['wav', 'mp3', 'm4a', 'ogg']} disabled={busy} /></Field><Button disabled={busy || !path.trim()} onClick={() => void importAudio()}><Plus size={14} />导入并添加</Button></details>
    {!draft.length && <p className="tiny-meta">添加音乐后可设置位置、音量、循环与淡入淡出。</p>}
    {draft.map((clip, index) => <MusicFields key={clip.id} clip={clip} index={index} assets={audio} disabled={busy}
      onChange={next => setDraft(current => current.map(item => item.id === clip.id ? next : item))}
      onRemove={() => setDraft(current => current.filter(item => item.id !== clip.id))}
      onValidity={value => setValidity(current => current[clip.id] === value ? current : { ...current, [clip.id]: value })}
      onSeek={() => onSeek(clip.startUs)} />)}
    {error && <Notice kind="error">{error}</Notice>}
  </div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button variant="primary" busy={busy} disabled={!valid || !changed} onClick={() => void apply()}>应用背景音乐</Button></div></Dialog>;
}

function MusicFields({ clip, index, assets, disabled, onChange, onRemove, onValidity, onSeek }: {
  clip: MusicClip; index: number; assets: AssetRecord[]; disabled: boolean;
  onChange: (clip: MusicClip) => void; onRemove: () => void; onValidity: (valid: boolean) => void; onSeek: () => void;
}) {
  const source = useSourceDuration({ audioAssetId: clip.assetId }, assets);
  const parsed = musicClipSchema.safeParse(clip);
  let error = !parsed.success ? parsed.error.issues[0]?.message ?? '音乐设置无效。' : '';
  if (!error && source.status === 'ready' && source.durationUs !== undefined) {
    if (clip.sourceInUs >= source.durationUs) error = '素材入点须早于音乐结尾。';
    else if (!clip.loop && clip.sourceInUs + clip.durationUs > source.durationUs) error = '片段超出素材尾部，请开启循环或缩短时长。';
  }
  const valid = !error && source.status === 'ready';
  useEffect(() => { onValidity(valid); }, [valid]);
  const seconds = (key: 'startUs' | 'sourceInUs' | 'durationUs' | 'fadeInUs' | 'fadeOutUs', label: string) => <Field label={`音乐 ${index + 1} ${label}`}><input type="number" min="0" step="0.01" value={Number.isFinite(clip[key]) ? clip[key] / 1_000_000 : ''} disabled={disabled} onChange={event => onChange({ ...clip, [key]: Math.round(event.target.valueAsNumber * 1_000_000) })} /></Field>;
  return <section className="music-editor__clip" aria-label={`音乐片段 ${index + 1}`}><div className="music-editor__heading"><Music2 size={16} /><strong>{assets.find(asset => asset.id === clip.assetId)?.name ?? '素材缺失'}</strong><Button variant="ghost" disabled={disabled || !Number.isFinite(clip.startUs)} onClick={onSeek}>定位</Button><IconButton label={`移除音乐 ${index + 1}`} disabled={disabled} onClick={onRemove}><Trash2 size={15} /></IconButton></div>
    <div className="music-editor__fields">{seconds('startUs', '项目起点（秒）')}{seconds('sourceInUs', '素材入点（秒）')}{seconds('durationUs', '时长（秒）')}<Field label={`音乐 ${index + 1} 音量（dB）`}><input type="number" min="-60" max="0" step="1" disabled={disabled} value={Number.isFinite(clip.gainDb) ? clip.gainDb : ''} onChange={event => onChange({ ...clip, gainDb: event.target.valueAsNumber })} /></Field>{seconds('fadeInUs', '淡入（秒）')}{seconds('fadeOutUs', '淡出（秒）')}</div>
    <label className="music-editor__loop"><input type="checkbox" checked={clip.loop} disabled={disabled} onChange={event => onChange({ ...clip, loop: event.target.checked })} />从素材入点循环到结尾</label>
    {source.status === 'loading' && <p className="tiny-meta" role="status">正在读取音乐时长…</p>}{source.status === 'ready' && <p className="tiny-meta">素材时长 {((source.durationUs ?? 0) / 1_000_000).toFixed(3)} 秒</p>}
    {(error || source.error) && <p className="field-error" role="alert">{source.error || error}</p>}
  </section>;
}
