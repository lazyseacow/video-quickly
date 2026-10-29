import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowLeft, ArrowRight, AudioLines, Copy, Film, Mic, ScanLine, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { frameAtTime, type AssetRecord, type FrameRate, type ProjectDocument, type Shot } from '@video-quickly/contracts';
import type { TimelineClip } from '@video-quickly/video';
import { PlaybackClock, usePlayback } from '../lib/playback';
import { IconButton, formatTime } from './Primitives';
import { ScenePreview } from './ScenePreview';
import './timeline.css';

interface Props {
  project: ProjectDocument; assets: AssetRecord[]; shots: Shot[]; timeline: TimelineClip[]; selectedId?: string; rate: FrameRate; clock: PlaybackClock;
  onSelect: (id: string) => Promise<void>; onMove: (offset: number) => Promise<void>;
  onDuplicate: () => Promise<void>; onRemove: () => Promise<void>;
}

export default memo(function Timeline({ project, assets, shots, timeline, selectedId, rate, clock, onSelect, onMove, onDuplicate, onRemove }: Props) {
  const [zoom, setZoom] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ time: number; x: number } | undefined>(undefined);
  const totalUs = timeline.at(-1)?.endUs ?? 0;
  const selectedIndex = shots.findIndex(shot => shot.id === selectedId);
  const audioCount = shots.filter(shot => shot.audioAssetId).length;
  const divisions = Math.round(6 * zoom);
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
  return <section className="timeline" aria-label="项目时间轴">
    <div className="timeline-toolbar">
      <div className="timeline-heading"><h2>时间轴</h2><span className="timeline-summary">{shots.length} 个镜头</span></div>
      <div className="timeline-edit-actions" role="group" aria-label="镜头操作">
        <IconButton label="将镜头前移" disabled={selectedIndex <= 0} onClick={() => void onMove(-1)}><ArrowLeft size={15} /></IconButton>
        <IconButton label="将镜头后移" disabled={selectedIndex < 0 || selectedIndex >= shots.length - 1} onClick={() => void onMove(1)}><ArrowRight size={15} /></IconButton>
        <IconButton label="复制镜头" disabled={selectedIndex < 0} onClick={() => void onDuplicate()}><Copy size={15} /></IconButton>
        <IconButton label="移除所选镜头" disabled={selectedIndex < 0} onClick={() => void onRemove()}><Trash2 size={15} /></IconButton>
      </div>
      <TimelineReadout clock={clock} rate={rate} />
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
        <div className="track-header-ruler"><span>轨道</span><span>2</span></div>
        <div className="track-header track-header--video"><span className="track-header__type"><Film size={14} /><b>V1</b></span><strong>画面</strong><small>{shots.length} 个片段</small></div>
        <div className="track-header track-header--audio"><span className="track-header__type"><Mic size={14} /><b>A1</b></span><strong>旁白</strong><small>{audioCount ? `${audioCount} 段音频` : '待添加'}</small></div>
      </div>
      <div className="timeline-scroll" ref={scroller}><div className="timeline-content" style={{ width: `${zoom * 100}%` }}>
        <TimelinePosition clock={clock} rate={rate} totalUs={totalUs} zoom={zoom} />
        {(['video', 'audio'] as const).map(kind => <div className={`track track--${kind}`} key={kind} style={{ backgroundSize: `${100 / divisions}% 100%` }}><div className="track-clips">
          {shots.map((shot, index) => {
            const clip = timeline[index];
            return <button type="button" className={`timeline-clip timeline-clip--${kind} ${kind === 'audio' && !shot.audioAssetId ? 'timeline-clip--pending' : ''} ${shot.id === selectedId ? 'selected' : ''}`} key={shot.id} style={{ left: `${totalUs ? clip.startUs / totalUs * 100 : 0}%`, width: `calc(${totalUs ? clip.durationUs / totalUs * 100 : 0}% - 2px)` }} onClick={() => void onSelect(shot.id)} aria-pressed={shot.id === selectedId} aria-label={`${kind === 'video' ? '定位镜头' : '定位旁白'} ${index + 1}：${shot.title}`} title={`${shot.title} · ${(shot.durationUs / 1_000_000).toFixed(1)} 秒`}>
              {kind === 'video' ? <><span className="timeline-clip__title"><span className="timeline-clip__index">{(index + 1).toString().padStart(2, '0')}</span><span>{shot.title}</span></span><span className="timeline-clip__media"><span className="timeline-clip__thumbnail"><ScenePreview project={project} shot={shot} shotIndex={index} assets={assets} thumbnail /></span><span className="timeline-clip__duration">{(shot.durationUs / 1_000_000).toFixed(1)}s</span></span></> : <span className="timeline-clip__audio">{shot.audioAssetId ? <AudioLines size={17} /> : <Mic size={15} />}<span>{shot.audioAssetId ? '旁白音频' : '待配音'}</span></span>}
            </button>;
          })}
        </div></div>)}
      </div></div>
    </div>
  </section>;
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
