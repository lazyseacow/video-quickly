import { memo, useMemo, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { Mic, VolumeX } from 'lucide-react';
import type { AssetRecord, FrameRate, Shot } from '@video-quickly/contracts';
import { minimumSourceInUs } from '@video-quickly/video/editing';
import { shotWaveformSpans } from '../lib/clip-preview';
import { ScenePreview, type ScenePreviewProject } from './ScenePreview';
import AudioWaveform from './AudioWaveform';

export interface TimelineDragView { id: string; ids: readonly string[]; mode: 'move' | 'in' | 'out'; deltaPx: number; inUs: number; outUs: number; markerUs?: number }
export interface TimelineRowHandlers {
  begin: (event: PointerEvent<HTMLButtonElement>, shot: Shot, index: number, mode: TimelineDragView['mode']) => void;
  move: (event: PointerEvent<HTMLButtonElement>) => void;
  finish: (event: PointerEvent<HTMLButtonElement>) => void;
  select: (event: MouseEvent<HTMLButtonElement>, shot: Shot) => void;
  trimKey: (event: KeyboardEvent<HTMLButtonElement>, shot: Shot, side: 'in' | 'out') => void;
}
interface Props {
  project: ScenePreviewProject; assets: AssetRecord[]; shot: Shot; index: number; kind: 'video' | 'audio' | 'original';
  selected: boolean; active?: TimelineDragView; startUs: number; durationUs: number; totalUs: number; thumbnailCount: number;
  handles: boolean; trimmingDisabled: boolean; editingDisabled: boolean; sourceOutLimit?: number; sourceDurationUs?: number;
  rate: FrameRate; sounding: boolean; soundAsset?: AssetRecord; modifierLabel: string; handlers: TimelineRowHandlers;
}

export default memo(function TimelineShotRow({ project, assets, shot, index, kind, selected, active, startUs, durationUs, totalUs, thumbnailCount, handles, trimmingDisabled, editingDisabled, sourceOutLimit, sourceDurationUs, rate, sounding, soundAsset, modifierLabel, handlers }: Props) {
  const clipInUs = shot.clipEdit?.inUs ?? shot.sourceInUs ?? 0;
  return <div className={`timeline-clip timeline-clip--${kind} ${kind === 'original' ? 'timeline-clip--audio' : ''} ${kind !== 'video' && !sounding ? 'timeline-clip--pending' : ''} ${selected ? 'selected' : ''} ${active ? 'is-editing' : ''}`} style={{ left: `${totalUs ? startUs / totalUs * 100 : 0}%`, width: `calc(${totalUs ? durationUs / totalUs * 100 : 0}% - 2px)`, transform: active?.mode === 'move' ? `translateX(${active.deltaPx}px)` : undefined }}>
    <button type="button" className="timeline-clip__select" disabled={editingDisabled} onPointerDown={event => handlers.begin(event, shot, index, 'move')} onPointerMove={handlers.move} onPointerUp={handlers.finish} onPointerCancel={handlers.finish} onLostPointerCapture={handlers.finish} onClick={event => handlers.select(event, shot)} aria-pressed={selected} aria-label={`${kind === 'video' ? '定位镜头' : kind === 'original' ? '定位原声' : '定位旁白'} ${index + 1}：${shot.title}`} title={`${shot.title} · ${(shot.durationUs / 1_000_000).toFixed(3)} 秒；${modifierLabel} 切换选择，Shift 连续选择；拖动调整顺序`}>
      {kind === 'video' ? <>
        <span className="timeline-clip__title"><span className="timeline-clip__index">{(index + 1).toString().padStart(2, '0')}</span><span>{shot.title}</span></span>
        <span className="timeline-clip__media">
          {Array.from({ length: thumbnailCount }, (_, frameIndex) => <span className="timeline-clip__thumbnail" key={frameIndex} aria-hidden={frameIndex > 0 || undefined}>
            <ScenePreview project={project} shot={shot} shotIndex={index} assets={assets} timeUs={Math.floor(frameIndex * shot.durationUs / thumbnailCount)} thumbnail />
          </span>)}
          <span className="timeline-clip__duration">{(durationUs / 1_000_000).toFixed(1)}s</span>
        </span>
      </> : sounding ? <ShotAudioWaveform project={project} shot={shot} kind={kind === 'original' ? 'video' : 'audio'} asset={soundAsset} active={active?.mode !== 'move' ? active : undefined} durationUs={durationUs} rate={rate} sourceDurationUs={sourceDurationUs} /> : <span className="timeline-clip__audio">{kind === 'original' ? <VolumeX size={15} /> : <Mic size={15} />}<span>{kind === 'original' ? (shot.videoAssetId ? '原声关闭' : '未关联视频') : '待配音'}</span></span>}
    </button>
    {handles && (['in', 'out'] as const).map(side => <button key={side} type="button" role="slider" className={`timeline-trim-handle timeline-trim-handle--${side}`} disabled={trimmingDisabled} aria-label={side === 'in' ? '镜头入点' : '镜头出点'} aria-valuemin={Math.round(minimumSourceInUs(shot) / 1000)} aria-valuemax={Math.round((sourceOutLimit ?? clipInUs + 600_000_000) / 1000)} aria-valuenow={Math.round((side === 'in' ? active?.inUs ?? clipInUs : active?.outUs ?? clipInUs + shot.durationUs) / 1000)} aria-valuetext="方向键逐帧调整，Shift 调整十帧" onPointerDown={event => handlers.begin(event, shot, index, side)} onPointerMove={handlers.move} onPointerUp={handlers.finish} onPointerCancel={handlers.finish} onLostPointerCapture={handlers.finish} onKeyDown={event => handlers.trimKey(event, shot, side)} />)}
  </div>;
});

const ShotAudioWaveform = memo(function ShotAudioWaveform({ project, shot, asset, active, durationUs, rate, sourceDurationUs, kind = 'audio' }: { project: ScenePreviewProject; shot: Shot; kind?: 'audio' | 'video'; asset?: AssetRecord; active?: TimelineDragView; durationUs: number; rate: FrameRate; sourceDurationUs?: number }) {
  const resolved = useMemo(() => {
    try { return { spans: shotWaveformSpans(shot, project, active ? { inUs: active.inUs, outUs: active.outUs, rate, sourceDurationUs } : undefined, kind), error: undefined }; }
    catch (error) { return { spans: undefined, error: error instanceof Error ? error.message : String(error) }; }
  }, [shot, project.clipEditSources, project.clipEditPlans, active?.inUs, active?.outUs, rate.numerator, rate.denominator, sourceDurationUs, kind]);
  const original = kind === 'video';
  return <AudioWaveform asset={asset} sourceInUs={resolved.spans?.[0]?.sourceInUs ?? (original ? shot.videoInUs : shot.audioInUs) ?? shot.sourceInUs ?? 0} durationUs={durationUs} spans={shot.clipEdit ? resolved.spans : undefined} mappingError={resolved.error} label={original ? '视频原声' : '旁白'} showSourceLabel={!original} />;
});
