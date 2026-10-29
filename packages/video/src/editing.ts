import { frameAtTime, timeAtFrame, type ClipEditPlan, type FrameRate, type Shot } from '@video-quickly/contracts';
import { clipEditPlan, clipEditTotalUs, resolveShotTime, type ClipEditContext, type ClipEditDocument, type ClipEditIdFactory } from './clip-edits.js';

const MINIMUM_DURATION_US = 500_000;
const MAXIMUM_DURATION_US = 600_000_000;

export function minimumShotDurationUs(rate: FrameRate): number {
  return timeAtFrame(Math.ceil(MINIMUM_DURATION_US * rate.numerator / (1_000_000 * rate.denominator)), rate);
}

/** Earlier common trims must not move either independent media source before its beginning. */
export function minimumSourceInUs(shot: Pick<Shot, 'sourceInUs' | 'audioInUs' | 'videoInUs' | 'audioAssetId' | 'videoAssetId'> & Partial<Pick<Shot, 'clipEdit'>>): number {
  if (shot.clipEdit) return 0;
  const commonInUs = shot.sourceInUs ?? 0;
  return Math.max(0, shot.audioAssetId ? commonInUs - (shot.audioInUs ?? commonInUs) : 0, shot.videoAssetId ? commonInUs - (shot.videoInUs ?? commonInUs) : 0);
}

/** Last complete project-frame boundary within the probed media duration. */
export function maximumSourceOutUs(sourceDurationUs: number, rate: FrameRate): number {
  if (!Number.isFinite(sourceDurationUs) || sourceDurationUs <= 0) throw new RangeError('素材时长须为有效的正数。');
  const frame = frameAtTime(sourceDurationUs, rate);
  const frameTimeUs = timeAtFrame(frame, rate);
  // Compare stored microsecond timestamps so an already aligned boundary does not lose a frame to rounding.
  return frameTimeUs <= sourceDurationUs ? frameTimeUs : timeAtFrame(frame - 1, rate);
}

export function canSplitShot(shot: Shot, localTimeUs: number, rate: FrameRate): boolean {
  if (!Number.isFinite(localTimeUs)) return false;
  const frame = frameAtTime(localTimeUs, rate);
  if (shot.clipEdit) { const splitUs = timeAtFrame(frame, rate), minimum = minimumShotDurationUs(rate); return splitUs >= minimum && shot.durationUs - splitUs >= minimum; }
  const totalFrames = frameAtTime(shot.durationUs, rate);
  const minimumFrames = frameAtTime(minimumShotDurationUs(rate), rate);
  return frame >= minimumFrames && totalFrames - frame >= minimumFrames;
}

/** Split on the project frame grid without restarting the source media, animation or captions. */
export function splitShot(shot: Shot, localTimeUs: number, rate: FrameRate, newId: string, context: ClipEditContext = {}): [Shot, Shot] {
  if (!newId || newId === shot.id) throw new Error('分割后的镜头需要独立编号。');
  if (!canSplitShot(shot, localTimeUs, rate)) throw new RangeError('分割位置两侧都须保留至少半秒的完整帧。');
  const splitUs = timeAtFrame(frameAtTime(localTimeUs, rate), rate);
  if (shot.clipEdit) {
    const reference = shot.clipEdit, mapped = resolveShotTime(shot, context, splitUs);
    const end = reference.restoreInUs + reference.restoreDurationUs;
    return [
      { ...shot, durationUs: splitUs, clipEdit: { ...reference, restoreDurationUs: mapped.originUs - reference.restoreInUs } },
      { ...shot, id: newId, durationUs: shot.durationUs - splitUs, sourceInUs: mapped.sourceUs, audioInUs: mapped.audioUs, videoInUs: mapped.videoUs, sceneInUs: mapped.sceneUs,
        clipEdit: { ...reference, inUs: reference.inUs + splitUs, restoreInUs: mapped.originUs, restoreDurationUs: end - mapped.originUs }, animation: { ...shot.animation, transition: 'cut' } },
    ];
  }
  const durationUs = timeAtFrame(frameAtTime(shot.durationUs, rate), rate);
  const sourceInUs = shot.sourceInUs ?? 0;
  const sceneInUs = shot.sceneInUs ?? 0;
  const sceneDurationUs = shot.sceneDurationUs ?? shot.durationUs;
  return [
    { ...shot, durationUs: splitUs, sourceInUs, sceneInUs, sceneDurationUs },
    { ...shot, id: newId, durationUs: durationUs - splitUs, sourceInUs: sourceInUs + splitUs, sceneInUs: sceneInUs + splitUs, sceneDurationUs,
      ...(shot.audioInUs === undefined ? {} : { audioInUs: shot.audioInUs + splitUs }),
      ...(shot.videoInUs === undefined ? {} : { videoInUs: shot.videoInUs + splitUs }),
      animation: { ...shot.animation, transition: 'cut' } },
  ];
}

