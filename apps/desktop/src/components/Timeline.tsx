import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowLeft, ArrowRight, Copy, ListChecks, Magnet, Mic, Music2, ScanLine, Scissors, Trash2, X, ZoomIn, ZoomOut, SlidersHorizontal, Volume2, VolumeX } from 'lucide-react';
import { frameAtTime, timeAtFrame, type AssetRecord, type FrameRate, type ProjectDocument, type Shot, usesVideoAudio } from '@video-quickly/contracts';
import type { TimelineClip } from '@video-quickly/video';
import { canSplitShot, maximumSourceOutUs, minimumShotDurationUs, minimumSourceInUs, snapTimeUs } from '@video-quickly/video/editing';
import { PlaybackClock, usePlayback } from '../lib/playback';
import type { SelectionModifiers } from '../lib/shot-selection';
import { Button, IconButton, formatTime } from './Primitives';
import { ScenePreview } from './ScenePreview';
import AudioWaveform from './AudioWaveform';
import { shotWaveformSpans } from '../lib/clip-preview';
import './timeline.css';

interface Props {
  project: ProjectDocument; assets: AssetRecord[]; shots: Shot[]; timeline: TimelineClip[]; selectedId?: string; selectedIds?: readonly string[]; rate: FrameRate; clock: PlaybackClock;
  sourceDurationUs?: number; sourceStatus: 'none' | 'loading' | 'ready' | 'error'; editingDisabled: boolean;
  onSelect: (id: string, modifiers?: SelectionModifiers) => void | Promise<void>; onMove: (offset: number) => Promise<void>;
  onSelectAll?: () => void; onClearSelection?: () => void; onBulkEdit?: () => void;
  onDuplicate: () => Promise<void>; onRemove: () => Promise<void>; onSplit: () => Promise<void>;
  onReorder: (id: string, index: number, revision: number, ids?: readonly string[]) => Promise<void>;
  onTrim: (id: string, inUs: number, outUs: number, revision?: number) => Promise<void>;
  onOpenMusic?: () => void;
}
type Gesture = { pointerId: number; element: HTMLButtonElement; id: string; ids: readonly string[]; mode: 'move' | 'in' | 'out'; shot: Shot; x: number; width: number; totalUs: number; startUs: number; revision: number; previousTimeUs: number; moved: boolean; targetIndex: number; inUs: number; outUs: number; snappedUs?: number };
type DragView = { id: string; ids: readonly string[]; mode: Gesture['mode']; deltaPx: number; inUs: number; outUs: number; markerUs?: number };

