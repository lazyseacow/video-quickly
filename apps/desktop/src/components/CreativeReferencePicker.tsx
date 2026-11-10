import { useEffect, useRef, useState } from 'react';
import { assetListItemSchema, assetSchema, recordPageSchema, type AssetRecord } from '@video-quickly/contracts';
import { getAssetUrl, rpc } from '../lib/client';
import { useRecordPage } from '../lib/use-record-page';
import { Button, Field, Notice } from './Primitives';
import PathPicker from './PathPicker';

const imagePage = recordPageSchema(assetListItemSchema);

function ReferenceImage({ asset }: { asset: AssetRecord }) {
  const [source, setSource] = useState<{ path: string; url?: string; error?: string }>();
  useEffect(() => {
    let active = true;
    void getAssetUrl(asset.path).then(url => { if (active) setSource({ path: asset.path, url }); }).catch(() => { if (active) setSource({ path: asset.path, error: '图片无法读取' }); });
    return () => { active = false; };
  }, [asset.path]);
  return source?.path === asset.path && source.url ? <img src={source.url} alt="" loading="lazy" onError={() => setSource({ path: asset.path, error: '图片无法读取' })} /> : <span className="tiny-meta">{source?.path === asset.path && source.error ? source.error : '读取中…'}</span>;
}

interface CreativeReferencePickerProps { value?: string[]; version: number; label: string; onChange(ids: string[]): void }

export default function CreativeReferencePicker(props: CreativeReferencePickerProps) {
  const [open, setOpen] = useState(false);
  return <details className="form-disclosure creative-reference-picker__disclosure" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{props.label}（{props.value?.length ?? 0} / 4）</summary>{open && <CreativeReferenceContent {...props} />}</details>;
}

function CreativeReferenceContent({ value = [], version, label, onChange }: CreativeReferencePickerProps) {
  const images = useRecordPage('asset.list', { kind: 'image', limit: 30 }, version, imagePage);
  const [selected, setSelected] = useState<AssetRecord[]>([]);
  const [path, setPath] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const latest = useRef({ value, onChange }); latest.current = { value, onChange };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const selectedKey = JSON.stringify(value);
  useEffect(() => {
    let active = true;
    void rpc('asset.getMany', { assetIds: value }).then(result => assetSchema.array().parse(result)).then(assets => { if (active) setSelected(assets); }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [selectedKey, version]);
  const assets = [...new Map([...selected, ...images.items.filter(asset => !asset.projectId && asset.active)].map(asset => [asset.id, asset])).values()];
  const missing = value.filter(id => !assets.some(asset => asset.id === id));
  function toggle(id: string) { onChange(value.includes(id) ? value.filter(current => current !== id) : [...value, id]); }
  async function importImage() {
    setBusy(true); setError('');
    try {
      const asset = assetSchema.parse(await rpc('asset.import', { path, kind: 'image' }));
      if (!mounted.current) return;
      setSelected(current => [...current, asset]); setPath(''); images.refresh();
      if (latest.current.value.length >= 4) { setError('参考图已满，图片已导入公共素材库，可移除一张后再选择。'); return; }
      latest.current.onChange([...latest.current.value, asset.id]);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <fieldset className="capability-fieldset form-stack form-stack--compact form-disclosure__body creative-reference-picker"><legend>{label}（最多 4 张）</legend>
    <div className="creative-reference-picker__images">{assets.map(asset => <label key={asset.id}><input type="checkbox" checked={value.includes(asset.id)} disabled={busy || !value.includes(asset.id) && (value.length >= 4 || !asset.active || asset.projectId !== undefined)} onChange={() => toggle(asset.id)} /><ReferenceImage asset={asset} /><span>{asset.name}{!asset.active ? '（已移除）' : ''}</span></label>)}</div>
    {missing.map(id => <label className="field-inline" key={id}><input type="checkbox" checked disabled={busy} onChange={() => toggle(id)} />已选参考图暂未读取（{id.slice(0, 8)}）</label>)}
    {(error || images.error) && <Notice kind="error">{error || images.error}</Notice>}
    {images.nextCursor !== null && <Button static busy={images.loadingMore} disabled={!images.canLoadMore} aria-label={`加载更多${label}`} onClick={() => void images.loadMore()}>加载更多</Button>}
    <Field label={`${label}路径`}><PathPicker label={`${label}路径`} value={path} onChange={setPath} extensions={['png', 'jpg', 'jpeg', 'webp']} disabled={busy} /></Field>
    <Button static disabled={!path || value.length >= 4} busy={busy} aria-label={`导入${label}`} onClick={() => void importImage()}>导入参考图</Button>
  </fieldset>;
}
