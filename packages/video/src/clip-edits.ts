import { firstFrameAtUs, timeAtFrame, type AssetRecord, type CaptionTrack, type ClipEditPlan, type ClipEditSource, type ClipEditSpan, type FrameRate, type ProjectDocument, type Shot } from '@video-quickly/contracts';

export type ClipEditContext = Pick<ProjectDocument, 'clipEditSources' | 'clipEditPlans'>;
export type ClipEditDocument = ClipEditContext & Pick<ProjectDocument, 'shots'>;
export type ClipEditIdFactory = (kind: 'source' | 'plan' | 'span') => string;
export type ClipTimingShot = Pick<Shot, 'durationUs'> & Partial<Pick<Shot, 'sourceInUs' | 'audioInUs' | 'videoInUs' | 'sceneInUs' | 'sceneDurationUs' | 'sceneIndex' | 'captionTrack' | 'clipEdit'>>;
export interface ClipRange { startUs: number; endUs: number }
export interface ResolvedClipSpan extends ClipEditSpan {
  spanIndex: number; outputStartUs: number; outputEndUs: number; planStartUs: number; planEndUs: number;
}
export interface ResolvedShotTime {
  originUs: number; sourceUs: number; audioUs: number; videoUs: number; sceneUs: number;
  spanIndex: number; discontinuityKey: string;
}

export function clipEditTotalUs(plan: Pick<ClipEditPlan, 'spans'>): number {
  return plan.spans.reduce((sum, span) => sum + span.durationUs, 0);
}

/** Return an absolute plan-clock endpoint, preserving the existing longer-tail hold/pad rule. */
export function clipSourceOutUs(shot: ClipTimingShot & Partial<Pick<Shot, 'audioAssetId' | 'videoAssetId' | 'sceneTemplate'>>, context: ClipEditContext, durations: { audioDurationUs?: number; videoDurationUs?: number }): number | undefined {
  const plan = clipEditPlan(shot, context);
  const last = plan?.spans.at(-1), totalUs = plan ? clipEditTotalUs(plan) : 0;
  const tails: number[] = [];
  if (durations.audioDurationUs !== undefined) tails.push(durations.audioDurationUs - (last ? last.audioInUs + last.durationUs : shot.audioInUs ?? shot.sourceInUs ?? 0));
  if (durations.videoDurationUs !== undefined && !shot.sceneTemplate) tails.push(durations.videoDurationUs - (last ? last.videoInUs + last.durationUs : shot.videoInUs ?? shot.sourceInUs ?? 0));
  return tails.length ? (plan ? totalUs : shot.sourceInUs ?? 0) + Math.max(...tails) : undefined;
}

export function clipEditPlan(shot: Pick<Shot, 'clipEdit'>, context: ClipEditContext = {}): ClipEditPlan | undefined {
  if (!shot.clipEdit) return undefined;
  const plan = context.clipEditPlans?.find(value => value.id === shot.clipEdit?.planId);
  if (!plan) throw new Error('镜头剪辑计划缺失，请重新读取项目。');
  return plan;
}

export function clipEditSource(shot: Pick<Shot, 'clipEdit'>, context: ClipEditContext = {}): ClipEditSource | undefined {
  const plan = clipEditPlan(shot, context);
  if (!plan) return undefined;
  const source = context.clipEditSources?.find(value => value.id === plan.sourceId);
  if (!source) throw new Error('镜头剪辑来源缺失，请重新读取项目。');
  return source;
}

export function sourceCaptionTrack(shot: Pick<Shot, 'captionTrack' | 'clipEdit'>, context: ClipEditContext = {}): CaptionTrack | undefined {
  return shot.captionTrack ?? clipEditSource(shot, context)?.original.captionTrack;
}

function shifted(span: ClipEditSpan, shiftUs: number, durationUs: number): ClipEditSpan {
  return { ...span, durationUs, originInUs: span.originInUs + shiftUs, sourceInUs: span.sourceInUs + shiftUs,
    audioInUs: span.audioInUs + shiftUs, videoInUs: span.videoInUs + shiftUs, sceneInUs: span.sceneInUs + shiftUs };
}