export default memo(function Timeline({ project, assets, shots, timeline, selectedId, selectedIds, rate, clock, sourceDurationUs, sourceStatus, editingDisabled, onSelect, onSelectAll, onClearSelection, onBulkEdit, onMove, onDuplicate, onRemove, onSplit, onReorder, onTrim, onOpenMusic }: Props) {
  const [zoom, setZoom] = useState(1);
  const [snapping, setSnapping] = useState(true);
  const [drag, setDrag] = useState<DragView>();
  const [trackWidth, setTrackWidth] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | undefined>(undefined);
  const suppressClick = useRef(false);
  const anchor = useRef<{ time: number; x: number } | undefined>(undefined);
  const totalUs = timeline.at(-1)?.endUs ?? 0;
  const selectedIndex = shots.findIndex(shot => shot.id === selectedId);
  const selected = useMemo(() => { const ids = new Set(selectedIds ?? (selectedId ? [selectedId] : [])); return new Set(shots.filter(shot => ids.has(shot.id)).map(shot => shot.id)); }, [shots, selectedIds, selectedId]);
  const draggingIds = useMemo(() => new Set(drag?.ids), [drag?.ids]);
  const singleSelected = selected.size === 1 && Boolean(selectedId && selected.has(selectedId));
  const audioCount = shots.filter(shot => shot.audioAssetId).length;
  const originalCount = shots.filter(usesVideoAudio).length;
  const tracks = originalCount ? ['video', 'audio', 'original'] as const : ['video', 'audio'] as const;
  const assetById = useMemo(() => new Map(assets.map(asset => [asset.id, asset])), [assets]);
  const musicClips = project.musicClips ?? [];
  const trimmingDisabled = editingDisabled || !singleSelected || Boolean(shots[selectedIndex]?.locked) || sourceStatus === 'loading' || sourceStatus === 'error';
  const sourceOutLimit = sourceDurationUs === undefined ? undefined : maximumSourceOutUs(sourceDurationUs, rate);
  const divisions = Math.round(6 * zoom);
  useLayoutEffect(() => {
    if (!track.current) return;
    const observer = new ResizeObserver(entries => setTrackWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(track.current); return () => observer.disconnect();
  }, []);
  useEffect(() => () => { const current = gesture.current; gesture.current = undefined; if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId); }, []);
  function changeZoom(value: number) {
    if (value === zoom) return;
    const element = scroller.current;
    const ruler = element?.querySelector<HTMLElement>('.timeline-ruler');
    if (element && ruler) {
      const time = totalUs ? clock.getSnapshot().timeUs / totalUs : 0;
      anchor.current = { time, x: ruler.offsetLeft + ruler.clientWidth * time - element.scrollLeft };
    }
    setZoom(value);
  }
  useLayoutEffect(() => {
    if (scroller.current && anchor.current) {
      const { time, x } = anchor.current;
      const ruler = scroller.current.querySelector<HTMLElement>('.timeline-ruler');
      if (ruler) scroller.current.scrollLeft = ruler.offsetLeft + ruler.clientWidth * time - x;
      anchor.current = undefined;
    }
  }, [zoom]);
  function begin(event: PointerEvent<HTMLButtonElement>, shot: Shot, index: number, mode: Gesture['mode']) {
    suppressClick.current = false;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || editingDisabled || !track.current || (mode !== 'move' && trimmingDisabled)) return;
    const width = track.current.getBoundingClientRect().width;
    if (!width || !totalUs) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    clock.pause();
    const ids = mode === 'move' && selected.has(shot.id) ? shots.filter(value => selected.has(value.id)).map(value => value.id) : [shot.id];
    const firstIndex = mode === 'move' && selected.has(shot.id) ? shots.findIndex(value => selected.has(value.id)) : index;
    const inUs = shot.clipEdit?.inUs ?? shot.sourceInUs ?? 0;
    gesture.current = { pointerId: event.pointerId, element: event.currentTarget, id: shot.id, ids, shot, mode, x: event.clientX, width, totalUs, startUs: timeline[firstIndex].startUs, revision: project.revision, previousTimeUs: clock.getSnapshot().timeUs, moved: false, targetIndex: firstIndex, inUs, outUs: inUs + shot.durationUs };
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const delta = event.clientX - current.x;
    if (!current.moved && Math.abs(delta) < 4) return;
    current.moved = true;
    const deltaUs = delta / current.width * current.totalUs;
    const threshold = snapping && !event.altKey ? 8 / current.width * current.totalUs : 0;
    const originalIn = current.shot.clipEdit?.inUs ?? current.shot.sourceInUs ?? 0;
    let markerUs: number | undefined;
    if (current.mode === 'move') {
      const moving = new Set(current.ids), remaining = shots.filter(shot => !moving.has(shot.id));
      const slots = [0]; for (const shot of remaining) slots.push(slots.at(-1)! + shot.durationUs);
      const proposed = current.startUs + deltaUs;
      const snapped = snapTimeUs(proposed, rate, slots, threshold);
      current.targetIndex = slots.reduce((best, value, index) => Math.abs(value - snapped) < Math.abs(slots[best] - snapped) ? index : best, 0);
      markerUs = slots[current.targetIndex];
    } else {
      const edge = current.mode === 'in' ? current.startUs : current.startUs + current.shot.durationUs;
      const proposed = edge + deltaUs;
      const anchors = [...timeline.flatMap(clip => [clip.startUs, clip.endUs]), current.previousTimeUs];
      const snapped = snapTimeUs(proposed, rate, anchors, threshold);
      const shift = snapped - edge;
      const minimum = minimumShotDurationUs(rate);
      if (current.mode === 'in') current.inUs = Math.max(minimumSourceInUs(current.shot), Math.min(originalIn + current.shot.durationUs - minimum, originalIn + shift));
      else current.outUs = Math.max(originalIn + minimum, Math.min(sourceOutLimit ?? originalIn + 600_000_000, originalIn + current.shot.durationUs + shift));
      markerUs = current.startUs + (current.mode === 'in' ? current.inUs - originalIn : current.outUs - originalIn);
      clock.seek(markerUs);
    }
    current.snappedUs = markerUs;
    setDrag({ id: current.id, ids: current.ids, mode: current.mode, deltaPx: delta, inUs: current.inUs, outUs: current.outUs, markerUs });
  }
  function finish(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (event.type === 'pointerup') move(event);
    gesture.current = undefined; setDrag(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!current.moved) return;
    suppressClick.current = true;
    if (event.type !== 'pointerup') { clock.seek(current.previousTimeUs); return; }
    if (current.mode === 'move') void onReorder(current.id, current.targetIndex, current.revision, current.ids);
    else void onTrim(current.id, current.inUs, current.outUs, current.revision);
  }
  function trimKey(event: KeyboardEvent<HTMLButtonElement>, shot: Shot, side: 'in' | 'out') {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || trimmingDisabled) return;
    event.preventDefault(); event.stopPropagation();
    const frame = event.key === 'ArrowLeft' ? -1 : 1;
    const inUs = shot.clipEdit?.inUs ?? shot.sourceInUs ?? 0, outUs = inUs + shot.durationUs;
    const target = timeAtFrame(frameAtTime(side === 'in' ? inUs : outUs, rate) + frame * (event.shiftKey ? 10 : 1), rate);
    if (side === 'in' && target >= minimumSourceInUs(shot) && outUs - target >= minimumShotDurationUs(rate)) void onTrim(shot.id, target, outUs, project.revision);
    if (side === 'out' && target - inUs >= minimumShotDurationUs(rate) && (sourceOutLimit === undefined || target <= sourceOutLimit)) void onTrim(shot.id, inUs, target, project.revision);
  }
  function selectionKey(event: KeyboardEvent<HTMLElement>) {
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const selectAll = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a' && Boolean(onSelectAll);
    const clear = event.key === 'Escape' && Boolean(onClearSelection);
    if (selectAll || clear) {
      event.preventDefault(); event.stopPropagation();
      const current = gesture.current; gesture.current = undefined; setDrag(undefined);
      if (current) { suppressClick.current = true; clock.seek(current.previousTimeUs); if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId); }
      if (event.key === 'Escape') onClearSelection?.(); else onSelectAll?.();
    }
  }
  return <section className="timeline" aria-label="项目时间轴" onKeyDown={selectionKey}>
    <div className="timeline-toolbar">
      <div className="timeline-heading"><h2>时间轴</h2><span className="timeline-summary">{shots.length} 个镜头</span><span className="timeline-selection-count" aria-live="polite">已选 {selected.size} 个镜头</span></div>
      <div className="timeline-edit-actions" role="group" aria-label="镜头操作">
        {onSelectAll && <IconButton label="全选镜头" disabled={!shots.length || selected.size === shots.length} onClick={onSelectAll}><ListChecks size={15} /></IconButton>}
        {onClearSelection && <IconButton label="清除镜头选择" disabled={!selected.size} onClick={onClearSelection}><X size={15} /></IconButton>}
        {onBulkEdit && <Button className="timeline-bulk-button" disabled={editingDisabled || !selected.size} onClick={onBulkEdit}><SlidersHorizontal size={14} />批量编辑镜头</Button>}
        <SplitControl shot={shots[selectedIndex]} clip={timeline[selectedIndex]} rate={rate} clock={clock} disabled={editingDisabled || !singleSelected} onSplit={onSplit} />
        <IconButton label="将镜头前移" disabled={editingDisabled || !selected.size || singleSelected && selectedIndex <= 0} onClick={() => void onMove(-1)}><ArrowLeft size={15} /></IconButton>
        <IconButton label="将镜头后移" disabled={editingDisabled || !selected.size || singleSelected && selectedIndex >= shots.length - 1} onClick={() => void onMove(1)}><ArrowRight size={15} /></IconButton>
        <IconButton label="复制镜头" disabled={editingDisabled || !selected.size} onClick={() => void onDuplicate()}><Copy size={15} /></IconButton>
        <IconButton label="移除所选镜头" disabled={editingDisabled || !selected.size} onClick={() => void onRemove()}><Trash2 size={15} /></IconButton>
        <IconButton label="时间轴吸附" aria-pressed={snapping} title="吸附到镜头边界和播放头；按住 Alt 临时关闭" onClick={() => setSnapping(value => !value)}><Magnet size={15} /></IconButton>
      </div>
      {drag ? <output className="timeline-drag-readout">{drag.mode === 'move' ? '调整镜头顺序' : `${(drag.inUs / 1e6).toFixed(3)} – ${(drag.outUs / 1e6).toFixed(3)} 秒`}</output> : <TimelineReadout clock={clock} rate={rate} />}
      <div className="timeline-view-actions" role="group" aria-label="时间轴视图">
        <IconButton label="适配完整时间轴" onClick={() => changeZoom(1)}><ScanLine size={16} /></IconButton>
        <IconButton className="timeline-zoom-step" label="缩小时间轴" disabled={zoom <= 1} onClick={() => changeZoom(Math.max(1, Math.round((zoom - .5) * 10) / 10))}><ZoomOut size={15} /></IconButton>
        <input className="timeline-zoom" aria-label="时间轴缩放" type="range" min="1" max="5" step="0.1" value={zoom} onChange={event => changeZoom(Number(event.target.value))} />
        <IconButton className="timeline-zoom-step" label="放大时间轴" disabled={zoom >= 5} onClick={() => changeZoom(Math.min(5, Math.round((zoom + .5) * 10) / 10))}><ZoomIn size={15} /></IconButton>
        <span className="timeline-zoom-value">{Math.round(zoom * 100)}%</span>
      </div>
    </div>
    <div className="timeline-body">
      <div className="timeline-track-headers" aria-label="轨道信息">
        <div className="track-header-ruler"><span>轨道</span><span>{2 + (musicClips.length ? 1 : 0) + (originalCount ? 1 : 0)}</span></div>
        <div className="track-header track-header--video"><strong>画面</strong><small>{shots.length} 个片段</small></div>
        <div className="track-header track-header--audio"><span className="track-header__type"><Mic size={14} /><b>A1</b></span><strong>旁白</strong><small>{audioCount ? `${audioCount} 段音频` : '待添加'}</small></div>
        {originalCount > 0 && <div className="track-header track-header--audio"><span className="track-header__type"><Volume2 size={14} /><b>A2</b></span><strong>原声</strong><small>{originalCount} 段</small></div>}
        {musicClips.length > 0 && <div className="track-header track-header--audio"><span className="track-header__type"><Music2 size={14} /><b>{originalCount ? 'A3' : 'A2'}</b></span><strong>背景音乐</strong><small>{musicClips.length} 段音频</small></div>}
      </div>
      <div className="timeline-scroll" ref={scroller}><div className="timeline-content" style={{ width: `${zoom * 100}%` }}>
        <TimelinePosition clock={clock} rate={rate} totalUs={totalUs} zoom={zoom} />
        {drag?.markerUs !== undefined && <div className="timeline-drop-marker" aria-hidden="true" style={{ left: `calc(12px + (100% - 32px) * ${drag.markerUs / (totalUs || 1)})` }} />}
        {tracks.map(kind => <div className={`track track--${kind} ${kind === 'original' ? 'track--audio' : ''}`} key={kind} style={{ backgroundSize: `${100 / divisions}% 100%` }}><div className="track-clips" ref={kind === 'video' ? track : undefined}>
          {shots.map((shot, index) => {
            const clip = timeline[index];
            const active = drag && (drag.mode === 'move' ? draggingIds.has(shot.id) : drag.id === shot.id) ? drag : undefined;
            const clipInUs = shot.clipEdit?.inUs ?? shot.sourceInUs ?? 0;
            const startUs = clip.startUs + (active?.mode === 'in' ? active.inUs - clipInUs : 0);
            const durationUs = active && active.mode !== 'move' ? active.outUs - active.inUs : clip.durationUs;
            // Keep the captured handle mounted until even a narrow trim gesture finishes.
            const trimming = active?.mode === 'in' || active?.mode === 'out';
            const handles = kind === 'video' && singleSelected && shot.id === selectedId && (trimming || trackWidth * durationUs / (totalUs || 1) > 84);
            const sounding = kind === 'audio' ? Boolean(shot.audioAssetId) : kind === 'original' && usesVideoAudio(shot);
            const soundAsset = assetById.get((kind === 'original' ? shot.videoAssetId : shot.audioAssetId) ?? '');
            return <div className={`timeline-clip timeline-clip--${kind} ${kind === 'original' ? 'timeline-clip--audio' : ''} ${kind !== 'video' && !sounding ? 'timeline-clip--pending' : ''} ${selected.has(shot.id) ? 'selected' : ''} ${active ? 'is-editing' : ''}`} key={shot.id} style={{ left: `${totalUs ? startUs / totalUs * 100 : 0}%`, width: `calc(${totalUs ? durationUs / totalUs * 100 : 0}% - 2px)`, transform: active?.mode === 'move' ? `translateX(${active.deltaPx}px)` : undefined }}>
              <button type="button" className="timeline-clip__select" disabled={editingDisabled} onPointerDown={event => begin(event, shot, index, 'move')} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onClick={event => { if (suppressClick.current && event.detail) { suppressClick.current = false; return; } suppressClick.current = false; void onSelect(shot.id, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey, keepGroup: !event.ctrlKey && !event.metaKey && !event.shiftKey && selected.has(shot.id) }); }} aria-pressed={selected.has(shot.id)} aria-label={`${kind === 'video' ? '定位镜头' : kind === 'original' ? '定位原声' : '定位旁白'} ${index + 1}：${shot.title}`} title={`${shot.title} · ${(shot.durationUs / 1_000_000).toFixed(3)} 秒；Ctrl/⌘ 切换选择，Shift 连续选择；拖动调整顺序`}>
                {kind === 'video' ? <><span className="timeline-clip__title"><span className="timeline-clip__index">{(index + 1).toString().padStart(2, '0')}</span><span>{shot.title}</span></span><span className="timeline-clip__media"><span className="timeline-clip__thumbnail"><ScenePreview project={project} shot={shot} shotIndex={index} assets={assets} thumbnail /></span><span className="timeline-clip__duration">{(durationUs / 1_000_000).toFixed(1)}s</span></span></> : sounding ? <ShotAudioWaveform project={project} shot={shot} kind={kind === 'original' ? 'video' : 'audio'} asset={soundAsset} active={active?.mode !== 'move' ? active : undefined} durationUs={durationUs} rate={rate} sourceDurationUs={sourceDurationUs} /> : <span className="timeline-clip__audio">{kind === 'original' ? <VolumeX size={15} /> : <Mic size={15} />}<span>{kind === 'original' ? (shot.videoAssetId ? '原声关闭' : '未关联视频') : '待配音'}</span></span>}
              </button>
              {handles && (['in', 'out'] as const).map(side => <button key={side} type="button" role="slider" className={`timeline-trim-handle timeline-trim-handle--${side}`} disabled={trimmingDisabled} aria-label={side === 'in' ? '镜头入点' : '镜头出点'} aria-valuemin={Math.round(minimumSourceInUs(shot) / 1000)} aria-valuemax={Math.round((sourceOutLimit ?? clipInUs + 600_000_000) / 1000)} aria-valuenow={Math.round((side === 'in' ? active?.inUs ?? clipInUs : active?.outUs ?? clipInUs + shot.durationUs) / 1000)} aria-valuetext="方向键逐帧调整，Shift 调整十帧" onPointerDown={event => begin(event, shot, index, side)} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onKeyDown={event => trimKey(event, shot, side)} />)}
            </div>;
          })}
        </div></div>)}
        {musicClips.length > 0 && <div className="track track--audio track--music" style={{ backgroundSize: `${100 / divisions}% 100%` }}><div className="track-clips">
          {musicClips.map(clip => {
            const visibleDuration = Math.min(clip.durationUs, totalUs - clip.startUs);
            if (visibleDuration <= 0) return null;
            return <div className="timeline-clip timeline-clip--audio timeline-clip--music" key={clip.id} style={{ left: `${clip.startUs / totalUs * 100}%`, width: `calc(${visibleDuration / totalUs * 100}% - 2px)` }}>
              <button type="button" className="timeline-clip__select" disabled={editingDisabled || !onOpenMusic} onClick={onOpenMusic} aria-label={`编辑背景音乐：${assetById.get(clip.assetId)?.name ?? '素材缺失'}`}>
                <AudioWaveform asset={assetById.get(clip.assetId)} sourceInUs={clip.sourceInUs} durationUs={visibleDuration} loop={clip.loop} label="背景音乐" />
              </button>
            </div>;
          })}
        </div></div>}
      </div></div>
    </div>
  </section>;
});

