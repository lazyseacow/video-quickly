import { z } from 'zod';
import { sceneTemplateSchema } from './scene-templates.js';
import { claimSchema, researchSourceSchema } from './research.js';
import { captionStyleSchema, scenePresetSchema } from './caption-style.js';
import { audioMixSettingsSchema, audioProcessingSchema } from './audio-processing.js';
export { audioProcessingSchema, audioMixSettingsSchema, DEFAULT_AUDIO_PROCESSING, DEFAULT_AUDIO_MIX_SETTINGS, preparedAudioMixSchema, audioMixJobSchema, audioMixPrepareResultSchema, audioLevelWindowSchema, silenceDetectionSchema, type AudioProcessing, type AudioMixSettings, type PreparedAudioMix, type AudioMixJob, type AudioMixPrepareResult, type AudioLevelWindow, type SilenceDetection } from './audio-processing.js';
export { captionStyleSchema, DEFAULT_CAPTION_STYLE, effectiveCaptionStyle, scenePresetSchema, seriesSettingsSchema, seriesTemplateSchema, type CaptionStyle, type ScenePreset, type SeriesSettings, type SeriesTemplate } from './caption-style.js';
export { claimSchema, claimEvidenceSchema, researchSourceSchema, researchResultSchema, researchSearchResultSchema, validateResearchContent, applyResearchClaims, type Claim, type ClaimEvidence, type ResearchSource, type ResearchResult, type ResearchSearchResult, type ShotClaims, type ResearchContent } from './research.js';
export { sceneTemplateSchema, processSceneTemplateSchema, comparisonSceneTemplateSchema, barChartSceneTemplateSchema, createSceneTemplate, type SceneTemplate, type SceneTemplateKind } from './scene-templates.js';
export { clipSourceAssetIds, validateClipEditContent, validateClipEditHistory, type ClipEditContent } from './clip-editing.js';

// A fixed application message is safe to retain across the external-activity boundary.
export class TranscriptionTimestampError extends Error {
  constructor() { super('模型没有返回语音时间戳。请选择支持分段时间戳的模型，不能用纯文字结果进行语音对齐。'); }
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
  sceneTemplate: sceneTemplateSchema.optional(),
  assetId: z.string().optional(), audioAssetId: z.string().optional(), videoAssetId: z.string().optional(),
  claimIds: z.array(z.string()).default([]), locked: z.boolean().default(false),
  animation: z.object({ panX: z.number().default(0), panY: z.number().default(0), zoom: z.number().min(0.1).max(5).default(1.05), transition: z.enum(['cut', 'fade', 'wipe']).default('fade') })
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
export const shotCandidateKindSchema = z.enum(['script', 'image', 'audio', 'video']);
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
export { getModelParameterFields, modelParameterValue, withModelParameter, validateModelParameters, requestModelParameters, type ModelParameterField, type ModelParameterOperation } from './model-parameters.js';
export const nodeKindSchema = z.enum(['brief', 'research', 'style', 'script', 'assets', 'voice', 'animation', 'review', 'export', 'agent', 'condition', 'join']);
export type NodeKind = z.infer<typeof nodeKindSchema>;
export const workflowNodeSchema = z.object({
  id: z.string().min(1), kind: nodeKindSchema, label: z.string().min(1), description: z.string().default(''),
  prompt: z.string().default(''), modelId: z.string().optional(), skillIds: z.array(z.string()).default([]),
  config: z.record(z.string(), jsonValueSchema).default({}),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }), requiresReview: z.boolean().default(false),
});
export const workflowSchema = z.object({
  id: z.string(), version: z.number().int().positive(), name: z.string(),
  nodes: z.array(workflowNodeSchema).min(1).max(100),
  edges: z.array(z.object({ id: z.string(), source: z.string(), target: z.string(), condition: z.string().optional() })),
});
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowDefinition = z.infer<typeof workflowSchema>;
export const projectSchema = z.object({
  id: z.string(), title: z.string().min(1).max(160), brief: z.string().max(30000), templateId: z.string().default('history-handdrawn'),
  revision: z.number().int().positive(), profile: videoProfileSchema, shots: z.array(shotSchema), workflow: workflowSchema,
  musicClips: z.array(musicClipSchema).optional(),
  researchSources: z.array(researchSourceSchema).max(20).optional(), referenceDisplay: z.enum(['hidden', 'numbers']).optional(),
  captionStyle: captionStyleSchema.nullable().optional(), scenePreset: scenePresetSchema.nullable().optional(),
  audioMix: audioMixSettingsSchema.nullable().optional(), clipEditSources: z.array(clipEditSourceSchema).max(2000).optional(), clipEditPlans: z.array(clipEditPlanSchema).max(5000).optional(),
  claims: z.array(claimSchema).default([]), style: z.string().default('手绘墨线、淡彩纸纹、固定人物和场景锚点'),
  createdAt: z.string(), updatedAt: z.string(), archived: z.boolean().default(false),
});
export type ProjectDocument = z.infer<typeof projectSchema>;
export type Project = ProjectDocument;

