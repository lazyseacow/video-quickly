import { z } from 'zod';
import { imageDerivationSchema } from './image-tools.js';
export { imageRectangleSchema, imageDerivationSchema, imageEditInputSchema, imageGridRectangles, type ImageRectangle, type ImageEditInput } from './image-tools.js';
export * from './workflow-patches.js';
export { sameJsonContent } from './json-content.js';
export { chargeActionRequestSchema, isChargeAction, type ChargeAction } from './charge-confirmation.js';
export { retryAfterMilliseconds } from './http-retry.js';
export * from './model-alternatives.js';
import { sceneTemplateSchema } from './scene-templates.js';
import { claimSchema, researchSourceSchema } from './research.js';
import { captionStyleSchema, scenePresetSchema, seriesSettingsSchema } from './caption-style.js';
import { audioMixSettingsSchema, audioProcessingSchema } from './audio-processing.js';
import { motionKeyframesSchema } from './keyframes.js';
import { creativeContextSchema, creativeEntityKeysSchema } from './creative-context.js';
export { creativeContextSchema, creativeEntitySchema, creativeEntityKeysSchema, creativeCharacterBindings, projectCharacterIds, validateCreativeReferences, shotCreativePrompt, creativeEntityLabels, creativeReferenceAssetIds, hasCharacterAppearance, isCreativeReferenceAsset, type CreativeContext, type CreativeEntity } from './creative-context.js';
import { productionSettingsSchema, resolveProductionWorkflow } from './production.js';
export { productionSettingsSchema, resolveProductionWorkflow, isVideoGenerationNode, isModelGenerationNode, captionsEnabled, productionEditingStep, productionEditingSkillIds, productionModelSetting, supportsProductionAgent, supportsAutomaticCasting, productionPlanningSteps, productionPlanningStep, usesManualPlanning, MAX_REFERENCE_AUDIO_BYTES, MAX_REFERENCE_AUDIOS, type ProductionPlanningStep, type ProductionSettings } from './production.js';
export { MAX_STORYBOARD_SHOTS, planningDocumentSchemas, planningDocumentSections, formatPlanningDocument, type ManualPlanningFields, type PlanningDocumentKind } from './planning-fields.js';
export * from './asset-recovery.js';
export { skillPromptContext, appendSkillContext, supportsSkillScript } from './skill-context.js';
export { motionKeyframesSchema, type MotionKeyframe, type MotionEasing } from './keyframes.js';
export { modelPlatforms, getModelPlatform, platformForConnection } from './model-platforms.js';
export { textProtocols, mediaAdapters, getMediaAdapters } from './model-protocols.js';
export { modelConnectionTypes, getModelConnectionType, modelToolProtocolIssue, validateModelConnection } from './model-connections.js';
export { providerReportedUsage, sumProviderUsage } from './provider-usage.js';
export { audioProcessingSchema, audioMixSettingsSchema, usesVideoAudio, DEFAULT_AUDIO_PROCESSING, DEFAULT_AUDIO_MIX_SETTINGS, preparedAudioMixSchema, audioMixJobSchema, audioMixPrepareResultSchema, audioLevelWindowSchema, silenceDetectionSchema, type PreparedAudioMix, type AudioMixJob, type AudioMixPrepareResult, type AudioLevelWindow, type SilenceDetection } from './audio-processing.js';
export { captionStyleSchema, DEFAULT_CAPTION_STYLE, effectiveCaptionStyle, seriesSettingsSchema, type CaptionStyle, type ScenePreset, type SeriesSettings } from './caption-style.js';
export { claimSchema, researchSourceSchema, researchResultSchema, validateResearchContent, applyResearchClaims, type Claim, type ResearchSource, type ResearchResult, type ShotClaims } from './research.js';
export { sceneTemplateSchema, processSceneTemplateSchema, comparisonSceneTemplateSchema, barChartSceneTemplateSchema, createSceneTemplate, type SceneTemplate, type SceneTemplateKind } from './scene-templates.js';
export { clipSourceAssetIds, validateClipEditContent, validateClipEditHistory } from './clip-editing.js';

// A fixed application message is safe to retain across the external-activity boundary.
export class VideoGenerationError extends Error {
  constructor() { super('生成结果缺少有效画面或音轨，已保留下载文件，请核对原任务。'); }
}
export class MediaRequestRejectedError extends Error {
  constructor(readonly status: number, readonly reason?: 'output-image-moderation') {
    super(reason === 'output-image-moderation'
      ? `模型服务的内容审核拦截了生成的图片（HTTP ${status}）。请调整生成描述或参考图后重试。`
      : `模型服务已拒绝素材生成请求（HTTP ${status}），请核对模型、尺寸和请求参数。`);
    this.name = 'MediaRequestRejectedError';
  }
}
export class LockedShotChangeError extends Error {
  constructor() { super('分镜结果改变了锁定镜头，请保留锁定镜头后重新生成。'); }
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema),
]));

export const frameRateSchema = z.object({ numerator: z.number().int().positive().max(120000), denominator: z.number().int().positive().max(1001) })
  .refine(value => value.numerator / value.denominator >= 1 && value.numerator / value.denominator <= 120, '帧率须介于 1 和 120 fps');
