import { useCallback, useEffect, useLayoutEffect, useRef, type MouseEvent, type PointerEvent } from 'react';
import type { Shot } from '@video-quickly/contracts';

export type ReorderStoryboard = (id: string, targetIndex: number, revision: number, groupIds: readonly string[]) => void | Promise<void>;

type Drag = {
  list: HTMLDivElement;
  source: HTMLButtonElement;
  cards: HTMLButtonElement[];
  group: HTMLButtonElement[];
  remaining: HTMLButtonElement[];
  ids: string[];
  sourceId: string;
  title: string;
  revision: number;
  pointerId: number;
  horizontal: boolean;
  reversed: boolean;
  start: number;
  startScroll: number;
  scrollLimit: number;
  position: number;
  crossPosition: number;
  targetIndices: number[];
  unchangedIndex?: number;
  targetIndex?: number;
  marker?: HTMLButtonElement;
  frame?: number;
  time?: number;
  active: boolean;
  restoreFocus: boolean;
};

type PendingDrop = Pick<Drag, 'source' | 'ids' | 'title' | 'restoreFocus'> & { index: number };

const threshold = 6;

function setMarker(drag: Drag, slot?: number) {
  drag.targetIndex = slot === undefined ? undefined : drag.targetIndices[slot];
  if (drag.targetIndex === drag.unchangedIndex) drag.targetIndex = undefined;
  const before = drag.targetIndex !== undefined ? drag.remaining[drag.targetIndex] : undefined;
  const marker = before ?? (drag.targetIndex === undefined ? undefined : drag.remaining.at(-1));
  if (drag.marker !== marker) drag.marker?.removeAttribute('data-storyboard-drop');
  drag.marker = marker;
  const side = before ? 'before' : 'after';
  if (marker && marker.dataset.storyboardDrop !== side) marker.dataset.storyboardDrop = side;
}

function readScroll(drag: Drag) { return drag.horizontal ? drag.list.scrollLeft : drag.list.scrollTop; }

function updatePosition(drag: Drag, now: number, autoScroll: boolean) {
  const { horizontal, list, position, crossPosition, source, cards } = drag;
  const bounds = list.getBoundingClientRect();
  const start = horizontal ? bounds.left + list.clientLeft : bounds.top + list.clientTop;
  const size = horizontal ? list.clientWidth : list.clientHeight;
  const end = start + size;
  const crossStart = horizontal ? bounds.top + list.clientTop : bounds.left + list.clientLeft;
  const crossEnd = crossStart + (horizontal ? list.clientHeight : list.clientWidth);
  const inside = position >= start && position <= end && crossPosition >= crossStart && crossPosition <= crossEnd;
  const previousScroll = readScroll(drag);
  let scroll = previousScroll;
  if (autoScroll && inside) {
    const edge = Math.min(size / 3, horizontal ? source.offsetWidth : source.offsetHeight);
    const pressure = position < start + edge ? position - (start + edge) : Math.max(0, position - (end - edge));
    if (pressure) {
      const elapsed = Math.min(32, now - (drag.time ?? now - 16));
      const amount = Math.round(pressure / edge * 1.4 * elapsed);
      // The translated card can extend the native scroll range. Stop at the original list edges.
      const position = Math.max(drag.reversed ? -drag.scrollLimit : 0, Math.min(drag.reversed ? 0 : drag.scrollLimit, scroll + amount));
      if (horizontal) list.scrollLeft = position;
      else list.scrollTop = position;
      scroll = readScroll(drag);
    }
  }

  if (inside) {
    // A captured pointer always targets the source. Resolve the actual slot from the layout.
    const coordinate = position - start + scroll;
    let low = 0, high = cards.length;
    while (low < high) {
      const index = Math.floor((low + high) / 2), card = cards[index];
      const midpoint = horizontal ? card.offsetLeft + card.offsetWidth / 2 : card.offsetTop + card.offsetHeight / 2;
      if (drag.reversed ? coordinate <= midpoint : coordinate >= midpoint) low = index + 1;
      else high = index;
    }
    setMarker(drag, low);
  } else setMarker(drag);

  const offset = Math.min(end, Math.max(start, position)) - drag.start + scroll - drag.startScroll;
  source.style.setProperty('--storyboard-drag-translate', horizontal ? `${offset}px 0` : `0 ${offset}px`);
  return scroll !== previousScroll;
}

function renderDrag(drag: Drag, time: number) {
  drag.frame = undefined;
  const scrolled = updatePosition(drag, time, true);
  drag.time = time;
  if (scrolled) drag.frame = requestAnimationFrame(next => renderDrag(drag, next));
}

function clearDrag(drag: Drag) {
  if (drag.frame !== undefined) cancelAnimationFrame(drag.frame);
  drag.marker?.removeAttribute('data-storyboard-drop');
  drag.source.removeAttribute('data-storyboard-drag-source');
  drag.source.style.removeProperty('--storyboard-drag-translate');
  for (const card of drag.group) card.removeAttribute('data-storyboard-drag-group');
  drag.list.removeAttribute('data-storyboard-dragging');
  if (drag.source.hasPointerCapture(drag.pointerId)) drag.source.releasePointerCapture(drag.pointerId);
}

