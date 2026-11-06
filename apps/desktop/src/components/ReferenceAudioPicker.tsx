import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { MAX_REFERENCE_AUDIOS, type AssetRecord } from '@video-quickly/contracts';
import { Button, Field, IconButton, Notice } from './Primitives';
import PathPicker from './PathPicker';

export default function ReferenceAudioPicker({ assets, value, onChange, onImport, disabled }: {
  assets: AssetRecord[]; value: string[]; onChange: (ids: string[]) => void;
  onImport: (path: string) => Promise<AssetRecord | undefined>; disabled: boolean;
}) {
  const [path, setPath] = useState('');
  const [imported, setImported] = useState<AssetRecord[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const available = new Map([...assets, ...imported].map(asset => [asset.id, asset]));
  async function add() {
    const selected = path.trim();
    if (!selected || disabled || busy || value.length >= MAX_REFERENCE_AUDIOS) return;
    if (!/\.(wav|mp3)$/i.test(selected)) { setError('请选择 WAV 或 MP3 音频文件。'); return; }
    setError(''); setBusy(true);
    try {
      const asset = await onImport(selected);
      if (!asset) { setError('参考音频未添加，请核对文件后重试。'); return; }
      setImported(current => [...current, asset]); onChange([...value, asset.id]); setPath('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  return <section className="production-settings__reference-audio" aria-label="参考音频">
    <Field label="参考音频">
      <PathPicker label="参考音频文件路径" value={path} onChange={setPath} extensions={['wav', 'mp3']} placeholder="WAV / MP3" disabled={disabled} />
    </Field>
    <Button static busy={busy} disabled={disabled || !path.trim() || value.length >= MAX_REFERENCE_AUDIOS} onClick={() => void add()}><Plus size={14} />添加参考音频</Button>
    {value.length > 0 && <ul className="production-settings__reference-audio-list" aria-label="已选参考音频">{value.map((id, index) => {
      const asset = available.get(id), name = asset?.name ?? '音频素材不可用';
      return <li key={id}><span>{index + 1}. {name}</span><IconButton label={`移除参考音频：${name}`} disabled={disabled} onClick={() => onChange(value.filter(value => value !== id))}><Trash2 size={14} /></IconButton></li>;
    })}</ul>}
    {error && <Notice kind="error">{error}</Notice>}
  </section>;
}