export const videoProfileSchema = z.object({
  width: z.number().int().min(64).max(7680).refine(value => value % 2 === 0, '宽度须为偶数'),
  height: z.number().int().min(64).max(7680).refine(value => value % 2 === 0, '高度须为偶数'),
  frameRate: frameRateSchema,
  fitMode: z.enum(['contain', 'cover', 'blur']).default('contain'),
  previewScale: z.number().min(0.1).max(1).default(0.5),
});
export type FrameRate = z.infer<typeof frameRateSchema>;
export type VideoProfile = z.infer<typeof videoProfileSchema>;
export const seriesTemplateSchema = z.object({
  id: z.string().min(1).max(128), name: z.string().trim().min(1).max(120), description: z.string().max(10_000),
  revision: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string(), archived: z.boolean().default(false),
  settings: seriesSettingsSchema,
  creationDefaults: z.object({ profile: videoProfileSchema, skillIds: z.array(z.string().min(1)).max(500) }).optional(),
});
export type SeriesTemplate = z.infer<typeof seriesTemplateSchema>;
export const exportTargetSchema = z.object({
  id: z.string().min(1).max(64), label: z.string().min(1).max(100), profile: videoProfileSchema,
});
export type ExportTarget = z.infer<typeof exportTargetSchema>;
export const exportBatchTargetSchema = exportTargetSchema.extend({
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled', 'interrupted']),
  runId: z.string().optional(), progress: z.number().min(0).max(1).default(0), error: z.string().optional(),
  videoPath: z.string().optional(), coverPath: z.string().optional(), subtitlePath: z.string().optional(), timelinePath: z.string().optional(),
});
export type ExportBatchTarget = z.infer<typeof exportBatchTargetSchema>;
export const exportBatchSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), projectRevision: z.number().int().positive(), revision: z.number().int().positive(),
  status: z.enum(['queued', 'running', 'interrupted', 'succeeded', 'partial', 'failed', 'canceled']),
  targets: z.array(exportBatchTargetSchema).min(1).max(8), destinationDirectory: z.string().optional(), error: z.string().optional(),
  createdAt: z.string(), updatedAt: z.string(),
}).refine(value => new Set(value.targets.map(target => target.id)).size === value.targets.length, '批量导出目标编号不能重复');
export type ExportBatch = z.infer<typeof exportBatchSchema>;
export const DEFAULT_VIDEO_PROFILE: VideoProfile = { width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: 0.5 };
export const FRAME_RATE_PRESETS = [
  { label: '23.976', numerator: 24000, denominator: 1001 },
  { label: '24', numerator: 24, denominator: 1 },
  { label: '25', numerator: 25, denominator: 1 },
  { label: '29.97', numerator: 30000, denominator: 1001 },
  { label: '30', numerator: 30, denominator: 1 },
  { label: '50', numerator: 50, denominator: 1 },
  { label: '59.94', numerator: 60000, denominator: 1001 },
  { label: '60', numerator: 60, denominator: 1 },
] as const;
export const ASPECT_RATIO_PRESETS = [
  { label: '16:9', width: 16, height: 9 }, { label: '9:16', width: 9, height: 16 },
  { label: '1:1', width: 1, height: 1 }, { label: '4:3', width: 4, height: 3 },
  { label: '3:4', width: 3, height: 4 }, { label: '4:5', width: 4, height: 5 },
  { label: '21:9', width: 21, height: 9 },
] as const;
export const VIDEO_FIT_MODE_LABELS = {
  contain: '完整显示 · 等比留边', cover: '裁剪填满', blur: '模糊背景填充',
} satisfies Record<VideoProfile['fitMode'], string>;
export function videoAspectRatioPreset(width: number, height: number) {
  const ratio = width / height;
  return ASPECT_RATIO_PRESETS.find(item => Math.abs(item.width / item.height - ratio) < .005);
}
export function formatFrameRate(rate: FrameRate): string {
  return FRAME_RATE_PRESETS.find(value => value.numerator === rate.numerator && value.denominator === rate.denominator)?.label ?? (rate.numerator / rate.denominator).toFixed(3).replace(/\.?0+$/, '');
}
export function frameAtTime(timeUs: number, rate: FrameRate): number {
  return Math.round(timeUs * rate.numerator / (1_000_000 * rate.denominator));
}
export function timeAtFrame(frame: number, rate: FrameRate): number {
  return Math.round(frame * 1_000_000 * rate.denominator / rate.numerator);
}
/** Use the persisted microsecond frame grid at half-open caption and edit boundaries. */
export function firstFrameAtUs(timeUs: number, rate: FrameRate): number {
  if (!Number.isFinite(timeUs)) throw new RangeError('时间须为有限数值。');
  let frame = Math.max(0, frameAtTime(timeUs, rate));
  while (timeAtFrame(frame, rate) < timeUs) frame++;
  while (frame > 0 && timeAtFrame(frame - 1, rate) >= timeUs) frame--;
  return frame;
}

export const captionCueSchema = z.object({
  id: z.string().min(1), startUs: z.number().int().nonnegative(), endUs: z.number().int().positive(),
  text: z.string().max(10000).refine(value => value.trim().length > 0, '字幕内容不能为空'),
}).refine(value => value.endUs > value.startUs, { message: '字幕结束时间须晚于开始时间', path: ['endUs'] });
export type CaptionCue = z.infer<typeof captionCueSchema>;
// Persist authored or source-media time; timeline positions are derived from each clip's offsets.
export const captionTrackSchema = z.object({
  timeBase: z.enum(['source', 'scene', 'clip']), cues: z.array(captionCueSchema).max(10000),
  alignment: z.enum(['manual', 'estimated', 'speech']), granularity: z.enum(['segment', 'word']).optional(),
  sourceAssetId: z.string().min(1).optional(), sourceSha256: z.string().min(1).optional(), modelId: z.string().min(1).optional(),
}).superRefine((value, context) => {
  const ids = new Set<string>();
  value.cues.forEach((cue, index) => {
    if (ids.has(cue.id)) context.addIssue({ code: 'custom', message: '字幕编号不能重复', path: ['cues', index, 'id'] });
    ids.add(cue.id);
    if (index > 0 && cue.startUs < value.cues[index - 1].endUs) context.addIssue({ code: 'custom', message: '字幕须按时间排序且不能重叠', path: ['cues', index, 'startUs'] });
  });
  if (value.alignment === 'speech') {
    if (value.timeBase !== 'source') context.addIssue({ code: 'custom', message: '语音对齐字幕须使用素材时间', path: ['timeBase'] });
    if (!value.sourceAssetId) context.addIssue({ code: 'custom', message: '语音对齐字幕需要原始音频素材', path: ['sourceAssetId'] });
    if (!value.sourceSha256) context.addIssue({ code: 'custom', message: '语音对齐字幕需要原始音频哈希', path: ['sourceSha256'] });
  }
});
export type CaptionTrack = z.infer<typeof captionTrackSchema>;
// BGM startUs is project time, independent of shot order; sourceInUs belongs to the audio asset.
export const musicClipSchema = z.object({
  id: z.string().min(1), assetId: z.string().min(1), startUs: z.number().int().nonnegative().default(0),
  sourceInUs: z.number().int().nonnegative().default(0), durationUs: z.number().int().positive(),
  gainDb: z.number().min(-60).max(0).default(-18), fadeInUs: z.number().int().nonnegative().default(0),
  fadeOutUs: z.number().int().nonnegative().default(0), loop: z.boolean().default(false),
}).superRefine((value, context) => {
  for (const field of ['fadeInUs', 'fadeOutUs'] as const) {
    if (value[field] > value.durationUs) context.addIssue({ code: 'custom', message: '淡入淡出时长不能超过音乐片段时长', path: [field] });
  }
});
export type MusicClip = z.infer<typeof musicClipSchema>;
// Derived source-local peaks, one absolute amplitude per 10ms window including a partial tail.
export const audioWaveformSchema = z.object({
  version: z.literal(1), assetId: z.string().min(1), sha256: z.string().min(1), durationUs: z.number().int().positive(),
  peaksPerSecond: z.literal(100), peaks: z.array(z.number().min(0).max(1)),
}).refine(value => value.peaks.length === Math.ceil(value.durationUs / 10_000), { message: '波形峰值数量须与音频时长一致', path: ['peaks'] });
export type AudioWaveform = z.infer<typeof audioWaveformSchema>;

export const CHARACTER_REFERENCE_VIEW_LABELS = ['正面', '四分之三侧面', '侧面', '背面'] as const;

export const characterProfileSchema = z.object({
  id: z.string().min(1), name: z.string().trim().min(1).max(120), description: z.string().max(10000),
  referenceAssetIds: z.array(z.string().min(1)).max(4).refine(value => new Set(value).size === value.length, '角色参考图不能重复'),
  revision: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string(), archived: z.boolean().default(false),
});
export type CharacterProfile = z.infer<typeof characterProfileSchema>;

export const clipEditReferenceSchema = z.object({
  planId: z.string().min(1), inUs: z.number().int().nonnegative(),
  restoreInUs: z.number().int().nonnegative(), restoreDurationUs: z.number().int().positive(),
});

