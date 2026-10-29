import { seriesSettingsSchema, type ProjectDocument, type SeriesSettings } from '@video-quickly/contracts';
import type { EditContent } from './project-edits';

export interface SeriesApplyOptions {
  style: boolean;
  captionStyle: boolean;
  scenePreset: boolean;
  clearShotCaptionStyles: boolean;
  updateExistingSceneLook: boolean;
}
export const DEFAULT_SERIES_APPLY_OPTIONS: SeriesApplyOptions = {
  style: true, captionStyle: true, scenePreset: true, clearShotCaptionStyles: false, updateExistingSceneLook: false,
};
export function seriesSettingsFromProject(project: Pick<ProjectDocument, 'style' | 'captionStyle' | 'scenePreset'>): SeriesSettings {
  return { style: project.style, captionStyle: project.captionStyle ? structuredClone(project.captionStyle) : null, scenePreset: project.scenePreset ? structuredClone(project.scenePreset) : null };
}

/** Copy reusable appearance, preserving the current topic, evidence, media and authored chart values. */
export function applySeriesSettings(content: EditContent, value: SeriesSettings, options: SeriesApplyOptions, shotIds?: readonly string[]): EditContent {
  const settings = seriesSettingsSchema.parse(value);
  const scope = shotIds ? new Set(shotIds) : undefined;
  return {
    ...content,
    ...(options.style ? { style: settings.style } : {}),
    ...(options.captionStyle ? { captionStyle: structuredClone(settings.captionStyle) } : {}),
    ...(options.scenePreset ? { scenePreset: structuredClone(settings.scenePreset) } : {}),
    shots: content.shots.map(shot => {
      if (shot.locked || scope && !scope.has(shot.id)) return shot;
      const sceneTemplate = options.updateExistingSceneLook && settings.scenePreset && shot.sceneTemplate ? { ...shot.sceneTemplate, palette: settings.scenePreset.palette, motion: settings.scenePreset.motion } : shot.sceneTemplate;
      return { ...shot, ...(options.clearShotCaptionStyles ? { captionStyle: null } : {}), sceneTemplate };
    }),
  };
}