/** A physical endpoint may round down to a whole frame; inputs beyond that endpoint are rejected. */
export function trimShot(shot: Shot, range: { inUs: number; outUs: number }, rate: FrameRate, sourceDurationUs?: number, context: ClipEditContext = {}): Shot {
  if (!Number.isFinite(range.inUs) || !Number.isFinite(range.outUs) || range.inUs < 0 || range.outUs <= range.inUs) throw new RangeError('素材入出点须为有效时间，且出点应晚于入点。');
  const minimumInUs = minimumSourceInUs(shot);
  if (range.inUs < minimumInUs) throw new RangeError('素材入点不能使独立音视频的入点早于 0 秒。');
  const maximumOutUs = sourceDurationUs === undefined ? Infinity : maximumSourceOutUs(sourceDurationUs, rate);
  if (sourceDurationUs !== undefined && range.outUs > sourceDurationUs) throw new RangeError('素材出点超出真实时长。');
  const minimumFrame = frameAtTime(minimumInUs, rate);
  const alignedMinimumUs = timeAtFrame(minimumFrame, rate) >= minimumInUs ? timeAtFrame(minimumFrame, rate) : timeAtFrame(minimumFrame + 1, rate);
  const sourceInUs = Math.max(timeAtFrame(frameAtTime(range.inUs, rate), rate), alignedMinimumUs);
  const sourceOutUs = Math.min(timeAtFrame(frameAtTime(range.outUs, rate), rate), maximumOutUs);
  const durationUs = sourceOutUs - sourceInUs;
  if (durationUs < minimumShotDurationUs(rate) || durationUs > MAXIMUM_DURATION_US) throw new RangeError('片段至少保留 0.5 秒，且不超过 10 分钟（按项目帧率对齐）。');
  if (shot.clipEdit) {
    const plan = clipEditPlan(shot, context)!;
    if (sourceOutUs > clipEditTotalUs(plan)) throw new RangeError('扩展剪辑需要同时更新计划，请使用完整项目裁剪操作。');
    const reference = shot.clipEdit;
    const complete = { ...shot, durationUs: clipEditTotalUs(plan), clipEdit: { ...reference, inUs: 0 } };
    const start = resolveShotTime(complete, context, sourceInUs), end = resolveShotTime(complete, context, sourceOutUs);
    const restoreInUs = sourceInUs === reference.inUs ? reference.restoreInUs : start.originUs;
    const restoreEndUs = sourceOutUs === reference.inUs + shot.durationUs ? reference.restoreInUs + reference.restoreDurationUs : end.originUs;
    return { ...shot, durationUs, sourceInUs: start.sourceUs, audioInUs: start.audioUs, videoInUs: start.videoUs, sceneInUs: start.sceneUs,
      clipEdit: { ...reference, inUs: sourceInUs, restoreInUs, restoreDurationUs: restoreEndUs - restoreInUs } };
  }
  return {
    ...shot, sourceInUs, durationUs,
    ...(shot.audioInUs === undefined || !shot.audioAssetId ? {} : { audioInUs: shot.audioInUs + sourceInUs - (shot.sourceInUs ?? 0) }),
    ...(shot.videoInUs === undefined || !shot.videoAssetId ? {} : { videoInUs: shot.videoInUs + sourceInUs - (shot.sourceInUs ?? 0) }),
    sceneInUs: Math.max(0, (shot.sceneInUs ?? 0) + sourceInUs - (shot.sourceInUs ?? 0)),
    sceneDurationUs: shot.sceneDurationUs ?? shot.durationUs,
  };
}

