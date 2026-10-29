import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowLeft, ArrowRight, Copy, Film, Mic, ScanLine, Trash2 } from 'lucide-react';
import { frameAtTime, type FrameRate, type Shot } from '@video-quickly/contracts';
import type { TimelineClip } from '@video-quickly/video';
import { PlaybackClock, usePlayback } from '../lib/playback';
import { IconButton, formatTime } from './Primitives';

interface Props {
  shots: Shot[]; timeline: TimelineClip[]; selectedId?: string; rate: FrameRate; clock: PlaybackClock;
  onSelect: (id: string) => Promise<void>; onMove: (offset: number) => Promise<void>;
  onDuplicate: () => Promise<void>; onRemove: () => Promise<void>;
}

export default memo(function Timeline({ shots, timeline, selectedId, rate, clock, onSelect, onMove, onDuplicate, onRemove }: Props) {
  const [zoom, setZoom] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ time: number; x: number } | undefined>(undefined);
  const totalUs = timeline.at(-1)?.endUs ?? 0;
  const selectedIndex = shots.findIndex(shot => shot.id === selectedId);
  function changeZoom(value: number) {
    const element = scroller.current;
    if (element) {
      const time = totalUs ? clock.getSnapshot().timeUs / totalUs : 0;
      anchor.current = { time, x: 52 + (element.scrollWidth - 67) * time - element.scrollLeft };
    }
    setZoom(value);
  }
  useLayoutEffect(() => {
    if (scroller.current && anchor.current) {
      const { time, x } = anchor.current;
      scroller.current.scrollLeft = 52 + (scroller.current.scrollWidth - 67) * time - x;
      anchor.current = undefined;
    }
  }, [zoom]);
  return <section className="timeline"><div className="timeline-toolbar"><h2>时间轴</h2><IconButton label="将镜头前移" disabled={selectedIndex <= 0} onClick={() => void onMove(-1)}><ArrowLeft size={14} /></IconButton><IconButton label="将镜头后移" disabled={selectedIndex < 0 || selectedIndex >= shots.length - 1} onClick={() => void onMove(1)}><ArrowRight size={14} /></IconButton><IconButton label="复制镜头" disabled={selectedIndex < 0} onClick={() => void onDuplicate()}><Copy size={13} /></IconButton><IconButton label="移除所选镜头" disabled={selectedIndex < 0} onClick={() => void onRemove()}><Trash2 size={13} /></IconButton><IconButton label="适配完整时间轴" onClick={() => changeZoom(1)}><ScanLine size={14} /></IconButton><input className="timeline-zoom" aria-label="时间轴缩放" type="range" min="1" max="5" step="0.1" value={zoom} onChange={event => changeZoom(Number(event.target.value))} /><span className="timeline-zoom-value">{Math.round(zoom * 100)}%</span></div><div className="timeline-scroll" ref={scroller}><div className="timeline-content" style={{ width: `${zoom * 100}%` }}>
    <TimelinePosition clock={clock} rate={rate} totalUs={totalUs} zoom={zoom} />
    {(['video', 'audio'] as const).map(kind => <div className="track" key={kind}><span className="track-icon">{kind === 'video' ? <Film size={13} /> : <Mic size={13} />}</span><div className="track-clips">{shots.map((shot, index) => { const clip = timeline[index]; return <button className={`timeline-clip ${kind === 'audio' ? 'audio' : ''} ${shot.id === selectedId ? 'selected' : ''}`} key={shot.id} style={{ left: `${totalUs ? clip.startUs / totalUs * 100 : 0}%`, width: `${totalUs ? clip.durationUs / totalUs * 100 : 0}%` }} onClick={() => void onSelect(shot.id)} aria-pressed={shot.id === selectedId} aria-label={`${kind === 'video' ? '定位镜头' : '定位旁白'} ${index + 1}：${shot.title}`} title={`${shot.title} · ${(shot.durationUs / 1_000_000).toFixed(1)} 秒`}>{kind === 'video' ? <><Film size={11} /><span>{(index + 1).toString().padStart(2, '0')}　{shot.title}</span></> : <>{shot.audioAssetId && <span className="waveform">{Array.from({ length: 25 }, (_, bar) => <i key={bar} style={{ height: `${4 + (bar * 13 % 15)}px` }} />)}</span>}<span className="audio-label">{shot.audioAssetId ? '旁白音轨' : '待配音'}</span></>}</button>; })}</div></div>)}
  </div></div></section>;
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
    const x = 52 + (element.scrollWidth - 67) * (totalUs ? timeUs / totalUs : 0);
    if (x > element.scrollLeft + element.clientWidth - 28) element.scrollLeft = x - element.clientWidth * .25;
    else if (x < element.scrollLeft + 52) element.scrollLeft = Math.max(0, x - 52);
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
  return <><div ref={ruler} className={`timeline-ruler ${dragging ? 'is-scrubbing' : ''}`} role="slider" tabIndex={0} aria-label="预览播放位置" aria-disabled={!totalUs} aria-valuemin={0} aria-valuemax={Math.round(totalUs / 1000)} aria-valuenow={Math.round(timeUs / 1000)} aria-valuetext={`${formatTime(timeUs)}，第 ${frameAtTime(timeUs, rate) + 1} 帧`} aria-keyshortcuts="ArrowLeft ArrowRight Home End" onKeyDown={keydown} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd}>{Array.from({ length: Math.round(6 * zoom) + 1 }, (_, index) => <span key={index}>{formatTime(totalUs * index / Math.round(6 * zoom)).split('.')[0]}</span>)}</div><div className="playhead-lane" aria-hidden="true"><div className={`playhead ${dragging ? 'is-scrubbing' : ''}`} style={{ transform: `translateX(${totalUs ? timeUs / totalUs * 100 : 0}%)` }} /></div></>;
}