const ShotAudioWaveform = memo(function ShotAudioWaveform({ project, shot, asset, active, durationUs, rate, sourceDurationUs, kind = 'audio' }: { project: ProjectDocument; shot: Shot; kind?: 'audio' | 'video'; asset?: AssetRecord; active?: DragView; durationUs: number; rate: FrameRate; sourceDurationUs?: number }) {
  const resolved = useMemo(() => {
    try { return { spans: shotWaveformSpans(shot, project, active ? { inUs: active.inUs, outUs: active.outUs, rate, sourceDurationUs } : undefined, kind), error: undefined }; }
    catch (error) { return { spans: undefined, error: error instanceof Error ? error.message : String(error) }; }
  }, [shot, project.clipEditSources, project.clipEditPlans, active?.inUs, active?.outUs, rate.numerator, rate.denominator, sourceDurationUs, kind]);
  return <AudioWaveform asset={asset} sourceInUs={resolved.spans?.[0]?.sourceInUs ?? (kind === 'video' ? shot.videoInUs : shot.audioInUs) ?? shot.sourceInUs ?? 0} durationUs={durationUs} spans={shot.clipEdit ? resolved.spans : undefined} mappingError={resolved.error} label={kind === 'video' ? '视频原声' : '旁白'} />;
});

const SplitControl = memo(function SplitControl({ shot, clip, rate, clock, disabled, onSplit }: { shot?: Shot; clip?: TimelineClip; rate: FrameRate; clock: PlaybackClock; disabled: boolean; onSplit: () => Promise<void> }) {
  const { timeUs } = usePlayback(clock);
  return <IconButton label="在播放头处分割镜头" title="在播放头处分割镜头（S）" disabled={disabled || !shot || shot.locked || !clip || !canSplitShot(shot, timeUs - clip.startUs, rate)} aria-keyshortcuts="S" onClick={() => void onSplit()}><Scissors size={15} /></IconButton>;
});

