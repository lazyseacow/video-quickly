import type { TimelineClip } from '@video-quickly/video';

export const CLIP_GAP_PX = 4;
export const MINIMUM_CLIP_WIDTH_PX = 72;

// The first and last scales also apply beyond the project when dragging trim handles.
function interpolate(value: number, from: readonly number[], to: readonly number[]) {
  let start = 0;
  let end = from.length - 1;
  if (!end) return 0;
  while (start + 1 < end) {
    const middle = Math.floor((start + end) / 2);
    if (from[middle] <= value) start = middle;
    else end = middle;
  }
  const fraction = (value - from[start]) / (from[end] - from[start]);
  return to[start] + fraction * (to[end] - to[start]);
}

export function createTimelineLayout(timeline: readonly TimelineClip[], viewportWidth: number, zoom: number, trim?: { index: number; durationUs: number }) {
  const totalUs = timeline.at(-1)?.endUs ?? 0;
  const pixelsPerUs = totalUs ? viewportWidth / totalUs : 0;
  const times = [0];
  const edges = [0];
  let extraWidth = 0;
  for (let index = 0; index < timeline.length; index++) {
    const clip = timeline[index];
    // Every track uses these edges, so enlarging a short shot also moves its following boundaries.
    const durationUs = trim?.index === index ? trim.durationUs : clip.durationUs;
    const endUs = times[index] + durationUs;
    extraWidth += Math.max(0, MINIMUM_CLIP_WIDTH_PX + CLIP_GAP_PX - durationUs * pixelsPerUs);
    times.push(endUs);
    edges.push((endUs * pixelsPerUs + extraWidth) * zoom);
  }
  return {
    totalUs: times.at(-1) ?? 0, width: edges.at(-1) ?? 0, minimumWidthsApplied: extraWidth > 0, times, edges,
    xAt: (timeUs: number) => interpolate(timeUs, times, edges),
    timeAt: (x: number) => interpolate(x, edges, times),
  };
}

export type TimelineLayout = ReturnType<typeof createTimelineLayout>;
