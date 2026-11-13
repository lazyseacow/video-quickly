import { primaryModifier } from '../lib/desktop';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { ArrowLeft, ArrowRight, Copy, ListChecks, Magnet, Mic, Music2, RotateCcw, Scissors, Trash2, X, ZoomIn, ZoomOut, SlidersHorizontal, Volume2 } from 'lucide-react';
import { frameAtTime, timeAtFrame, type AssetRecord, type FrameRate, type ProjectDocument, type Shot, usesVideoAudio } from '@video-quickly/contracts';
import type { TimelineClip } from '@video-quickly/video';
import { canSplitShot, maximumSourceOutUs, minimumShotDurationUs, minimumSourceInUs, snapTimeUs } from '@video-quickly/video/editing';
import { PlaybackClock, usePlayback } from '../lib/playback';
import { beginGuideAction } from '../lib/guide-actions';
import type { SelectionModifiers } from '../lib/shot-selection';
import { Button, IconButton, formatTime } from './Primitives';
import AudioWaveform from './AudioWaveform';
import TimelineShotRow, { type TimelineDragView as DragView, type TimelineRowHandlers } from './TimelineShotRow';
import { useScenePreviewContext } from '../lib/scene-preview-context';
import { CLIP_GAP_PX, createTimelineLayout, MINIMUM_CLIP_WIDTH_PX, type TimelineLayout } from '../lib/timeline-layout';
import { useCommittedCallback } from '../lib/use-committed-callback';
import './timeline.css';

const THUMBNAIL_WIDTH_PX = 72;
const MAX_THUMBNAILS_PER_CLIP = 48;

interface Props {
  project: ProjectDocument; assets: AssetRecord[]; shots: Shot[]; timeline: TimelineClip[]; selectedId?: string; selectedIds?: readonly string[]; rate: FrameRate; clock: PlaybackClock;
  sourceDurationUs?: number; sourceStatus: 'none' | 'loading' | 'ready' | 'error'; editingDisabled: boolean; readOnly?: boolean;
  onSelect: (id: string, modifiers?: SelectionModifiers) => void | Promise<void>; onMove: (offset: number) => Promise<void>;
  onSelectAll?: () => void; onClearSelection?: () => void; onBulkEdit?: () => void;
  onDuplicate: () => Promise<void>; onRemove: () => Promise<void>; onSplit: () => Promise<void>;
  onReorder: (id: string, index: number, revision: number, ids?: readonly string[]) => Promise<void>;
  onTrim: (id: string, inUs: number, outUs: number, revision?: number) => Promise<void>;
  onOpenMusic?: () => void;
}
type Gesture = {
  pointerId: number; element: HTMLButtonElement; id: string; index: number; ids: readonly string[]; mode: 'move' | 'in' | 'out'; shot: Shot;
  x: number; layout: TimelineLayout; startUs: number; revision: number; previousTimeUs: number;
  slots: number[]; moved: boolean; targetIndex: number; inUs: number; outUs: number;
};

