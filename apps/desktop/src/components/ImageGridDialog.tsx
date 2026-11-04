import { useEffect, useRef, useState } from 'react';
import { assetSchema, imageGridRectangles, type AssetRecord } from '@video-quickly/contracts';
import { z } from 'zod';
import { getAssetUrl, rpc } from '../lib/client';
import { Button, Dialog, Field, Notice, Select } from './Primitives';
import './image-tools.css';

export default function ImageGridDialog({ asset, onClose }: { asset: AssetRecord; onClose(): void }) {
  const [rows, setRows] = useState(2), [columns, setColumns] = useState(2);
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [url, setUrl] = useState(''), [results, setResults] = useState<Array<{ asset: AssetRecord; url: string }>>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void Promise.all([rpc('image.dimensions', { assetId: asset.id }), getAssetUrl(asset.path)]).then(([info, path]) => {
      if (!alive.current) return;
      const parsed = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).parse(info);
      setSize(parsed); setRows(Math.min(2, parsed.height)); setColumns(Math.min(2, parsed.width)); setUrl(path);
    }).catch(failure => { if (alive.current) setError(String(failure instanceof Error ? failure.message : failure)); });
    return () => { alive.current = false; };
  }, [asset.id, asset.path]);
  async function cut() {
    setBusy(true); setError('');
    try {
      const assets = z.array(assetSchema).parse(await rpc('image.cutGrid', { assetId: asset.id, rows, columns }));
      const values = await Promise.all(assets.map(async asset => ({ asset, url: await getAssetUrl(asset.path) })));
      if (alive.current) setResults(values);
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (alive.current) setBusy(false); }
  }
  const rectangles = size ? imageGridRectangles(size.width, size.height, rows, columns) : [];
  return <Dialog title="网格切图" className="image-grid-dialog" onClose={onClose}>
    <div className="dialog__body">
      <p className="tiny-meta">{asset.name} · {size ? `${size.width} × ${size.height}` : '正在读取原图…'}。切图会加入素材库，可逐张预览后再绑定到镜头或设定。</p>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="image-tools__fields">{(['rows', 'columns'] as const).map(field => <Field key={field} label={field === 'rows' ? '网格行数' : '网格列数'}><Select aria-label={field === 'rows' ? '网格行数' : '网格列数'} value={field === 'rows' ? rows : columns} disabled={!size || busy} onChange={event => { (field === 'rows' ? setRows : setColumns)(Number(event.target.value)); setResults([]); }}>{Array.from({ length: Math.min(8, (field === 'rows' ? size?.height : size?.width) ?? 1) }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</Select></Field>)}</div>
      {url && <div className="image-tools__source"><img src={url} alt="网格切图原图" /><div className="image-tools__grid" style={{ gridTemplateRows: `repeat(${rows},1fr)`, gridTemplateColumns: `repeat(${columns},1fr)` }}>{rectangles.map((_, index) => <span key={index}>{index + 1}</span>)}</div></div>}
      {results.length > 0 && <><Notice kind="success">已保存 {results.length} 张切图，来源和像素区域已记录。</Notice><div className="image-tools__results">{results.map(({ asset, url }, index) => <figure key={asset.id}><img src={url} alt={`切图 ${index + 1}`} /><figcaption>{index + 1} · {asset.width} × {asset.height}</figcaption></figure>)}</div></>}
    </div>
    <div className="dialog__footer"><Button onClick={onClose}>关闭</Button><Button variant="primary" disabled={!size || results.length > 0} busy={busy} onClick={() => void cut()}>保存 {rows * columns} 张切图</Button></div>
  </Dialog>;
}
