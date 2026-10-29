import { z } from 'zod';

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

export const shotSchema = z.object({
  id: z.string().min(1), title: z.string().min(1).max(160), narration: z.string().max(10000), visualPrompt: z.string().max(20000),
  durationUs: z.number().int().min(500000).max(600000000),
  assetId: z.string().optional(), audioAssetId: z.string().optional(), videoAssetId: z.string().optional(),
  claimIds: z.array(z.string()).default([]), locked: z.boolean().default(false),
  animation: z.object({ panX: z.number().default(0), panY: z.number().default(0), zoom: z.number().min(0.1).max(5).default(1.05), transition: z.enum(['cut', 'fade', 'wipe']).default('fade') })
    .default({ panX: 0, panY: 0, zoom: 1.05, transition: 'fade' }),
});
export type Shot = z.infer<typeof shotSchema>;
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
export const claimSchema = z.object({ id: z.string(), text: z.string(), source: z.string(), locator: z.string().default(''), status: z.enum(['pending', 'verified', 'disputed']).default('pending') });
export type Claim = z.infer<typeof claimSchema>;
export const projectSchema = z.object({
  id: z.string(), title: z.string().min(1).max(160), brief: z.string().max(30000), templateId: z.string().default('history-handdrawn'),
  revision: z.number().int().positive(), profile: videoProfileSchema, shots: z.array(shotSchema), workflow: workflowSchema,
  claims: z.array(claimSchema).default([]), style: z.string().default('手绘墨线、淡彩纸纹、固定人物和场景锚点'),
  createdAt: z.string(), updatedAt: z.string(), archived: z.boolean().default(false),
});
export type ProjectDocument = z.infer<typeof projectSchema>;
export type Project = ProjectDocument;

export const modelCapabilitySchema = z.enum(['text', 'image', 'video', 'tts', 'asr', 'vision', 'tools', 'structured-output']);
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export const modelSchema = z.object({
  id: z.string(), name: z.string().min(1).max(120),
  provider: z.enum(['openai-compatible', 'ollama', 'comfyui', 'seedream', 'seedance', 'qwen-tts', 'custom-http']),
  baseUrl: z.string().url().refine(value => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }, '服务地址须为不含凭据、查询参数和片段的 HTTP(S) 地址'), model: z.string().min(1).max(200), capabilities: z.array(modelCapabilitySchema).min(1),
  parameters: z.record(z.string(), jsonValueSchema).default({}), enabled: z.boolean().default(true),
  credentialRef: z.string().optional(), hasSecret: z.boolean().default(false), createdAt: z.string(), updatedAt: z.string(),
});
export type ModelProfile = z.infer<typeof modelSchema>;
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