/** Slice one fixed plan clock without re-quantizing its internal cuts at another output fps. */
export function sliceClipPlan(plan: Pick<ClipEditPlan, 'spans'>, startUs: number, endUs: number): ResolvedClipSpan[] {
  if (!Number.isFinite(startUs) || !Number.isFinite(endUs) || startUs < 0 || endUs < startUs || endUs > clipEditTotalUs(plan)) throw new RangeError('剪辑窗口超出计划范围。');
  let cursor = 0;
  return plan.spans.flatMap((span, spanIndex) => {
    const spanStartUs = cursor; cursor += span.durationUs;
    const from = Math.max(startUs, spanStartUs), to = Math.min(endUs, cursor);
    return to > from ? [{ ...shifted(span, from - spanStartUs, to - from), spanIndex, outputStartUs: from - startUs, outputEndUs: to - startUs, planStartUs: from, planEndUs: to }] : [];
  });
}

/** Legacy shots remain a single linear span; edited shots share immutable plan/source records. */
export function resolveShotSpans(shot: ClipTimingShot, context: ClipEditContext = {}): ResolvedClipSpan[] {
  const plan = clipEditPlan(shot, context);
  if (plan && shot.clipEdit) {
    clipEditSource(shot, context);
    return sliceClipPlan(plan, shot.clipEdit.inUs, shot.clipEdit.inUs + shot.durationUs);
  }
  const sourceInUs = shot.sourceInUs ?? 0;
  return [{ id: 'linear', spanIndex: 0, durationUs: shot.durationUs, outputStartUs: 0, outputEndUs: shot.durationUs, planStartUs: 0, planEndUs: shot.durationUs,
    originInUs: 0, sourceInUs, audioInUs: shot.audioInUs ?? sourceInUs, videoInUs: shot.videoInUs ?? sourceInUs, sceneInUs: shot.sceneInUs ?? 0 }];
}

export function resolveShotTime(shot: ClipTimingShot, context: ClipEditContext = {}, localUs = 0): ResolvedShotTime {
  if (!Number.isFinite(localUs)) throw new RangeError('镜头播放时间须为有效数值。');
  const timeUs = Math.max(0, Math.min(shot.durationUs, localUs)), plan = clipEditPlan(shot, context);
  if (!plan || !shot.clipEdit) {
    const common = shot.sourceInUs ?? 0;
    return { originUs: timeUs, sourceUs: common + timeUs, audioUs: (shot.audioInUs ?? common) + timeUs, videoUs: (shot.videoInUs ?? common) + timeUs, sceneUs: (shot.sceneInUs ?? 0) + timeUs,
      spanIndex: 0, discontinuityKey: 'linear' };
  }
  clipEditSource(shot, context);
  const absoluteUs = shot.clipEdit.inUs + timeUs;
  if (shot.clipEdit.inUs + shot.durationUs > clipEditTotalUs(plan)) throw new RangeError('剪辑窗口超出计划范围。');
  // Playback resolves only one span, without allocating every span on every animation frame.
  let cursor = 0;
  for (let index = 0; index < plan.spans.length; index++) {
    const span = plan.spans[index], endUs = cursor + span.durationUs;
    if (absoluteUs < endUs || timeUs === shot.durationUs && absoluteUs === endUs || index === plan.spans.length - 1) {
      const deltaUs = absoluteUs - cursor;
      return { originUs: span.originInUs + deltaUs, sourceUs: span.sourceInUs + deltaUs, audioUs: span.audioInUs + deltaUs, videoUs: span.videoInUs + deltaUs, sceneUs: span.sceneInUs + deltaUs,
        spanIndex: index, discontinuityKey: JSON.stringify([plan.id, span.id, index]) };
    }
    cursor = endUs;
  }
  throw new Error('镜头剪辑窗口为空。');
}
export const resolveShotAtTime = resolveShotTime;

export function captureClipEditSource(shot: Shot, assets: readonly Pick<AssetRecord, 'id' | 'sha256'>[], id: string): ClipEditSource {
  const { durationUs, sourceInUs, audioInUs, videoInUs, sceneInUs, sceneDurationUs, sceneIndex, captionTrack, assetId, audioAssetId, videoAssetId } = shot;
  const ids = new Set([assetId, audioAssetId, videoAssetId, captionTrack?.sourceAssetId].filter((value): value is string => Boolean(value)));
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const assetHashes = [...ids].map(assetId => {
    const asset = byId.get(assetId);
    if (!asset) throw new Error('剪辑来源素材缺失，请重新读取素材。');
    return { assetId, sha256: asset.sha256 };
  });
  return { id, original: structuredClone({ durationUs, sourceInUs, audioInUs, videoInUs, sceneInUs, sceneDurationUs, sceneIndex, captionTrack, assetId, audioAssetId, videoAssetId }), assetHashes };
}

