import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

interface PanelResizeHandleProps {
  id: string;
  label: string;
  side: 'left' | 'right';
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
}

interface PanelDrag {
  pointerId: number;
  target: HTMLDivElement;
  startX: number;
  startValue: number;
  nextValue: number;
  appliedValue: number;
}

export function PanelResizeHandle(props: PanelResizeHandleProps) {
  const { id, label, side, value, min, max, defaultValue } = props;
  const latest = useRef(props);
  const drag = useRef<PanelDrag | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => { latest.current = props; });

  function clamp(next: number): number {
    return Math.min(latest.current.max, Math.max(latest.current.min, Math.round(next)));
  }

  function flush() {
    frame.current = undefined;
    const current = drag.current;
    if (!current || current.nextValue === current.appliedValue) return;
    current.appliedValue = current.nextValue;
    latest.current.onChange(current.nextValue);
  }

  function cancelFrame() {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
  }

  function release(current: PanelDrag) {
    if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
  }

  function cancelDrag() {
    const current = drag.current;
    if (!current) return;
    cancelFrame();
    drag.current = undefined;
    release(current);
    if (current.appliedValue !== current.startValue) latest.current.onChange(clamp(current.startValue));
    setDragging(false);
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const direction = latest.current.side === 'left' ? 1 : -1;
    current.nextValue = clamp(current.startValue + (event.clientX - current.startX) * direction);
    frame.current ??= requestAnimationFrame(flush);
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    move(event);
    cancelFrame();
    flush();
    drag.current = undefined;
    release(current);
    setDragging(false);
    latest.current.onCommit?.(current.appliedValue);
  }

  function commit(next: number) {
    const width = clamp(next);
    if (width !== latest.current.value) latest.current.onChange(width);
    latest.current.onCommit?.(width);
  }

  function keydown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && drag.current) { event.preventDefault(); cancelDrag(); return; }
    const step = event.shiftKey ? 64 : 16;
    const direction = side === 'left' ? 1 : -1;
    const next = event.key === 'Home' ? min : event.key === 'End' ? max
      : event.key === 'ArrowLeft' ? value - step * direction
      : event.key === 'ArrowRight' ? value + step * direction : undefined;
    if (next === undefined) return;
    event.preventDefault();
    commit(next);
  }

  useEffect(() => () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    const current = drag.current;
    drag.current = undefined;
    if (current) release(current);
  }, []);

  return <div
    id={id}
    className={`panel-resize-handle panel-resize-handle--${side}${dragging ? ' panel-resize-handle--dragging' : ''}`}
    role="separator"
    aria-label={label}
    aria-orientation="vertical"
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={value}
    aria-valuetext={`${Math.round(value)} 像素`}
    tabIndex={0}
    title={`${label} · 拖动或使用方向键调整${defaultValue === undefined ? '' : '，双击重置'}`}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, target: event.currentTarget, startX: event.clientX, startValue: value, nextValue: value, appliedValue: value };
      setDragging(true);
    }}
    onPointerMove={move}
    onPointerUp={finish}
    onPointerCancel={cancelDrag}
    onLostPointerCapture={cancelDrag}
    onKeyDown={keydown}
    onDoubleClick={() => { if (defaultValue !== undefined) commit(defaultValue); }}
  />;
}
