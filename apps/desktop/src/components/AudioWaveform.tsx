import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { audioWaveformSchema, type AssetRecord, type AudioWaveform as Waveform } from '@video-quickly/contracts';
import { rpc } from '../lib/client';
import { waveformColumns, waveformSpanColumns, type WaveformSpan } from '../lib/waveform-peaks';

const cache = new Map<string, Waveform>();
const requests = new Map<string, Promise<Waveform>>();

function readWaveform(asset: AssetRecord, key: string): Promise<Waveform> {
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return Promise.resolve(cached); }
  const pending = requests.get(key);
  if (pending) return pending;
  const request = rpc('asset.waveform', { assetId: asset.id }).then(value => {
    const waveform = audioWaveformSchema.parse(value);
    if (waveform.assetId !== asset.id || waveform.sha256 !== asset.sha256) throw new Error('波形与当前素材不匹配。');
    cache.set(key, waveform);
    while (cache.size > 16) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return waveform;
  }).finally(() => { requests.delete(key); });
  requests.set(key, request);
  return request;
}

export default memo(function AudioWaveform({ asset, sourceInUs, durationUs, spans, mappingError, loop = false, label = '旁白' }: { asset?: AssetRecord; sourceInUs: number; durationUs: number; spans?: readonly WaveformSpan[]; mappingError?: string; loop?: boolean; label?: string }) {
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);
  const [result, setResult] = useState<{ key: string; waveform?: Waveform; error?: string }>();
  const key = asset ? JSON.stringify([asset.id, asset.sha256, asset.version, asset.kind, asset.path]) : '';
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { root: element.closest('.timeline-scroll') });
    const resize = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(element); resize.observe(element);
    return () => { observer.disconnect(); resize.disconnect(); };
  }, []);
  useEffect(() => {
    if (!visible || !asset) return;
    let active = true;
    void readWaveform(asset, key).then(waveform => { if (active) setResult({ key, waveform }); }).catch(error => {
      if (active) setResult({ key, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { active = false; };
  }, [visible, key]);
  const current = result?.key === key ? result : undefined;
  const peaks = useMemo(() => current?.waveform ? spans ? waveformSpanColumns(current.waveform, spans, durationUs, Math.min(1600, Math.max(1, Math.ceil(width / 2)))) : waveformColumns(current.waveform, sourceInUs, durationUs, Math.min(1600, Math.max(1, Math.ceil(width / 2))), loop) : [], [current?.waveform, sourceInUs, durationUs, spans, width, loop]);
  const path = peaks.map((peak, index) => { const height = peak * 13; return `M${index + .5},${16 - height}V${16 + height}`; }).join('');
  const error = mappingError || (!asset?.active ? '关联音频素材缺失' : current?.error);
  const state = error ? 'error' : current?.waveform ? 'ready' : visible ? 'loading' : 'waiting';
  const range = spans ? `剪后 ${(durationUs / 1_000_000).toFixed(2)} 秒 · ${spans.length} 段源区间` : loop ? `从 ${(sourceInUs / 1_000_000).toFixed(2)} 秒起 · ${(durationUs / 1_000_000).toFixed(2)} 秒循环` : `${(sourceInUs / 1_000_000).toFixed(2)} – ${((sourceInUs + durationUs) / 1_000_000).toFixed(2)} 秒`;
  return <span ref={container} className={`audio-waveform audio-waveform--${state}`} data-status={state} data-asset-id={asset?.id} data-source-in-us={sourceInUs} data-duration-us={durationUs} data-span-count={spans?.length} title={error || `${label} · ${range}`}>
    {current?.waveform && !error ? <svg role="img" aria-label={`${label}真实音频波形，${range}`} viewBox={`0 0 ${peaks.length || 1} 32`} preserveAspectRatio="none"><line x1="0" y1="16" x2={peaks.length} y2="16" className="audio-waveform__zero" /><path d={path} /></svg> : <span className="audio-waveform__status" role={error ? 'status' : undefined}>{error ? '波形读取失败' : visible ? '正在读取波形…' : '波形待载入'}</span>}
    <span className="audio-waveform__label">{error ? error : `${label} · ${range}`}</span>
  </span>;
});