function target(content: ClipEditDocument, shotId: string): Shot {
  const shot = content.shots.find(value => value.id === shotId);
  if (!shot) throw new Error('镜头已移除，请重新选择。');
  if (shot.locked) throw new Error('请先解锁镜头，再修改剪辑。');
  return shot;
}
function storedSpan(value: ClipEditSpan, id: string): ClipEditSpan {
  const { durationUs, originInUs, sourceInUs, audioInUs, videoInUs, sceneInUs } = value;
  return { id, durationUs, originInUs, sourceInUs, audioInUs, videoInUs, sceneInUs };
}
function withShot<T extends ClipEditDocument>(content: T, shot: Shot): T {
  return { ...content, shots: content.shots.map(value => value.id === shot.id ? shot : value) };
}
function normalizedRanges(ranges: readonly ClipRange[], durationUs: number, rate: FrameRate): ClipRange[] {
  const rounded = ranges.map(range => {
    if (!Number.isFinite(range.startUs) || !Number.isFinite(range.endUs) || range.startUs < 0 || range.endUs > durationUs || range.endUs <= range.startUs) throw new RangeError('删除区间须位于当前镜头内。');
    const afterStart = firstFrameAtUs(range.startUs, rate), boundary = timeAtFrame(afterStart, rate);
    return { startUs: Math.max(0, boundary > range.startUs ? timeAtFrame(afterStart - 1, rate) : boundary), endUs: Math.min(durationUs, timeAtFrame(firstFrameAtUs(range.endUs, rate), rate)) };
  }).sort((a, b) => a.startUs - b.startUs);
  const merged: ClipRange[] = [];
  for (const range of rounded) {
    const previous = merged.at(-1);
    if (previous && range.startUs <= previous.endUs) previous.endUs = Math.max(previous.endUs, range.endUs);
    else merged.push({ ...range });
  }
  return merged;
}

/** Remove output ranges across every clock, retaining the original track exactly once. */
export function deleteShotRanges<T extends ClipEditDocument>(content: T, shotId: string, ranges: readonly ClipRange[], rate: FrameRate, assets: readonly Pick<AssetRecord, 'id' | 'sha256'>[], id: ClipEditIdFactory): T {
  const shot = target(content, shotId);
  if (!ranges.length) return content;
  const removed = normalizedRanges(ranges, shot.durationUs, rate), spans = resolveShotSpans(shot, content);
  const kept: ClipRange[] = []; let cursor = 0;
  for (const range of removed) { if (range.startUs > cursor) kept.push({ startUs: cursor, endUs: range.startUs }); cursor = range.endUs; }
  if (cursor < shot.durationUs) kept.push({ startUs: cursor, endUs: shot.durationUs });
  const durationUs = kept.reduce((sum, range) => sum + range.endUs - range.startUs, 0);
  const minimumUs = timeAtFrame(firstFrameAtUs(500_000, rate), rate);
  if (durationUs < minimumUs) throw new RangeError('删除后镜头须保留至少 0.5 秒。');
  const source = clipEditSource(shot, content) ?? captureClipEditSource(shot, assets, id('source'));
  const originalWindow = shot.clipEdit ?? { restoreInUs: 0, restoreDurationUs: shot.durationUs };
  const plan: ClipEditPlan = { id: id('plan'), sourceId: source.id, spans: kept.flatMap(range => spans.flatMap(span => {
    const from = Math.max(range.startUs, span.outputStartUs), to = Math.min(range.endUs, span.outputEndUs);
    return to > from ? [storedSpan(shifted(span, from - span.outputStartUs, to - from), id('span'))] : [];
  })) };
  let next: Shot = { ...shot, durationUs, captionTrack: undefined, sourceInUs: shot.sourceInUs ?? 0, sceneInUs: shot.sceneInUs ?? 0, sceneDurationUs: shot.sceneDurationUs ?? source.original.sceneDurationUs ?? source.original.durationUs,
    clipEdit: { planId: plan.id, inUs: 0, restoreInUs: originalWindow.restoreInUs, restoreDurationUs: originalWindow.restoreDurationUs } };
  // An authored override belongs to the previous output clock. Project it through the kept ranges.
  if (shot.captionTrack?.timeBase === 'clip') {
    const offset = shot.clipEdit?.inUs ?? 0; let outputUs = 0;
    const cues = kept.flatMap(range => {
      const projected = shot.captionTrack!.cues.flatMap(cue => {
        const from = Math.max(cue.startUs, offset + range.startUs), to = Math.min(cue.endUs, offset + range.endUs);
        return to > from ? [{ ...cue, id: `${cue.id}:${outputUs}:${from}`, startUs: outputUs + from - offset - range.startUs, endUs: outputUs + to - offset - range.startUs }] : [];
      });
      outputUs += range.endUs - range.startUs; return projected;
    });
    next = { ...next, captionTrack: { ...shot.captionTrack, cues } };
  } else if (shot.captionTrack && shot.clipEdit) next = { ...next, captionTrack: shot.captionTrack };
  return withShot({ ...content, clipEditSources: content.clipEditSources?.some(value => value.id === source.id) ? content.clipEditSources : [...content.clipEditSources ?? [], source], clipEditPlans: [...content.clipEditPlans ?? [], plan] }, next);
}

