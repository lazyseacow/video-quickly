import { captionStyleSchema, effectiveCaptionStyle, shotSchema, usesVideoAudio, type CaptionStyle, type Shot } from '@video-quickly/contracts';
import { commonSourceOutUs } from '@video-quickly/video/audio';
import { trimShotInContext } from '@video-quickly/video/editing';
import { clipEditPlan, clipEditSource, type ClipEditContext, type ClipEditIdFactory } from '@video-quickly/video/clip-edits';
import { sameContent, type EditContent } from './project-edits';

export interface BulkShotChanges {
  durationUs?: number;
  animation?: Shot['animation'];
  captionStyle?: CaptionStyle | null;
  copyStyleFromId?: string;
}
const names = (shots: readonly Shot[]) => shots.map(shot => `「${shot.title || shot.id}」`).join('、');

function targets(content: EditContent, ids: readonly string[]): Shot[] {
  if (!ids.length) throw new Error('请先选择至少一个镜头。');
  const selected = new Set(ids);
  if (selected.size !== ids.length) throw new Error('选中镜头编号不能重复。');
  const found = content.shots.filter(shot => selected.has(shot.id));
  const missing = ids.filter(id => !found.some(shot => shot.id === id));
  if (missing.length) throw new Error(`准备修改的镜头已移除：${missing.join('、')}。`);
  if (found.length !== ids.length) throw new Error('镜头编号重复，请先修复项目。');
  const locked = found.filter(shot => shot.locked);
  if (locked.length) throw new Error(`镜头${names(locked)}已锁定，请先解锁后再批量操作。`);
  return found;
}
function requireSame(current: unknown, before: unknown, label: string) {
  if (!sameContent(current, before)) throw new Error(`${label}已变化，当前输入已保留，请重新打开批改后核对。`);
}
const look = (shot: Shot) => shot.sceneTemplate ? { palette: shot.sceneTemplate.palette, motion: shot.sceneTemplate.motion } : undefined;
function timingInputs(shot: Shot) {
  const videoId = shot.sceneTemplate && !usesVideoAudio(shot) ? undefined : shot.videoAssetId;
  return { durationUs: shot.durationUs, sourceInUs: shot.sourceInUs, sceneInUs: shot.sceneInUs, sceneDurationUs: shot.sceneDurationUs,
    audioAssetId: shot.audioAssetId, audioInUs: shot.audioAssetId ? shot.audioInUs : undefined,
    templateActive: Boolean(shot.sceneTemplate), videoAssetId: videoId, videoInUs: videoId ? shot.videoInUs : undefined, clipEdit: shot.clipEdit };
}
function sourceLimit(shot: Shot, durations: Readonly<Record<string, number>>, context: ClipEditContext): number | undefined {
  function duration(id: string | undefined, kind: string) {
    if (!id) return undefined;
    const value = Object.hasOwn(durations, id) ? durations[id] : undefined;
    if (value === undefined || !Number.isFinite(value) || value <= 0) throw new Error(`镜头${names([shot])}的${kind}素材时长尚未读取或读取失败，请读取成功后重试。`);
    return value;
  }
  return commonSourceOutUs(shot, { audioDurationUs: duration(shot.audioAssetId, '音频'), videoDurationUs: duration(shot.sceneTemplate && !usesVideoAudio(shot) ? undefined : shot.videoAssetId, '视频') }, context);
}