export function useStoryboardReorder(shots: readonly Shot[], selected: ReadonlySet<string>, revision?: number, onReorder?: ReorderStoryboard) {
  const drag = useRef<Drag | undefined>(undefined);
  const pending = useRef<PendingDrop | undefined>(undefined);
  const suppressClick = useRef(false);
  const status = useRef<HTMLSpanElement>(null);
  const enabled = Boolean(onReorder && revision !== undefined);

  const cancel = useCallback(() => {
    const current = drag.current;
    if (!current) return;
    drag.current = undefined;
    clearDrag(current);
    if (current.active && status.current) status.current.textContent = '已取消拖动排序';
  }, []);

  useLayoutEffect(() => {
    if (drag.current && (!enabled || drag.current.revision !== revision)) cancel();
    const drop = pending.current;
    if (!drop || !drop.ids.every((id, index) => shots[drop.index + index]?.id === id)) return;
    pending.current = undefined;
    drop.source.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (drop.restoreFocus && (document.activeElement === document.body || drop.source.parentElement?.contains(document.activeElement))) drop.source.focus({ preventScroll: true });
    const position = drop.index + 1;
    if (status.current) status.current.textContent = drop.ids.length === 1 ? `「${drop.title}」已移至第 ${position} 镜` : `${drop.ids.length} 个分镜已移至第 ${position} 镜起`;
  }, [shots, enabled, revision, cancel]);

  useEffect(() => {
    function keyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape' || !drag.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
    document.addEventListener('keydown', keyDown, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    return () => {
      document.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
      cancel();
    };
  }, [cancel]);

  function point(current: Drag, event: PointerEvent<HTMLDivElement>) {
    current.position = current.horizontal ? event.clientX : event.clientY;
    current.crossPosition = current.horizontal ? event.clientY : event.clientX;
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || drag.current) return;
    suppressClick.current = false;
    if (!enabled || revision === undefined || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(event.target instanceof Element)) return;
    const source = event.target.closest<HTMLButtonElement>('.outline-shot[data-storyboard-reorderable]');
    const sourceId = source?.dataset.storyboardShot;
    if (!source || !sourceId || (event.pointerType !== 'mouse' && !event.target.closest('.outline-shot__grip'))) return;
    const list = event.currentTarget;
    const cards = [...list.querySelectorAll<HTMLButtonElement>(':scope > .outline-shot')];
    const ids = selected.has(sourceId) ? shots.filter(shot => selected.has(shot.id)).map(shot => shot.id) : [sourceId];
    const movingIds = new Set(ids);
    const group = cards.filter(card => card.dataset.storyboardShot && movingIds.has(card.dataset.storyboardShot));
    const groupCards = new Set(group);
    const remaining = cards.filter(card => !groupCards.has(card));
    const firstIndex = cards.indexOf(group[0]);
    const contiguous = group.every((card, index) => cards[firstIndex + index] === card);
    const targetIndices = [0];
    for (const card of cards) targetIndices.push(targetIndices[targetIndices.length - 1] + Number(!groupCards.has(card)));
    const style = getComputedStyle(list), horizontal = style.flexDirection === 'row', reversed = horizontal && style.direction === 'rtl';
    const position = horizontal ? event.clientX : event.clientY;
    const title = shots.find(shot => shot.id === sourceId)?.title ?? '';
    source.setPointerCapture(event.pointerId);
    drag.current = {
      list, source, cards, group, remaining, sourceId, title, revision, targetIndices, ids,
      pointerId: event.pointerId, horizontal, reversed, start: position, position, crossPosition: horizontal ? event.clientY : event.clientX,
      startScroll: horizontal ? list.scrollLeft : list.scrollTop, scrollLimit: horizontal ? list.scrollWidth - list.clientWidth : list.scrollHeight - list.clientHeight,
      unchangedIndex: contiguous ? firstIndex : undefined, active: false, restoreFocus: false,
    };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    point(current, event);
    if (!current.active) {
      if (Math.abs(current.position - current.start) < threshold) return;
      current.active = true;
      current.restoreFocus = document.activeElement === current.source;
      suppressClick.current = true;
      pending.current = undefined;
      if (status.current) status.current.textContent = '';
      current.list.dataset.storyboardDragging = '';
      current.source.dataset.storyboardDragSource = '';
      for (const card of current.group) card.dataset.storyboardDragGroup = '';
    }
    current.frame ??= requestAnimationFrame(time => renderDrag(current, time));
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (current.active) {
      point(current, event);
      updatePosition(current, performance.now(), false);
    }
    drag.current = undefined;
    clearDrag(current);
    if (current.targetIndex === undefined || !onReorder) return;
    pending.current = { source: current.source, ids: current.ids, title: current.title, restoreFocus: current.restoreFocus, index: current.targetIndex };
    void onReorder(current.sourceId, current.targetIndex, current.revision, current.ids);
  }

  function onClickCapture(event: MouseEvent<HTMLDivElement>) {
    if (!event.detail || !suppressClick.current) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  function onPointerCancel(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerId === drag.current?.pointerId) cancel();
  }

  function onScroll() {
    const current = drag.current;
    if (current?.active) current.frame ??= requestAnimationFrame(time => renderDrag(current, time));
  }

  return { status, pointerHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture: onPointerCancel, onClickCapture, onScroll } };
}