/** Restore only this split/trimmed source-local window, never the entire parent shot. */
export function restoreShotRanges<T extends ClipEditDocument>(content: T, shotId: string): T {
  const shot = target(content, shotId), reference = shot.clipEdit, source = clipEditSource(shot, content);
  if (!reference || !source) return content;
  if (reference.restoreDurationUs < 500_000 || reference.restoreDurationUs > 600_000_000) throw new RangeError('恢复后的镜头须为 0.5 秒至 10 分钟，请先分割镜头后分别恢复。');
  const original = source.original, delta = reference.restoreInUs;
  const captionTrack = original.captionTrack?.timeBase === 'clip' ? { ...original.captionTrack, timeBase: 'scene' as const,
    cues: original.captionTrack.cues.map(cue => ({ ...cue, startUs: cue.startUs + (original.sceneInUs ?? 0), endUs: cue.endUs + (original.sceneInUs ?? 0) })) } : original.captionTrack;
  return withShot(content, { ...shot, clipEdit: undefined, durationUs: reference.restoreDurationUs,
    assetId: original.assetId, audioAssetId: original.audioAssetId, videoAssetId: original.videoAssetId,
    sourceInUs: (original.sourceInUs ?? 0) + delta,
    audioInUs: (original.audioInUs ?? original.sourceInUs ?? 0) + delta,
    videoInUs: (original.videoInUs ?? original.sourceInUs ?? 0) + delta,
    sceneInUs: (original.sceneInUs ?? 0) + delta, sceneDurationUs: original.sceneDurationUs ?? original.durationUs,
    sceneIndex: original.sceneIndex ?? shot.sceneIndex,
    captionTrack });
}

/** Rebase one replacement stream on output time; the other stream retains every old jump. */
export function replaceShotMedia<T extends ClipEditDocument>(content: T, shotId: string, kind: 'audio' | 'video', asset: Pick<AssetRecord, 'id' | 'sha256'>, id: ClipEditIdFactory): T {
  const shot = target(content, shotId), key = kind === 'audio' ? 'audioAssetId' : 'videoAssetId';
  if (shot[key] === asset.id) return content;
  let next: Shot = { ...shot, [key]: asset.id, ...(kind === 'audio' ? { audioInUs: 0 } : { videoInUs: 0, sceneTemplate: undefined }) };
  if (!shot.clipEdit) return withShot(content, next);
  const source = clipEditSource(shot, content)!;
  const plan: ClipEditPlan = { id: id('plan'), sourceId: source.id, spans: resolveShotSpans(shot, content).map(span => storedSpan({ ...span, [kind === 'audio' ? 'audioInUs' : 'videoInUs']: span.outputStartUs }, id('span'))) };
  next = { ...next, clipEdit: { ...shot.clipEdit, planId: plan.id, inUs: 0 } };
  if (shot.captionTrack?.timeBase === 'clip') next = { ...next, captionTrack: { ...shot.captionTrack, cues: shot.captionTrack.cues.map(cue => ({ ...cue, startUs: cue.startUs - shot.clipEdit!.inUs, endUs: cue.endUs - shot.clipEdit!.inUs })).filter(cue => cue.endUs > 0 && cue.startUs < shot.durationUs).map(cue => ({ ...cue, startUs: Math.max(0, cue.startUs), endUs: Math.min(shot.durationUs, cue.endUs) })) } };
  return withShot({ ...content, clipEditPlans: [...content.clipEditPlans ?? [], plan] }, next);
}