const TimelineReadout = memo(function TimelineReadout({ clock, rate }: { clock: PlaybackClock; rate: FrameRate }) {
  const { timeUs } = usePlayback(clock);
  return <output className="timeline-readout" aria-label="时间轴当前时间" aria-live="off"><b>{formatTime(timeUs)}</b><span>F {frameAtTime(timeUs, rate) + 1}</span></output>;
});

function TimelinePosition({ clock, rate, totalUs, zoom }: { clock: PlaybackClock; rate: FrameRate; totalUs: number; zoom: number }) {
  const { timeUs, playing } = usePlayback(clock);
  const ruler = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ id: number; left: number; width: number } | undefined>(undefined);
  const pending = useRef<number | undefined>(undefined);
  const request = useRef<number | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const flush = () => { if (pending.current !== undefined) { clock.seek(pending.current); pending.current = undefined; } };
  const cancelRequest = () => { if (request.current !== undefined) cancelAnimationFrame(request.current); request.current = undefined; };
  useEffect(() => () => { if (request.current !== undefined) cancelAnimationFrame(request.current); }, []);
  useEffect(() => {
    if (!playing || !ruler.current) return;
    const element = ruler.current.closest('.timeline-scroll');
    if (!(element instanceof HTMLElement)) return;
    const x = ruler.current.offsetLeft + ruler.current.clientWidth * (totalUs ? timeUs / totalUs : 0);
    if (x > element.scrollLeft + element.clientWidth - 28) element.scrollLeft = x - element.clientWidth * .25;
    else if (x < element.scrollLeft + ruler.current.offsetLeft) element.scrollLeft = Math.max(0, x - ruler.current.offsetLeft);
  }, [playing, timeUs, totalUs, zoom]);
  function position(clientX: number) {
    const bounds = pointer.current;
    if (bounds) pending.current = Math.max(0, Math.min(totalUs, (clientX - bounds.left) / bounds.width * totalUs));
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !totalUs) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    pointer.current = { id: event.pointerId, left: bounds.left, width: bounds.width };
    event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus();
    setDragging(true); position(event.clientX); flush();
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (pointer.current?.id !== event.pointerId) return;
    position(event.clientX);
    if (request.current === undefined) request.current = requestAnimationFrame(() => { request.current = undefined; flush(); });
  }
  function pointerEnd(event: PointerEvent<HTMLDivElement>) {
    if (pointer.current?.id !== event.pointerId) return;
    if (event.type === 'pointerup') position(event.clientX);
    cancelRequest(); flush(); pointer.current = undefined; setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keydown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') clock.step(step);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') clock.step(-step);
    else if (event.key === 'Home') clock.seek(0);
    else if (event.key === 'End') clock.seek(totalUs);
    else return;
    event.preventDefault(); event.stopPropagation();
  }
  const divisions = Math.round(6 * zoom);
  return <><div ref={ruler} className={`timeline-ruler ${dragging ? 'is-scrubbing' : ''}`} style={{ backgroundSize: `${100 / (divisions * 5)}% 6px` }} role="slider" tabIndex={0} aria-label="预览播放位置" aria-disabled={!totalUs} aria-valuemin={0} aria-valuemax={Math.round(totalUs / 1000)} aria-valuenow={Math.round(timeUs / 1000)} aria-valuetext={`${formatTime(timeUs)}，第 ${frameAtTime(timeUs, rate) + 1} 帧`} aria-keyshortcuts="ArrowLeft ArrowRight Home End" onKeyDown={keydown} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd}><TimelineRulerMarks divisions={divisions} totalUs={totalUs} /></div><div className="playhead-lane" aria-hidden="true"><div className={`playhead ${dragging ? 'is-scrubbing' : ''}`} style={{ transform: `translateX(${totalUs ? timeUs / totalUs * 100 : 0}%)` }} /></div></>;
}

const TimelineRulerMarks = memo(function TimelineRulerMarks({ divisions, totalUs }: { divisions: number; totalUs: number }) {
  const fractional = totalUs % (divisions * 1_000_000) !== 0;
  return Array.from({ length: totalUs ? divisions + 1 : 1 }, (_, index) => {
    const label = formatTime(totalUs * index / divisions);
    return <span className="ruler-marker" key={index} style={{ left: `${index / divisions * 100}%` }}><span>{fractional ? label : label.split('.')[0]}</span></span>;
  });
});