/** Extend with a linear tail on a private plan; never reveal previously removed internal ranges. */
export function trimShotInContext<T extends ClipEditDocument>(content: T, shotId: string, range: { inUs: number; outUs: number }, rate: FrameRate, sourceDurationUs: number | undefined, id: ClipEditIdFactory): T {
  const shot = content.shots.find(value => value.id === shotId);
  if (!shot) throw new Error('镜头已移除，请重新选择。');
  if (shot.locked) throw new Error('请先解锁镜头，再调整入出点。');
  let nextContent = content, working = shot;
  const plan = clipEditPlan(shot, content);
  if (plan) {
    const totalUs = clipEditTotalUs(plan), maximum = sourceDurationUs === undefined ? Infinity : maximumSourceOutUs(sourceDurationUs, rate);
    if (sourceDurationUs !== undefined && range.outUs > sourceDurationUs) throw new RangeError('素材出点超出真实时长。');
    const endUs = Math.min(timeAtFrame(frameAtTime(range.outUs, rate), rate), maximum);
    if (endUs > totalUs) {
      const last = plan.spans.at(-1)!;
      const extended: ClipEditPlan = { ...plan, id: id('plan'), spans: [...plan.spans, { id: id('span'), durationUs: endUs - totalUs,
        originInUs: last.originInUs + last.durationUs, sourceInUs: last.sourceInUs + last.durationUs, audioInUs: last.audioInUs + last.durationUs, videoInUs: last.videoInUs + last.durationUs, sceneInUs: last.sceneInUs + last.durationUs }] };
      working = { ...shot, clipEdit: { ...shot.clipEdit!, planId: extended.id } };
      nextContent = { ...content, clipEditPlans: [...content.clipEditPlans ?? [], extended] };
    }
  }
  const trimmed = trimShot(working, range, rate, sourceDurationUs, nextContent);
  return { ...nextContent, shots: content.shots.map(value => value.id === shotId ? trimmed : value) };
}

/** targetIndex is the desired final index, including when moving a clip forward. */
export function reorderShots(shots: readonly Shot[], shotId: string, targetIndex: number): Shot[] {
  const current = shots.findIndex(shot => shot.id === shotId);
  if (current === -1) throw new Error('待移动镜头不存在。');
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= shots.length) throw new RangeError('目标镜头位置无效。');
  const result = [...shots];
  const [shot] = result.splice(current, 1);
  result.splice(targetIndex, 0, shot);
  return result;
}

/** Anchors and the returned position share the project frame grid; ties retain the first anchor. */
export function snapTimeUs(timeUs: number, rate: FrameRate, anchorsUs: readonly number[] = [], thresholdUs = 0): number {
  if (!Number.isFinite(timeUs) || !Number.isFinite(thresholdUs) || thresholdUs < 0) throw new RangeError('吸附时间与范围无效。');
  const aligned = timeAtFrame(frameAtTime(Math.max(0, timeUs), rate), rate);
  let snapped = aligned;
  let distance = Infinity;
  for (const anchor of anchorsUs) {
    if (!Number.isFinite(anchor) || anchor < 0) continue;
    const position = timeAtFrame(frameAtTime(anchor, rate), rate);
    const delta = Math.abs(position - aligned);
    if (delta <= thresholdUs && delta < distance) { snapped = position; distance = delta; }
  }
  return snapped;
}
