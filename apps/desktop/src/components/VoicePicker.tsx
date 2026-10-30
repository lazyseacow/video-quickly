import { useId, useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import type { VoiceDiscovery } from '@video-quickly/contracts';
import { Button, IconButton, Select } from './Primitives';

export default function VoicePicker({ value, required, disabled, catalog, loading, onReload, onChange }: {
  value: string; required?: boolean; disabled: boolean; catalog: VoiceDiscovery; loading?: boolean; onReload?: () => void; onChange: (value: string) => void;
}) {
  const inputId = useId(), hintId = useId();
  const [custom, setCustom] = useState(false), [search, setSearch] = useState('');
  const manual = custom || !catalog.items.length;
  const filtered = catalog.items.filter(voice => `${voice.label} ${voice.id}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <div className="voice-picker field">
    <label className="field__label" htmlFor={inputId}>配音音色</label>
    <div className="voice-picker__controls">
      {!manual && catalog.items.length > 20 && <input className="voice-picker__search" type="search" aria-label="搜索配音音色" placeholder="搜索名称或 ID" value={search} disabled={disabled} onChange={event => setSearch(event.target.value)} />}
      {manual ? <input id={inputId} aria-label="配音音色" aria-describedby={hintId} value={value} required={required} disabled={disabled} autoFocus={custom} placeholder={loading ? '正在读取音色…' : '自定义音色 ID'} onChange={event => { setCustom(true); onChange(event.target.value); }} /> : <Select id={inputId} aria-label="配音音色" aria-describedby={hintId} value={value} required={required} disabled={disabled} onChange={event => { if (event.target.value === '__custom_voice__') setCustom(true); else onChange(event.target.value); }}>
        <option value="" disabled={required}>{required ? '选择音色' : '使用默认音色'}</option>
        {value && !filtered.some(voice => voice.id === value) && <option value={value}>当前：{catalog.items.find(voice => voice.id === value)?.label ?? value}</option>}
        {filtered.map(voice => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
        {!filtered.length && search && <option disabled>没有匹配的音色</option>}
        <option value="__custom_voice__">自定义音色…</option>
      </Select>}
      {onReload && <IconButton label="获取账号音色" disabled={disabled || loading} aria-busy={loading || undefined} onClick={onReload}>{loading ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}</IconButton>}
    </div>
    {manual && catalog.items.length > 0 && <Button static variant="ghost" className="voice-picker__switch" onClick={() => setCustom(false)}>从列表选择</Button>}
    <span id={hintId} className="field__hint" role="status">{loading ? '正在读取与当前模型匹配的账号音色…' : catalog.message}{catalog.sourceUrl && <> <a href={catalog.sourceUrl} target="_blank" rel="noreferrer">官方音色列表</a></>}</span>
  </div>;
}
