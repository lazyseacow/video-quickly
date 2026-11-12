import { captionStyleSchema, type CaptionStyle, type ProjectDocument, type SeriesSettings, type Shot } from '@video-quickly/contracts';
import { sameContent, type EditContent } from './project-edits';
import { applySeriesSettings, type SeriesApplyOptions } from './series-templates';

export type CaptionStyleTarget = { mode: 'project' } | { mode: 'shot'; shotId: string };
export type SeriesSubmission = {
  content: EditContent;
  options: SeriesApplyOptions;
  shotIds: { clearShotCaptionStyles: string[]; updateExistingSceneLook: string[] };
};

export function rememberSeriesSubmission(previous: SeriesSubmission | undefined, content: EditContent, touchedOptions: SeriesApplyOptions, scopeShotIds: readonly string[]): SeriesSubmission {
  const owned = structuredClone(previous?.content ?? content);
  const options = { ...touchedOptions };
  for (const key of Object.keys(options) as (keyof SeriesApplyOptions)[]) options[key] ||= previous?.options[key] ?? false;
  // Unselected scopes may contain unrelated live edits; only retain values this dialog submitted.
  for (const key of ['style', 'captionStyle', 'scenePreset'] as const) if (touchedOptions[key]) Object.assign(owned, { [key]: structuredClone(content[key]) });
  const captionIds = new Set(previous?.shotIds.clearShotCaptionStyles), lookIds = new Set(previous?.shotIds.updateExistingSceneLook);
  const scope = new Set(scopeShotIds), shots = new Map(owned.shots.map(shot => [shot.id, shot]));
  for (const shot of content.shots) {
    if (shot.locked || !scope.has(shot.id)) continue;
    const clearCaption = touchedOptions.clearShotCaptionStyles, updateLook = touchedOptions.updateExistingSceneLook && Boolean(shot.sceneTemplate);
    if (!clearCaption && !updateLook) continue;
    const value = shots.get(shot.id) ?? structuredClone(shot);
    if (clearCaption) { value.captionStyle = structuredClone(shot.captionStyle ?? null); captionIds.add(shot.id); }
    if (updateLook) { value.sceneTemplate = structuredClone(shot.sceneTemplate); lookIds.add(shot.id); }
    shots.set(shot.id, value);
  }
  owned.shots = [...shots.values()];
  return { content: owned, options, shotIds: { clearShotCaptionStyles: [...captionIds], updateExistingSceneLook: [...lookIds] } };
}
function requireUnchanged(current: unknown, baseline: unknown, owned: unknown, hasOwned: boolean) {
  if (!sameContent(current, baseline) && !(hasOwned && sameContent(current, owned))) throw new Error('准备修改的样式已在其他视图更新，当前输入已保留，请重新打开后核对。');
}
export function applyCaptionStyleEdit(current: EditContent, baseline: ProjectDocument, target: CaptionStyleTarget, value: CaptionStyle | null, submitted?: CaptionStyle | null): EditContent {
  const style = captionStyleSchema.nullable().parse(value);
  if (target.mode === 'project') {
    requireUnchanged(current.captionStyle, baseline.captionStyle ?? null, submitted, submitted !== undefined);
    return { ...current, captionStyle: structuredClone(style) };
  }
  const before = baseline.shots.find(shot => shot.id === target.shotId), shot = current.shots.find(shot => shot.id === target.shotId);
  if (!before || !shot) throw new Error('准备修改字幕样式的镜头已移除，请重新选择。');
  if (shot.locked) throw new Error('请先解锁镜头，再修改字幕样式。');
  requireUnchanged(shot.captionStyle ?? null, before.captionStyle ?? null, submitted, submitted !== undefined);
  return { ...current, shots: current.shots.map(shot => shot.id === target.shotId ? { ...shot, captionStyle: structuredClone(style) } : shot) };
}

export function applySeriesEdit(current: EditContent, baseline: ProjectDocument, settings: SeriesSettings, options: SeriesApplyOptions, submitted?: SeriesSubmission): EditContent {
  if (!Object.values(options).some(Boolean)) throw new Error('请至少选择一个系列设置应用范围。');
  for (const key of ['style', 'captionStyle', 'scenePreset'] as const) if (options[key]) requireUnchanged(current[key], key === 'style' ? baseline[key] : baseline[key] ?? null, submitted?.content[key], Boolean(submitted?.options[key]));
  for (const shot of current.shots) {
    if (shot.locked) continue;
    const before = baseline.shots.find(value => value.id === shot.id), owned = submitted?.content.shots.find(value => value.id === shot.id);
    if (!before) continue;
    if (options.clearShotCaptionStyles) requireUnchanged(shot.captionStyle ?? null, before.captionStyle ?? null, owned?.captionStyle ?? null, Boolean(submitted?.shotIds.clearShotCaptionStyles.includes(shot.id)));
    if (options.updateExistingSceneLook && settings.scenePreset && shot.sceneTemplate) {
      const look = (value: Shot['sceneTemplate']) => value ? { palette: value.palette, motion: value.motion } : undefined;
      requireUnchanged(look(shot.sceneTemplate), look(before.sceneTemplate), look(owned?.sceneTemplate), Boolean(submitted?.shotIds.updateExistingSceneLook.includes(shot.id)));
    }
  }
  return applySeriesSettings(current, settings, options, baseline.shots.map(shot => shot.id));
}