/** Validate every target before returning a single immutable command payload. */
export function applyBulkShotEdit(current: EditContent, baseline: EditContent, ids: readonly string[], changes: BulkShotChanges, sourceDurations: Readonly<Record<string, number>>, id: ClipEditIdFactory = () => crypto.randomUUID()): EditContent {
  const selected = targets(current, ids), previous = new Map(baseline.shots.map(shot => [shot.id, shot]));
  const hasDuration = changes.durationUs !== undefined, hasAnimation = changes.animation !== undefined, hasCaption = changes.captionStyle !== undefined, copying = changes.copyStyleFromId !== undefined;
  if (!hasDuration && !hasAnimation && !hasCaption && !copying) throw new Error('请选择至少一项批改内容。');
  if (copying && (hasAnimation || hasCaption)) throw new Error('复制样式不能与显式运镜或字幕样式修改同时应用。');
  const duration = hasDuration ? shotSchema.shape.durationUs.parse(changes.durationUs) : undefined;
  const animation = hasAnimation ? shotSchema.shape.animation.parse(changes.animation) : undefined;
  const captionStyle = hasCaption ? captionStyleSchema.nullable().parse(changes.captionStyle) : undefined;
  if (hasDuration) requireSame(current.profile.frameRate, baseline.profile.frameRate, '项目帧率');
  let source: Shot | undefined, sourceBefore: Shot | undefined, copiedCaption: CaptionStyle | null | undefined;
  if (copying) {
    source = current.shots.find(shot => shot.id === changes.copyStyleFromId); sourceBefore = baseline.shots.find(shot => shot.id === changes.copyStyleFromId);
    if (!source || !sourceBefore) throw new Error('准备复制样式的来源镜头已移除，请重新选择。');
    requireSame(source.animation, sourceBefore.animation, `来源镜头${names([source])}的运镜`);
    copiedCaption = effectiveCaptionStyle(current, source) ?? null;
    requireSame(copiedCaption, effectiveCaptionStyle(baseline, sourceBefore) ?? null, `来源镜头${names([source])}的字幕样式`);
    if (selected.some(shot => shot.sceneTemplate || previous.get(shot.id)?.sceneTemplate)) requireSame(look(source), look(sourceBefore), `来源镜头${names([source])}的图解外观`);
  }
  const replacements = new Map<string, Shot>();
  let working = current;
  const errors: string[] = [];
  for (const shot of selected) {
    try {
      const before = previous.get(shot.id);
      if (!before) throw new Error(`镜头${names([shot])}不在本次批改打开时的范围，请重新选择。`);
      if (hasDuration) {
        requireSame(timingInputs(shot), timingInputs(before), `镜头${names([shot])}准备修改的时长或素材区间`);
        if (shot.clipEdit) { requireSame(clipEditPlan(shot, current), clipEditPlan(before, baseline), '剪辑计划'); requireSame(clipEditSource(shot, current), clipEditSource(before, baseline), '原始剪辑来源'); }
      }
      if (hasAnimation || copying) requireSame(shot.animation, before.animation, `镜头${names([shot])}准备修改的运镜`);
      if (hasCaption || copying) requireSame(shot.captionStyle ?? null, before.captionStyle ?? null, `镜头${names([shot])}准备修改的字幕样式`);
      if (source && sourceBefore && (source.sceneTemplate || sourceBefore.sceneTemplate)) requireSame(look(shot), look(before), `镜头${names([shot])}准备修改的图解外观`);
      let next = shot;
      if (duration !== undefined) {
        const inUs = shot.clipEdit?.inUs ?? shot.sourceInUs ?? 0, limit = sourceLimit(shot, sourceDurations, current);
        try { working = trimShotInContext(working, shot.id, { inUs, outUs: inUs + duration }, current.profile.frameRate, limit, id); next = working.shots.find(value => value.id === shot.id)!; }
        catch (error) { throw new Error(`镜头${names([shot])}：${error instanceof Error ? error.message : String(error)}`); }
      }
      if (animation) next = { ...next, animation: structuredClone(animation) };
      if (captionStyle !== undefined) next = { ...next, captionStyle: structuredClone(captionStyle) };
      if (source) next = { ...next, animation: structuredClone(source.animation), captionStyle: structuredClone(copiedCaption ?? null), sceneTemplate: source.sceneTemplate && next.sceneTemplate ? { ...next.sceneTemplate, palette: source.sceneTemplate.palette, motion: source.sceneTemplate.motion } : next.sceneTemplate };
      replacements.set(shot.id, next);
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const shots = working.shots.map(shot => replacements.get(shot.id) ?? shot);
  return sameContent(shots, current.shots) && sameContent(working.clipEditPlans, current.clipEditPlans) ? current : { ...working, shots };
}

function stableSceneShots(content: EditContent): Shot[] {
  if (new Set(content.shots.map(shot => shot.id)).size !== content.shots.length) throw new Error('镜头编号重复，请先修复项目。');
  return content.shots.map((shot, index) => shot.sceneIndex === undefined ? { ...shot, sceneIndex: index } : shot);
}

/** A drag inserts the selected group into a slot in the remaining list. */
export function bulkReorderShots(content: EditContent, ids: readonly string[], targetIndexAfterRemoval: number): EditContent {
  targets(content, ids); const selected = new Set(ids), remainingLength = content.shots.length - ids.length;
  if (!Number.isInteger(targetIndexAfterRemoval) || targetIndexAfterRemoval < 0 || targetIndexAfterRemoval > remainingLength) throw new Error('目标镜头位置无效。');
  const stable = stableSceneShots(content), group = stable.filter(shot => selected.has(shot.id)), remaining = stable.filter(shot => !selected.has(shot.id));
  const shots = [...remaining.slice(0, targetIndexAfterRemoval), ...group, ...remaining.slice(targetIndexAfterRemoval)];
  return sameContent(shots.map(shot => shot.id), content.shots.map(shot => shot.id)) ? content : { ...content, shots };
}

/** Move each contiguous selected run across one neighboring unselected shot. */
export function bulkMoveShots(content: EditContent, ids: readonly string[], direction: -1 | 1): EditContent {
  targets(content, ids); if (direction !== -1 && direction !== 1) throw new Error('移动方向须为前移或后移。');
  const selected = new Set(ids), shots = stableSceneShots(content);
  if (direction === -1) {
    for (let index = 1; index < shots.length; index++) if (selected.has(shots[index].id) && !selected.has(shots[index - 1].id)) [shots[index - 1], shots[index]] = [shots[index], shots[index - 1]];
  } else {
    for (let index = shots.length - 2; index >= 0; index--) if (selected.has(shots[index].id) && !selected.has(shots[index + 1].id)) [shots[index], shots[index + 1]] = [shots[index + 1], shots[index]];
  }
  return sameContent(shots.map(shot => shot.id), content.shots.map(shot => shot.id)) ? content : { ...content, shots };
}

export function bulkRemoveShots(content: EditContent, ids: readonly string[]): EditContent {
  targets(content, ids); const selected = new Set(ids);
  return { ...content, shots: stableSceneShots(content).filter(shot => !selected.has(shot.id)) };
}

/** Insert each copy immediately after its original; IDs are allocated once by the caller. */
export function bulkDuplicateShots(content: EditContent, ids: readonly string[], newIds: Readonly<Record<string, string>>): EditContent {
  const selected = targets(content, ids), existingIds = new Set(content.shots.map(shot => shot.id)), createdIds = new Set<string>();
  for (const shot of selected) {
    const id = Object.hasOwn(newIds, shot.id) ? newIds[shot.id] : undefined;
    if (typeof id !== 'string' || !id || existingIds.has(id) || createdIds.has(id)) throw new Error(`镜头${names([shot])}的副本需要独立且不重复的新编号。`);
    createdIds.add(id);
  }
  const selectedIds = new Set(ids);
  return { ...content, shots: stableSceneShots(content).flatMap(shot => selectedIds.has(shot.id) ? [shot, { ...structuredClone(shot), id: newIds[shot.id], title: `${shot.title.slice(0, 155)} · 副本` }] : [shot]) };
}