export default memo(function Timeline({ project, assets, shots, timeline, selectedId, selectedIds, rate, clock, sourceDurationUs, sourceStatus, editingDisabled, readOnly = false, onSelect, onSelectAll, onClearSelection, onBulkEdit, onMove, onDuplicate, onRemove, onSplit, onReorder, onTrim, onOpenMusic }: Props) {
  const [zoom, setZoom] = useState(1);
  const [snapping, setSnapping] = useState(true);
  const [drag, setDrag] = useState<DragView>();
  const [viewportWidth, setViewportWidth] = useState(0);
  const modifierLabel = primaryModifier().label;
  const previewContext = useScenePreviewContext(project);
  const scroller = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | undefined>(undefined);
  const suppressClick = useRef(false);
  const lastRevealedShot = useRef<TimelineClip | undefined>(undefined);
  const anchor = useRef<{ timeUs: number; x: number } | undefined>(undefined);
  const layout = useMemo(() => createTimelineLayout(timeline, viewportWidth, zoom), [timeline, viewportWidth, zoom]);
  const { totalUs } = layout;
  const trim = drag && drag.mode !== 'move' ? drag : undefined;
  const visibleLayout = useMemo(() => trim ? createTimelineLayout(timeline, viewportWidth, zoom, { index: trim.index, durationUs: trim.outUs - trim.inUs }) : layout, [trim, timeline, viewportWidth, zoom, layout]);
  const markerX = trim ? visibleLayout.edges[trim.index + Number(trim.mode === 'out')] : drag?.markerX;
  const selectedIndex = shots.findIndex(shot => shot.id === selectedId);
  const selected = useMemo(() => { const ids = new Set(selectedIds ?? (selectedId ? [selectedId] : [])); return new Set(shots.filter(shot => ids.has(shot.id)).map(shot => shot.id)); }, [shots, selectedIds, selectedId]);
  const draggingIds = useMemo(() => new Set(drag?.ids), [drag?.ids]);
  const singleSelected = selected.size === 1 && Boolean(selectedId && selected.has(selectedId));
  const audioCount = shots.filter(shot => shot.audioAssetId).length;
  const originalCount = shots.filter(usesVideoAudio).length;
  const tracks = ['video' as const, ...(audioCount ? ['audio' as const] : []), ...(originalCount ? ['original' as const] : [])];
  const assetById = useMemo(() => new Map(assets.map(asset => [asset.id, asset])), [assets]);
  const musicClips = project.musicClips ?? [];
  const trimmingDisabled = editingDisabled || !singleSelected || Boolean(shots[selectedIndex]?.locked) || sourceStatus === 'loading' || sourceStatus === 'error';
  const sourceOutLimit = sourceDurationUs === undefined ? undefined : maximumSourceOutUs(sourceDurationUs, rate);
  const preferredDivisions = Math.max(Math.round(6 * zoom), visibleLayout.minimumWidthsApplied ? Math.round(visibleLayout.width / 160) : 0);
  const divisions = Math.max(1, Math.min(preferredDivisions, Math.floor(visibleLayout.width / MINIMUM_CLIP_WIDTH_PX)));
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setViewportWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => { const current = gesture.current; gesture.current = undefined; if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId); }, []);
  useLayoutEffect(() => {
    const current = gesture.current;
    if (!readOnly || !current) return;
    gesture.current = undefined;
    suppressClick.current = current.moved;
    setDrag(undefined);
    if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  }, [readOnly]);
  function changeZoom(value: number) {
    if (value === zoom) return;
    const element = scroller.current;
    if (element) {
      const { timeUs } = clock.getSnapshot();
      anchor.current = { timeUs, x: layout.xAt(timeUs) - element.scrollLeft };
    }
    setZoom(value);
  }
  useLayoutEffect(() => {
    if (scroller.current && anchor.current) {
      const { timeUs, x } = anchor.current;
      scroller.current.scrollLeft = layout.xAt(timeUs) - x;
      anchor.current = undefined;
    }
  }, [layout]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !viewportWidth || drag) return;
    const clip = timeline[selectedIndex];
    const previous = lastRevealedShot.current;
    lastRevealedShot.current = clip;
    if (!clip || (clip.shotId === previous?.shotId && clip.startUs === previous.startUs)) return;
    const left = layout.edges[selectedIndex];
    const right = layout.edges[selectedIndex + 1];
    if (left < element.scrollLeft || right > element.scrollLeft + viewportWidth) {
      element.scrollLeft = right - left > viewportWidth || left < element.scrollLeft ? left : right - viewportWidth;
    }
  }, [drag, layout, selectedIndex, timeline, viewportWidth]);
  function begin(event: PointerEvent<HTMLButtonElement>, shot: Shot, index: number, mode: Gesture['mode']) {
    suppressClick.current = false;
    const element = scroller.current;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || editingDisabled || readOnly || !element || !totalUs || (mode !== 'move' && trimmingDisabled)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    clock.pause();
    const moveSelection = mode === 'move' && selected.has(shot.id);
    const ids = moveSelection ? shots.filter(value => selected.has(value.id)).map(value => value.id) : [shot.id];
    const firstIndex = moveSelection ? shots.findIndex(value => selected.has(value.id)) : index;
    const slots = [0];
    if (mode === 'move') {
      const moving = new Set(ids);
      timeline.forEach((clip, index) => {
        if (!moving.has(clip.shotId)) slots.push(slots.at(-1)! + layout.edges[index + 1] - layout.edges[index]);
      });
    }
    const inUs = shot.clipEdit?.inUs ?? shot.sourceInUs ?? 0;
    gesture.current = {
      pointerId: event.pointerId, element: event.currentTarget, id: shot.id, index, ids, shot, mode,
      x: event.clientX + element.scrollLeft, layout, startUs: timeline[firstIndex].startUs, revision: project.revision,
      previousTimeUs: clock.getSnapshot().timeUs, slots, moved: false, targetIndex: firstIndex, inUs, outUs: inUs + shot.durationUs,
    };
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId || readOnly) return;
    const delta = event.clientX + (scroller.current?.scrollLeft ?? 0) - current.x;
    if (!current.moved && Math.abs(delta) < 4) return;
    current.moved = true;
    const originalIn = current.shot.clipEdit?.inUs ?? current.shot.sourceInUs ?? 0;
    const { layout, slots } = current;
    let markerX: number | undefined;
    if (current.mode === 'move') {
      const proposedX = layout.xAt(current.startUs) + delta;
      current.targetIndex = slots.reduce((best, x, index) => Math.abs(x - proposedX) < Math.abs(slots[best] - proposedX) ? index : best, 0);
      markerX = slots[current.targetIndex];
    } else {
      const edge = current.mode === 'in' ? current.startUs : current.startUs + current.shot.durationUs;
      const proposedX = layout.xAt(edge) + delta;
      let proposed = layout.timeAt(proposedX);
      if (snapping && !event.altKey) {
        let closest = 8;
        for (let index = 0; index < layout.edges.length; index++) {
          const distance = Math.abs(layout.edges[index] - proposedX);
          if (distance <= closest) { closest = distance; proposed = layout.times[index]; }
        }
        if (Math.abs(layout.xAt(current.previousTimeUs) - proposedX) <= closest) proposed = current.previousTimeUs;
      }
      const snapped = snapTimeUs(proposed, rate);
      const shift = snapped - edge;
      const minimum = minimumShotDurationUs(rate);
      if (current.mode === 'in') current.inUs = Math.max(minimumSourceInUs(current.shot), Math.min(originalIn + current.shot.durationUs - minimum, originalIn + shift));
      else current.outUs = Math.max(originalIn + minimum, Math.min(sourceOutLimit ?? originalIn + 600_000_000, originalIn + current.shot.durationUs + shift));
      const markerUs = current.startUs + (current.mode === 'in' ? current.inUs - originalIn : current.outUs - originalIn);
      clock.seek(markerUs);
    }
    setDrag({ id: current.id, index: current.index, ids: current.ids, mode: current.mode, deltaPx: delta, inUs: current.inUs, outUs: current.outUs, markerX });
  }
  function finish(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (event.type === 'pointerup') move(event);
    gesture.current = undefined; setDrag(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!current.moved) return;
    suppressClick.current = true;
    if (readOnly) return;
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
  function selectClip(event: MouseEvent<HTMLButtonElement>, shot: Shot) {
    if (suppressClick.current && event.detail) { suppressClick.current = false; return; }
    suppressClick.current = false;
    void onSelect(shot.id, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey, keepGroup: !event.ctrlKey && !event.metaKey && !event.shiftKey && selected.has(shot.id) });
  }
  const rowBegin = useCommittedCallback(begin), rowMove = useCommittedCallback(move), rowFinish = useCommittedCallback(finish);
  const rowSelect = useCommittedCallback(selectClip), rowTrimKey = useCommittedCallback(trimKey);
  const rowHandlers = useMemo<TimelineRowHandlers>(() => ({ begin: rowBegin, move: rowMove, finish: rowFinish, select: rowSelect, trimKey: rowTrimKey }), [rowBegin, rowMove, rowFinish, rowSelect, rowTrimKey]);
  const zoomPercent = `${Math.round(zoom * 100)}%`;
  return <section data-guide="timeline" className="timeline" aria-label={readOnly ? '制作时间轴' : '项目时间轴'} data-read-only={readOnly || undefined} onKeyDown={selectionKey}>
    <div className="timeline-toolbar">
      <div className="timeline-heading"><h2>时间轴</h2><span className="timeline-summary">{shots.length} 个镜头</span><span className="timeline-selection-count" aria-live="polite">已选 {selected.size} 个镜头</span></div>
      {!readOnly && <div className="timeline-edit-actions" role="group" aria-label="镜头操作">
        {onSelectAll && <IconButton label="全选镜头" disabled={!shots.length || selected.size === shots.length} onClick={onSelectAll}><ListChecks size={15} /></IconButton>}
        {onClearSelection && <IconButton label="清除镜头选择" disabled={!selected.size} onClick={onClearSelection}><X size={15} /></IconButton>}
        {onBulkEdit && <Button className="timeline-bulk-button" aria-label="批量编辑镜头" disabled={editingDisabled || !selected.size} onClick={onBulkEdit}><SlidersHorizontal size={14} />批量编辑</Button>}
        <SplitControl shot={shots[selectedIndex]} clip={timeline[selectedIndex]} rate={rate} clock={clock} disabled={editingDisabled || !singleSelected} onSplit={onSplit} />
        <IconButton label="将镜头前移" disabled={editingDisabled || !selected.size || singleSelected && selectedIndex <= 0} onClick={() => void onMove(-1)}><ArrowLeft size={15} /></IconButton>
        <IconButton label="将镜头后移" disabled={editingDisabled || !selected.size || singleSelected && selectedIndex >= shots.length - 1} onClick={() => void onMove(1)}><ArrowRight size={15} /></IconButton>
        <IconButton label="复制镜头" disabled={editingDisabled || !selected.size} onClick={() => void onDuplicate()}><Copy size={15} /></IconButton>
        <IconButton label="移除所选镜头" disabled={editingDisabled || !selected.size} onClick={() => void onRemove()}><Trash2 size={15} /></IconButton>
        <IconButton label="时间轴吸附" aria-pressed={snapping} title="吸附到镜头边界和播放头；按住 Alt 临时关闭" onClick={() => setSnapping(value => !value)}><Magnet size={15} /></IconButton>
      </div>}
      {drag ? <output className="timeline-drag-readout">{drag.mode === 'move' ? '调整镜头顺序' : `${(drag.inUs / 1e6).toFixed(3)} – ${(drag.outUs / 1e6).toFixed(3)} 秒`}</output> : <TimelineReadout clock={clock} rate={rate} />}
      <div className="timeline-view-actions" role="group" aria-label="时间轴视图">
        <IconButton label="重置时间轴缩放" onClick={() => changeZoom(1)}><RotateCcw size={16} /></IconButton>
        <IconButton className="timeline-zoom-step" label="缩小时间轴" disabled={zoom <= 1} onClick={() => changeZoom(Math.max(1, Math.round((zoom - .5) * 10) / 10))}><ZoomOut size={15} /></IconButton>
        <input className="timeline-zoom" aria-label="时间轴缩放" aria-valuetext={zoomPercent} type="range" min="1" max="5" step="0.1" value={zoom} onChange={event => changeZoom(Number(event.target.value))} />
        <IconButton className="timeline-zoom-step" label="放大时间轴" disabled={zoom >= 5} onClick={() => changeZoom(Math.min(5, Math.round((zoom + .5) * 10) / 10))}><ZoomIn size={15} /></IconButton>
        <span className="timeline-zoom-value" aria-hidden="true">{zoomPercent}</span>
      </div>
    </div>
    <div className="timeline-body">
      <div className="timeline-track-headers" aria-label="轨道信息">
        <div className="track-header-ruler"><span>轨道</span><span>{tracks.length + (musicClips.length ? 1 : 0)}</span></div>
        <div className="track-header track-header--video"><strong>画面</strong><small>{shots.length} 个片段</small></div>
        {audioCount > 0 && <div className="track-header track-header--audio"><span className="track-header__type"><Mic size={14} /><b>A1</b></span><strong>旁白</strong><small>{audioCount} 段音频</small></div>}
        {originalCount > 0 && <div className="track-header track-header--audio"><span className="track-header__type"><Volume2 size={14} /><b>A{audioCount ? 2 : 1}</b></span><strong>原声</strong><small>{originalCount} 段</small></div>}
        {musicClips.length > 0 && <div className="track-header track-header--audio"><span className="track-header__type"><Music2 size={14} /><b>A{1 + Number(audioCount > 0) + Number(originalCount > 0)}</b></span><strong>背景音乐</strong><small>{musicClips.length} 段音频</small></div>}
      </div>
      <div className="timeline-scroll" ref={scroller}><div className="timeline-content" style={{ inlineSize: visibleLayout.width || `${zoom * 100}%` }}>
        <TimelinePosition clock={clock} rate={rate} layout={visibleLayout} divisions={divisions} totalUs={totalUs} viewportWidth={viewportWidth} />
        {markerX !== undefined && <div className="timeline-drop-marker" aria-hidden="true" style={{ left: markerX }} />}
        {tracks.map(kind => <div className={`track track--${kind} ${kind === 'original' ? 'track--audio' : ''}`} key={kind} style={{ backgroundSize: `${100 / divisions}% 100%` }}><div className="track-clips">
          {shots.map((shot, index) => {
            const clip = timeline[index];
            const active = drag && (drag.mode === 'move' ? draggingIds.has(shot.id) : drag.id === shot.id) ? drag : undefined;
            const trimming = trim?.index === index;
            const durationUs = trimming ? trim.outUs - trim.inUs : clip.durationUs;
            const clipWidth = layout.edges[index + 1] - layout.edges[index];
            const left = visibleLayout.edges[index];
            const width = (trim ? visibleLayout.edges[index + 1] - left : clipWidth) - CLIP_GAP_PX;
            const handles = !readOnly && kind === 'video' && singleSelected && shot.id === selectedId;
            // Sample the committed clip so a trim gesture can resize the strip without decoding new frames.
            const thumbnailCount = kind === 'video' && (shot.videoAssetId || shot.assetId || shot.sceneTemplate) ? Math.min(MAX_THUMBNAILS_PER_CLIP, Math.max(1, Math.round(clipWidth / THUMBNAIL_WIDTH_PX))) : 1;
            const sounding = kind === 'audio' ? Boolean(shot.audioAssetId) : kind === 'original' && usesVideoAudio(shot);
            const soundAsset = assetById.get((kind === 'original' ? shot.videoAssetId : shot.audioAssetId) ?? '');
            return <TimelineShotRow key={shot.id} project={previewContext} assets={assets} shot={shot} index={index} kind={kind} selected={selected.has(shot.id)} active={active} left={left} width={width} durationUs={durationUs} thumbnailCount={thumbnailCount} handles={handles} trimmingDisabled={handles && trimmingDisabled} editingDisabled={editingDisabled} sourceOutLimit={handles ? sourceOutLimit : undefined} sourceDurationUs={sourceDurationUs} rate={rate} sounding={sounding} soundAsset={soundAsset} modifierLabel={modifierLabel} handlers={rowHandlers} />;
          })}
        </div></div>)}
        {musicClips.length > 0 && <div className="track track--audio track--music" style={{ backgroundSize: `${100 / divisions}% 100%` }}><div className="track-clips">
          {musicClips.map(clip => {
            const visibleDuration = Math.min(clip.durationUs, visibleLayout.totalUs - clip.startUs);
            if (visibleDuration <= 0) return null;
            const left = visibleLayout.xAt(clip.startUs);
            const span = visibleLayout.xAt(clip.startUs + visibleDuration) - left;
            const width = Math.max(0, span - 2);
            const timeAtProgress = visibleLayout.minimumWidthsApplied ? (progress: number) => Math.round(visibleLayout.timeAt(left + progress * span)) - clip.startUs : undefined;
            return <div className="timeline-clip timeline-clip--audio timeline-clip--music" key={clip.id} style={{ left, width }}>
              <button type="button" className="timeline-clip__select" disabled={editingDisabled || !onOpenMusic} onClick={onOpenMusic} aria-label={`编辑背景音乐：${assetById.get(clip.assetId)?.name ?? '素材缺失'}`}>
                <AudioWaveform asset={assetById.get(clip.assetId)} sourceInUs={clip.sourceInUs} durationUs={visibleDuration} loop={clip.loop} label="背景音乐" timeAtProgress={timeAtProgress} />
              </button>
            </div>;
          })}
        </div></div>}
      </div></div>
    </div>
  </section>;
});