export const shotSchema = z.object({
  id: z.string().min(1), title: z.string().min(1).max(160), narration: z.string().max(10000), visualPrompt: z.string().max(20000),
  soundPrompt: z.string().max(10000).optional(),
  durationUs: z.number().int().min(500000).max(600000000),
  sourceInUs: z.number().int().nonnegative().optional(),
  // Independent replacements start at their own source origin; absent overrides retain legacy shared trims.
  audioInUs: z.number().int().nonnegative().optional(), videoInUs: z.number().int().nonnegative().optional(),
  // Preserve authored animation, caption timing and sample identity across clip edits.
  sceneInUs: z.number().int().nonnegative().optional(), sceneDurationUs: z.number().int().positive().optional(),
  sceneIndex: z.number().int().nonnegative().optional(),
  captionTrack: captionTrackSchema.optional(),
  captionStyle: captionStyleSchema.nullable().optional(),
  clipEdit: clipEditReferenceSchema.optional(), audioProcessing: audioProcessingSchema.optional(),
  characterIds: z.array(z.string().min(1)).max(8).refine(value => new Set(value).size === value.length, '镜头角色不能重复').optional(),
  creativeEntityKeys: creativeEntityKeysSchema.optional(),
  sceneTemplate: sceneTemplateSchema.optional(),
  assetId: z.string().optional(), audioAssetId: z.string().optional(), videoAssetId: z.string().optional(),
  claimIds: z.array(z.string()).default([]), locked: z.boolean().default(false),
  animation: z.object({ panX: z.number().default(0), panY: z.number().default(0), zoom: z.number().min(0.1).max(5).default(1.05), transition: z.enum(['cut', 'fade', 'wipe']).default('fade'), keyframes: motionKeyframesSchema.optional() })
    .default({ panX: 0, panY: 0, zoom: 1.05, transition: 'fade' }),
});
export type Shot = z.infer<typeof shotSchema>;
export const clipEditSourceSchema = z.object({
  id: z.string().min(1),
  original: shotSchema.pick({ durationUs: true, sourceInUs: true, audioInUs: true, videoInUs: true, sceneInUs: true, sceneDurationUs: true, sceneIndex: true, captionTrack: true, assetId: true, audioAssetId: true, videoAssetId: true }),
  assetHashes: z.array(z.object({ assetId: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).max(4),
});
export type ClipEditSource = z.infer<typeof clipEditSourceSchema>;
export const clipEditSpanSchema = z.object({
  id: z.string().min(1), durationUs: z.number().int().positive(), originInUs: z.number().int().nonnegative(),
  sourceInUs: z.number().int().nonnegative(), audioInUs: z.number().int().nonnegative(), videoInUs: z.number().int().nonnegative(), sceneInUs: z.number().int().nonnegative(),
});
export type ClipEditSpan = z.infer<typeof clipEditSpanSchema>;
export const clipEditPlanSchema = z.object({ id: z.string().min(1), sourceId: z.string().min(1), spans: z.array(clipEditSpanSchema).min(1).max(2000) });
export type ClipEditPlan = z.infer<typeof clipEditPlanSchema>;
export const shotCandidateKindSchema = z.enum(['script', 'image', 'video']);
export type ShotCandidateKind = z.infer<typeof shotCandidateKindSchema>;
export const shotCandidateFieldSchema = z.enum(['title', 'narration', 'visualPrompt', 'durationUs']);
export type ShotCandidateField = z.infer<typeof shotCandidateFieldSchema>;
export const shotCandidateSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), shotId: z.string().min(1),
  kind: shotCandidateKindSchema, runId: z.string().min(1), nodeId: z.string().min(1), createdAt: z.string(),
  baseline: shotSchema, shot: shotSchema, assetIds: z.array(z.string().min(1)), characters: z.array(characterProfileSchema).optional(),
  modelId: z.string().optional(), instruction: z.string().max(20000).optional(),
}).refine(value => value.baseline.id === value.shotId && value.shot.id === value.shotId, '候选与原始镜头编号须一致');
export type ShotCandidate = z.infer<typeof shotCandidateSchema>;
export { applyShotCandidate } from './shot-candidates.js';
export { defaultVideoRequestSeconds, getModelParameterFields, modelParameterValue, withModelParameter, validateModelParameters, requestModelParameters } from './model-parameters.js';
export const nodeKindSchema = z.enum(['brief', 'research', 'style', 'script', 'assets', 'animation', 'review', 'export', 'agent', 'condition', 'join', 'subflow']);
export const workflowValueBindingSchema = z.union([
  z.object({ literal: jsonValueSchema }),
  z.object({ nodeId: z.string().min(1), path: z.array(z.string().min(1)).max(20).default([]) }),
]);
export const subflowReferenceSchema = z.object({ id: z.string().min(1), version: z.number().int().positive(), inputs: z.record(z.string(), workflowValueBindingSchema).default({}) });
const promptPathSchema = z.array(z.string().min(1).max(120).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value), '不支持此字段路径。')).max(20);
export const promptBindingsSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), z.union([
  z.object({ literal: jsonValueSchema }).strict(),
  z.object({ projectPath: promptPathSchema.min(1) }).strict(),
  z.object({ shotPath: promptPathSchema.min(1) }).strict(),
  z.object({ nodeId: z.string().min(1), path: promptPathSchema.optional().default([]) }).strict(),
])).refine(value => Object.keys(value).length <= 40, '提示词变量不能超过 40 个。');
export type PromptBindings = z.infer<typeof promptBindingsSchema>;
export const promptTemplateReferenceSchema = z.object({ id: z.string().min(1), version: z.number().int().positive() });
export const workflowNodeSchema = z.object({
  id: z.string().min(1), kind: nodeKindSchema, label: z.string().min(1), description: z.string().default(''),
  prompt: z.string().default(''), modelId: z.string().optional(), skillIds: z.array(z.string()).default([]),
  config: z.record(z.string(), jsonValueSchema).default({}).refine(config => config.operation === undefined || ['prepare-references', 'generate-native-video', 'prepare-edit', 'regenerate', 'research'].includes(String(config.operation)), '不支持的制作任务类型。'),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }), requiresReview: z.boolean().default(false),
  subflow: subflowReferenceSchema.optional(),
  promptBindings: promptBindingsSchema.optional(), promptTemplate: promptTemplateReferenceSchema.optional(),
});
const workflowEdgesSchema = z.array(z.object({ id: z.string(), source: z.string(), target: z.string(), condition: z.string().optional() }));
export const subflowInputSchema = z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), type: z.enum(['string', 'number', 'boolean', 'json']), required: z.boolean().default(true), default: jsonValueSchema.optional() }).superRefine((value, context) => { if (value.default !== undefined && value.type !== 'json' && typeof value.default !== value.type) context.addIssue({ code: 'custom', message: '输入默认值与声明类型不一致。', path: ['default'] }); });
export const subflowOutputSchema = z.object({ type: z.enum(['string', 'number', 'boolean', 'json']).default('json'), name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), nodeId: z.string().min(1), path: z.array(z.string().min(1)).max(20).default([]) });
export const subflowDefinitionSchema = z.object({
  id: z.string().min(1), version: z.number().int().positive(), name: z.string().trim().min(1).max(120), description: z.string().max(10000).default(''),
  inputs: z.array(subflowInputSchema).max(40).default([]), outputs: z.array(subflowOutputSchema).max(40).default([]),
  nodes: z.array(workflowNodeSchema).min(1).max(100), edges: workflowEdgesSchema,
});
export const workflowExecutionSchema = z.object({ maxConcurrentShots: z.number().int().min(1).max(8).default(1), modelLimits: z.record(z.string(), z.number().int().min(1).max(8)).default({}) });
export const workflowStageSchema = z.object({
  id: z.string().min(1), label: z.string().min(1).max(120), description: z.string().max(10000).default(''),
  nodeIds: z.array(z.string().min(1)).min(1).max(100).refine(ids => new Set(ids).size === ids.length, '阶段中的任务不能重复'),
});
export type WorkflowStage = z.infer<typeof workflowStageSchema>;
export const workflowSchema = z.object({
  id: z.string(), version: z.number().int().positive(), name: z.string(),
  nodes: z.array(workflowNodeSchema).min(1).max(100),
  edges: workflowEdgesSchema,
  subflows: z.array(subflowDefinitionSchema).max(100).optional(), execution: workflowExecutionSchema.optional(),
  production: productionSettingsSchema,
  stages: z.array(workflowStageSchema).max(100).refine(stages => new Set(stages.map(stage => stage.id)).size === stages.length, '阶段编号不能重复').optional(),
});
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export const promptLibraryItemSchema = z.object({
  id: z.string().min(1), revision: z.number().int().positive(), version: z.number().int().positive(),
  kind: z.enum(['template', 'snippet']), name: z.string().trim().min(1).max(120), prompt: z.string().min(1).max(100000),
  nodeKinds: z.array(nodeKindSchema).min(1).max(13), bindings: promptBindingsSchema.optional(),
  favorite: z.boolean().default(false), archived: z.boolean().default(false), createdAt: z.string(), updatedAt: z.string(),
});
export type PromptLibraryItem = z.infer<typeof promptLibraryItemSchema>;
export type WorkflowDefinition = z.infer<typeof workflowSchema>;
export type SubflowDefinition = z.infer<typeof subflowDefinitionSchema>;
export type SubflowReference = z.infer<typeof subflowReferenceSchema>;
export const workflowTemplateSchema = z.object({
  id: z.string().min(1), revision: z.number().int().positive(), definition: subflowDefinitionSchema, dependencies: z.array(subflowDefinitionSchema).max(100),
  archived: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
});
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;
export { validateWorkflowComposition, workflowNodesWithSubflows, workflowEdgesWithSubflows, resolveSubflowInputs, substituteSubflowInputs, subflowNodeId, subflowThreadId, subflowValueAt } from './workflow-composition.js';
export { resolveWorkflowStages, type ResolvedWorkflowStage } from './workflow-stages.js';
export const episodeSchema = z.object({ workId: z.string().min(1), number: z.number().int().min(1).max(100000), originalText: z.string().max(30000), defaultsRevision: z.number().int().positive().optional() });
export const episodeSourceSchema = episodeSchema.extend({ workTitle: z.string().max(160) });
export const projectSchema = z.object({
  id: z.string(), title: z.string().min(1).max(160), brief: z.string().max(30000), templateId: z.string().default('history-handdrawn'),
  revision: z.number().int().positive(), profile: videoProfileSchema, shots: z.array(shotSchema), workflow: workflowSchema,
  creativeContext: creativeContextSchema.nullable().optional(),
  episode: episodeSchema.optional(), episodeSource: episodeSourceSchema.optional(),
  musicClips: z.array(musicClipSchema).optional(),
  researchSources: z.array(researchSourceSchema).max(20).optional(), referenceDisplay: z.enum(['hidden', 'numbers']).optional(),
  captionStyle: captionStyleSchema.nullable().optional(), scenePreset: scenePresetSchema.nullable().optional(),
  audioMix: audioMixSettingsSchema.nullable().optional(), clipEditSources: z.array(clipEditSourceSchema).max(2000).optional(), clipEditPlans: z.array(clipEditPlanSchema).max(5000).optional(),
  claims: z.array(claimSchema).default([]), style: z.string().default('手绘墨线、淡彩纸纹、固定人物和场景锚点'),
  createdAt: z.string(), updatedAt: z.string(), archived: z.boolean().default(false),
});
export type ProjectDocument = z.infer<typeof projectSchema>;
export const workDefaultsSchema = z.object({
  style: z.string().max(30000).default(''), creativeContext: creativeContextSchema.nullable().optional(),
  profile: videoProfileSchema.default(() => structuredClone(DEFAULT_VIDEO_PROFILE)),
  production: productionSettingsSchema.omit({ referenceAudioAssetIds: true, manualPlanningFields: true }).extend({ executionMode: z.enum(['workflow', 'agent']).optional() }).strict()
    .transform(({ executionMode: _legacy, ...settings }) => settings).default(() => productionSettingsSchema.parse({ mode: 'native-video' })),
});
export const workSchema = z.object({
  id: z.string(), revision: z.number().int().positive(), title: z.string().trim().min(1).max(160), description: z.string().max(10000).default(''),
  defaults: workDefaultsSchema, archived: z.boolean().default(false), createdAt: z.string(), updatedAt: z.string(),
});
export type StoryWork = z.infer<typeof workSchema>;
export const productionQueueSchema = z.object({
  id: z.string(), workId: z.string(), revision: z.number().int().positive(), status: z.enum(['paused', 'running', 'needs_attention', 'succeeded', 'canceled']),
  createdAt: z.string(), updatedAt: z.string(), error: z.string().optional(),
});
export type ProductionQueue = z.infer<typeof productionQueueSchema>;
export const productionQueueItemSchema = z.object({
  id: z.string(), queueId: z.string(), projectId: z.string(), projectRevision: z.number().int().positive(), revision: z.number().int().positive(),
  position: z.number().int().nonnegative(), episodeNumber: z.number().int().positive(), title: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'needs_attention', 'failed', 'canceled', 'skipped']),
  runId: z.string().optional(), error: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
});
export type ProductionQueueItem = z.infer<typeof productionQueueItemSchema>;
export const productionQueueDetailSchema = z.object({ queue: productionQueueSchema, items: z.array(productionQueueItemSchema) });
export const productionQueueEnqueueResultSchema = z.object({ queue: productionQueueSchema.nullable(), items: z.array(productionQueueItemSchema), reused: z.array(productionQueueItemSchema) });

