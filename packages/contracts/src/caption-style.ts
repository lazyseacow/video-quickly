import { z } from 'zod';
import { processSceneTemplateSchema } from './scene-templates.js';

const color = z.string().regex(/^#[0-9a-f]{6}$/i, '颜色须为六位十六进制值，例如 #FFFFFF');
export const captionStyleSchema = z.object({
  version: z.literal(1), fontId: z.enum(['sans', 'serif']), fontSizeRatio: z.number().finite().min(.018).max(.09),
  fontWeight: z.union([z.literal(400), z.literal(700)]), textColor: color, backgroundColor: color,
  backgroundOpacity: z.number().finite().min(0).max(1), position: z.enum(['top', 'bottom']),
  maxLines: z.number().int().min(1).max(3),
});
export type CaptionStyle = z.infer<typeof captionStyleSchema>;
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  version: 1, fontId: 'sans', fontSizeRatio: .047, fontWeight: 400, textColor: '#fbf4e1',
  backgroundColor: '#20382e', backgroundOpacity: .9, position: 'bottom', maxLines: 2,
};
export const scenePresetSchema = z.object({
  kind: z.enum(['process', 'comparison', 'bar-chart']),
  palette: processSceneTemplateSchema.shape.palette, motion: processSceneTemplateSchema.shape.motion,
});
export type ScenePreset = z.infer<typeof scenePresetSchema>;
export const seriesSettingsSchema = z.object({
  style: z.string().max(30_000), captionStyle: captionStyleSchema.nullable(), scenePreset: scenePresetSchema.nullable(),
});
export type SeriesSettings = z.infer<typeof seriesSettingsSchema>;
export const seriesTemplateSchema = z.object({
  id: z.string().min(1).max(128), name: z.string().trim().min(1).max(120), description: z.string().max(10_000),
  revision: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string(), archived: z.boolean().default(false),
  settings: seriesSettingsSchema,
});
export type SeriesTemplate = z.infer<typeof seriesTemplateSchema>;

/** Null/absence means inheritance. Absence at both levels retains the legacy renderer. */
export function effectiveCaptionStyle(project: { captionStyle?: CaptionStyle | null }, shot?: { captionStyle?: CaptionStyle | null }): CaptionStyle | undefined {
  return shot?.captionStyle ?? project.captionStyle ?? undefined;
}
