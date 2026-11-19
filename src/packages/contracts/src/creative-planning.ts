import { z } from 'zod';
import { MAX_STORYBOARD_SHOTS, planningDocumentSchemas } from './planning-fields.js';

export const CREATIVE_REFERENCE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const CREATIVE_SEGMENT_DURATION_US = 5_000_000;
export const CREATIVE_SEGMENT_COUNT = 3;
export const creativeReferenceMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp']);

export const creativeStyleCardContentSchema = z.strictObject({
  fields: planningDocumentSchemas.style,
  swatches: z.array(z.strictObject({ hex: z.string().regex(/^#[\da-fA-F]{6}$/), label: z.string().trim().min(1).max(40) })).min(3).max(6),
});

export const creativeStyleCardSchema = creativeStyleCardContentSchema.extend({
  id: z.string().min(1), title: z.string(), version: z.literal(1),
  reference: z.strictObject({ assetId: z.string().min(1), version: z.number().int().positive() }), createdAt: z.string(),
});
export type CreativeStyleCard = z.infer<typeof creativeStyleCardSchema>;

export const creativeObjectiveRoutes = { 'style-only': '只提取风格', storyboard: '沿用风格出分镜', 'keyframe-preview': '预演关键镜头' } as const;
export const creativeObjectiveRouteSchema = z.enum(['style-only', 'storyboard', 'keyframe-preview']);

export const creativeObjectiveAnalysisSchema = z.strictObject({
  route: creativeObjectiveRouteSchema, reason: z.string().trim().min(1).max(500),
  totalSeconds: z.number().nullable(), shotCount: z.number().nullable(),
  shotSeconds: z.array(z.number().nullable()).nullable(), keyframeShots: z.array(z.number()).nullable(),
});
export type CreativeObjectiveAnalysis = z.infer<typeof creativeObjectiveAnalysisSchema>;

export const creativeObjectiveInputSchema = z.strictObject({
  requestId: z.uuid(), goal: z.string().trim().min(1).max(3000), modelId: z.string().min(1),
});

const objectiveTimingSchema = z.object({
  shotDurationsUs: z.array(z.number().int().min(500_000).max(600_000_000)).max(MAX_STORYBOARD_SHOTS),
  keyframeShots: z.array(z.number().int().min(1).max(MAX_STORYBOARD_SHOTS)).max(3),
});
export const creativeObjectiveOptionSchema = objectiveTimingSchema.extend({ id: z.string().min(1), label: z.string().min(1) });
export const creativeObjectivePlanSchema = z.object({
  id: z.uuid(), goal: creativeObjectiveInputSchema.shape.goal, modelId: creativeObjectiveInputSchema.shape.modelId,
  route: creativeObjectiveRouteSchema, reason: creativeObjectiveAnalysisSchema.shape.reason,
  issues: z.array(z.string().min(1)), options: z.array(creativeObjectiveOptionSchema),
});
export type CreativeObjectivePlan = z.infer<typeof creativeObjectivePlanSchema>;

export const creativeObjectiveExecutionSchema = objectiveTimingSchema.extend({
  planId: z.uuid(), optionId: z.string().min(1), route: creativeObjectiveRouteSchema,
});
export type CreativeObjectiveExecution = z.infer<typeof creativeObjectiveExecutionSchema>;

export const creativePlanningStartInputSchema = z.strictObject({
  requestId: z.uuid(), title: z.string().trim().min(1).max(160), goal: z.string().trim().min(1).max(3000),
  modelId: z.string().min(1), skillIds: z.array(z.string().min(1)).min(1).max(100),
  reference: z.union([z.strictObject({ path: z.string().trim().min(1).max(4096) }), z.strictObject({ assetId: z.string().min(1) }), z.strictObject({ styleCardId: z.string().min(1) })]),
  plan: z.strictObject({ id: z.uuid(), optionId: z.string().min(1) }).optional(),
  imageModelId: z.string().min(1).optional(),
});

export const creativeRevisionFieldSchema = z.enum(['title', 'narration', 'visualPrompt', 'soundPrompt', 'lineText']);
export type CreativeRevisionField = z.infer<typeof creativeRevisionFieldSchema>;

export const creativeRevisionScopeSchema = z.strictObject({
  shotId: z.string().min(1),
  fields: z.array(creativeRevisionFieldSchema).min(1).max(creativeRevisionFieldSchema.options.length)
    .refine(fields => new Set(fields).size === fields.length, '修改字段不能重复。'),
  lineId: z.string().min(1).optional(),
  sentenceIndex: z.number().int().nonnegative().optional(),
}).superRefine(({ fields, lineId, sentenceIndex }, context) => {
  const line = fields.includes('lineText');
  const targets = Number(lineId !== undefined) + Number(sentenceIndex !== undefined);
  if (targets !== Number(line)) context.addIssue({ code: 'custom', path: ['fields'], message: '修改单句时须指定一条台词或旁白句子。' });
  if (line && fields.includes('narration')) context.addIssue({ code: 'custom', path: ['fields'], message: '请选择整段旁白或其中一句。' });
});
export type CreativeRevisionScope = z.infer<typeof creativeRevisionScopeSchema>;

export const creativeRevisionTargetSchema = creativeRevisionScopeSchema.safeExtend({ shotTitle: z.string() });
export const creativeRevisionChangeSchema = z.strictObject({ field: creativeRevisionFieldSchema, before: z.string(), after: z.string() });
export type CreativeRevisionChange = z.infer<typeof creativeRevisionChangeSchema>;

const revisionRequestShape = { requestId: z.uuid(), instruction: z.string().trim().min(1).max(3000) };
export const creativePlanningReviseInputSchema = z.union([
  z.strictObject({ ...revisionRequestShape, runId: z.string().min(1) }),
  z.strictObject({ ...revisionRequestShape, runId: z.string().min(1), scope: creativeRevisionScopeSchema }),
  z.strictObject({ ...revisionRequestShape, projectId: z.string().min(1), revision: z.number().int().positive(), modelId: z.string().min(1), scope: creativeRevisionScopeSchema }),
]);

const sentenceSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'sentence' });

export function creativeNarrationSentences(narration: string): { start: number; end: number; text: string }[] {
  return Array.from(sentenceSegmenter.segment(narration)).flatMap(({ index, segment }) => {
    const text = segment.trim();
    if (!text) return [];
    const start = index + segment.length - segment.trimStart().length;
    return [{ start, end: start + text.length, text }];
  });
}