export const modelCapabilitySchema = z.enum(['text', 'image', 'video', 'vision', 'tools', 'structured-output']);
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export const currencySchema = z.enum(['USD', 'CNY']);
const chargeAmountSchema = z.object({ currency: currencySchema, amount: z.number().nonnegative() });
export const chargeEstimateSchema = z.object({
  batch: z.boolean(),
  items: z.array(z.object({
    modelName: z.string().optional(), model: z.string().optional(),
    kind: z.enum(['text', 'image', 'video']),
    count: z.number().int().nonnegative().optional(), videoSeconds: z.number().nonnegative().optional(),
    referenceViews: z.number().int().positive().optional(), estimated: chargeAmountSchema.optional(),
  })),
  totals: z.array(chargeAmountSchema).optional(),
});
export type ChargeEstimate = z.infer<typeof chargeEstimateSchema>;
export const chargeConfirmationSchema = z.object({
  confirmationId: z.string().uuid(), title: z.string(), description: z.string(), confirmLabel: z.string(),
  estimate: chargeEstimateSchema.optional(),
});
export const modelPricingSchema = z.object({
  currency: currencySchema,
  inputPerMillionTokens: z.number().nonnegative().optional(), outputPerMillionTokens: z.number().nonnegative().optional(),
  perImage: z.number().nonnegative().optional(), perVideoSecond: z.number().nonnegative().optional(),
});
export type ModelPricing = z.infer<typeof modelPricingSchema>;
export const costRequestMetricsSchema = z.object({
  source: z.literal('request'), requestCount: z.number().int().nonnegative().optional(),
  images: z.number().int().nonnegative().optional(), videoSeconds: z.number().nonnegative().optional(),
});
export type CostRequestMetrics = z.infer<typeof costRequestMetricsSchema>;
export const providerUsageSchema = z.object({
  source: z.literal('provider'), inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(), cachedInputTokens: z.number().int().nonnegative().optional(), cachedOutputTokens: z.number().int().nonnegative().optional(),
  images: z.number().int().nonnegative().optional(), videoSeconds: z.number().nonnegative().optional(),
});
export type ProviderUsage = z.infer<typeof providerUsageSchema>;
export const modelPlatformSchema = z.enum(['openai', 'anthropic', 'google', 'deepseek', 'qwen', 'volcengine', 'moonshot', 'zhipu', 'siliconflow', 'openrouter', 'ollama', 'comfyui', 'seedream', 'seedance', 'custom']);
export type ModelPlatform = z.infer<typeof modelPlatformSchema>;
export const textProtocolSchema = z.enum(['chat-completions', 'responses', 'messages']);
export type TextProtocol = z.infer<typeof textProtocolSchema>;
export const modelAuthModeSchema = z.enum(['protocol-default', 'bearer', 'x-api-key']);
export type ModelAuthMode = z.infer<typeof modelAuthModeSchema>;
export const modelConnectionTypeSchema = z.enum(['text', 'image', 'video']);
export type ModelConnectionType = z.infer<typeof modelConnectionTypeSchema>;
export const modelDiscoverySchema = z.object({
  source: z.enum(['remote', 'preset', 'workflow']),
  items: z.array(z.object({ id: z.string(), label: z.string(), capabilities: z.array(modelCapabilitySchema).optional() })),
  message: z.string().optional(),
});
export type ModelDiscovery = z.infer<typeof modelDiscoverySchema>;
export const modelSchema = z.object({
  id: z.string(), name: z.string().min(1).max(120),
  provider: z.enum(['openai-compatible', 'ollama', 'comfyui', 'seedream', 'seedance', 'custom-http']),
  platform: modelPlatformSchema.optional(),
  textProtocol: textProtocolSchema.optional(),
  authMode: modelAuthModeSchema.optional(),
  fullUrl: z.boolean().optional(),
  connectionType: modelConnectionTypeSchema,
  baseUrl: z.string().url().refine(value => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }, '服务地址须为不含凭据、查询参数和片段的 HTTP(S) 地址'), model: z.string().min(1).max(200), capabilities: z.array(modelCapabilitySchema).min(1),
  parameters: z.record(z.string(), jsonValueSchema).default({}), pricing: modelPricingSchema.nullable().optional(), enabled: z.boolean().default(true),
  credentialRef: z.string().optional(), hasSecret: z.boolean().default(false), createdAt: z.string(), updatedAt: z.string(),
});
export type ModelProfile = z.infer<typeof modelSchema>;
export const usageRecordSchema = z.object({
  id: z.string().min(1), revision: z.number().int().positive(), operationId: z.string().min(1),
  runId: z.string().min(1), nodeId: z.string().min(1), shotId: z.string().optional(), projectId: z.string().min(1),
  modelId: z.string().min(1), modelName: z.string(), provider: modelSchema.shape.provider, model: z.string(), capability: modelCapabilitySchema,
  platform: modelPlatformSchema.optional(),
  status: z.enum(['submitted', 'completed', 'unknown', 'failed', 'canceled']), requestMetrics: costRequestMetricsSchema,
  providerUsage: providerUsageSchema.optional(), pricing: modelPricingSchema.nullable().optional(),
  estimatedAmount: z.number().nonnegative().optional(), estimateBasis: z.enum(['provider', 'request', 'mixed']).optional(),
  actualAmount: z.number().nonnegative().optional(), actualCurrency: currencySchema.optional(), note: z.string().max(10000).default(''),
  createdAt: z.string(), updatedAt: z.string(),
}).refine(value => (value.actualAmount === undefined) === (value.actualCurrency === undefined), '实际金额与币种须同时填写');
export type UsageRecord = z.infer<typeof usageRecordSchema>;
export const tokenMetrics = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cachedOutputTokens'] as const;
export type TokenMetric = typeof tokenMetrics[number];
export const tokenSummarySchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(), cachedOutputTokens: z.number().int().nonnegative().optional(),
});
export const costSummarySchema = z.object({
  tokens: tokenSummarySchema.default({}),
  tokenRecords: z.object({ inputTokens: z.number().int().nonnegative().default(0), outputTokens: z.number().int().nonnegative().default(0), cachedInputTokens: z.number().int().nonnegative().default(0), cachedOutputTokens: z.number().int().nonnegative().default(0) }).default({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cachedOutputTokens: 0 }),
  currencies: z.array(z.object({ currency: currencySchema, estimatedAmount: z.number().nonnegative().optional(), actualAmount: z.number().nonnegative().optional(), estimatedRecords: z.number().int().nonnegative(), actualRecords: z.number().int().nonnegative() })),
  total: z.number().int().nonnegative(), unknownEstimated: z.number().int().nonnegative(), unknownActual: z.number().int().nonnegative(), unknownSubmissions: z.number().int().nonnegative(),
});
export type CostSummary = z.infer<typeof costSummarySchema>;
export const skillSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), source: z.string(), version: z.string(),
  enabled: z.boolean(), instructions: z.string().default(''), resources: z.array(z.string()).default([]),
  autoDiscover: z.boolean().optional(),
  referenceContents: z.record(z.string(), z.string()).optional(),
  tools: z.array(z.object({ id: z.string(), label: z.string(), enabled: z.boolean(), permissions: z.array(z.string()) })).default([]),
  contentHash: z.string(), importedAt: z.string(),
});
export type SkillPackage = z.infer<typeof skillSchema>;
export const skillGroupSchema = z.object({
  id: z.string().min(1), name: z.string().trim().min(1).max(120), source: z.string(),
  skillIds: z.array(z.string().min(1)), createdAt: z.string(), updatedAt: z.string(),
});
export type SkillGroup = z.infer<typeof skillGroupSchema>;
export const skillImportSourceSchema = z.object({
  path: z.string().trim().min(1).optional(), url: z.string().trim().url().optional(), skillPath: z.string().min(1).optional(),
}).refine(value => Boolean(value.path) !== Boolean(value.url), '请选择目录、ZIP 文件或 GitHub 链接。');
export type SkillImportSource = z.infer<typeof skillImportSourceSchema>;
export const skillImportJobSchema = z.object({
  id: z.string().uuid(), source: skillImportSourceSchema, groupName: z.string().optional(), groupId: z.string().optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted']),
  completed: z.number().int().nonnegative(), total: z.number().int().nonnegative().optional(),
  skillIds: z.array(z.string()), error: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
});
export type SkillImportJob = z.infer<typeof skillImportJobSchema>;
export const mcpServerSchema = z.object({
  id: z.string().min(1), name: z.string().min(1).max(120), transport: z.enum(['stdio', 'http']),
  command: z.string().optional(), args: z.array(z.string()).max(100).default([]), url: z.string().url().optional(),
  enabled: z.boolean().default(false), credentialRef: z.string().optional(),
  credentialEnvName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(), hasSecret: z.boolean().default(false),
}).superRefine((value, context) => {
  if (value.transport === 'stdio' && !value.command?.trim()) context.addIssue({ code: 'custom', message: '本地工具连接需要填写可执行文件路径', path: ['command'] });
  if (value.transport === 'http' && !value.url) context.addIssue({ code: 'custom', message: 'HTTP 工具连接需要填写服务地址', path: ['url'] });
  if (value.url) {
    try {
      const url = new URL(value.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) context.addIssue({ code: 'custom', message: '工具服务地址须为不含凭据、查询参数和片段的 HTTP(S) 地址', path: ['url'] });
    } catch { context.addIssue({ code: 'custom', message: '工具服务地址格式无效', path: ['url'] }); }
  }
});
export type MCPServer = z.infer<typeof mcpServerSchema>;
export const runStatusSchema = z.enum(['queued', 'running', 'waiting_review', 'waiting_external', 'retry_scheduled', 'needs_attention', 'succeeded', 'failed', 'canceled']);
export function isRunActive(status: z.infer<typeof runStatusSchema>) {
  return status === 'queued' || status === 'running' || status === 'waiting_review' || status === 'waiting_external' || status === 'retry_scheduled';
}
export const activitySchema = z.object({
  id: z.string(), runId: z.string(), nodeId: z.string(), shotId: z.string().optional(),
  status: z.enum(['prepared', 'submitted', 'completed', 'failed', 'unknown', 'canceled']),
  inputHash: z.string(), result: jsonValueSchema.optional(), remoteTaskId: z.string().optional(),
  attempt: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string(), error: z.string().optional(),
});
export type ActivityRecord = z.infer<typeof activitySchema>;
export const runEventSchema = z.object({
  id: z.string(), runId: z.string(), projectId: z.string(), sequence: z.number().int(), type: z.string(),
  message: z.string(), nodeId: z.string().optional(), createdAt: z.string(),
});
export type RunEvent = z.infer<typeof runEventSchema>;
export const runSelectionSchema = z.object({ nodeId: z.string().min(1), mode: z.enum(['node', 'downstream']) });
export type RunSelection = z.infer<typeof runSelectionSchema>;
export const runPlanSchema = z.object({
  projectId: z.string(), projectTitle: z.string(), projectRevision: z.number().int(), workflowVersion: z.number().int(),
  selection: runSelectionSchema, digest: z.string().regex(/^[a-f0-9]{64}$/),
  steps: z.array(z.object({ id: z.string(), label: z.string(), kind: nodeKindSchema, requiresReview: z.boolean(), modelName: z.string().optional() })),
  boundary: z.array(z.object({ sourceId: z.string(), sourceLabel: z.string(), targetId: z.string(), targetLabel: z.string() })),
  shotCount: z.number().int().nonnegative(), lockedShotCount: z.number().int().nonnegative(), hasConditions: z.boolean(), blockedReason: z.string(),
  chargeEstimate: chargeEstimateSchema.optional(),
});
export type RunPlan = z.infer<typeof runPlanSchema>;
export const readinessIssueSchema = z.object({
  id: z.string(), severity: z.enum(['error', 'warning']), category: z.enum(['project', 'workflow', 'model', 'media', 'environment', 'skill']),
  message: z.string(), hint: z.string().optional(), nodeId: z.string().optional(), nodeLabel: z.string().optional(), modelId: z.string().optional(), modelName: z.string().optional(), assetId: z.string().optional(),
  fix: z.enum(['project', 'step', 'models', 'characters', 'assets', 'runtime', 'runs']),
});
export type ReadinessIssue = z.infer<typeof readinessIssueSchema>;
export const projectReadinessSchema = z.object({
  projectId: z.string(), projectTitle: z.string(), projectRevision: z.number().int().positive(), workflowVersion: z.number().int().positive(),
  selection: runSelectionSchema.optional(), checkedAt: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/), ready: z.boolean(),
  serviceCheck: z.literal('not_contacted'), stepCount: z.number().int().nonnegative(), modelCount: z.number().int().nonnegative(), assetCount: z.number().int().nonnegative(),
  issues: z.array(readinessIssueSchema),
});
export type ProjectReadiness = z.infer<typeof projectReadinessSchema>;
export const runSchema = z.object({
  id: z.string(), projectId: z.string(), projectRevision: z.number().int(), status: runStatusSchema,
  workflowVersion: z.number().int(), snapshotDigest: z.string(), currentNodeId: z.string().optional(),
  parentRunId: z.string().optional(), selection: runSelectionSchema.optional(), stepCount: z.number().int().positive().optional(), createdAt: z.string(), updatedAt: z.string(), error: z.string().optional(),
  stepRetry: z.object({ nodeId: z.string().min(1), status: z.enum(['pending', 'completed']) }).optional(),
  regenerationSource: z.object({ runId: z.string().min(1), nodeId: z.string().min(1), shotId: z.string().min(1), requestId: z.string().uuid() }).optional(),
  events: z.array(runEventSchema).default([]), activities: z.array(activitySchema).default([]),
  purpose: z.enum(['production', 'prompt-trial', 'workflow-assistant']).optional(), promptSessionId: z.string().optional(), promptSessionRevision: z.number().int().positive().optional(),
  productionQueueId: z.string().optional(), productionQueueItemId: z.string().optional(),
});
export type StepRun = z.infer<typeof runSchema>;
export type RunRecord = StepRun;
export const costTaskSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), projectTitle: z.string(), title: z.string(),
  createdAt: z.string(), updatedAt: z.string(), status: runStatusSchema.optional(), projectRevision: z.number().int().optional(), workflowVersion: z.number().int().optional(),
  runAvailable: z.boolean(), summary: costSummarySchema,
});
export const costTaskDetailSchema = costTaskSchema.extend({
  parentRunId: z.string().optional(),
  nodes: z.array(z.object({ id: z.string(), label: z.string() })),
  shots: z.array(z.object({ id: z.string(), title: z.string() })),
});
export type CostTaskDetail = z.infer<typeof costTaskDetailSchema>;
export const assetSchema = z.object({
  id: z.string(), projectId: z.string().optional(), shotId: z.string().optional(), name: z.string(),
  kind: z.enum(['image', 'video', 'audio', 'subtitle', 'document']), path: z.string(), mimeType: z.string(),
  size: z.number().nonnegative(), sha256: z.string(), version: z.number().int().positive(),
  durationUs: z.number().int().positive().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  createdAt: z.string(), provenance: z.string(), retained: z.boolean().default(false), active: z.boolean().default(true),
  derivation: imageDerivationSchema.optional(),
});
export type AssetRecord = z.infer<typeof assetSchema>;
export const systemSchema = z.object({
  platform: z.string(), runtimeVersion: z.string(), dataDirectory: z.string(),
  ffmpegAvailable: z.boolean(), ffmpegPath: z.string().optional(), secureStorageAvailable: z.boolean(),
  mode: z.enum(['desktop', 'development']),
});
export type RuntimeSystem = z.infer<typeof systemSchema>;
export const workspaceSnapshotSchema = z.object({
  projects: z.array(projectSchema), models: z.array(modelSchema), skills: z.array(skillSchema),
  skillGroups: z.array(skillGroupSchema).optional(), skillImports: z.array(skillImportJobSchema).optional(),
  runs: z.array(runSchema), assets: z.array(assetSchema), events: z.array(runEventSchema), system: systemSchema,
});
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
// Summaries deliberately exclude shot collections, activity results and event history.
export const projectSummarySchema = projectSchema.pick({ id: true, title: true, brief: true, templateId: true, revision: true, profile: true, captionStyle: true, episode: true, episodeSource: true, createdAt: true, updatedAt: true, archived: true }).extend({
  shotCount: z.number().int().nonnegative(), durationUs: z.number().nonnegative(), workflowNodeCount: z.number().int().nonnegative(),
  thumbnailShot: shotSchema.nullable(), thumbnailAsset: assetSchema.optional(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export const runSummarySchema = runSchema.omit({ events: true, activities: true }).extend({ completedNodeIds: z.array(z.string()) });
export type RunSummary = z.infer<typeof runSummarySchema>;
export const promptDraftSchema = z.object({
  projectId: z.string().min(1), projectRevision: z.number().int().positive(), node: workflowNodeSchema,
  context: projectSchema.pick({ brief: true, style: true, creativeContext: true, profile: true }).partial().extend({ production: productionSettingsSchema.optional() }).optional(),
  shotId: z.string().min(1).optional(), upstreamRunId: z.string().min(1).optional(),
});
export type PromptDraft = z.infer<typeof promptDraftSchema>;
export const promptPreviewSchema = z.object({
  digest: z.string(), prompt: z.string(), node: workflowNodeSchema, projectRevision: z.number().int(),
  model: modelSchema.optional(), skills: z.array(skillSchema), references: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() })),
  variables: z.array(z.object({ name: z.string(), source: z.string(), value: jsonValueSchema })),
  upstream: z.array(z.object({ nodeId: z.string(), label: z.string(), kind: nodeKindSchema })),
});
export type PromptPreview = z.infer<typeof promptPreviewSchema>;
export const promptSessionSchema = z.object({
  id: z.string(), revision: z.number().int().positive(), draft: promptDraftSchema, preview: promptPreviewSchema,
  createdAt: z.string(), updatedAt: z.string(),
});
export type PromptSession = z.infer<typeof promptSessionSchema>;
export { resolvePromptBindings, applyPromptLibraryItem, supportsPromptExperiment } from './prompt-bindings.js';
export { buildMediaPrompt, characterReferencePrompt, generationFramePrompt, singleFrameVideoModel, needsComposedSceneFrame, usesVideoSceneImage, characterSceneFirstFrame } from './media-prompts.js';
export const runStepStatusSchema = z.enum(['pending', 'running', 'waiting_review', 'waiting_external', 'retry_scheduled', 'needs_attention', 'succeeded', 'failed', 'canceled', 'skipped', 'not_recorded']);
export const modelResponseIssueSchema = z.object({ path: z.string(), message: z.string() });
export type ModelResponseIssue = z.infer<typeof modelResponseIssueSchema>;
export const generationShotStatusSchema = z.enum(['pending', 'queued', 'preparing', 'submitting', 'waiting', 'generating', 'downloading', 'validating', 'completed', 'interrupted', 'canceled']);
const storyboardPartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('outline') }),
  z.object({ kind: z.literal('batch'), index: z.number().int().positive(), batches: z.number().int().positive() }),
]);
export type StoryboardPart = z.infer<typeof storyboardPartSchema>;
export const runStepProgressSchema = z.object({
  phase: z.enum(['preparing', 'requesting', 'receiving', 'validating', 'saving', 'generating', 'rendering', 'completed']),
  startedAt: z.string(), updatedAt: z.string(), endedAt: z.string().optional(), lastConfirmedAt: z.string().optional(),
  completed: z.number().int().nonnegative().optional(), total: z.number().int().nonnegative().optional(),
  fraction: z.number().min(0).max(1).optional(),
  storyboard: storyboardPartSchema.optional(),
});
export type RunStepProgress = z.infer<typeof runStepProgressSchema>;
export const generationShotProgressSchema = z.object({
  id: z.string(), title: z.string(), durationUs: z.number(), status: generationShotStatusSchema,
  assetId: z.string().optional(), referenceAssetId: z.string().optional(), updatedAt: z.string(),
});
export type GenerationShotProgress = z.infer<typeof generationShotProgressSchema>;
export const runStepProgressDetailSchema = runStepProgressSchema.extend({
  shots: z.array(generationShotProgressSchema), assets: z.array(assetSchema),
});
export type RunStepProgressDetail = z.infer<typeof runStepProgressDetailSchema>;
export const runStepSummarySchema = z.object({
  id: z.string().min(1), label: z.string(), kind: nodeKindSchema, description: z.string(), requiresReview: z.boolean(),
  status: runStepStatusSchema, reason: z.string(), inputAvailable: z.boolean(), outputAvailable: z.boolean(),
  activityCount: z.number().int().nonnegative(), unknownSubmission: z.boolean(),
  modelGeneration: z.boolean().optional(),
  responseAvailable: z.boolean().optional(),
  retry: z.object({ allowed: z.boolean(), reason: z.string() }).optional(),
  progress: runStepProgressSchema.optional(),
  startedAt: z.string().optional(), completedAt: z.string().optional(), error: z.string().optional(),
});
export type RunStepSummary = z.infer<typeof runStepSummarySchema>;
export const runRecoverySchema = z.object({ review: z.boolean(), resume: z.boolean(), cancel: z.boolean(), restart: z.boolean(), reason: z.string() });
export const runInspectionSchema = z.object({
  stages: z.array(workflowStageSchema).optional(),
  workflowId: z.string().optional(),
  autonomousVideo: z.boolean().optional(),
  run: runSummarySchema, projectTitle: z.string(), snapshotAvailable: z.boolean(), checkpointAvailable: z.boolean(),
  steps: z.array(runStepSummarySchema).max(1000), recovery: runRecoverySchema,
  selected: z.object({
    node: workflowNodeSchema, dependencies: z.array(z.string()),
    model: z.object({ id: z.string(), name: z.string(), provider: modelSchema.shape.provider, model: z.string() }).optional(),
    skills: z.array(z.object({ id: z.string(), name: z.string(), version: z.string(), enabled: z.boolean() })),
    handlerVersion: z.number().int().optional(),
  }).optional(),
});
export type RunInspection = z.infer<typeof runInspectionSchema>;
export const runStepPayloadSchema = z.object({
  runId: z.string(), nodeId: z.string(), kind: z.enum(['input', 'output']), available: z.boolean(),
  value: jsonValueSchema.nullable(), inputHash: z.string().optional(), resolvedPromptRecorded: z.boolean().optional(),
  mediaShots: z.array(shotSchema.pick({ id: true, title: true, durationUs: true })).optional(),
  mediaGeneration: z.object({ kind: z.enum(['image', 'video']), modelName: z.string() }).optional(),
  partialStoryboard: z.object({ outline: z.string(), shots: z.array(shotSchema.pick({ id: true, title: true, narration: true, visualPrompt: true, soundPrompt: true, durationUs: true })) }).optional(),
  progress: runStepProgressDetailSchema.optional(),
  modelResponse: z.object({ attempt: z.number().int().positive(), receivedAt: z.string(), text: z.string(), incomplete: z.boolean().optional(), issues: z.array(modelResponseIssueSchema).optional() }).optional(),
  modelResponseHistory: z.array(z.object({ attempt: z.number().int().positive(), receivedAt: z.string(), invalid: z.boolean() })).optional(),
});
export type RunStepPayload = z.infer<typeof runStepPayloadSchema>;
export const stepOutputVersionSchema = z.object({
  id: z.string(), nodeId: z.string(), label: z.string(), createdAt: z.string(), status: runStatusSchema,
  projectRevision: z.number().int(), workflowVersion: z.number().int(),
});
export type StepOutputVersion = z.infer<typeof stepOutputVersionSchema>;
export const runDiagnosticsSchema = z.object({ path: z.string(), bytes: z.number().int().nonnegative(), format: z.literal('json.gz') });
export const runDiagnosticBundleSchema = z.object({
  version: z.literal(1), captureStartedAt: z.string(), captureCompletedAt: z.string(),
  inspection: runInspectionSchema, checkpoint: z.object({ available: z.boolean(), values: jsonValueSchema }), snapshot: jsonValueSchema.nullable(),
  steps: z.array(z.object({ nodeId: z.string(), input: runStepPayloadSchema, output: runStepPayloadSchema })),
  events: z.array(jsonValueSchema), activities: z.array(jsonValueSchema),
});
export const workspaceSummarySchema = z.object({
  projects: z.array(projectSummarySchema), models: z.array(modelSchema), skills: z.array(skillSchema), system: systemSchema,
  skillGroups: z.array(skillGroupSchema).optional(), skillImports: z.array(skillImportJobSchema).optional(),
  version: z.number().int().nonnegative(), assetsVersion: z.number().int().nonnegative(),
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export const projectDetailSchema = z.object({
  id: z.string(), revision: z.number().int().positive(), assetsVersion: z.number().int().nonnegative(),
  project: projectSchema.optional(), assets: z.array(assetSchema).optional(), latestRun: runSummarySchema.optional(), activeRun: runSummarySchema.optional(),
  videoPreview: z.object({ runId: z.string(), key: z.string(), project: projectSchema.optional() }).optional(),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;
export const pageInputSchema = z.object({ before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(100) });
export const assetListItemSchema = assetSchema.extend({ inUse: z.boolean() });
export type AssetListItem = z.infer<typeof assetListItemSchema>;
export const recordPageSchema = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.number().int().positive().nullable() });
export type RecordPage<T> = { items: T[]; nextCursor: number | null };
export const runtimeConnectionSchema = z.object({ state: z.enum(['ready', 'reconnecting', 'disconnected']), generation: z.number().int().nonnegative(), message: z.string().nullable().optional() });
export type RuntimeConnection = z.infer<typeof runtimeConnectionSchema>;
export const runtimeEventSchema = z.object({ type: z.enum(['workspace.changed', 'run.event', 'runtime.ready', 'runtime.connection']), data: jsonValueSchema.optional() });
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export function createNativeVideoWorkflow(): WorkflowDefinition {
  const definitions: Array<Pick<WorkflowNode, 'id' | 'kind' | 'label' | 'description' | 'prompt' | 'config'>> = [
    { id: 'brief', kind: 'brief', label: '创意简报', description: '明确主题、观众与核心诉求', prompt: '根据项目标题与创意要求，形成可直接用于制作的简报，明确目标观众、核心信息、叙事顺序、时长与表达要求。保留明确约束。', config: { modelBinding: 'default', requiresModel: true } },
    { id: 'style', kind: 'style', label: '风格与角色', description: '统一画风、角色与场景要求', prompt: '承接创意简报，制定画风、色彩、构图、光线与角色方案，保持全片连续。', config: { modelBinding: 'default', requiresModel: true } },
    { id: 'script', kind: 'script', label: '旁白与分镜', description: '组织台词、画面和时长', prompt: '根据简报和风格生成完整分镜，按顺序提供标题、完整台词、画面描述、声音要求与微秒时长。保持叙事、角色和声音连续，保留锁定镜头。', config: { modelBinding: 'default', requiresModel: true } },
    { id: 'assets', kind: 'assets', label: '参考素材准备', description: '按选择准备参考图，也可直接使用文字生成视频。', prompt: '生成适合视频首帧的参考图，保持主体、场景和画风一致，不叠加字幕、水印或文字。', config: { operation: 'prepare-references', modelBinding: 'default' } },
    { id: 'video', kind: 'animation', label: '镜头视频生成', description: '根据分镜与台词生成画面、人声和环境音。', prompt: '根据当前镜头的画面描述、台词与声音要求生成视频。保持角色、画风和声音连续，完整表达台词，声音与画面同步。不要生成画面字幕、文字标注或水印。', config: { operation: 'generate-native-video', modelBinding: 'default', requiresModel: true } },
    { id: 'animation', kind: 'animation', label: '剪辑与运镜准备', description: '按分镜顺序准备时间轴、转场与混音。', prompt: '', config: { operation: 'prepare-edit' } },
    { id: 'export', kind: 'export', label: '导出成片', description: '检查素材并按选定规格导出成片。', prompt: '', config: {} },
  ];
  const nodes = definitions.map((node, index) => ({ ...node, skillIds: [], position: { x: index * 270, y: 100 }, requiresReview: false }));
  return resolveProductionWorkflow({ id: 'native-video', version: 1, name: '视频制作', production: productionSettingsSchema.parse({ mode: 'native-video', agentInheritsPlanningSkills: false }), nodes,
    edges: nodes.slice(1).map((node, index) => ({ id: nodes[index].id + '-' + node.id, source: nodes[index].id, target: node.id })),
    stages: [
      { id: 'planning', label: '策划与分镜', description: '一次确定创作方向、视觉风格与镜头脚本。', nodeIds: ['brief', 'style', 'script'] },
      { id: 'materials', label: '素材与配音', description: '准备参考素材，生成带人声与环境音的镜头视频。', nodeIds: ['assets', 'video'] },
      { id: 'editing', label: '剪辑与动画', description: '安排镜头节奏、运镜、动画与转场。', nodeIds: ['animation'] },
      { id: 'delivery', label: '审阅与导出', description: '检查内容并按规格导出成片。', nodeIds: ['export'] },
    ],
  });
}