const SplitControl = memo(function SplitControl({ shot, clip, rate, clock, disabled, onSplit }: { shot?: Shot; clip?: TimelineClip; rate: FrameRate; clock: PlaybackClock; disabled: boolean; onSplit: () => Promise<void> }) {
  const { timeUs } = usePlayback(clock);
  return <IconButton label="在播放头处分割镜头" title="在播放头处分割镜头（S）" disabled={disabled || !shot || shot.locked || !clip || !canSplitShot(shot, timeUs - clip.startUs, rate)} aria-keyshortcuts="S" onClick={() => void onSplit()}><Scissors size={15} /></IconButton>;
});

const TimelineReadout = memo(function TimelineReadout({ clock, rate }: { clock: PlaybackClock; rate: FrameRate }) {
  const { timeUs } = usePlayback(clock);
  return <output className="timeline-readout" aria-label="时间轴当前时间" aria-live="off"><b>{formatTime(timeUs)}</b><span>F {frameAtTime(timeUs, rate) + 1}</span></output>;
});

function TimelinePosition({ clock, rate, layout, divisions, totalUs, viewportWidth }: { clock: PlaybackClock; rate: FrameRate; layout: TimelineLayout; divisions: number; totalUs: number; viewportWidth: number }) {
  const { timeUs, playing } = usePlayback(clock);
  const ruler = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ id: number; element: HTMLDivElement; initialTimeUs: number; completed: () => void } | undefined>(undefined);
  const pending = useRef<number | undefined>(undefined);
  const request = useRef<number | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const flush = () => { if (pending.current !== undefined) { clock.seek(pending.current); pending.current = undefined; } };
  const cancelRequest = () => { if (request.current !== undefined) cancelAnimationFrame(request.current); request.current = undefined; };
  useEffect(() => () => { if (request.current !== undefined) cancelAnimationFrame(request.current); }, []);
  useEffect(() => {
    if (!playing || !ruler.current) return;
    const element = ruler.current.closest<HTMLElement>('.timeline-scroll');
    if (!element) return;
    const x = layout.xAt(timeUs);
    if (x > element.scrollLeft + viewportWidth - 16) element.scrollLeft = x - viewportWidth * .25;
    else if (x < element.scrollLeft) element.scrollLeft = x;
  }, [playing, timeUs, layout, viewportWidth]);
  function position(clientX: number) {
    const bounds = pointer.current;
    if (bounds) {
      const x = clientX - bounds.element.getBoundingClientRect().left;
      pending.current = Math.max(0, Math.min(totalUs, layout.timeAt(x)));
    }
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !totalUs) return;
    pointer.current = { id: event.pointerId, element: event.currentTarget, initialTimeUs: clock.getSnapshot().timeUs, completed: beginGuideAction('timeline-seeked') };
    event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus({ preventScroll: true });
    setDragging(true); position(event.clientX); flush();
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (pointer.current?.id !== event.pointerId) return;
    position(event.clientX);
    if (request.current === undefined) request.current = requestAnimationFrame(() => { request.current = undefined; flush(); });
  }
  function pointerEnd(event: PointerEvent<HTMLDivElement>) {
    const gesture = pointer.current;
    if (gesture?.id !== event.pointerId) return;
    if (event.type === 'pointerup') position(event.clientX);
    cancelRequest(); flush(); pointer.current = undefined; setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (event.type === 'pointerup' && clock.getSnapshot().timeUs !== gesture.initialTimeUs) gesture.completed();
  }
  function keydown(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const initialTimeUs = clock.getSnapshot().timeUs;
    const completed = beginGuideAction('timeline-seeked');
    const step = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') clock.step(step);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') clock.step(-step);
    else if (event.key === 'Home') clock.seek(0);
    else if (event.key === 'End') clock.seek(totalUs);
    event.preventDefault(); event.stopPropagation();
    const { timeUs } = clock.getSnapshot();
    const scroller = event.currentTarget.closest<HTMLElement>('.timeline-scroll');
    if (scroller) {
      const x = layout.xAt(timeUs);
      if (x < scroller.scrollLeft || x >= scroller.scrollLeft + viewportWidth) scroller.scrollLeft = x - viewportWidth / 2;
    }
    if (timeUs !== initialTimeUs) completed();
  }
  return <><div ref={ruler} className={`timeline-ruler ${dragging ? 'is-scrubbing' : ''}`} style={{ backgroundSize: `${100 / (divisions * 5)}% 6px` }} role="slider" tabIndex={0} aria-label="预览播放位置" aria-disabled={!totalUs} aria-valuemin={0} aria-valuemax={Math.round(totalUs / 1000)} aria-valuenow={Math.round(timeUs / 1000)} aria-valuetext={`${formatTime(timeUs)}，第 ${frameAtTime(timeUs, rate) + 1} 帧`} aria-keyshortcuts="ArrowLeft ArrowRight Home End" onKeyDown={keydown} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd}><TimelineRulerMarks layout={layout} divisions={divisions} /></div><div className="playhead-lane" aria-hidden="true"><div className={`playhead ${dragging ? 'is-scrubbing' : ''}`} style={{ transform: `translateX(${layout.xAt(timeUs)}px)` }} /></div></>;
}

const TimelineRulerMarks = memo(function TimelineRulerMarks({ layout, divisions }: { layout: TimelineLayout; divisions: number }) {
  const times = Array.from({ length: layout.totalUs ? divisions + 1 : 1 }, (_, index) => Math.round(layout.timeAt(layout.width * index / divisions)));
  const fractional = times.some(timeUs => timeUs % 1_000_000 !== 0);
  return times.map((timeUs, index) => {
    const label = formatTime(timeUs);
    return <span className="ruler-marker" key={index} style={{ left: `${index / divisions * 100}%` }}><span>{fractional ? label : label.split('.')[0]}</span></span>;
  });
});
