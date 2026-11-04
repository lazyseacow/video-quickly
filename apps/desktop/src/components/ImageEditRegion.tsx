import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { AssetRecord, ImageRectangle } from '@video-quickly/contracts';
import { getAssetUrl, rpc } from '../lib/client';
import { Field, Notice } from './Primitives';
import './image-tools.css';

export default function ImageEditRegion({ asset, disabled, rectangle, onChange, onError }: { asset: AssetRecord; disabled: boolean; rectangle?: ImageRectangle; onChange(value: ImageRectangle | undefined): void; onError(value: string): void }) {
  const [size, setSize] = useState<{ width: number; height: number }>(), [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setSize(undefined); setError(''); onError('正在读取改图源图…');
    void Promise.all([rpc('image.dimensions', { assetId: asset.id }), getAssetUrl(asset.path)]).then(([value, url]) => {
      const size = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).parse(value);
      if (active) { setSize(size); setUrl(url); onError(''); }
    }).catch(failure => { if (active) { const message = failure instanceof Error ? failure.message : String(failure); setError(message); onError(message); } });
    return () => { active = false; };
  }, [asset.id, asset.path, onError]);
  const toggle = (enabled: boolean) => onChange(enabled && size ? { x: Math.floor(size.width / 4), y: Math.floor(size.height / 4), width: Math.max(1, Math.floor(size.width / 2)), height: Math.max(1, Math.floor(size.height / 2)) } : undefined);
  return <div className="image-edit-region">
    {error && <Notice kind="error">{error}</Notice>}
    <label className="checkbox-row"><input type="checkbox" checked={Boolean(rectangle)} disabled={disabled || !size} onChange={event => toggle(event.target.checked)} />局部改图：保留原图并修改选中区域</label>
    {rectangle && size && <><p className="tiny-meta">区域为像素坐标。生成结果将作为新候选保留；模型可能调整区域边缘。</p><div className="image-edit-region__preview"><img src={url} alt="局部改图原图" /><span className="image-edit-region__rectangle" style={{ left: `${rectangle.x / size.width * 100}%`, top: `${rectangle.y / size.height * 100}%`, width: `${rectangle.width / size.width * 100}%`, height: `${rectangle.height / size.height * 100}%` }} /></div><div className="image-edit-region__coordinates">{(['x', 'y', 'width', 'height'] as const).map(field => <Field key={field} label={{ x: '左侧像素', y: '顶部像素', width: '区域宽度', height: '区域高度' }[field]}><input aria-label={{ x: '左侧像素', y: '顶部像素', width: '区域宽度', height: '区域高度' }[field]} type="number" min={field === 'x' || field === 'y' ? 0 : 1} step={1} max={field === 'x' || field === 'width' ? size.width : size.height} value={rectangle[field]} disabled={disabled} onChange={event => onChange({ ...rectangle, [field]: Number(event.target.value) })} /></Field>)}</div></>}
  </div>;
}