export const modelCapabilitySchema = z.enum(['text', 'image', 'video', 'tts', 'asr', 'vision', 'tools', 'structured-output']);
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export const currencySchema = z.enum(['USD', 'CNY']);
export const modelPricingSchema = z.object({
  currency: currencySchema,
  inputPerMillionTokens: z.number().nonnegative().optional(), outputPerMillionTokens: z.number().nonnegative().optional(),
  perImage: z.number().nonnegative().optional(), perVideoSecond: z.number().nonnegative().optional(),
  perThousandCharacters: z.number().nonnegative().optional(), perAudioMinute: z.number().nonnegative().optional(),
});
export type ModelPricing = z.infer<typeof modelPricingSchema>;
export const costRequestMetricsSchema = z.object({
  source: z.literal('request'), requestCount: z.number().int().nonnegative().optional(),
  images: z.number().int().nonnegative().optional(), videoSeconds: z.number().nonnegative().optional(),
  characters: z.number().int().nonnegative().optional(), audioSeconds: z.number().nonnegative().optional(),
});
export type CostRequestMetrics = z.infer<typeof costRequestMetricsSchema>;
export const providerUsageSchema = z.object({
  source: z.literal('provider'), inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(), cachedInputTokens: z.number().int().nonnegative().optional(),
  images: z.number().int().nonnegative().optional(), videoSeconds: z.number().nonnegative().optional(),
  characters: z.number().int().nonnegative().optional(), audioSeconds: z.number().nonnegative().optional(),
});
export type ProviderUsage = z.infer<typeof providerUsageSchema>;
export const modelSchema = z.object({
  id: z.string(), name: z.string().min(1).max(120),
  provider: z.enum(['openai-compatible', 'ollama', 'comfyui', 'seedream', 'seedance', 'qwen-tts', 'custom-http']),
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
  status: z.enum(['submitted', 'completed', 'unknown', 'failed', 'canceled']), requestMetrics: costRequestMetricsSchema,
  providerUsage: providerUsageSchema.optional(), pricing: modelPricingSchema.nullable().optional(),
  estimatedAmount: z.number().nonnegative().optional(), estimateBasis: z.enum(['provider', 'request', 'mixed']).optional(),
  actualAmount: z.number().nonnegative().optional(), actualCurrency: currencySchema.optional(), note: z.string().max(10000).default(''),
  createdAt: z.string(), updatedAt: z.string(),
}).refine(value => (value.actualAmount === undefined) === (value.actualCurrency === undefined), '实际金额与币种须同时填写');
export type UsageRecord = z.infer<typeof usageRecordSchema>;
export const skillSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), source: z.string(), version: z.string(),
  enabled: z.boolean(), instructions: z.string().default(''), resources: z.array(z.string()).default([]),
  tools: z.array(z.object({ id: z.string(), label: z.string(), enabled: z.boolean(), permissions: z.array(z.string()) })).default([]),
  contentHash: z.string(), importedAt: z.string(),
});
export type SkillPackage = z.infer<typeof skillSchema>;
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
export type RunStatus = z.infer<typeof runStatusSchema>;
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
export const runSchema = z.object({
  id: z.string(), projectId: z.string(), projectRevision: z.number().int(), status: runStatusSchema,
  workflowVersion: z.number().int(), snapshotDigest: z.string(), currentNodeId: z.string().optional(),
  parentRunId: z.string().optional(), createdAt: z.string(), updatedAt: z.string(), error: z.string().optional(),
  events: z.array(runEventSchema).default([]), activities: z.array(activitySchema).default([]),
});
export type StepRun = z.infer<typeof runSchema>;
export type RunRecord = StepRun;
export const assetSchema = z.object({
  id: z.string(), projectId: z.string().optional(), shotId: z.string().optional(), name: z.string(),
  kind: z.enum(['image', 'video', 'audio', 'subtitle', 'document']), path: z.string(), mimeType: z.string(),
  size: z.number().nonnegative(), sha256: z.string(), version: z.number().int().positive(),
  createdAt: z.string(), provenance: z.string(), retained: z.boolean().default(false), active: z.boolean().default(true),
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
  runs: z.array(runSchema), assets: z.array(assetSchema), events: z.array(runEventSchema), system: systemSchema,
});
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
// Summaries deliberately exclude shot collections, activity results and event history.
export const projectSummarySchema = projectSchema.pick({ id: true, title: true, brief: true, templateId: true, revision: true, profile: true, captionStyle: true, createdAt: true, updatedAt: true, archived: true }).extend({
  shotCount: z.number().int().nonnegative(), durationUs: z.number().nonnegative(), workflowNodeCount: z.number().int().nonnegative(),
  thumbnailShot: shotSchema.nullable(), thumbnailAsset: assetSchema.optional(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export const runSummarySchema = runSchema.omit({ events: true, activities: true }).extend({ completedNodeIds: z.array(z.string()) });
export type RunSummary = z.infer<typeof runSummarySchema>;
export const workspaceSummarySchema = z.object({
  projects: z.array(projectSummarySchema), models: z.array(modelSchema), skills: z.array(skillSchema), system: systemSchema,
  version: z.number().int().nonnegative(), assetsVersion: z.number().int().nonnegative(),
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export const projectDetailSchema = z.object({
  id: z.string(), revision: z.number().int().positive(), assetsVersion: z.number().int().nonnegative(),
  project: projectSchema.optional(), assets: z.array(assetSchema).optional(), latestRun: runSummarySchema.optional(),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;
export const pageInputSchema = z.object({ before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(100) });
export const assetListItemSchema = assetSchema.extend({ inUse: z.boolean() });
export type AssetListItem = z.infer<typeof assetListItemSchema>;
export const recordPageSchema = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.number().int().positive().nullable() });
export type RecordPage<T> = { items: T[]; nextCursor: number | null };
export const runtimeConnectionSchema = z.object({ state: z.enum(['ready', 'reconnecting', 'disconnected']), generation: z.number().int().nonnegative(), message: z.string().nullable().optional() });
export type RuntimeConnection = z.infer<typeof runtimeConnectionSchema>;
export type RuntimeEvent = { type: 'workspace.changed' | 'run.event' | 'runtime.ready' | 'runtime.connection'; data?: JsonValue };
export type RpcRequest = { jsonrpc: '2.0'; id: string | number; method: string; params?: unknown };
export type RpcResponse = { jsonrpc: '2.0'; id: string | number; result?: unknown; error?: { code: number; message: string } };

export function createHistoryWorkflow(): WorkflowDefinition {
  const steps: Array<[NodeKind, string, string, boolean]> = [
    ['brief', '创意简报', '明确主题、观众与核心问题', false],
    ['research', '资料与史实', '记录来源与待核验主张', false],
    ['style', '风格与角色', '固定画风、角色和场景锚点', true],
    ['script', '旁白与分镜', '编写旁白，逐镜头组织信息', true],
    ['assets', '画面素材', '生成或引用图片与场景图层', false],
    ['voice', '配音与字幕', '使用录音或模型制作旁白', false],
    ['animation', '动画与运镜', '调整图层、关键帧和转场', false],
    ['review', '小样审阅', '检查史实、画面、声音和字幕', true],
    ['export', '导出成片', '按选定视频规格生成文件', false],
  ];
  const nodes: WorkflowNode[] = steps.map(([kind, label, description, requiresReview], index) => ({
    id: kind, kind, label, description, prompt: '', skillIds: [], config: {}, position: { x: index * 270, y: 100 }, requiresReview,
  }));
  return { id: 'history-handdrawn', version: 1, name: '历史手绘科普', nodes, edges: nodes.slice(1).map((node, index) => ({ id: `${nodes[index].id}-${node.id}`, source: nodes[index].id, target: node.id })) };
}
