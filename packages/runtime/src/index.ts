import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile, rename, lstat } from 'node:fs/promises';
import { basename, extname, join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readGithubTrending, readResearchSource, selectResearchPassages, parseResearchResult, type GithubTrendingRanking } from '@video-quickly/integrations/research';
import type { MediaDiagnosticEvent } from '@video-quickly/integrations';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import {
  MAX_REFERENCE_AUDIO_BYTES, applyShotCandidate, assetSchema, audioWaveformSchema, characterProfileSchema, claimSchema, clipSourceAssetIds, DEFAULT_VIDEO_PROFILE, LockedShotChangeError, modelSchema, pageInputSchema, projectSchema, providerUsageSchema, runInspectionSchema, runSchema, sumProviderUsage, runSelectionSchema, runStatusSchema, shotCandidateFieldSchema, shotCandidateKindSchema, shotCandidateSchema, shotSchema, validateClipEditContent, validateClipEditHistory, validateModelConnection, getModelCapabilities, validateModelParameters, videoProfileSchema, workflowSchema,
  type AssetRecord, type AudioWaveform, type CharacterProfile, type JsonValue, type ModelCapability, type ModelProfile, type PreparedAudioMix, type ProjectDocument, type ReadinessIssue, type RunEvent, type RunPlan, type RunRecord, type RunSelection, type RuntimeEvent, type RuntimeSystem, type Shot, type ShotCandidate, type ShotCandidateKind, type SkillPackage, type WorkflowDefinition, type WorkflowNode, type WorkspaceSnapshot,
} from '@video-quickly/contracts';
import { ActivityJournal, AGENT_CONTINUATION_EXHAUSTED, AgentCompletionError, AmbiguousActivityError, fingerprint, SimulatedProcessExit, type ActivityHooks, type ActivitySafety } from './activities.js';
import { openDatabase, DocumentStore } from './database.js';
import { activityNodeId, createReadModels } from './read-models.js';
import { createExecutionGraph } from './graph.js';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { validateWorkflowComposition, workflowNodesWithSubflows, workflowEdgesWithSubflows, resolveSubflowInputs, substituteSubflowInputs, subflowNodeId, subflowThreadId, subflowValueAt, type SubflowDefinition } from '@video-quickly/contracts';
import { createWorkflowTemplateLibrary } from './workflow-templates.js';
import { buildWorkflowPrompt, parseWorkflowScript, scriptOutputJsonSchema, type WorkflowUpstreamResult } from './workflow-prompts.js';
import { githubTrendingPrompt, githubTrendingRequest, githubTrendingSummary, validateGithubTrendingStoryboard } from './github-trending.js';
import { storyboardWebPrompt, storyboardWebRequest, type StoryboardWebReader, type StoryboardWebResearch } from './storyboard-research.js';
import { createModelResponses, ModelResponseValidationError } from './model-responses.js';
import { createRunProgress } from './run-progress.js';
import { creativeContextSchema, MediaRequestRejectedError, projectCharacterIds, shotCreativePrompt, validateCreativeReferences } from '@video-quickly/contracts';
import { executeMediaGraph } from './media-graph.js';
import { discoverModels, generateText, testModelConnection, TextRequestRejectedError, type ModelRequestPhase, type TextProvider } from './providers.js';
import { seedExampleProject } from './seed.js';
import { createNativeVideoWorkflow, resolveProductionWorkflow, isVideoGenerationNode, DEFAULT_AUDIO_PROCESSING, productionEditingStep, productionSettingsSchema, sameJsonContent, supportsProductionAgent } from '@video-quickly/contracts';
import { createSkillLibrary } from './skill-library.js';
import { appendSkillContext, supportsSkillScript } from '@video-quickly/contracts';
import { connectMcp, mcpServerSchema, type McpServer } from './mcp.js';
import { createCostLedger, requestCostMetrics } from './costs.js';
import { createCharacterLibrary } from './characters.js';
import { createExportBatchManager, verifyBatchRenderResult, type ExportBatchSnapshot } from './export-batches.js';
import { validateResearchProject, researchPrompt, researchModelResponse } from './research.js';
import { createSeriesTemplateLibrary } from './series-templates.js';
import { replaceShotMedia } from '@video-quickly/video/clip-edits';
import { trimShotInContext } from '@video-quickly/video/editing';
import { createAudioPreview, type AudioMixCallbacks } from './audio-preview.js';
import { createAssetRecovery } from './asset-recovery.js';
import { createRunInspector, redactInspectionText } from './run-inspection.js';
import { createLogger, logError, type DiagnosticLogger } from './logging.js';
import { createProjectReadiness } from './project-readiness.js';
import { validateExecutionModel } from './execution-model.js';
import { buildMediaPrompt, resolvePromptBindings, supportsPromptExperiment, type PromptDraft, type PromptPreview, type PromptSession } from '@video-quickly/contracts';
import { createPromptLibrary } from './prompt-library.js';
import { createPromptWorkbench } from './prompt-workbench.js';
import { createWorkLibrary } from './works.js';
import { createProductionQueue } from './production-queue.js';
import { createImageTools } from './image-tools.js';
import { resolveImageEdit } from '@video-quickly/integrations/image-edit';
import { imageEditInputSchema, creativeReferenceAssetIds, type ImageEditInput } from '@video-quickly/contracts';
import { prepareWorkflowAssistant, parseWorkflowAssistantResult, type WorkflowAssistantContext } from './workflow-assistant.js';
import { workflowNodeSchema } from '@video-quickly/contracts';
import { type ProductionQueueItem } from '@video-quickly/contracts';
import { legacyVideoAgentNode, videoEditingAgentNode, videoTaskNode } from './video-agent.js';
import type { AgentBusinessTools, AgentContinuation } from './agent.js';
import { agentToolOutputDirectory, materializeToolArtifact } from './tool-artifacts.js';

export { SimulatedProcessExit } from './activities.js';
export type { DiagnosticLogger } from './logging.js';

export interface SecretStore {
  persistent?: boolean;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ActivityExecutionContext {
  skills?: SkillPackage[];
  project: ProjectDocument;
  node: WorkflowNode;
  runId: string;
  operationId: string;
  signal: AbortSignal;
  queueSignal?: AbortSignal;
  onFailure?: (error: unknown) => void;
  remoteTaskId?: string;
  dataDirectory: string;
  assets: AssetRecord[];
  model?: ModelProfile;
  apiKey?: string;
  characters?: CharacterProfile[];
  promptUpstream?: Record<string, JsonValue>;
  onProgress?: (value: number) => void;
  onAsset?: (asset: AssetRecord) => void;
  onDiagnostic?: (event: MediaDiagnosticEvent) => void;
  preparedAudioMix?: PreparedAudioMix;
  persistRemoteTask(id: string): void;
}

export interface RuntimeOptions {
  dataDirectory: string;
  logger?: DiagnosticLogger;
  mode?: 'desktop' | 'development';
  secretStore?: SecretStore;
  provider?: TextProvider;
  webResearch?: StoryboardWebReader;
  failpoint?: ActivityHooks['failpoint'];
  executeActivity?: (context: ActivityExecutionContext) => Promise<JsonValue>;
  preflightActivity?: (context: Pick<ActivityExecutionContext, 'project' | 'node' | 'assets' | 'model' | 'characters' | 'signal' | 'dataDirectory'> & Partial<Pick<ActivityExecutionContext, 'operationId'>>) => void | Promise<void>;
  readAudioWaveform?: (asset: AssetRecord) => Promise<AudioWaveform>;
  audioMix?: AudioMixCallbacks;
  activitySafety?: (node: WorkflowNode) => ActivitySafety;
  hostCall?: (method: string, params: unknown) => Promise<unknown>;
  seed?: boolean;
  ffmpegPath?: string;
}

export interface RunSnapshot {
  project: ProjectDocument;
  models: ModelProfile[];
  skills: SkillPackage[];
  automaticSkillIds?: string[];
  autonomousVideo?: boolean;
  videoEditingAgentId?: string;
  mcpServers: McpServer[];
  nodes: WorkflowNode[];
  handlerVersion: number;
  inspectionNodes?: WorkflowNode[];
  inspectionThreads?: Record<string, string>;
  inspectionEdges?: WorkflowDefinition['edges'];
  regeneration?: { shotId: string; kind: ShotCandidateKind; baseline: Shot; instruction?: string; imageEdit?: ImageEditInput };
  assistant?: WorkflowAssistantContext;
  characters?: CharacterProfile[];
  characterAssets?: AssetRecord[];
  assets?: AssetRecord[];
  exportBatch?: { batchId: string; targetId: string };
  research?: { sourceIds?: string[]; instruction?: string };
  selection?: RunSelection;
  trial?: { inputProject: ProjectDocument; upstream: WorkflowUpstreamResult[]; preview: PromptPreview };
  sourceGeneration?: { inputProject: ProjectDocument; upstream: WorkflowUpstreamResult[]; requestHash: string };
}

const entityId = z.object({ projectId: z.string().min(1) });
const assetListInput = pageInputSchema.extend({ kind: assetSchema.shape.kind.optional() });
const projectUpdateInput = entityId.extend({
  revision: z.number().int().optional(),
  patch: z.object({
    title: z.string().min(1).max(160).optional(),
    brief: z.string().max(30000).optional(),
    profile: videoProfileSchema.optional(),
    style: z.string().optional(),
    creativeContext: projectSchema.shape.creativeContext,
    workflow: workflowSchema.optional(),
    captionStyle: projectSchema.shape.captionStyle,
    scenePreset: projectSchema.shape.scenePreset,
    claims: z.array(claimSchema).optional(),
    shots: z.array(shotSchema).optional(),
    researchSources: projectSchema.shape.researchSources,
    referenceDisplay: projectSchema.shape.referenceDisplay,
    musicClips: projectSchema.shape.musicClips,
    audioMix: projectSchema.shape.audioMix,
    clipEditSources: projectSchema.shape.clipEditSources,
    clipEditPlans: projectSchema.shape.clipEditPlans,
  }),
});
const runIdInput = z.object({ runId: z.string().min(1) });
const regenerationInput = z.object({ shotId: z.string().min(1), kind: shotCandidateKindSchema, modelId: z.string().min(1).optional(), instruction: z.string().max(10_000).optional(), imageEdit: imageEditInputSchema.optional() });
const researchInput = z.object({ modelId: z.string().min(1), sourceIds: z.array(z.string().min(1)).min(1).max(20).optional(), instruction: z.string().max(10_000).optional() });
const now = () => new Date().toISOString();

function rpcIdentifiers(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
    ['projectId', 'runId', 'nodeId', 'shotId', 'modelId', 'assetId'].includes(entry[0]) && typeof entry[1] === 'string'));
}

const regenerationKinds = {
  script: { nodeKind: 'script', capability: 'text', label: '脚本', protocols: ['openai-compatible', 'ollama', 'custom-http'] },
  image: { nodeKind: 'assets', capability: 'image', label: '画面', protocols: ['openai-compatible', 'seedream', 'comfyui', 'custom-http'] },
  video: { nodeKind: 'animation', capability: 'video', label: '视频', protocols: ['openai-compatible', 'seedance', 'comfyui', 'custom-http'] },
} as const;

function containsPromptTemplate(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{prompt}}');
  if (Array.isArray(value)) return value.some(containsPromptTemplate);
  return Boolean(value && typeof value === 'object' && Object.values(value).some(containsPromptTemplate));
}

export function createRuntime(options: RuntimeOptions) {
  const directory = resolve(options.dataDirectory);
  const logger = options.logger ?? createLogger({ dataDirectory: directory, component: 'runtime' });
  logger.info('runtime.initializing');
  let database: ReturnType<typeof openDatabase>;
  try { database = openDatabase(directory); }
  catch (error) { logger.error('runtime.initialization_failed', { error: logError(error) }); throw error; }
  const store = new DocumentStore(database);
  const reads = createReadModels(database, store);
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const active = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  // Native graph cancellation can finish invoke before a node's local commit.
  // Keep ownership of that work until it settles, before closing SQLite.
  const pendingWork = new Set<Promise<unknown>>();
  function trackWork<T>(work: () => Promise<T>): Promise<T> {
    const promise = work(); pendingWork.add(promise);
    void promise.then(() => pendingWork.delete(promise), () => pendingWork.delete(promise));
    return promise;
  }
  async function drainWork() {
    while (active.size || pendingWork.size) await Promise.allSettled([...Array.from(active.values(), value => value.promise), ...pendingWork]);
  }
  const transientSecrets = new Set<string>();
  function rememberSecret(value: string | undefined) { if (value) transientSecrets.add(value); return value; }
  let closing = false;
  let workspaceVersion = 0;
  let productionQueue: ReturnType<typeof createProductionQueue> | undefined;
  const editorExports = new Map<string, AbortController>();
  const changed = () => { workspaceVersion++; emit({ type: 'workspace.changed' }); productionQueue?.notify(); };
  function emit(event: RuntimeEvent) { for (const listener of listeners) listener(event); }
  const assetRecovery = createAssetRecovery({ directory, store, onRestored(assetIds) { workspaceVersion++; emit({ type: 'workspace.changed', data: { repairedAssetIds: assetIds } }); } });
  const skillLibrary = createSkillLibrary({ store, directory, changed, logger });
  const journal = new ActivityJournal(database, { failpoint: options.failpoint, onEvent: changed, logger });
  const modelResponses = createModelResponses(store);
  const runProgress = createRunProgress(store, changed);
  const costs = createCostLedger({ database, store, onChanged: changed });
  const characters = createCharacterLibrary({ database, store, onChanged: changed });
  const seriesTemplates = createSeriesTemplateLibrary({ database, store, onChanged: changed });
  const workflowTemplates = createWorkflowTemplateLibrary({ database, store, onChanged: changed });
  const promptLibrary = createPromptLibrary(database, store, changed);
  const imageTools = createImageTools({ store, directory, changed });
  const promptWorkbench = createPromptWorkbench({ database, store, prepare: preparePromptDraft, changed, start: startPromptTrial, schedule });
  const works = createWorkLibrary({ database, store, project, saveProject, changed,
    reserved: id => projectBusy(id), validateDefaults: defaults => { characters.profilesFor({ creativeContext: defaults.creativeContext, shots: [] }); } });
  const audioPreview = createAudioPreview({ directory, store, callbacks: options.audioMix, project, validate: value => { validateEdits(value, project(value.id)); validateResearchProject(value, project(value.id)); characters.profilesFor(value); } });
  const runInspector = createRunInspector({ database, store, dataDirectory: directory, run,
    async secrets(models) {
      const references = [...new Set(models.flatMap(model => model.credentialRef ? [model.credentialRef] : []))];
      const values = await Promise.all(references.map(async reference => rememberSecret(await options.secretStore?.get(reference))));
      return [...transientSecrets, ...values.filter((value): value is string => Boolean(value))];
    },
    redactText: (text, models, secrets) => redactError(text, models, secrets, Number.POSITIVE_INFINITY),
  });

  if (options.seed === true && !store.get('metadata', 'initialized')) {
    database.transaction(() => {
      const seed = seedExampleProject(directory);
      store.put('project', seed.project.id, seed.project);
      for (const asset of seed.assets) store.put('asset', asset.id, asset);
      store.put('metadata', 'initialized', { version: 1 });
    })();
  }
  // The graph checkpoint remains authoritative. A previous process's transient
  // running label only needs a presentation reset to expose the resume action.
  for (const previous of store.list<RunRecord>('run')) {
    if (['running', 'queued', 'waiting_external', 'retry_scheduled'].includes(previous.status)) {
      store.put('run', previous.id, { ...previous, status: 'queued', updatedAt: now(), error: '上次执行已中断，可从检查点继续。' });
      logger.warn('run.recovered', { runId: previous.id, projectId: previous.projectId, previousStatus: previous.status, status: 'queued' });
    }
  }

  function project(id: string) {
    const value = store.get<ProjectDocument>('project', id);
    if (!value) throw new Error('项目不存在或已被移除。');
    return { ...value, workflow: resolveProductionWorkflow({ ...value.workflow, production: productionSettingsSchema.parse(value.workflow.production) }) };
  }

  function run(id: string) {
    const value = store.get<RunRecord>('run', id);
    if (!value) throw new Error('运行记录不存在。');
    return value;
  }

  function regenerationNode(value: ProjectDocument, input: z.infer<typeof regenerationInput>): WorkflowNode {
    const shot = value.shots.find(shot => shot.id === input.shotId);
    if (!shot) throw new Error('待重新生成的镜头不存在。');
    if (shot.locked) throw new Error('请先解锁镜头，再重新生成。');
    const configuration = regenerationKinds[input.kind];
    const template = value.workflow.nodes.find(node => node.kind === configuration.nodeKind);
    const modelId = input.modelId ?? template?.modelId;
    const model = modelId ? store.get<ModelProfile>('model', modelId) : undefined;
    const protocols: readonly string[] = configuration.protocols;
    if (!model?.enabled || !model.capabilities.includes(configuration.capability) || !protocols.includes(model.provider)) throw new Error(`请为镜头${configuration.label}重新生成选择可用的对应模型。`);
    const instruction = input.instruction?.trim();
    if (input.imageEdit && (input.kind !== 'image' || !instruction || shot.sceneTemplate || shot.assetId !== input.imageEdit.sourceAssetId)) throw new Error('局部改图需要当前镜头图片及明确的修改要求。');
    return {
      id: 'regenerate', kind: configuration.nodeKind, label: `重新生成镜头${configuration.label}`,
      description: template?.description ?? '', prompt: [template?.prompt, instruction].filter(Boolean).join('\n\n'),
      modelId: model.id, skillIds: template?.skillIds ?? [], position: template?.position ?? { x: 0, y: 0 }, requiresReview: false,
      config: { ...template?.config, operation: 'regenerate', shotId: shot.id, regenerationKind: input.kind, ...(instruction ? { instruction } : {}), ...(input.imageEdit ? { imageEdit: input.imageEdit } : {}) },
    };
  }

  function requireCandidateAssets(assets: AssetRecord[]) {
    for (const asset of assets) {
      const current = store.get<AssetRecord>('asset', asset.id);
      const keys = ['projectId', 'shotId', 'kind', 'path', 'sha256', 'size', 'version'] as const;
      if (!current?.active || keys.some(key => current[key] !== asset[key])) throw new Error('候选素材读取期间已更改或移除，请重新读取。');
    }
  }

  async function validatePromptAssets(assets: AssetRecord[]) {
    requireCandidateAssets(assets);
    for (const asset of assets) {
      const info = await stat(asset.path).catch(() => undefined);
      if (!info?.isFile() || info.size !== asset.size) throw new Error('实验输入素材缺失或损坏，请修复后重新预览。');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(asset.path)) hash.update(chunk);
      if (hash.digest('hex') !== asset.sha256) throw new Error('实验输入素材校验失败，请修复后重新预览。');
    }
  }

  async function validateCharacterAssets(profiles: CharacterProfile[], references: AssetRecord[], creativeIds: string[] = []) {
    const ids = new Set([...profiles.flatMap(profile => profile.referenceAssetIds), ...creativeIds]);
    if (ids.size !== references.length || references.some(asset => !ids.has(asset.id) || !asset.active || asset.kind !== 'image' || asset.projectId !== undefined)) throw new Error('角色参考图快照无效。');
    for (const reference of references) {
      const info = await stat(reference.path).catch(() => undefined);
      if (!info?.isFile() || info.size !== reference.size) throw new Error('角色参考图缺失或损坏。');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(reference.path)) hash.update(chunk);
      if (hash.digest('hex') !== reference.sha256) throw new Error('角色参考图校验失败，请重新生成。');
    }
  }

  function requireCurrentCharacters(profiles: CharacterProfile[]) {
    const current = characters.profilesFor({ shots: [{ characterIds: profiles.map(profile => profile.id) }] }).characters;
    if (fingerprint(current) !== fingerprint(profiles)) throw new Error('生成后角色设定或参考图已修改，请重新生成后应用。');
  }

  function requireCandidateResearch(value: ProjectDocument, candidate: ShotCandidate) {
    const claimIds = candidate.baseline.claimIds;
    if (!claimIds.length) return;
    const rows = database.prepare("SELECT c.value AS body FROM documents s, json_each(CASE WHEN json_type(s.body, '$.sourceGeneration') = 'object' THEN json_extract(s.body, '$.sourceGeneration.inputProject') ELSE json_extract(s.body, '$.project') END, '$.claims') c WHERE s.kind = 'run-snapshot' AND s.id = ? AND json_extract(c.value, '$.id') IN (SELECT value FROM json_each(?)) ORDER BY json_extract(c.value, '$.id')").all(candidate.runId, JSON.stringify(claimIds)) as { body: string }[];
    const parsedClaims = rows.map(row => claimSchema.parse(JSON.parse(row.body)));
    const claims = claimIds.map(id => parsedClaims.find(claim => claim.id === id));
    const current = claimIds.map(id => value.claims.find(claim => claim.id === id));
    if (claims.some(claim => !claim) || fingerprint(claims) !== fingerprint(current)) throw new Error('生成后镜头引用的主张或核验结论已变化，请基于当前资料重新生成。');
    const sourceIds = [...new Set(parsedClaims.flatMap(claim => claim.evidence?.map(evidence => evidence.sourceId) ?? []))].sort();
    if (!sourceIds.length) return;
    const sources = database.prepare("SELECT json_object('id', json_extract(c.value, '$.id'), 'title', json_extract(c.value, '$.title'), 'kind', json_extract(c.value, '$.kind'), 'sha256', json_extract(c.value, '$.sha256'), 'capturedAt', json_extract(c.value, '$.capturedAt'), 'url', json_extract(c.value, '$.url'), 'fileName', json_extract(c.value, '$.fileName')) AS body FROM documents s, json_each(CASE WHEN json_type(s.body, '$.sourceGeneration') = 'object' THEN json_extract(s.body, '$.sourceGeneration.inputProject') ELSE json_extract(s.body, '$.project') END, '$.researchSources') c WHERE s.kind = 'run-snapshot' AND s.id = ? AND json_extract(c.value, '$.id') IN (SELECT value FROM json_each(?)) ORDER BY json_extract(c.value, '$.id')").all(candidate.runId, JSON.stringify(sourceIds)) as { body: string }[];
    const metadata = sourceIds.map(id => { const source = value.researchSources?.find(source => source.id === id); return source ? { id: source.id, title: source.title, kind: source.kind, sha256: source.sha256, capturedAt: source.capturedAt, url: source.url ?? null, fileName: source.fileName ?? null } : undefined; });
    const parsedSources = sources.map(row => JSON.parse(row.body) as { id: string });
    if (sources.length !== sourceIds.length || fingerprint(sourceIds.map(id => parsedSources.find(source => source.id === id))) !== fingerprint(metadata)) throw new Error('生成后镜头证据来源已变化，请基于当前资料重新生成。');
  }

  async function candidateFor(projectId: string, candidateId: string): Promise<{ candidate: ShotCandidate; assets: AssetRecord[] }> {
    const stored = store.get('shot-candidate', candidateId);
    if (!stored) throw new Error('候选不存在。');
    const candidate = shotCandidateSchema.parse(stored);
    const record = store.get<RunRecord>('run', candidate.runId);
    const row = database.prepare("SELECT json_extract(body, '$.regeneration') AS regeneration, json_extract(body, '$.characters') AS characters, json_extract(body, '$.characterAssets') AS characterAssets, CASE WHEN json_type(body, '$.sourceGeneration') = 'object' THEN json_extract(body, '$.sourceGeneration.inputProject.creativeContext') WHEN json_type(body, '$.trial') = 'object' THEN json_extract(body, '$.trial.inputProject.creativeContext') ELSE json_extract(body, '$.project.creativeContext') END AS creativeContext FROM documents WHERE kind = 'run-snapshot' AND id = ?").get(candidate.runId) as { regeneration: string | null; characters: string | null; characterAssets: string | null; creativeContext: string | null } | undefined;
    const metadata = row?.regeneration ? z.object({ shotId: z.string(), kind: shotCandidateKindSchema, baseline: shotSchema, imageEdit: imageEditInputSchema.optional() }).parse(JSON.parse(row.regeneration)) : undefined;
    const activity = journal.get(candidate.runId, candidate.nodeId);
    if (candidate.projectId !== projectId || record?.projectId !== projectId || record.status !== 'succeeded' || activity?.status !== 'completed' || metadata?.shotId !== candidate.shotId || metadata.kind !== candidate.kind || fingerprint(metadata.baseline) !== fingerprint(candidate.baseline) || candidate.shot.id !== candidate.shotId) throw new Error('候选未完成或不属于当前镜头项目。');
    const profiles = row?.characters ? z.array(characterProfileSchema).parse(JSON.parse(row.characters)) : [];
    if (fingerprint(profiles) !== fingerprint(candidate.characters ?? [])) throw new Error('候选角色与生成快照不匹配。');
    const references = row?.characterAssets ? z.array(assetSchema).parse(JSON.parse(row.characterAssets)) : [];
    const editAssets: AssetRecord[] = [];
    if (metadata?.imageEdit) {
      const frozen = store.get<RunSnapshot>('run-snapshot', candidate.runId);
      const node = frozen?.nodes.find(node => node.id === candidate.nodeId);
      if (!frozen || !node) throw new Error('局部改图快照缺失，请重新生成。');
      await resolveImageEdit({ project: frozen.project, node, assets: frozen.assets ?? [], model: frozen.models.find(model => model.id === node.modelId) });
      editAssets.push(...(frozen.assets ?? []).filter(asset => asset.id === metadata.imageEdit!.sourceAssetId || asset.id === metadata.imageEdit!.maskAssetId));
      requireCandidateAssets(editAssets);
    }
    await validateCharacterAssets(profiles, references, creativeReferenceAssetIds({ creativeContext: row?.creativeContext ? creativeContextSchema.parse(JSON.parse(row.creativeContext)) : undefined }));
    if (candidate.kind === 'script') {
      if (candidate.assetIds.length) throw new Error('脚本候选包含无效素材。');
      return { candidate, assets: references };
    }
    const key = candidate.kind === 'image' ? 'assetId' : 'videoAssetId';
    if (candidate.assetIds.length !== 1 || candidate.shot[key] !== candidate.assetIds[0]) throw new Error('候选缺少相应的生成素材。');
    const asset = store.get<AssetRecord>('asset', candidate.assetIds[0]);
    const info = asset ? await stat(asset.path).catch(() => undefined) : undefined;
    if (!asset?.active || asset.projectId !== projectId || asset.shotId !== candidate.shotId || asset.kind !== candidate.kind || !info?.isFile() || info.size !== asset.size) throw new Error('候选素材缺失、已更改或不属于当前镜头。');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(asset.path)) hash.update(chunk);
    if (hash.digest('hex') !== asset.sha256) throw new Error('候选素材校验失败，请重新生成。');
    return { candidate, assets: [...references, ...editAssets, asset] };
  }

  function requireRevision(value: ProjectDocument, revision?: number) {
    if (revision !== undefined && revision !== value.revision) throw new Error('项目已在其他视图修改，请刷新后重新保存。');
  }

  function validateEdits(value: ProjectDocument, previous?: ProjectDocument) {
    validateCreativeReferences(value);
    const ids = new Set((value.clipEditSources ?? []).flatMap(clipSourceAssetIds));
    const assets = [...ids].map(id => {
      const asset = store.get<AssetRecord>('asset', id);
      if (!asset?.active || asset.projectId && asset.projectId !== value.id) throw new Error('原始剪辑素材已移除或不属于当前项目。');
      return asset;
    });
    validateClipEditContent(value, assets);
    if (previous) validateClipEditHistory(value, previous);
  }

  function saveProject(value: ProjectDocument, previous?: ProjectDocument) {
    const baseline = previous ?? project(value.id);
    const previousWorkflow = baseline.workflow;
    let workflow = value.workflow;
    const sameProduction = sameJsonContent(workflow.production, previousWorkflow.production)
      || sameJsonContent(workflow.production, workflowSchema.shape.production.safeParse(previousWorkflow.production).data);
    if (sameProduction) {
      const before = new Map(previousWorkflow.nodes.map(node => [node.id, node]));
      workflow = { ...workflow, nodes: workflow.nodes.map(node => node.config.modelBinding === 'default' && before.has(node.id) && node.config.modelOverride === before.get(node.id)?.config.modelOverride && node.modelId !== before.get(node.id)?.modelId
        ? { ...node, config: { ...node.config, modelOverride: true } } : node) };
    }
    const resolved = { ...resolveProductionWorkflow(workflow), version: previousWorkflow.version };
    const saved = projectSchema.parse({ ...value, workflow: resolved, revision: value.revision + 1, updatedAt: now() });
    if (!sameJsonContent(saved.workflow, previousWorkflow)) {
      // Older workspaces can omit settings supplied by the current schema.
      const parsed = workflowSchema.safeParse(previousWorkflow);
      if (!parsed.success || !sameJsonContent(saved.workflow, resolveProductionWorkflow(parsed.data))) {
        saved.workflow.version = workflowSchema.shape.version.parse(previousWorkflow.version + 1);
      }
    }
    validateResearchProject(saved, baseline);
    validateEdits(saved, baseline);
    characters.profilesFor(saved);
    store.put('project', saved.id, saved);
    changed();
    return saved;
  }

  function bindMedia(value: ProjectDocument, shotId: string, asset: AssetRecord, explicit = true): ProjectDocument {
    if (value.shots.find(shot => shot.id === shotId)?.locked) throw new Error('请先解锁镜头，再更换素材。');
    if (asset.kind === 'audio' || asset.kind === 'video') {
      const next = replaceShotMedia(value, shotId, asset.kind, asset, () => randomUUID());
      return asset.kind === 'video' ? { ...next, shots: next.shots.map(shot => shot.id === shotId ? { ...shot, sceneTemplate: explicit ? undefined : value.shots.find(before => before.id === shotId)?.sceneTemplate } : shot) } : next;
    }
    return { ...value, shots: value.shots.map(shot => shot.id === shotId ? { ...shot, assetId: asset.id, sceneTemplate: undefined } : shot) };
  }

  function nodeResultAssets(result: JsonValue): AssetRecord[] {
    return result && typeof result === 'object' && !Array.isArray(result) && Array.isArray(result.assets) ? z.array(assetSchema).parse(result.assets) : [];
  }

  function upstreamResults(runId: string, node: WorkflowNode, saved: RunSnapshot): WorkflowUpstreamResult[] {
    if (saved.sourceGeneration) return saved.sourceGeneration.upstream;
    if (saved.trial) return saved.trial.upstream;
    const edges = saved.inspectionEdges ?? saved.project.workflow.edges;
    const ancestors = new Set(edges.filter(edge => edge.target === node.id).map(edge => edge.source));
    // A subflow entry also inherits the call site's upstream context.
    let parentId = node.id;
    while (parentId.includes('/subflow/')) {
      parentId = parentId.slice(0, parentId.lastIndexOf('/subflow/'));
      edges.filter(edge => edge.target === parentId).forEach(edge => ancestors.add(edge.source));
    }
    for (const id of ancestors) edges.filter(edge => edge.target === id).forEach(edge => ancestors.add(edge.source));
    return (saved.inspectionNodes ?? saved.nodes).flatMap(upstream => {
      if (!ancestors.has(upstream.id)) return [];
      const output = store.get<JsonValue>('node-result', `${runId}:${upstream.id}`);
      return output === undefined ? [] : [{ nodeId: upstream.id, label: upstream.label, kind: upstream.kind, output }];
    });
  }

  function productionOutput({ brief, style, creativeContext, shots, clipEditSources, clipEditPlans }: ProjectDocument) {
    return { brief, style, creativeContext, shots, clipEditSources, clipEditPlans };
  }

  function projectContentDigest({ revision: _revision, updatedAt: _updatedAt, workflow, ...content }: ProjectDocument) {
    const production = productionSettingsSchema.safeParse(workflow.production);
    return fingerprint({ ...content, workflow: production.success ? resolveProductionWorkflow({ ...workflow, production: production.data }) : workflow });
  }

  function productionMediaIds(value: ProjectDocument) {
    return new Set([...value.shots.flatMap(shot => [shot.assetId, shot.audioAssetId, shot.videoAssetId, shot.captionTrack?.sourceAssetId]),
      ...(value.clipEditSources ?? []).flatMap(clipSourceAssetIds)].filter((id): id is string => Boolean(id)));
  }

  function applyProductionResult(runId: string, saved: RunSnapshot, videoNodeId?: string) {
    if (saved.assistant || saved.trial || saved.regeneration || saved.research || saved.exportBatch) return;
    if (!videoNodeId && (saved.selection || !saved.nodes.some(node => node.kind === 'agent') && (saved.inspectionNodes ?? saved.nodes).filter(node => node.kind !== 'subflow').length < 2)) return;
    const videoApplication = store.get<{ nodeIds: string[]; projectDigest: string; outputDigest: string }>('run-video-application', runId);
    if (store.get('run-application', runId) || videoNodeId && videoApplication?.nodeIds.includes(videoNodeId)) return;
    const working = store.get<ProjectDocument>('run-project', runId);
    if (!working) return;
    const output = productionOutput(working), outputDigest = fingerprint(output);
    if (outputDigest === (videoApplication?.outputDigest ?? fingerprint(productionOutput(saved.project)))) return;
    const current = project(saved.project.id);
    // An identical save advances the revision but leaves the generation inputs intact.
    if (projectContentDigest(current) !== (videoApplication?.projectDigest ?? projectContentDigest(saved.project))) {
      recordEvent(runId, videoNodeId ? 'node.apply_conflict' : 'project.apply_conflict', '项目在制作期间已修改，生成结果已保留在步骤详情中。', videoNodeId);
      return;
    }
    requireCurrentCharacters(saved.characters ?? []);
    database.transaction(() => {
      const applied = saveProject({ ...current, ...output }, current);
      if (videoNodeId) store.put('run-video-application', runId, { nodeIds: [...videoApplication?.nodeIds ?? [], videoNodeId], projectDigest: projectContentDigest(applied), outputDigest });
      else store.put('run-application', runId, { revision: applied.revision });
    })();
    recordEvent(runId, 'project.applied', videoNodeId ? '生成的视频已自动应用到项目。' : '制作结果已自动保存到项目。', videoNodeId);
  }

  async function preparePromptDraft(draft: PromptDraft): Promise<{ saved: RunSnapshot; preview: PromptPreview }> {
    const baseline = project(draft.projectId); requireRevision(baseline, draft.projectRevision);
    if (baseline.archived) throw new Error('请先恢复项目。');
    const original = baseline.workflow.nodes.find(node => node.id === draft.node.id && node.kind === draft.node.kind);
    if (draft.node.config.imageEdit !== undefined) throw new Error('局部改图请从镜头候选选择原图与区域后生成。');
    if (!original || !supportsPromptExperiment(original)) throw new Error('提示词实验支持简报、风格、分镜、参考图和镜头视频任务。');
    const media = ['assets', 'animation'].includes(original.kind);
    if (media && !draft.shotId) throw new Error('图片和视频实验需要选择一个镜头。');
    const upstream: WorkflowUpstreamResult[] = [];
    let inputProject = projectSchema.parse({ ...baseline, ...draft.context, workflow: { ...baseline.workflow, production: draft.context?.production ?? baseline.workflow.production } });
    const assets = store.list<AssetRecord>('asset').filter(asset => !asset.projectId || asset.projectId === baseline.id);
    if (draft.upstreamRunId) {
      const source = run(draft.upstreamRunId), snapshot = store.get<RunSnapshot>('run-snapshot', source.id);
      if (source.projectId !== baseline.id || source.status !== 'succeeded' || !snapshot || source.purpose && source.purpose !== 'production') throw new Error('请选择本项目已成功的正式制作作为上游输入。');
      const ancestors = new Set(baseline.workflow.edges.filter(edge => edge.target === original.id).map(edge => edge.source));
      for (const id of ancestors) baseline.workflow.edges.filter(edge => edge.target === id).forEach(edge => ancestors.add(edge.source));
      for (const node of orderedNodes(baseline.workflow).filter(node => ancestors.has(node.id))) {
        if (!(snapshot.inspectionNodes ?? snapshot.nodes).some(saved => saved.id === node.id && saved.kind === node.kind)) continue;
        const output = store.get<JsonValue>('node-result', `${source.id}:${node.id}`);
        if (output === undefined) continue;
        const references = nodeResultAssets(output); requireCandidateAssets(references);
        for (const asset of references) {
          if (asset.projectId !== baseline.id) throw new Error('上游素材与当前项目不匹配。');
          const info = await stat(asset.path).catch(() => undefined);
          if (!info?.isFile() || info.size !== asset.size) throw new Error('上游素材缺失或损坏，请修复后重新预览。');
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(asset.path)) hash.update(chunk);
          if (hash.digest('hex') !== asset.sha256) throw new Error('上游素材缺失或损坏，请修复后重新预览。');
        }
        inputProject = projectAfterNode(inputProject, node, output, references);
        upstream.push({ nodeId: node.id, label: node.label, kind: node.kind, output });
      }
      if (!upstream.length) throw new Error('该制作没有保存当前任务可用的上游产物。');
    }
    validateCreativeReferences(inputProject);
    const baselineShot = draft.shotId ? baseline.shots.find(shot => shot.id === draft.shotId) : undefined;
    if (draft.shotId && (!baselineShot || baselineShot.locked)) throw new Error('请选择存在且已解锁的镜头。');
    if (draft.shotId) {
      const shot = inputProject.shots.find(shot => shot.id === draft.shotId);
      if (!shot) throw new Error('上游产物没有包含所选镜头。');
      inputProject = { ...inputProject, shots: [shot], creativeContext: inputProject.creativeContext ? { ...inputProject.creativeContext, characterIds: [] } : undefined };
    }
    const kind = media ? original.kind === 'assets' ? 'image' : 'video' : 'script';
    const candidate = baselineShot && (media || original.kind === 'script');
    const node: WorkflowNode = { ...draft.node, requiresReview: false, ...(candidate ? { id: 'regenerate', config: { ...draft.node.config, operation: 'regenerate', shotId: baselineShot.id, regenerationKind: kind, instruction: '' } } : {}) };
    const bundle = characters.profilesFor(inputProject);
    await validateCharacterAssets(bundle.characters, bundle.assets, creativeReferenceAssetIds(inputProject));
    const model = availableModels().find(model => model.id === node.modelId);
    const sceneImageIds = node.kind === 'animation' && inputProject.workflow.production.referenceMode !== 'none' ? inputProject.shots.flatMap(shot => shot.assetId ? [shot.assetId] : []) : [];
    for (const id of sceneImageIds) if (!assets.some(asset => asset.id === id && asset.active && asset.kind === 'image')) throw new Error('镜头参考图不可用，请重新选择后预览。');
    const audioIds = node.kind === 'animation' && (!model || model.provider === 'seedance') ? inputProject.workflow.production.referenceAudioAssetIds ?? [] : [];
    for (const id of audioIds) if (!assets.some(asset => asset.id === id && asset.active && asset.kind === 'audio')) throw new Error('参考音频不可用，请重新选择后预览。');
    const requiredAssetIds = new Set([...bundle.assets.map(asset => asset.id), ...sceneImageIds, ...audioIds]);
    const frozenAssets = assets.filter(asset => requiredAssetIds.has(asset.id));
    if (frozenAssets.length !== requiredAssetIds.size) throw new Error('实验参考素材不完整，请重新选择后预览。');
    await validatePromptAssets(frozenAssets);
    const skills = await skillLibrary.prepare(node.skillIds);
    if (skills.length !== new Set(node.skillIds).size) throw new Error('选用的 Skill 不存在或已停用，请重新选择。');
    if (media && model) await options.preflightActivity?.({ project: inputProject, node, model, assets: frozenAssets, characters: bundle.characters, dataDirectory: directory, signal: new AbortController().signal });
    const values = Object.fromEntries(upstream.map(result => [result.nodeId, result.output]));
    const shot = inputProject.shots.length === 1 ? inputProject.shots[0] : undefined;
    const resolved = resolvePromptBindings(node, inputProject, shot, values);
    const hasImage = Boolean(shot?.assetId && assets.some(asset => asset.id === shot.assetId && asset.active && asset.kind === 'image')) && inputProject.workflow.production?.referenceMode !== 'none';
    const prompt = media ? appendSkillContext(buildMediaPrompt(inputProject, node, shot!, bundle.characters, model, hasImage, values), node, skills) : buildWorkflowPrompt(inputProject, node, skills, Boolean(baselineShot), bundle.characters, upstream);
    const references = frozenAssets.map(({ id, name, kind }) => ({ id, name, kind }));
    const preview: PromptPreview = { digest: '', prompt, node, model, skills, projectRevision: baseline.revision, variables: resolved.variables, references, upstream: upstream.map(({ nodeId, label, kind }) => ({ nodeId, label, kind })) };
    const saved: RunSnapshot = { project: baseline, models: model ? [model] : [], skills, mcpServers: [], nodes: [node], handlerVersion: 1, characters: bundle.characters, characterAssets: bundle.assets, assets: frozenAssets,
      selection: { nodeId: node.id, mode: 'node' }, ...(candidate ? { regeneration: { shotId: baselineShot.id, baseline: baselineShot, kind } } : {}), trial: { inputProject, upstream, preview } };
    preview.digest = fingerprint(saved);
    requireRevision(project(draft.projectId), draft.projectRevision);
    return { saved, preview };
  }

  function startPromptTrial(session: PromptSession, saved: RunSnapshot): RunRecord {
    const current = project(session.draft.projectId); requireRevision(current, session.draft.projectRevision);
    if (current.archived) throw new Error('请先恢复项目。');
    if (batches.blocked(current.id) || projectBusy(current.id)) throw new Error('该项目已有未完成的运行，请先完成或停止现有任务。');
    const node = saved.nodes[0], model = saved.models.find(model => model.id === node.modelId);
    if (!model?.enabled) throw new Error('请选择可用模型后重新预览。');
    validateExecutionModel(node, model);
    const id = randomUUID(), timestamp = now();
    const record: RunRecord = { id, projectId: current.id, projectRevision: current.revision, workflowVersion: current.workflow.version, snapshotDigest: fingerprint(saved), purpose: 'prompt-trial', promptSessionId: session.id, promptSessionRevision: session.revision, selection: saved.selection, stepCount: 1, status: 'queued', createdAt: timestamp, updatedAt: timestamp, events: [], activities: [] };
    store.put('run-snapshot', id, saved); store.put('run', id, record);
    recordEvent(id, 'run.created', '提示词实验快照已保存，结果等待手动应用。');
    return record;
  }

  function projectAfterNode(value: ProjectDocument, node: WorkflowNode, result: JsonValue, assets: AssetRecord[]): ProjectDocument {
    let working = value;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      if (node.kind === 'brief' && typeof result.text === 'string') working = { ...working, brief: result.text };
      if (node.kind === 'script' && Array.isArray(result.shots)) {
        const shots = z.array(shotSchema).parse(result.shots);
        if (value.shots.some((shot, index) => shot.locked && !isDeepStrictEqual(shot, shots[index]))) throw new LockedShotChangeError();
        working = { ...working, shots, ...(result.creativeContext ? { creativeContext: creativeContextSchema.parse(result.creativeContext) } : {}) };
      }
      if (node.kind === 'style' && typeof result.text === 'string') working = { ...working, style: result.text };

    }
    for (const asset of assets) {
      if (asset.projectId !== value.id) throw new Error('生成素材与当前项目不匹配。');
      if (!asset.shotId || !['image', 'audio', 'video'].includes(asset.kind)) continue;
      const shot = working.shots.find(shot => shot.id === asset.shotId);
      if (!shot) throw new Error('生成素材对应的镜头不存在。');
      if (shot.locked) {
        const binding = asset.kind === 'image' ? 'assetId' : asset.kind === 'audio' ? 'audioAssetId' : 'videoAssetId';
        if (shot[binding] !== asset.id) throw new Error('请先解锁镜头，再更换素材。');
        requireCandidateAssets([asset]);
        continue;
      }
      working = asset.kind === 'image' ? { ...working, shots: working.shots.map(shot => shot.id === asset.shotId ? { ...shot, assetId: asset.id } : shot) } : bindMedia(working, asset.shotId, asset, false);
      if (asset.kind === 'video' && isVideoGenerationNode(node)) working = { ...working, shots: working.shots.map(item => item.id === asset.shotId ? {
        ...item, audioAssetId: undefined, audioInUs: undefined, captionTrack: undefined, sceneTemplate: undefined,
        durationUs: asset.durationUs ?? item.durationUs, sourceInUs: undefined, videoInUs: 0,
        audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, version: 2, videoAudio: { enabled: true, gainDb: 0 } },
      } : item) };
    }
    validateCreativeReferences(working);
    return working;
  }

  function applyMediaResult(current: ProjectDocument, input: ProjectDocument, node: WorkflowNode, result: JsonValue, assets: AssetRecord[]): ProjectDocument {
    const originalShots = new Map(input.shots.map(shot => [shot.id, shot]));
    const currentShots = new Map(current.shots.map(shot => [shot.id, shot]));
    const pending: AssetRecord[] = [];
    const fieldsByShot = new Map<string, Set<keyof Shot>>();
    for (const asset of assets) {
      if (asset.projectId !== current.id) throw new Error('生成素材与当前项目不匹配。');
      if (!asset.shotId || !['image', 'audio', 'video'].includes(asset.kind)) continue;
      const shot = currentShots.get(asset.shotId), original = originalShots.get(asset.shotId);
      if (!shot || !original) throw new Error('生成素材对应的镜头已移除或不在执行输入中，请核对后再应用。');
      const binding = asset.kind === 'image' ? 'assetId' : asset.kind === 'audio' ? 'audioAssetId' : 'videoAssetId';
      // An already-applied stream may have been trimmed or mixed since then.
      if (shot[binding] === asset.id) continue;
      if (shot.locked) throw new Error('请先解锁镜头，再更换素材。');
      const fields = fieldsByShot.get(shot.id) ?? new Set<keyof Shot>();
      fields.add(binding);
      if (asset.kind === 'audio' || asset.kind === 'video') {
        for (const key of ['durationUs', 'sourceInUs', 'clipEdit'] as const) fields.add(key);
        fields.add(asset.kind === 'audio' ? 'audioInUs' : 'videoInUs');
        if (original.clipEdit) fields.add('captionTrack');
      }
      if (asset.kind === 'video' && isVideoGenerationNode(node)) {
        for (const key of ['audioAssetId', 'audioInUs', 'captionTrack', 'sceneTemplate', 'audioProcessing'] as const) fields.add(key);
      }
      fieldsByShot.set(shot.id, fields);
      pending.push(asset);
    }
    for (const [shotId, fields] of fieldsByShot) {
      const shot = currentShots.get(shotId)!, original = originalShots.get(shotId)!;
      if ([...fields].some(key => !isDeepStrictEqual(shot[key], original[key]))) throw new Error(`镜头“${shot.title}”的素材或剪辑区间已在生成后修改，请核对后再应用。`);
    }
    // Reuse the normal binding path against the current document so other shots,
    // authored text and immutable clip-edit history stay intact.
    return pending.length ? projectAfterNode(current, node, result, pending) : current;
  }

  function updateRun(id: string, patch: Partial<RunRecord>) {
    const previous = run(id);
    const updated = { ...previous, ...patch, updatedAt: now() };
    store.put('run', id, updated);
    if (previous.status !== updated.status) logger.debug('run.status_changed', { runId: id, projectId: updated.projectId, nodeId: updated.currentNodeId, previousStatus: previous.status, status: updated.status });
    changed();
    return updated;
  }

  function recordEvent(runId: string, type: string, message: string, nodeId?: string, error?: unknown) {
    const record = run(runId);
    const created = store.event(runId, type, { message, nodeId });
    const event: RunEvent = { id: `event-${created.sequence}`, runId, projectId: record.projectId, sequence: created.sequence, type, message, nodeId, createdAt: created.createdAt };
    // Presentation messages contain user labels and provider text. Diagnostics
    // keep only the event identity and safe, explicitly selected metadata.
    const fields = { runId, projectId: record.projectId, nodeId, sequence: created.sequence, status: record.status, ...(error === undefined ? {} : { error: logError(error) }) };
    if (type === 'run.failed') logger.error(type, fields);
    else if (type === 'run.interrupted') logger.warn(type, fields);
    else logger.info(type, fields);
    emit({ type: 'run.event', data: event as unknown as JsonValue });
    changed();
    return event;
  }

  function events(runId?: string): RunEvent[] {
    const rows = (runId ? database.prepare('SELECT * FROM execution_events WHERE run_id = ? ORDER BY sequence').all(runId) : database.prepare('SELECT * FROM execution_events ORDER BY sequence DESC LIMIT 300').all()) as { sequence: number; run_id: string; type: string; body: string; created_at: string }[];
    return rows.flatMap(row => {
      const savedRun = store.get<RunRecord>('run', row.run_id);
      if (!savedRun) return [];
      const body = JSON.parse(row.body) as { message?: string; nodeId?: string; activityId?: string };
      return [{ id: `event-${row.sequence}`, runId: row.run_id, projectId: savedRun.projectId, sequence: row.sequence, type: row.type, message: body.message ?? '步骤结果已保存', nodeId: body.nodeId ?? body.activityId, createdAt: row.created_at }];
    });
  }

  function hydrateRun(value: RunRecord): RunRecord {
    const ids = reads.nodeIds(value.id);
    return { ...value, events: events(value.id), activities: journal.list(value.id).map(row => ({ id: row.activity_id, runId: row.run_id, nodeId: activityNodeId(row.activity_id, ids), status: row.status === 'dispatched' ? 'submitted' : row.status === 'unknown' ? 'unknown' : row.status, inputHash: row.input_hash, result: row.result ? JSON.parse(row.result) as JsonValue : undefined, remoteTaskId: row.remote_id ?? undefined, attempt: 1, createdAt: row.started_at, updatedAt: row.completed_at ?? row.started_at, error: row.error ?? undefined })) };
  }

  function systemStatus(): RuntimeSystem {
    const executable = options.ffmpegPath ?? process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
    const probe = spawnSync(executable, ['-version'], { windowsHide: true, timeout: 3000, encoding: 'utf8' });
    return { platform: process.platform, runtimeVersion: process.version, dataDirectory: directory, ffmpegAvailable: probe.status === 0, ffmpegPath: probe.status === 0 ? executable : undefined, secureStorageAvailable: !!options.secretStore && options.secretStore.persistent !== false, mode: options.mode ?? 'desktop' };
  }

  const system = systemStatus();
  function availableModels(): ModelProfile[] { return store.list<ModelProfile>('model').map(model => ({ ...model, capabilities: getModelCapabilities(model) })); }

  function validateCompositionUpdate(value: WorkflowDefinition, previous: WorkflowDefinition) {
    validateWorkflow(value);
    for (const definition of value.subflows ?? []) {
      const before = previous.subflows?.find(item => item.id === definition.id && item.version === definition.version);
      if (before && !isDeepStrictEqual(before, definition)) throw new Error('已引用的子流程版本不能原地修改，请保存并插入新版本。');
      const library = store.get<{ definition: SubflowDefinition }>('workflow-template-version', `${definition.id}@${definition.version}`);
      if (library && !isDeepStrictEqual(library.definition, definition)) throw new Error('子流程副本与固定版本不一致，请重新插入。');
    }
  }

  function selectedWorkflowNodes(value: ProjectDocument, selection?: RunSelection): WorkflowNode[] {
    if (!selection) return orderedNodes(value.workflow);
    if (!value.workflow.nodes.some(node => node.id === selection.nodeId)) throw new Error('未找到所选步骤，请重新打开执行范围。');
    const ids = new Set([selection.nodeId]);
    if (selection.mode === 'downstream') for (const id of ids) {
      for (const edge of value.workflow.edges) if (edge.source === id) ids.add(edge.target);
    }
    return orderedNodes(value.workflow).filter(node => ids.has(node.id));
  }
  function videoEditingAgent(value: ProjectDocument, models: ModelProfile[], mcpServers: McpServer[]): WorkflowNode | undefined {
    const step = productionEditingStep(value.workflow);
    const { textModelId, agentSkillIds, agentMcpServerIds } = value.workflow.production;
    const model = models.find(model => model.id === textModelId && supportsProductionAgent(model));
    if (!step || !model) return;
    const hasConnection = mcpServers.some(server => server.enabled && (!agentMcpServerIds.length || agentMcpServerIds.includes(server.id)));
    // Plain library Skills can inform an explicitly bound project. With no
    // bindings, an enabled tool gives the editing Agent work beyond the preset.
    const hasSkill = store.list<SkillPackage>('skill').some(skill => skill.enabled && (agentSkillIds.length
      ? agentSkillIds.includes(skill.id) : skill.tools.some(tool => tool.enabled && supportsSkillScript(tool.id))));
    return hasConnection || hasSkill ? videoEditingAgentNode(step, value, model.id) : undefined;
  }
  function isAutonomousVideoRun(saved: RunSnapshot) {
    if (saved.autonomousVideo !== undefined) return saved.autonomousVideo;
    // Legacy full Agent snapshots contain the synthetic node outside the
    // authored workflow. An authored node with the same ID is ambiguous.
    const production = saved.project.workflow.production;
    return !saved.selection && saved.nodes.length === 1 && 'executionMode' in production && production.executionMode === 'agent'
      && !saved.project.workflow.nodes.some(node => node.id === 'video-agent')
      && fingerprint(saved.nodes[0]) === fingerprint(legacyVideoAgentNode(saved.project));
  }
  function productionBlockIssue(value: ProjectDocument, nodes: WorkflowNode[]): Pick<ReadinessIssue, 'category' | 'message' | 'fix' | 'nodeId'> | undefined {
    if (value.archived) return { category: 'project', message: '请先恢复项目。', fix: 'project' };
    if (batches.blocked(value.id) || projectBusy(value.id)) return { category: 'project', message: '该项目已有未完成的运行或批量导出，请继续或停止现有运行。', fix: 'runs' };
    const ids = new Set(nodes.map(node => node.id));
    const unavailableBinding = nodes.find(node => node.kind === 'subflow' && Object.values(node.subflow?.inputs ?? {}).some(binding => 'nodeId' in binding && !ids.has(binding.nodeId)));
    if (unavailableBinding) return { category: 'workflow', nodeId: unavailableBinding.id, message: '子流程输入引用了范围外的上游产物，请包含上游步骤或改用明确输入值。', fix: 'step' };
    return undefined;
  }
  async function prepareRunSelection(value: ProjectDocument, selection: RunSelection): Promise<{ plan: RunPlan; saved: RunSnapshot }> {
    const nodes = selectedWorkflowNodes(value, selection), ids = new Set(nodes.map(node => node.id));
    const composedNodes = workflowNodesWithSubflows({ ...value.workflow, nodes });
    const modelIds = new Set(composedNodes.flatMap(node => node.modelId ? [node.modelId] : []));
    const bundle = characters.profilesFor(value);
    const saved: RunSnapshot = {
      project: structuredClone(value), nodes, selection, handlerVersion: value.workflow.execution || nodes.some(node => node.kind === 'subflow') ? 3 : 2,
      models: availableModels().filter(model => composedNodes.some(node => node.kind === 'agent') || modelIds.has(model.id)),
      ...await skillLibrary.prepareForNodes(composedNodes, { allowUnavailable: true }),
      mcpServers: store.list<McpServer>('mcp-server'), characters: bundle.characters, characterAssets: bundle.assets,
      assets: store.list<AssetRecord>('asset').filter(asset => !asset.projectId || asset.projectId === value.id),
    };
    const missingModel = composedNodes.find(node => node.modelId && !saved.models.some(model => model.id === node.modelId && model.enabled));
    const missingSkill = composedNodes.find(node => node.skillIds.some(id => !saved.skills.some(skill => skill.id === id && skill.enabled)));
    const blockedReason = productionBlockIssue(value, nodes)?.message || (missingModel ? `「${missingModel.label}」的模型不可用，请重新选择模型。` : missingSkill ? `「${missingSkill.label}」选用的 Skill 不可用，请重新选择。` : '');
    return { saved, plan: {
      projectId: value.id, projectTitle: value.title, projectRevision: value.revision, workflowVersion: value.workflow.version,
      selection, digest: fingerprint(saved),
      steps: composedNodes.map(node => ({ id: node.id, label: node.label, kind: node.kind, requiresReview: false, modelName: node.modelId ? saved.models.find(model => model.id === node.modelId)?.name ?? '模型不可用' : undefined })),
      boundary: value.workflow.edges.filter(edge => !ids.has(edge.source) && ids.has(edge.target)).map(edge => ({
        sourceId: edge.source, sourceLabel: value.workflow.nodes.find(node => node.id === edge.source)?.label ?? edge.source,
        targetId: edge.target, targetLabel: value.workflow.nodes.find(node => node.id === edge.target)?.label ?? edge.target,
      })),
      shotCount: value.shots.length, lockedShotCount: value.shots.filter(shot => shot.locked).length,
      hasConditions: workflowEdgesWithSubflows({ ...value.workflow, nodes, edges: value.workflow.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) }).some(edge => Boolean(edge.condition)), blockedReason,
    } };
  }

  const readiness = createProjectReadiness({ system, directory, hasMediaExecutor: Boolean(options.executeActivity), preflight: options.preflightActivity,
    redactText: (text, models) => redactError(text, models, transientSecrets),
    snapshot(projectId, selection) {
      const value = project(projectId), models = availableModels();
      const agent = selection ? undefined : videoEditingAgent(value, models, store.list<McpServer>('mcp-server'));
      const nodes = selectedWorkflowNodes(value, selection).map(node => node.id === agent?.id ? agent : node);
      const subflows = value.workflow.subflows?.map(definition => ({ ...definition, nodes: orderedNodes({ ...value.workflow, nodes: definition.nodes, edges: definition.edges }) }));
      const expanded = workflowNodesWithSubflows({ ...value.workflow, nodes, subflows });
      const modelIds = new Set(expanded.flatMap(node => node.modelId ? [node.modelId] : [])), skillIds = new Set(expanded.flatMap(node => node.skillIds));
      const characterIds = projectCharacterIds(value);
      return { project: value, nodes: expanded, selection, blockedIssue: productionBlockIssue(value, nodes),
        models: models.filter(model => modelIds.has(model.id)),
        skills: store.list<SkillPackage>('skill').filter(skill => skillIds.has(skill.id)),
        characters: [...characterIds].flatMap(id => { const parsed = characterProfileSchema.safeParse(store.get('character', id)); return parsed.success ? [parsed.data] : []; }),
        assets: store.list<AssetRecord>('asset').filter(asset => !asset.projectId || asset.projectId === value.id) };
    },
  });

  function snapshot(): WorkspaceSnapshot {
    return { projects: store.list<ProjectDocument>('project'), models: availableModels(), skills: store.list<SkillPackage>('skill'), skillGroups: skillLibrary.groups(), skillImports: skillLibrary.jobs(), runs: store.list<RunRecord>('run').map(hydrateRun).reverse(), assets: store.list<AssetRecord>('asset'), events: events(), system };
  }

  async function importAsset(input: { path: string; projectId?: string; shotId?: string; kind?: AssetRecord['kind']; purpose?: 'reference-audio'; name?: string }, bind = true): Promise<AssetRecord> {
    const source = resolve(input.path); const info = await stat(source);
    if (!info.isFile() || info.size > 2_000_000_000) throw new Error('请选择不超过 2 GB 的文件。');
    const projectValue = input.projectId && bind ? project(input.projectId) : undefined;
    if (bind && input.shotId && !projectValue?.shots.some(shot => shot.id === input.shotId)) throw new Error('镜头不存在。');
    const id = randomUUID(); const extension = extname(source).toLowerCase();
    if (input.purpose === 'reference-audio' && (info.size <= 0 || info.size > MAX_REFERENCE_AUDIO_BYTES || !['.wav', '.mp3'].includes(extension))) throw new Error('请选择不超过 15 MB 的非空 WAV 或 MP3 参考音频。');
    const metadata = mediaKind(extension); const destinationDirectory = join(directory, 'projects', input.projectId ?? 'library', 'assets');
    if (input.kind && input.kind !== metadata.kind) throw new Error('文件格式与所选素材类型不一致。');
    await mkdir(destinationDirectory, { recursive: true });
    const destination = join(destinationDirectory, `${id}${extension}`); await copyFile(source, `${destination}.part`);
    const data = await readFile(`${destination}.part`); await rename(`${destination}.part`, destination);
    const value = assetSchema.parse({ id, projectId: input.projectId, shotId: input.shotId, name: input.name ?? basename(source), kind: input.kind ?? metadata.kind, path: destination, mimeType: metadata.mimeType, size: info.size, sha256: createHash('sha256').update(data).digest('hex'), version: 1, createdAt: now(), provenance: bind ? '用户导入' : '工具导入', retained: false, active: true });
    if (!bind) return value;
    database.transaction(() => {
      store.put('asset', id, value);
      if (projectValue && input.shotId && ['image', 'audio', 'video'].includes(value.kind)) {
        const currentProject = project(projectValue.id);
        if (!currentProject.shots.some(shot => shot.id === input.shotId)) throw new Error('镜头已移除，无法关联导入素材。');
        saveProject(bindMedia(currentProject, input.shotId, value));
      }
    })(); changed(); return value;
  }

  function agentBusinessTools(runId: string, parent: WorkflowNode, saved: RunSnapshot, controller: AbortController, skills: SkillPackage[], autonomous: boolean): AgentBusinessTools {
    const readProject = () => store.get<ProjectDocument>('run-project', runId) ?? saved.project;
    // LangChain may dispatch several tool calls together. Project mutations must
    // retain the same serial ordering as the existing workflow executor.
    let pending: Promise<unknown> = Promise.resolve();
    let fatalError: unknown;
    let stopped = false;
    return { readProject,
      models: saved.models.filter(model => model.enabled).map(({ id, name, capabilities }) => ({ id, name, capabilities })),
      ...(autonomous ? { isComplete: () => store.get<{ projectDigest: string }>('agent-export', `${runId}:${parent.id}`)?.projectDigest === fingerprint(readProject()) } : { operations: ['image', 'video', 'edit', 'import'] as const }),
      execute(input) {
        const work = pending.then(async () => {
          if (stopped) throw fatalError;
          controller.signal.throwIfAborted();
          if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.requestId)) throw new Error('requestId 需要 1–100 位字母、数字、下划线或连字符。');
          if (!autonomous && ['image', 'video'].includes(input.operation) && !input.shotId) throw new Error('剪辑阶段重新生成素材时，请指定单个镜头。');
          const node = videoTaskNode(saved.project, parent, input);
          if (input.skillIds?.some(id => !skills.some(skill => skill.id === id))) throw new Error('所选 Skill 不在本次允许使用的能力中。');
          if (input.modelId && !saved.models.some(model => model.id === input.modelId && model.enabled)) throw new Error('所选模型不在本次运行快照中。');
          return journal.execute(runId, `${parent.id}:business:${input.requestId}`, input, 'local', async () => {
            const previous = readProject();
            const shot = input.shotId ? previous.shots.find(shot => shot.id === input.shotId) : undefined;
            if (input.shotId && (!shot || shot.locked)) throw new Error('请选择存在且未锁定的镜头。');
            if (input.shotId && !['image', 'video', 'import'].includes(input.operation)) throw new Error('此操作使用完整项目，请移除 shotId。');
            const nodes = saved.inspectionNodes ?? saved.nodes;
            if (!nodes.some(value => value.id === node.id)) {
              const upstream = nodes.findLast(value => value.config.agentTask === true && value.id.startsWith(`${parent.id}/tool/`)) ?? (autonomous ? undefined : parent);
              const insertAt = autonomous ? nodes.length : nodes.findIndex(value => value.id === upstream?.id) + 1;
              saved.inspectionNodes = [...nodes.slice(0, insertAt), node, ...nodes.slice(insertAt)];
              saved.inspectionEdges = [...(saved.inspectionEdges ?? saved.project.workflow.edges), ...(upstream ? [{ id: `${upstream.id}-${node.id}`, source: upstream.id, target: node.id }] : [])];
              store.put('run-snapshot', runId, saved);
              updateRun(runId, { stepCount: saved.inspectionNodes.length, snapshotDigest: fingerprint(saved) });
            }
            let result: JsonValue;
            if (input.operation === 'import' || input.operation === 'edit') {
              result = await journal.execute(runId, node.id, input, 'local', async () => {
                if (input.operation === 'import') {
                  if (!input.shotId) throw new Error('导入素材需要目标镜头编号。');
                  const localOutputDirectory = input.path === undefined ? undefined : await agentToolOutputDirectory(directory, runId);
                  const path = await materializeToolArtifact(input, join(directory, 'projects', previous.id, 'tool-artifacts'), controller.signal, { localOutputDirectory, ffmpegPath: options.ffmpegPath });
                  try {
                    const asset = await importAsset({ path, projectId: previous.id, shotId: input.shotId, name: input.path && basename(input.path) }, false);
                    controller.signal.throwIfAborted();
                    return { assets: [asset] } as unknown as JsonValue;
                  } finally { await rm(path, { force: true }); }
                }
                let edited = previous;
                for (const edit of input.edits ?? []) {
                  const target = edited.shots.find(shot => shot.id === edit.shotId);
                  if (!target || target.locked) throw new Error('请选择存在且未锁定的镜头。');
                  if (edit.inUs !== undefined || edit.outUs !== undefined) {
                    const asset = store.get<AssetRecord>('asset', target.videoAssetId ?? target.assetId ?? '');
                    edited = trimShotInContext(edited, target.id, { inUs: edit.inUs ?? target.sourceInUs ?? 0, outUs: edit.outUs ?? (target.sourceInUs ?? 0) + target.durationUs }, edited.profile.frameRate, asset?.durationUs, () => randomUUID());
                  }
                  if (edit.transition) edited = { ...edited, shots: edited.shots.map(shot => shot.id === edit.shotId ? { ...shot, animation: { ...shot.animation, transition: edit.transition! } } : shot) };
                }
                validateEdits(edited, previous);
                return { editedProject: edited } as unknown as JsonValue;
              }, output => {
                const assets = nodeResultAssets(output);
                const next = output && typeof output === 'object' && !Array.isArray(output) && output.editedProject ? projectSchema.parse(output.editedProject) : projectAfterNode(previous, node, output, assets);
                for (const asset of assets) store.put('asset', asset.id, asset);
                store.put('node-project', `${runId}:${node.id}`, previous);
                store.put('node-definition', `${runId}:${node.id}`, node);
                store.put('run-project', runId, next);
                store.put('node-result', `${runId}:${node.id}`, output);
              });
            } else {
              result = await executeNode(runId, node, saved, controller);
            }
            controller.signal.throwIfAborted();
            if (input.operation === 'export') store.put('agent-export', `${runId}:${parent.id}`, { projectDigest: fingerprint(readProject()), nodeId: node.id });
            updateRun(runId, { currentNodeId: parent.id });
            return JSON.parse(JSON.stringify({ nodeId: node.id, result, project: readProject() })) as JsonValue;
          });
        });
        const result = work.catch(error => {
          if (stopped || error instanceof SimulatedProcessExit || controller.signal.aborted || error instanceof AmbiguousActivityError) { stopped = true; fatalError = error; throw error; }
          // A rejected local input can be corrected by the Agent. An ambiguous
          // external submission must retain the existing manual recovery contract.
          const unknown = journal.list(runId).some(activity => activity.activity_id !== parent.id && activity.safety === 'external' && ['unknown', 'dispatched'].includes(activity.status) && !activity.remote_id);
          if (unknown) { stopped = true; fatalError = error; throw error; }
          updateRun(runId, { currentNodeId: parent.id });
          return { error: redactError(error instanceof Error ? error.message : '任务失败', saved.models, transientSecrets), recoverable: true, project: JSON.parse(JSON.stringify(readProject())) as JsonValue };
        });
        pending = result.catch(() => undefined);
        return result;
      },
    };
  }

  async function executeNode(runId: string, inputNode: WorkflowNode, saved: RunSnapshot, controller: AbortController): Promise<JsonValue> {
    const started = performance.now();
    const node = store.get<WorkflowNode>('node-definition', `${runId}:${inputNode.id}`) ?? inputNode;
    const model = saved.models.find(model => model.id === node.modelId);
    const nodeLogger = logger.child({ runId, projectId: saved.project.id, nodeId: node.id, nodeKind: node.kind, modelId: model?.id, provider: model?.provider });
    nodeLogger.info('node.execution_started');
    try {
      const result = await executeNodeWork(runId, node, saved, controller, nodeLogger);
      if (!controller.signal.aborted && isVideoGenerationNode(node) && !node.config.agentTask
        && nodeResultAssets(result).some(asset => asset.kind === 'video' && asset.shotId)) {
        applyProductionResult(runId, saved, node.id);
      }
      nodeLogger.info('node.execution_completed', { durationMs: performance.now() - started });
      return result;
    } catch (error) {
      if (!(error instanceof SimulatedProcessExit)) {
        const canceled = controller.signal.aborted || run(runId).status === 'canceled';
        nodeLogger[canceled ? 'warn' : 'error'](canceled ? 'node.execution_canceled' : 'node.execution_failed', { durationMs: performance.now() - started, error: logError(error) });
      }
      throw error;
    }
  }

  async function executeNodeWork(runId: string, node: WorkflowNode, saved: RunSnapshot, controller: AbortController, nodeLogger: DiagnosticLogger): Promise<JsonValue> {
    if (controller.signal.aborted || run(runId).status === 'canceled') throw new Error('任务已停止。');
    store.put('node-definition', `${runId}:${node.id}`, node);
    if (node.kind === 'subflow') return executeSubflow(runId, node, saved, controller);
    updateRun(runId, { status: 'running', currentNodeId: node.id, error: undefined });
    recordEvent(runId, 'node.started', `开始：${node.label}`, node.id);
    const scopedProject = saved.regeneration ? { ...saved.project, creativeContext: saved.project.creativeContext ? { ...saved.project.creativeContext, characterIds: [] } : undefined, shots: saved.project.shots.filter(shot => shot.id === saved.regeneration!.shotId) } : saved.project;
    const executionProject = store.get<ProjectDocument>('node-project', `${runId}:${node.id}`) ?? store.get<ProjectDocument>('run-project', runId) ?? saved.sourceGeneration?.inputProject ?? saved.trial?.inputProject ?? scopedProject;
    const mediaProject = node.config.agentTask && typeof node.config.shotId === 'string' ? { ...executionProject, shots: executionProject.shots.filter(shot => shot.id === node.config.shotId) } : executionProject;
    store.put('node-project', `${runId}:${node.id}`, executionProject);
    if (saved.trial || saved.sourceGeneration) await validatePromptAssets(saved.assets ?? []);
    if (node.config.imageEdit !== undefined && (!saved.regeneration?.imageEdit || fingerprint(node.config.imageEdit) !== fingerprint(saved.regeneration.imageEdit))) throw new Error('局部改图输入须由镜头候选冻结，请重新选择改图区域。');
    const selectedModel = node.modelId ? saved.models.find(model => model.id === node.modelId) : undefined;
    validateExecutionModel(node, selectedModel);
    const usesProvider = !!selectedModel && ['brief', 'research', 'style', 'script', 'agent'].includes(node.kind);
    const secret = selectedModel?.credentialRef ? rememberSecret(await options.secretStore?.get(selectedModel.credentialRef)) : undefined;
    if (selectedModel?.hasSecret && !secret) throw new Error('模型凭据不可用，请重新保存密钥后创建新的运行。');
    const media = ['assets', 'animation', 'export'].includes(node.kind);
    const safety = options.activitySafety?.(node) ?? (usesProvider || (media && !!selectedModel) ? 'external' : 'local');
    const cached = journal.get(runId, node.id);
    const selectedCharacterIds = new Set(saved.assistant || node.kind === 'research' || node.kind === 'export' && !selectedModel ? [] : usesProvider ? projectCharacterIds(executionProject) : executionProject.shots.flatMap(shot => shot.characterIds ?? []));
    const executionCharacters = (saved.characters ?? []).filter(profile => selectedCharacterIds.has(profile.id));
    if (executionCharacters.length !== selectedCharacterIds.size) throw new Error('运行快照缺少镜头角色，请基于当前角色新建运行。');
    const referenceIds = new Set([...executionCharacters.flatMap(profile => profile.referenceAssetIds), ...executionProject.shots.flatMap(shot => creativeReferenceAssetIds(executionProject, shot))]);
    const characterAssets = (saved.characterAssets ?? []).filter(asset => referenceIds.has(asset.id));
    const assetIds = saved.regeneration ? new Set(executionProject.shots.flatMap(shot => [shot.assetId, shot.audioAssetId, shot.videoAssetId]).filter((id): id is string => Boolean(id))) : undefined;
    const generatedAssets = media ? database.prepare("SELECT asset.value AS body FROM documents result, json_each(result.body, '$.assets') asset WHERE result.kind = 'node-result' AND json_type(result.body, '$.assets') = 'array' AND result.id IN (SELECT value FROM json_each(?))").all(JSON.stringify((saved.inspectionNodes ?? saved.nodes).map(node => `${runId}:${node.id}`))).map(row => assetSchema.parse(JSON.parse((row as { body: string }).body))) : [];
    const activityAssets = media && options.executeActivity ? [...new Map([
      ...(saved.assets ?? (assetIds ? [...assetIds].map(id => store.get<AssetRecord>('asset', id)).filter((asset): asset is AssetRecord => Boolean(asset)) : store.list<AssetRecord>('asset'))).filter(asset => !asset.projectId || asset.projectId === saved.project.id),
      ...generatedAssets,
      ...characterAssets,
    ].map(asset => [asset.id, asset])).values()] : [];
    if (media && selectedModel) await options.preflightActivity?.({ project: mediaProject, node, assets: activityAssets, model: selectedModel, characters: executionCharacters, signal: controller.signal, dataDirectory: directory, operationId: `${runId}:${node.id}` });
    if (media && cached?.status === 'completed' && cached.result) {
      const result: unknown = JSON.parse(cached.result);

      const cachedAssets = result && typeof result === 'object' && 'assets' in result && Array.isArray(result.assets) ? result.assets : [];
      let invalid = false;
      for (const candidate of cachedAssets) {
        const asset = assetSchema.parse(candidate);
        const bytes = await readFile(asset.path).catch(() => undefined);
        if (!bytes || bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) { invalid = true; break; }
      }
      if (invalid) {
        if (safety === 'external') throw new Error('已完成的生成素材缺失或损坏，请显式重新生成此镜头；恢复不会重新提交模型请求。');
        database.prepare("UPDATE activities SET status = 'failed', result = NULL, error = '本地渲染文件需要重建' WHERE run_id = ? AND activity_id = ?").run(runId, node.id);
      }
    }
    const deepAgent = node.kind === 'agent' && selectedModel?.capabilities.includes('tools') && selectedModel.provider !== 'ollama';
    const researchContext = usesProvider && node.kind === 'research' ? selectResearchPassages(executionProject, saved.research?.sourceIds ?? (Array.isArray(node.config.sourceIds) ? node.config.sourceIds.filter((id): id is string => typeof id === 'string') : undefined), saved.research?.instruction ?? node.prompt) : undefined;
    let githubTrending: GithubTrendingRanking | undefined;
    let webResearch: StoryboardWebResearch | undefined;
    if (usesProvider && node.kind === 'script' && !saved.trial && !saved.regeneration && !saved.assistant) {
      const id = `${runId}:${node.id}`;
      githubTrending = store.get<GithubTrendingRanking>('github-trending-input', id);
      webResearch = store.get<StoryboardWebResearch>('storyboard-web-input', id);
      // A legacy activity already has a frozen input hash and possibly a model receipt.
      const lookup = !githubTrending && !webResearch && !cached ? storyboardWebRequest(saved.project, node.prompt) : undefined;
      if (lookup) {
        const trending = githubTrendingRequest(saved.project.brief) ?? githubTrendingRequest(node.prompt);
        if (trending) {
          githubTrending = await readGithubTrending(trending, controller.signal);
          store.put('github-trending-input', id, githubTrending);
          recordEvent(runId, 'node.web_research_finished', githubTrendingSummary(githubTrending), node.id);
        } else if (options.webResearch) {
          recordEvent(runId, 'node.web_research_started', '正在查找分镜所需的网页资料。', node.id);
          const redactLookup = (value: string) => redactError(value, saved.models, transientSecrets, Number.POSITIVE_INFINITY);
          const query = lookup.query ? redactLookup(lookup.query).replaceAll('[已隐藏]', '').trim() : undefined;
          const urls = lookup.urls.filter(url => redactLookup(url) === url);
          webResearch = await options.webResearch({ query, urls }, controller.signal);
          controller.signal.throwIfAborted();
          if (lookup.required && !webResearch.sources.length) throw new Error('未读到分镜所需的网页正文。请检查网络后重试。要补充来源，请更新简报后新建制作。');
          store.put('storyboard-web-input', id, webResearch);
          recordEvent(runId, 'node.web_research_finished', webResearch.sources.length ? `分镜已读取 ${webResearch.sources.length} 个网页来源。` : '未读到可用网页资料，按简报继续创作。', node.id);
        }
      }
    }
    const input = { project: executionProject, node, model: selectedModel ?? null, skills: saved.skills.filter(skill => node.skillIds.includes(skill.id)), handlerVersion: saved.handlerVersion, ...(saved.exportBatch ? { exportBatch: saved.exportBatch, assets: saved.assets } : {}), ...(githubTrending ? { githubTrending } : {}), ...(webResearch ? { webResearch } : {}) };
    const retryIssues = node.kind === 'script' ? modelResponses.retryIssues(`${runId}:${node.id}`) : undefined;
    const basePrompt = saved.assistant ? node.prompt : usesProvider ? researchContext ? researchPrompt(executionProject, node, saved.skills, researchContext) : buildWorkflowPrompt(executionProject, node, saved.skills, Boolean(saved.regeneration), executionCharacters, upstreamResults(runId, node, saved)) : '';
    const webPrompt = githubTrending ? githubTrendingPrompt(githubTrending) : webResearch ? storyboardWebPrompt(webResearch) : '';
    const prompt = `${basePrompt}${webPrompt ? `\n\n${webPrompt}` : ''}${retryIssues?.length ? `\n\n上次分镜返回的字段校验错误：${JSON.stringify(retryIssues)}\n本次请修正上述字段，仍依据本次已完成的简报与风格返回完整 JSON 对象，不要只返回修补片段。` : ''}`;
    if (!cached || cached.status === 'prepared') runInspector.captureInput(runId, node.id, { inputHash: fingerprint(input), recordedAt: now(),
      prompt: usesProvider || saved.trial ? redactInspectionText(saved.trial?.preview.prompt ?? prompt, text => redactError(text, saved.models, transientSecrets, Number.POSITIVE_INFINITY)) : undefined });
    const capability: ModelCapability | undefined = node.kind === 'assets' ? 'image' : node.kind === 'animation' ? 'video' : usesProvider ? 'text' : undefined;
    const responseAttempt = node.kind === 'script' ? modelResponses.attempt(`${runId}:${node.id}`) : undefined;
    const costOperation = selectedModel && capability && !deepAgent ? `${runId}:${node.id}${responseAttempt ? `:response:${responseAttempt}` : ''}` : undefined;
    if (costOperation && selectedModel && capability) {
      const existing = costs.get(costOperation);
      if (cached?.status !== 'completed' || existing) costs.begin({ operationId: costOperation, runId, nodeId: node.id, shotId: saved.regeneration?.shotId ?? (typeof node.config.shotId === 'string' ? node.config.shotId : undefined), projectId: saved.project.id, model: selectedModel, capability, requestMetrics: requestCostMetrics(executionProject, node, selectedModel) });
      if (cached?.status === 'completed' && existing) costs.status(costOperation, 'completed');
    }
    try {
    const result = await journal.execute(runId, node.id, input, safety, async context => {
      runProgress.begin(context.operationId, executionProject, selectedModel && node.kind === 'assets' ? 'image' : selectedModel && isVideoGenerationNode(node) ? 'video' : undefined, activityAssets);
      if (usesProvider) {
        runProgress.phase(context.operationId, 'requesting');
        const generate = async () => {
          runProgress.phase(context.operationId, 'requesting');
          if (node.kind === 'script') runInspector.captureInput(runId, node.id, { inputHash: fingerprint(input), recordedAt: now(), prompt: redactInspectionText(prompt, text => redactError(text, saved.models, transientSecrets, Number.POSITIVE_INFINITY)) });
          const started = performance.now();
          let requestPhase: ModelRequestPhase | undefined;
          nodeLogger.info('provider.request_started', { phase: 'submit' });
          try {
            const result = await (options.provider ?? generateText)({ model: selectedModel, secret, prompt, operationId: responseAttempt ? `${context.operationId}:response:${responseAttempt}` : context.operationId, signal: controller.signal, outputSchema: node.kind === 'script' ? scriptOutputJsonSchema : undefined, promptOutputFormat: node.kind === 'script' && modelResponses.promptFormat(context.operationId), onOutputFormatFallback: () => { modelResponses.usePromptFormat(context.operationId); nodeLogger.info('provider.output_format_fallback'); }, onRequestPhase: phase => {
              requestPhase = phase;
              runProgress.phase(context.operationId, phase === 'validate' || phase === 'parse' ? 'validating' : phase === 'headers' || phase === 'read' ? 'receiving' : 'requesting', ['headers', 'read', 'parse', 'validate'].includes(phase));
            } });
            nodeLogger.info('provider.request_completed', { durationMs: performance.now() - started });
            return result;
          } catch (error) {
            nodeLogger[controller.signal.aborted ? 'warn' : 'error']('provider.request_failed', { requestPhase, durationMs: performance.now() - started, error: logError(error) });
            throw error;
          }
        };
        const generated = researchContext
          ? await researchModelResponse({ dataDirectory: directory, projectId: executionProject.id, operationId: context.operationId, inputHash: fingerprint({ prompt, model: selectedModel }), recordReceipt: context.recordRemoteId, generate })
          : deepAgent
          ? await (async () => {
              context.recordRemoteId(`langgraph:${runId}:${node.id}:agent`);
              const { executeDeepAgent } = await import('./agent.js');
              const selectedServers = Array.isArray(node.config.mcpServerIds) ? node.config.mcpServerIds.filter((value): value is string => typeof value === 'string') : [];
              const mcpServers = await Promise.all((saved.mcpServers ?? []).filter(server => server.enabled && (!selectedServers.length || selectedServers.includes(server.id))).map(async server => ({ ...server, secret: server.credentialRef ? rememberSecret(await options.secretStore?.get(server.credentialRef)) : undefined })));
              const autonomous = node.id === 'video-agent' && isAutonomousVideoRun(saved);
              const skillIds = node.skillIds.length ? node.skillIds : saved.automaticSkillIds;
              const skills = saved.skills.filter(skill => skill.enabled && (!skillIds || skillIds.includes(skill.id)));
              const business = autonomous || node.id === saved.videoEditingAgentId ? agentBusinessTools(runId, node, saved, controller, skills, autonomous) : undefined;
              const text = await executeDeepAgent({ database, model: selectedModel, secret, prompt, signal: controller.signal, runId, nodeId: node.id, project: executionProject, skills, mcpServers, dataDirectory: directory, ffmpegPath: options.ffmpegPath, failpoint: options.failpoint, costs, business });
              if (business?.isComplete && !business.isComplete()) throw new AgentCompletionError('视频 Agent 尚未完成当前产物的实际导出，请继续制作。');
              return text;
            })()
          : node.kind === 'script' ? await modelResponses.generate({ operationId: context.operationId, inputHash: fingerprint(input), recordReceipt: context.recordRemoteId, generate }) : await generate();
        const text = typeof generated === 'string' ? generated : generated.text;
        runProgress.phase(context.operationId, 'validating', true);
        const usage = typeof generated === 'string' ? undefined : generated.usage;
        if (costOperation) costs.status(costOperation, 'completed', usage);
        if (node.kind === 'script') {
          try {
            if (typeof generated !== 'string' && generated.incomplete) throw new ModelResponseValidationError([{ path: '$', message: '模型输出被截断，请提高最大输出 Token 或减少镜头数量。' }]);
            const script = parseWorkflowScript(text, executionProject, Boolean(saved.regeneration), executionCharacters);
            if (githubTrending) validateGithubTrendingStoryboard(script.shots, githubTrending);
            return { text, source: 'model', modelId: selectedModel.id, ...(usage ? { providerUsage: usage } : {}), ...script } as JsonValue;
          } catch (error) {
            if (error instanceof ModelResponseValidationError) modelResponses.validationFailed(context.operationId, error.issues);
            throw error;
          }
        }
        if (!text.trim()) throw new Error('模型没有返回可用内容，请检查模型配置后重试。');
        if (researchContext) return { ...parseResearchResult(text, executionProject, researchContext, runId, node.id), ...(usage ? { providerUsage: usage } : {}) } as unknown as JsonValue;
        return { text, source: 'model', modelId: selectedModel.id, ...(usage ? { providerUsage: usage } : {}) } as JsonValue;
      }
      if (media && options.executeActivity) {
        const batch = saved.exportBatch;
        const executeActivity = options.executeActivity;
        const activityContext: ActivityExecutionContext = { project: mediaProject, node, skills: saved.skills.filter(skill => node.skillIds.includes(skill.id)), runId, operationId: context.operationId, signal: controller.signal, remoteTaskId: context.remoteId, persistRemoteTask: context.recordRemoteId, dataDirectory: directory, assets: activityAssets, model: selectedModel, apiKey: secret, characters: executionCharacters, promptUpstream: Object.fromEntries(upstreamResults(runId, node, saved).map(result => [result.nodeId, result.output])),
          onDiagnostic: event => {
            const { event: name, level, ...fields } = event;
            nodeLogger[level](name, { ...fields, shotCount: executionProject.shots.length });
            runProgress.media(context.operationId, event);
            if (name === 'media.render_started') runProgress.phase(context.operationId, 'rendering');
          },
          onAsset: value => {
            const asset = assetSchema.parse(value);
            if (asset.projectId !== executionProject.id || !executionProject.shots.some(shot => shot.id === asset.shotId)) throw new Error('生成进度素材不属于本次镜头。');
            runProgress.asset(context.operationId, asset);
          },
          ...(node.kind === 'export' ? { preparedAudioMix: audioPreview.ready(executionProject, activityAssets) } : {}),
          onProgress: value => { if (batch) batches.progress(batch.batchId, batch.targetId, value); runProgress.phase(context.operationId, 'rendering', false, value); } };
        let output: JsonValue;
        if (saved.handlerVersion >= 3 && executionProject.workflow.execution && selectedModel && ['assets', 'animation'].includes(node.kind) && !node.config.agentTask) {
          // Each Send owns a stable shot identity. The adapter keeps its existing
          // parent operation + shot receipts, including ambiguous POST protection.
          const shots = executionProject.shots;
          const scheduling = new AbortController();
          const outputs = await executeMediaGraph({ database, runId, nodeId: node.id, shotIds: shots.map(shot => shot.id), concurrency: executionProject.workflow.execution.maxConcurrentShots, signal: controller.signal,
            execute: async shotId => {
              const shot = shots.find(shot => shot.id === shotId);
              if (!shot) throw new Error('运行快照缺少并行镜头。');
              try { return await trackWork(() => executeActivity({ ...activityContext, project: { ...executionProject, shots: [shot] }, queueSignal: scheduling.signal, onFailure: error => scheduling.abort(error) })); }
              catch (error) { scheduling.abort(error); throw error; }
            } });
          const assets: AssetRecord[] = [], usages = [];
          for (const shot of shots) {
            const result = outputs[shot.id], generated = nodeResultAssets(result);
            if (generated.length !== 1 || generated[0].projectId !== executionProject.id || generated[0].shotId !== shot.id) throw new Error('并行步骤须为每个镜头返回对应的一份素材。');
            const asset = generated[0], info = await stat(asset.path).catch(() => undefined);
            if (!info?.isFile() || info.size !== asset.size) throw new Error('已完成的生成素材缺失或损坏，请显式重新生成此镜头；恢复不会重新提交模型请求。');
            const hash = createHash('sha256');
            for await (const chunk of createReadStream(asset.path)) hash.update(chunk);
            if (hash.digest('hex') !== asset.sha256) throw new Error('已完成的生成素材缺失或损坏，请显式重新生成此镜头；恢复不会重新提交模型请求。');
            assets.push(asset);
            const usage = providerUsageSchema.safeParse(result && typeof result === 'object' && !Array.isArray(result) ? result.providerUsage : undefined);
            usages.push(usage.success ? usage.data : undefined);
          }
          const usage = sumProviderUsage(usages);
          output = { assets: assets as unknown as JsonValue, source: 'model', modelId: selectedModel.id, ...(usage ? { providerUsage: usage as unknown as JsonValue } : {}) };
        } else output = await executeActivity(activityContext);
        const usage = providerUsageSchema.safeParse(output && typeof output === 'object' && !Array.isArray(output) ? output.providerUsage : undefined);
        if (costOperation) costs.status(costOperation, 'completed', usage.success ? usage.data : undefined);
        runProgress.phase(context.operationId, 'saving');
        return output;
      }
      return localNodeResult(node, executionProject, store.list<AssetRecord>('asset'));
    }, output => {
      if (saved.assistant) {
        if (!output || typeof output !== 'object' || Array.isArray(output) || typeof output.text !== 'string') throw new Error('任务修改建议未返回文本。');
        let proposalResult: JsonValue;
        try { proposalResult = { ...output, proposal: parseWorkflowAssistantResult(output.text, saved.assistant) } as unknown as JsonValue; }
        catch (error) { proposalResult = { ...output, proposalError: error instanceof Error ? error.message : String(error) }; }
        store.put('node-result', `${runId}:${node.id}`, proposalResult);
        return;
      }
      if (saved.regeneration) {
        const baseline = saved.regeneration.baseline;
        if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('镜头重新生成没有返回有效候选。');
        const assets = Array.isArray(output.assets) ? output.assets.map(asset => assetSchema.parse(asset)) : [];
        let shot = baseline;
        if (saved.regeneration.kind === 'script') {
          const shots = z.array(shotSchema).length(1).parse(output.shots);
          if (shots[0].id !== baseline.id || assets.length) throw new Error('脚本重新生成必须只返回当前镜头。');
          shot = shots[0];
        } else {
          const [asset] = assets;
          if (assets.length !== 1 || !asset || asset.projectId !== saved.project.id || asset.shotId !== baseline.id || asset.kind !== saved.regeneration.kind) throw new Error('重新生成素材必须仅属于当前镜头。');
          if (asset.kind === 'image') shot = { ...baseline, assetId: asset.id };
          if (asset.kind === 'video') shot = { ...baseline, videoAssetId: asset.id, videoInUs: 0,
            ...(isVideoGenerationNode(node) ? { audioAssetId: undefined, audioInUs: undefined, captionTrack: undefined,
              audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, version: 2, videoAudio: { enabled: true, gainDb: 0 } } } : {}) };
          store.put('asset', asset.id, asset);
        }
        const candidate = shotCandidateSchema.parse({
          id: `candidate-${createHash('sha256').update(`${runId}:${node.id}`).digest('hex').slice(0, 32)}`,
          projectId: saved.project.id, shotId: baseline.id, kind: saved.regeneration.kind, runId, nodeId: node.id, createdAt: now(),
          baseline, shot, assetIds: assets.map(asset => asset.id), modelId: selectedModel?.id, instruction: saved.regeneration.instruction, characters: executionCharacters,
        });
        store.put('shot-candidate', candidate.id, candidate);
        store.put('node-result', `${runId}:${node.id}`, { ...output, candidateId: candidate.id });
        return;
      }
      const assets = nodeResultAssets(output);
      const working = projectAfterNode(node.kind === 'agent' ? store.get<ProjectDocument>('run-project', runId) ?? executionProject : executionProject, node, output, assets);
      for (const asset of assets) {
        if (store.get<AssetRecord>('asset', asset.id)) requireCandidateAssets([asset]);
        else store.put('asset', asset.id, asset);
      }
      store.put('run-project', runId, working);
      store.put('node-result', `${runId}:${node.id}`, output);
    });
    for (const asset of nodeResultAssets(result)) {
      runProgress.asset(`${runId}:${node.id}`, asset);
      if (asset.shotId) runProgress.media(`${runId}:${node.id}`, { event: 'media.completed', level: 'info', shotId: asset.shotId, assetId: asset.id });
    }
    runProgress.end(`${runId}:${node.id}`, 'completed');
    return result;
    } catch (error) {
      if (!(error instanceof SimulatedProcessExit)) runProgress.end(`${runId}:${node.id}`, controller.signal.aborted ? 'canceled' : 'interrupted');
      if (costOperation && !(error instanceof SimulatedProcessExit)) costs.status(costOperation, controller.signal.aborted ? 'canceled' : error instanceof TextRequestRejectedError || error instanceof MediaRequestRejectedError ? 'failed' : 'unknown');
      throw error;
    }
  }

  async function executeSubflow(runId: string, node: WorkflowNode, saved: RunSnapshot, controller: AbortController): Promise<JsonValue> {
    const reference = node.subflow;
    const definition = reference && saved.project.workflow.subflows?.find(item => item.id === reference.id && item.version === reference.version);
    if (!reference || !definition) throw new Error('子流程固定版本不完整，请重新插入。');
    const identity = `${runId}:${node.id}`;
    const previous = store.get<{ values: Record<string, JsonValue> }>('subflow-input', identity);
    const inputs = previous?.values ?? resolveSubflowInputs(definition, reference, id => store.get<JsonValue>('node-result', `${runId}:${id}`));
    if (!previous) {
      store.put('subflow-input', identity, { values: inputs, templateId: definition.id, version: definition.version });
      store.put('node-project', identity, store.get<ProjectDocument>('run-project', runId) ?? saved.project);
    }
    const children = definition.nodes.map(child => {
      const subflow = child.subflow ? { ...child.subflow, inputs: Object.fromEntries(Object.entries(child.subflow.inputs).map(([name, binding]) => [name, 'literal' in binding ? { literal: substituteSubflowInputs(binding.literal, inputs) } : { ...binding, nodeId: subflowNodeId(node.id, binding.nodeId) }])) } : undefined;
      const prompt = substituteSubflowInputs(child.prompt, inputs);
      const promptBindings = child.promptBindings ? Object.fromEntries(Object.entries(child.promptBindings).map(([name, binding]) => [name, 'nodeId' in binding ? { ...binding, nodeId: subflowNodeId(node.id, binding.nodeId) } : 'literal' in binding ? { literal: substituteSubflowInputs(binding.literal, inputs) } : binding])) : undefined;
      return { ...child, id: subflowNodeId(node.id, child.id), prompt: typeof prompt === 'string' ? prompt : JSON.stringify(prompt), promptBindings, config: substituteSubflowInputs(child.config, inputs) as WorkflowNode['config'], subflow };
    });
    const workflow: WorkflowDefinition = { production: saved.project.workflow.production, id: definition.id, version: definition.version, name: definition.name, nodes: children, edges: definition.edges.map(edge => ({ ...edge, source: subflowNodeId(node.id, edge.source), target: subflowNodeId(node.id, edge.target) })) };
    const graph = createExecutionGraph(database, workflow, {
      execute: child => trackWork(() => executeNode(runId, child, saved, controller)),
      advanced: child => recordEvent(runId, 'node.completed', `已完成：${child.label}`, child.id),
    });
    const config = { configurable: { thread_id: subflowThreadId(runId, node.id), checkpoint_ns: '' }, durability: 'sync' as const, signal: controller.signal, recursionLimit: 400 };
    // This invocation has its own durable thread. Do not inherit the parent
    // task's checkpoint map or scratchpad from LangChain's ambient context.
    const invokeChild = (input: Parameters<typeof graph.invoke>[0]) => AsyncLocalStorageProviderSingleton.runWithConfig(config, () => graph.invoke(input, config));
    const state = await graph.getState(config);
    const input = state.values && Object.keys(state.values).length ? state.values : { completed: [], skipped: [], currentNodeId: '', outputs: {} };
    await invokeChild(state.next.length ? null : input);
    controller.signal.throwIfAborted();
    const outputs: Record<string, JsonValue> = {};
    for (const output of definition.outputs) {
      const value = subflowValueAt(store.get<JsonValue>('node-result', `${runId}:${subflowNodeId(node.id, output.nodeId)}`), output.path);
      if (output.type !== 'json' && typeof value !== output.type) throw new Error(`子流程输出 ${output.name} 的类型须为 ${output.type}。`);
      outputs[output.name] = value;
    }
    updateRun(runId, { status: 'running', currentNodeId: node.id });
    return journal.execute(runId, node.id, { node, definition, inputs }, 'local', async () => ({ outputs, templateId: definition.id, version: definition.version }), result => store.put('node-result', identity, result));
  }

  function schedule(runId: string, resume = false) {
    if (active.has(runId)) return;
    if (closing) throw new Error('运行环境正在关闭。');
    const saved = store.get<RunSnapshot>('run-snapshot', runId);
    if (!saved || ![1, 2, 3, 4].includes(saved.handlerVersion)) throw new Error('运行版本不兼容，请复制项目并创建新的运行。');
    const { stepRetry: retry, currentNodeId } = run(runId);
    const retryNode = retry?.status === 'pending' ? (saved.inspectionNodes ?? saved.nodes).find(node => node.id === retry.nodeId) : undefined;
    if (retry?.status === 'pending' && !retryNode) throw new Error('本次制作中没有所选的重试步骤。');
    if (resume && currentNodeId === 'video-agent' && isAutonomousVideoRun(saved)) {
      const id = `${runId}:${currentNodeId}`;
      const continuation = store.get<AgentContinuation>('agent-continuation', id);
      const exhausted = continuation ? continuation.exhausted : journal.get(runId, currentNodeId)?.error === AGENT_CONTINUATION_EXHAUSTED;
      if (exhausted && !journal.list(runId).some(activity => activity.safety === 'external' && ['unknown', 'dispatched'].includes(activity.status) && !activity.remote_id)) {
        store.put('agent-continuation', id, { round: (continuation?.round ?? 1) + 1, attempts: 0 } satisfies AgentContinuation);
      }
    }
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      if (saved.inspectionNodes?.some(node => node.config.agentTask === true && node.kind === 'assets'
        && nodeResultAssets(store.get<JsonValue>('node-result', `${runId}:${node.id}`) ?? null).some(asset => asset.provenance === '用户导入'))) {
        throw new Error('本次制作含旧版工具导入的素材。请停止当前制作，在素材库核对来源后新建制作。');
      }
      updateRun(runId, { status: 'running', error: undefined, stepRetry: retryNode ? retry : undefined });
      const nodes = retryNode ? [retryNode] : saved.nodes;
      const nodeIds = new Set(nodes.map(node => node.id));
      const workflow = { ...saved.project.workflow, nodes, edges: saved.project.workflow.edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)) };
      const graph = createExecutionGraph(database, workflow, {
        execute: node => trackWork(() => executeNode(runId, node, saved, controller)),
        advanced: node => recordEvent(runId, 'node.completed', `已完成：${node.label}`, node.id),
      });
      const config = { configurable: { thread_id: retryNode ? saved.inspectionThreads?.[retryNode.id] ?? runId : runId, checkpoint_ns: '' }, durability: 'sync' as const, signal: controller.signal, recursionLimit: 400 };
      const state = await graph.getState(config);
      logger.info('run.execution_started', { runId, projectId: saved.project.id, resumed: Boolean(state.values && Object.keys(state.values).length) });
      // A single-step retry ends its graph while retaining the original thread's
      // completed nodes and outputs. A later full resume dispatches from that state.
      const input = state.values && Object.keys(state.values).length ? state.values : { completed: [], skipped: [], currentNodeId: '', outputs: {} };
      await graph.invoke(state.next.length ? null : input, config);
      const latest = run(runId);
      if (latest.status !== 'canceled') {
        if (retryNode) {
          const root = await graph.getState({ configurable: { thread_id: runId } });
          if (controller.signal.aborted || run(runId).status === 'canceled') return;
          const complete = saved.nodes.every(node => root.values.completed?.includes(node.id) || root.values.skipped?.includes(node.id));
          recordEvent(runId, 'run.step_retried', `已完成步骤重试：${retryNode.label}`, retryNode.id);
          if (!complete) {
            updateRun(runId, { status: 'needs_attention', currentNodeId: undefined, error: undefined, stepRetry: { nodeId: retryNode.id, status: 'completed' } });
            return;
          }
        }
        applyProductionResult(runId, saved);
        updateRun(runId, { status: 'succeeded', currentNodeId: undefined, stepRetry: undefined });
        recordEvent(runId, 'run.completed', '所选步骤已完成');
      }
    }).catch(error => {
      if (error instanceof SimulatedProcessExit) return;
      const latest = run(runId);
      if (latest.status === 'canceled') return;
      const message = redactError(error instanceof Error ? error.message : '运行失败', availableModels(), transientSecrets);
      const status = error instanceof AmbiguousActivityError || message.includes('请') || message.includes('先') ? 'needs_attention' : 'failed';
      updateRun(runId, { status, error: message });
      recordEvent(runId, 'run.failed', message, latest.currentNodeId, error);
    }).finally(() => { active.delete(runId); });
    active.set(runId, { promise, controller });
  }

  function projectBusy(projectId: string, exceptBatchId?: string, exceptQueueItemId?: string, exceptRunId = '') {
    if (editorExports.has(projectId)) return true;
    return Boolean(database.prepare("SELECT 1 FROM documents r LEFT JOIN documents s ON s.kind = 'run-snapshot' AND s.id = r.id WHERE r.kind = 'run' AND r.id <> ? AND json_extract(r.body, '$.projectId') = ? AND (json_extract(r.body, '$.status') IN ('queued','running','waiting_review','waiting_external','retry_scheduled') OR r.id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR coalesce(json_extract(s.body, '$.exportBatch.batchId'), '') <> ?) LIMIT 1").get(exceptRunId, projectId, JSON.stringify([...active.keys()]), exceptBatchId ?? null, exceptBatchId ?? null)) || Boolean(productionQueue?.activeForProject(projectId, exceptQueueItemId));
  }
  const batches = createExportBatchManager({
    database, store, dataDirectory: directory, onChanged: changed, projectBusy,
    currentRevision(projectId) { const row = store.get<{ revision: number }>('project-summary', projectId); if (!row) throw new Error('项目不存在。'); return row.revision; },
    capture(projectId, revision): ExportBatchSnapshot {
      const value = project(projectId); requireRevision(value, revision);
      if (value.archived) throw new Error('请先恢复项目。');
      if (!value.shots.length) throw new Error('请先添加镜头后再批量导出。');
      const ids = new Set([...value.shots.flatMap(shot => [shot.sceneTemplate ? undefined : shot.videoAssetId ?? shot.assetId, shot.audioAssetId]), ...(value.musicClips ?? []).map(clip => clip.assetId)].filter((id): id is string => Boolean(id)));
      const assets = [...ids].map(id => {
        const asset = store.get<AssetRecord>('asset', id);
        if (!asset?.active || asset.projectId && asset.projectId !== projectId) throw new Error('项目引用的素材缺失或不属于当前项目，请先重新关联。');
        return asset;
      });
      return structuredClone({ project: value, assets, characters: [], characterAssets: [] });
    },
    createRun(batch, target, frozen) {
      const id = randomUUID(), template = frozen.project.workflow.nodes.find(node => node.kind === 'export');
      const { destination: _destination, ...configuration } = template?.config ?? {};
      const node: WorkflowNode = { id: 'export', kind: 'export', label: `批量导出：${target.label}`, description: template?.description ?? '', prompt: '', config: configuration, skillIds: [], position: { x: 0, y: 0 }, requiresReview: false };
      const saved: RunSnapshot = { project: { ...structuredClone(frozen.project), profile: target.profile }, assets: frozen.assets, models: [], skills: [], mcpServers: [], nodes: [node], handlerVersion: 1, characters: frozen.characters, characterAssets: frozen.characterAssets, exportBatch: { batchId: batch.id, targetId: target.id } };
      const createdAt = now();
      const record: RunRecord = { id, projectId: batch.projectId, projectRevision: batch.projectRevision, status: 'queued', workflowVersion: saved.project.workflow.version, snapshotDigest: fingerprint(saved), createdAt, updatedAt: createdAt, events: [], activities: [] };
      database.transaction(() => { store.put('run-snapshot', id, saved); store.put('run', id, record); })();
      recordEvent(id, 'run.created', `批量导出固定快照已保存：${target.label}`);
      return id;
    },
    async executeRun(runId, signal, rebuild) {
      const saved = store.get<RunSnapshot>('run-snapshot', runId);
      if (!saved?.exportBatch || saved.nodes.length !== 1 || saved.nodes[0].kind !== 'export' || saved.nodes[0].modelId) throw new Error('批量导出只能恢复对应的本地导出运行。');
      const previous = store.get('node-result', `${runId}:export`);
      if (rebuild) recordEvent(runId, 'render.restore', '批量输出校验失败，仅恢复当前规格的本地产物。', 'export');
      if (run(runId).status === 'succeeded') {
        try { return await verifyBatchRenderResult(previous, signal); }
        catch (error) {
          signal.throwIfAborted();
          await new SqliteSaver(database).deleteThread(runId);
          database.prepare("UPDATE activities SET status = 'failed', result = NULL, error = '批量导出产物需本地重建' WHERE run_id = ? AND activity_id = 'export'").run(runId);
          store.delete('node-result', `${runId}:export`);
          recordEvent(runId, 'render.rebuild', '导出产物缺失或校验失败，仅重建当前规格的本地产物。', 'export');
        }
      }
      signal.throwIfAborted();
      updateRun(runId, { status: 'queued', error: undefined }); schedule(runId);
      const abort = () => active.get(runId)?.controller.abort(); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      try { await active.get(runId)?.promise; }
      finally { signal.removeEventListener('abort', abort); }
      signal.throwIfAborted();
      if (run(runId).status !== 'succeeded') throw new Error(run(runId).error ?? '当前规格导出未完成，请继续重试。');
      return verifyBatchRenderResult(store.get('node-result', `${runId}:export`), signal);
    },
    abortRun(runId, interrupted) {
      if (run(runId).status === 'succeeded') return;
      updateRun(runId, { status: 'canceled', error: interrupted ? '批量导出已中断，可从原快照继续。' : undefined }); active.get(runId)?.controller.abort();
      recordEvent(runId, interrupted ? 'run.interrupted' : 'run.canceled', interrupted ? '运行环境关闭，当前本地导出已中断。' : '已取消批量导出中的当前规格。');
    },
  });

  productionQueue = createProductionQueue({ database, store, project, work: works.get, changed,
    busy: (id, exceptItemId, exceptRunId) => batches.blocked(id) || projectBusy(id, undefined, exceptItemId, exceptRunId),
    createRun: async (item, queueRevision) => {
      const created = await dispatchRequest('run.start', { projectId: item.projectId, revision: item.projectRevision }, { item, queueRevision });
      return run(z.object({ id: z.string() }).parse(created).id);
    },
    resumeRun: id => { if (batches.blocked(run(id).projectId)) throw new Error('请先处理该项目的批量导出。'); updateRun(id, { status: 'queued', error: undefined }); schedule(id, true); },
    cancelRun: id => dispatch('run.cancel', { runId: id }),
    runConflict: id => Boolean(database.prepare("SELECT 1 FROM execution_events WHERE run_id = ? AND type = 'project.apply_conflict' LIMIT 1").get(id)),
  });

  function dispatch(method: string, rawParams: unknown = {}, context?: { requestId?: string | number }): Promise<unknown> {
    const requestLogger = logger.child({ ...rpcIdentifiers(rawParams), requestId: context?.requestId ?? randomUUID(), method });
    const started = performance.now();
    const read = /\.(?:get|list|summary|snapshot|inspect|payload|versions|plan|replay|status|read|references|tasks|events|activities|candidates|voices|waveform|result)$/.test(method);
    requestLogger[read ? 'debug' : 'info']('rpc.started');
    return trackWork(async () => {
      try {
        const result = await dispatchRequest(method, rawParams);
        const idField = { 'project.create': 'projectId', 'project.importBackup': 'projectId', 'run.start': 'runId', 'run.resume': 'runId', 'run.cancel': 'runId', 'model.save': 'modelId' }[method];
        const created = idField && result && typeof result === 'object' && 'id' in result && typeof result.id === 'string' ? { [idField]: result.id } : {};
        const fields = { ...rpcIdentifiers(result), ...created, durationMs: Math.round(performance.now() - started) };
        // Polling and read models belong to debug; successful user changes
        // remain visible at the default info level without their payloads.
        if (read) requestLogger.debug('rpc.completed', fields);
        else requestLogger.info('rpc.completed', fields);
        return result;
      } catch (error) {
        requestLogger.error('rpc.failed', { durationMs: Math.round(performance.now() - started), error: logError(error) });
        throw error;
      }
    });
  }
  async function dispatchRequest(method: string, rawParams: unknown, queueClaim?: { item: ProductionQueueItem; queueRevision: number }): Promise<unknown> {
    if (closing) throw new Error('运行环境正在关闭。');
    if (method.startsWith('audio.mix.') || method === 'audio.silence') return audioPreview.dispatch(method, rawParams);
    if (method.startsWith('skill.import.') || method.startsWith('skill.group.') || method === 'skill.resource.read' || method === 'skill.uninstall') return skillLibrary.dispatch(method, rawParams);
    switch (method) {
      case 'asset.recovery.start':
      case 'asset.recovery.get':
      case 'asset.recovery.scan':
      case 'asset.recovery.confirm':
      case 'asset.recovery.cancel': return assetRecovery.dispatch(method, rawParams);
      case 'workspace.snapshot': return snapshot();
      case 'workspace.summary': return { projects: reads.projects(), models: availableModels(), skills: store.list<SkillPackage>('skill'), skillGroups: skillLibrary.groups(), skillImports: skillLibrary.jobs(), system, version: workspaceVersion, assetsVersion: reads.assetsVersion() };
      case 'project.get': {
        const input = entityId.extend({ revision: z.number().int().positive().optional(), assetsVersion: z.number().int().nonnegative().optional() }).parse(rawParams);
        return reads.projectDetail(input.projectId, input.revision, input.assetsVersion);
      }
      case 'run.list': {
        const instant = z.string().datetime().regex(/T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/, '请使用 UTC 秒或最多三位毫秒精度时间。');
        const input = pageInputSchema.extend({ projectId: z.string().optional(), purpose: z.enum(['production', 'prompt-trial', 'workflow-assistant']).optional(), promptSessionId: z.string().optional(), status: runStatusSchema.optional(), createdAfter: instant.optional(), createdBefore: instant.optional() })
          .refine(value => !value.createdAfter || !value.createdBefore || Date.parse(value.createdAfter) < Date.parse(value.createdBefore), { path: ['createdBefore'], message: '结束时间必须晚于开始时间。' }).parse(rawParams);
        return reads.runs(input.before, input.limit, input.projectId, input);
      }
      case 'run.events':
      case 'run.activities': {
        const input = pageInputSchema.extend({ runId: z.string().min(1), nodeId: z.string().min(1).optional() }).parse(rawParams);
        const value = run(input.runId);
        return method === 'run.events' ? reads.events(value, input.before, input.limit, input.nodeId) : reads.activities(value.id, input.before, input.limit, input.nodeId);
      }
      case 'run.inspect':
      case 'run.step.payload':
      case 'run.step.versions':
      case 'run.diagnostics': return runInspector.dispatch(method, rawParams);
      case 'asset.list': {
        const input = assetListInput.parse(rawParams);
        const result = reads.assets(input.before, input.limit, input.kind);
        const uncheckedIds = result.items.filter(asset => !asset.inUse).map(asset => asset.id);
        if (uncheckedIds.length === 0) return result;
        const characterReferences = characters.assetsInUse(uncheckedIds);
        const imageReferences = imageTools.assetsInUse(uncheckedIds);
        return { ...result, items: result.items.map(asset => !asset.inUse && (characterReferences.has(asset.id) || imageReferences.has(asset.id))
          ? { ...asset, inUse: true } : asset) };
      }
      case 'work.list': case 'work.get': case 'work.save': case 'work.archive': case 'work.restore': case 'work.episodes.create': case 'work.episode.attach': case 'work.episode.detach': case 'work.defaults.apply': return works.dispatch(method, rawParams);
      case 'productionQueue.list': case 'productionQueue.get': case 'productionQueue.enqueue': case 'productionQueue.start': case 'productionQueue.pause': case 'productionQueue.cancel': case 'productionQueue.refreshItem': case 'productionQueue.skipItem': case 'productionQueue.resumeItem': case 'productionQueue.stopCurrent': return productionQueue!.dispatch(method, rawParams);
      case 'project.create': {
        const input = z.object({ title: z.string().min(1).max(160), brief: z.string().max(30000).default(''), profile: videoProfileSchema.optional(), skillIds: z.array(z.string().min(1)).max(500).default([]), templateId: z.string().optional(), seriesTemplateId: z.string().min(1).optional(), seriesTemplateRevision: z.number().int().positive().optional() }).refine(value => Boolean(value.seriesTemplateId) === (value.seriesTemplateRevision !== undefined), '请选择系列模板及其当前修订。').parse(rawParams);
        const settings = input.seriesTemplateId ? seriesTemplates.settingsFor(input.seriesTemplateId, input.seriesTemplateRevision) : undefined;
        const skills = skillLibrary.resolveSkills(input.skillIds), workflow = createNativeVideoWorkflow();
        const timestamp = now();
        const value = projectSchema.parse({ id: randomUUID(), title: input.title, brief: input.brief, templateId: input.templateId ?? 'generic', revision: 1, profile: input.profile ?? DEFAULT_VIDEO_PROFILE, ...(input.templateId === 'history-handdrawn' ? {} : { style: '' }), ...(settings ?? {}), shots: [], claims: [], workflow: { ...workflow, nodes: workflow.nodes.map(node => ['brief', 'style', 'script', 'agent'].includes(node.kind) ? { ...node, skillIds: skills.map(skill => skill.id) } : node) }, createdAt: timestamp, updatedAt: timestamp, archived: false });
        store.put('project', value.id, value); changed(); return value;
      }
      case 'project.update': {
        const input = projectUpdateInput.parse(rawParams);
        const value = project(input.projectId); requireRevision(value, input.revision);
        if (input.patch.workflow) validateCompositionUpdate(input.patch.workflow, value.workflow);
        for (const clip of input.patch.musicClips ?? []) {
          const asset = store.get<AssetRecord>('asset', clip.assetId);
          if (!asset?.active || asset.kind !== 'audio' || asset.projectId && asset.projectId !== value.id) throw new Error('背景音乐需要当前项目或公共素材库中的有效音频。');
        }
        return saveProject({ ...value, ...input.patch, workflow: input.patch.workflow ?? value.workflow }, value);
      }
      case 'project.archive':
      case 'project.restore': {
        const input = entityId.parse(rawParams); const value = project(input.projectId);
        if (productionQueue?.activeForProject(value.id) || store.list<RunRecord>('run').some(record => record.projectId === value.id && active.has(record.id))) throw new Error('请先停止项目任务并处理生产队列中的排队项。');
        return saveProject({ ...value, archived: method === 'project.archive' });
      }
      case 'render.export': {
        const input = entityId.extend({ profile: videoProfileSchema.optional(), destination: z.string().optional() }).parse(rawParams);
        const result = await dispatch('run.start', { projectId: input.projectId, nodeId: 'export', profile: input.profile, destination: input.destination }) as RunRecord;
        return { runId: result.id };
      }
      case 'run.plan': {
        const input = entityId.extend({ selection: runSelectionSchema }).parse(rawParams);
        return (await prepareRunSelection(project(input.projectId), input.selection)).plan;
      }
      case 'project.readiness': {
        const input = entityId.extend({ selection: runSelectionSchema.optional(), requestId: z.string().uuid().optional() }).parse(rawParams);
        return readiness.check(input.projectId, input.selection, input.requestId);
      }
      case 'project.readiness.cancel': {
        const input = entityId.extend({ requestId: z.string().uuid() }).parse(rawParams);
        return readiness.cancel(input.projectId, input.requestId);
      }
      case 'run.start': {
        const queueItem = queueClaim?.item;
        const input = entityId.extend({ nodeId: z.string().optional(), parentRunId: z.string().optional(), profile: videoProfileSchema.optional(), destination: z.string().optional(), revision: z.number().int().optional(), regeneration: regenerationInput.optional(), research: researchInput.optional(), selection: runSelectionSchema.extend({ previewDigest: z.string().regex(/^[a-f0-9]{64}$/) }).optional() }).strict().parse(rawParams);
        if (input.selection && [input.nodeId, input.profile, input.destination, input.regeneration, input.research].some(value => value !== undefined)) throw new Error('执行范围不能同时指定其他制作任务。');
        let inheritedScope = false;
        let inheritedNode: WorkflowNode | undefined, inheritedExport: WorkflowNode | undefined;
        if (input.parentRunId) {
          const parent = run(input.parentRunId);
          if (parent.productionQueueItemId) throw new Error('请通过生产队列处理原运行或将分集重新入队。');
          if (parent.purpose && parent.purpose !== 'production') throw new Error('请在提示词实验中创建新试运行，实验不能接续正式制作。');
          if (parent.projectId !== input.projectId) throw new Error('父运行不属于当前项目。');
          // Read only the scope, without decoding the parent's full project or asset snapshot.
          const row = database.prepare("SELECT json_object('exportBatch', json_extract(body, '$.exportBatch'), 'regeneration', json_extract(body, '$.regeneration'), 'research', json_extract(body, '$.research'), 'nodes', json_extract(body, '$.nodes'), 'selection', json_extract(body, '$.selection'), 'profile', json_extract(body, '$.project.profile'), 'workflowNodeCount', json_array_length(body, '$.project.workflow.nodes'), 'autonomousVideo', json_extract(body, '$.autonomousVideo')) AS body FROM documents WHERE kind = 'run-snapshot' AND id = ?").get(parent.id) as { body: string } | undefined;
          if (!row) throw new Error('父运行快照不存在，无法确认重新制作范围。');
          const saved = JSON.parse(row.body) as Pick<RunSnapshot, 'exportBatch' | 'regeneration' | 'research' | 'nodes' | 'selection'> & { profile: ProjectDocument['profile']; workflowNodeCount: number | null; autonomousVideo: number | null };
          if (parent.regenerationSource && saved.regeneration) {
            if (parent.status !== 'canceled') throw new Error('请先停止原镜头候选，再重新生成。');
            if ([input.nodeId, input.profile, input.destination, input.regeneration, input.research, input.selection].some(value => value !== undefined)) throw new Error('重新生成必须保留原镜头与制作来源。');
            return dispatch('shot.regenerate', { projectId: parent.projectId, revision: input.revision ?? project(parent.projectId).revision, shotId: parent.regenerationSource.shotId, kind: saved.regeneration.kind, instruction: saved.regeneration.instruction, source: { runId: parent.regenerationSource.runId, nodeId: parent.regenerationSource.nodeId, requestId: randomUUID() } });
          }
          const originalNodeCount = saved.workflowNodeCount ?? 0;
          if (saved.selection && (!input.selection || saved.selection.nodeId !== input.selection.nodeId || saved.selection.mode !== input.selection.mode)) throw new Error('请先预览原任务的执行范围，再重新制作。');
          const single = !saved.selection && !saved.exportBatch && !saved.regeneration && !saved.research && saved.nodes.length === 1 && !(saved.autonomousVideo ?? saved.nodes[0].config.videoAgent) ? saved.nodes[0] : undefined;
          if (single && originalNodeCount < 1) throw new Error('原任务的流程范围不完整，请在项目中确认后重新执行。');
          if ((saved.exportBatch || saved.regeneration || saved.research) && [input.nodeId, input.profile, input.destination, input.regeneration, input.research, input.selection].some(value => value !== undefined)) throw new Error('特殊任务重新制作必须保留原任务范围，请从对应编辑器创建其他任务。');
          if (saved.exportBatch) { await batches.dispatch('render.batch.resume', { batchId: saved.exportBatch.batchId }); return hydrateRun(run(parent.id)); }
          if (saved.regeneration) {
            const modelId = saved.nodes.find(node => node.id === 'regenerate')?.modelId;
            if (!modelId) throw new Error('原镜头生成模型缺失，请从镜头编辑器选择模型后重新生成。');
            input.regeneration = { shotId: saved.regeneration.shotId, kind: saved.regeneration.kind, instruction: saved.regeneration.instruction, imageEdit: saved.regeneration.imageEdit, modelId };
            inheritedScope = true;
          } else if (saved.research) {
            const modelId = saved.nodes.find(node => node.kind === 'research')?.modelId;
            if (!modelId) throw new Error('原资料整理模型缺失，请在资料审阅中重新选择模型。');
            input.research = { ...saved.research, modelId }; inheritedScope = true;
          } else if (single?.kind === 'export') {
            if ([input.nodeId, input.profile, input.destination, input.regeneration, input.research, input.selection].some(value => value !== undefined)) throw new Error('导出任务重新制作必须保留原规格和路径，请从导出面板创建其他任务。');
            input.profile = videoProfileSchema.parse(saved.profile); inheritedExport = single; inheritedScope = true;
          } else if (single && originalNodeCount > 1) {
            if (input.selection) {
              if (input.selection.nodeId !== single.id || input.selection.mode !== 'node') throw new Error('请保留原单步骤范围，或在项目中创建新的执行任务。');
            } else {
              if ([input.nodeId, input.profile, input.destination, input.regeneration, input.research].some(value => value !== undefined)) throw new Error('请保留原单步骤范围，或在项目中创建新的执行任务。');
              input.nodeId = single.id; inheritedNode = single; inheritedScope = true;
            }
          }
        }
        const original = project(input.projectId);
        if (inheritedNode && !original.workflow.nodes.some(node => node.id === inheritedNode.id && node.kind === inheritedNode.kind)) throw new Error('原单步骤已删除或变更类型，请在项目中确认后重新执行。');
        validateResearchProject(original, original);
        if (inheritedScope && input.revision === undefined) input.revision = original.revision;
        if (input.regeneration && (input.revision === undefined)) throw new Error('镜头重新生成需要当前修订，且不能同时识别字幕。');
        if (input.research && (input.regeneration || input.revision === undefined)) throw new Error('资料整理需要当前修订，且不能同时启动其他特殊任务。');
        requireRevision(original, input.revision);
        const value = input.profile ? { ...original, profile: input.profile } : original;
        if (value.archived) throw new Error('请先恢复项目。');
        if (batches.blocked(value.id) || projectBusy(value.id, undefined, queueItem?.id)) throw new Error('该项目已有未完成的运行、批量导出或排队项，请先处理现有任务。');
        const prepared = input.selection ? await prepareRunSelection(value, { nodeId: input.selection.nodeId, mode: input.selection.mode }) : undefined;
        if (prepared && input.selection) {
          if (prepared.plan.digest !== input.selection.previewDigest) throw new Error('项目或执行配置已变化，请重新预览执行范围后确认。');
          if (prepared.plan.blockedReason) throw new Error(prepared.plan.blockedReason);
        }
        const models = prepared?.saved.models ?? availableModels(), mcpServers = prepared?.saved.mcpServers ?? store.list<McpServer>('mcp-server');
        const agent = !input.nodeId && !prepared && !input.regeneration && !input.research && !inheritedExport ? videoEditingAgent(value, models, mcpServers) : undefined;
        let nodes = inheritedExport ? [inheritedExport] : prepared?.saved.nodes ?? (input.nodeId ? value.workflow.nodes.filter(node => node.id === input.nodeId) : selectedWorkflowNodes(value)).map(node => node.id === agent?.id ? agent : input.destination && node.kind === 'export' ? { ...node, config: { ...node.config, destination: input.destination } } : node);

        if (input.regeneration) nodes = [regenerationNode(value, input.regeneration)];
        if (input.research) {
          const model = store.get<ModelProfile>('model', input.research.modelId);
          if (!model?.enabled || !model.capabilities.includes('text') || !['openai-compatible', 'ollama', 'custom-http'].includes(model.provider)) throw new Error('请选择可用的文本模型整理实际资料。');
          const template = value.workflow.nodes.find(node => node.kind === 'research');
          nodes = [{ id: 'research', kind: 'research', label: '资料证据候选', description: template?.description ?? '', prompt: [template?.prompt, input.research.instruction].filter(Boolean).join('\n\n'), skillIds: template?.skillIds ?? [], modelId: model.id, config: { ...template?.config, operation: 'research', ...(input.research.sourceIds ? { sourceIds: input.research.sourceIds } : {}) }, position: { x: 0, y: 0 }, requiresReview: false }];
          selectResearchPassages(value, input.research.sourceIds, input.research.instruction);
        }
        if (!nodes.length) throw new Error('未找到所选步骤。');
        if (nodes.some(node => node.kind === 'subflow' && Object.values(node.subflow?.inputs ?? {}).some(binding => 'nodeId' in binding && !nodes.some(source => source.id === binding.nodeId)))) throw new Error('子流程输入引用了范围外的上游产物，请包含上游步骤或改用明确输入值。');
        const id = randomUUID();
        const baseline = input.regeneration ? value.shots.find(shot => shot.id === input.regeneration?.shotId) : undefined;
        const scope = input.research ? [] : baseline ? [baseline] : value.shots;
        const bundle = prepared ? { characters: prepared.saved.characters, assets: prepared.saved.characterAssets } : characters.profilesFor({ shots: scope, ...(input.regeneration ? { creativeContext: value.creativeContext ? { ...value.creativeContext, characterIds: [] } : undefined } : !input.research ? { creativeContext: value.creativeContext } : {}) });
        const nodeSelection: RunSelection | undefined = input.nodeId && !input.profile && !input.destination && !input.regeneration && !input.research && nodes[0].kind !== 'export' ? { nodeId: input.nodeId, mode: 'node' } : undefined;
        const saved: RunSnapshot = prepared?.saved ?? { project: structuredClone(value), ...(value.workflow.production.referenceAudioAssetIds?.length || input.regeneration?.imageEdit ? { assets: store.list<AssetRecord>('asset').filter(asset => input.regeneration?.imageEdit ? [input.regeneration.imageEdit.sourceAssetId, input.regeneration.imageEdit.maskAssetId].includes(asset.id) : !asset.projectId || asset.projectId === value.id) } : {}), models, ...await skillLibrary.prepareForNodes(workflowNodesWithSubflows({ ...value.workflow, nodes })), mcpServers, nodes, autonomousVideo: false, ...(agent ? { videoEditingAgentId: agent.id } : {}), handlerVersion: 1, characters: bundle.characters, characterAssets: bundle.assets, selection: nodeSelection, ...(input.research ? { research: { sourceIds: input.research.sourceIds, instruction: input.research.instruction } } : {}), ...(input.regeneration && baseline ? { regeneration: { shotId: baseline.id, baseline: structuredClone(baseline), kind: input.regeneration.kind, instruction: input.regeneration.instruction?.trim(), ...(input.regeneration.imageEdit ? { imageEdit: input.regeneration.imageEdit } : {}) } } : {}) };
        if (input.regeneration?.imageEdit) {
          await resolveImageEdit({ project: saved.project, node: saved.nodes[0], assets: saved.assets ?? [], model: saved.models.find(model => model.id === saved.nodes[0].modelId) });
          requireRevision(project(value.id), value.revision);
          if (batches.blocked(value.id) || projectBusy(value.id, undefined, queueItem?.id)) throw new Error('该项目已有未完成的运行，请先处理现有任务。');
        }
        requireRevision(project(value.id), value.revision);
        if (batches.blocked(value.id) || projectBusy(value.id, undefined, queueItem?.id)) throw new Error('该项目已有未完成的运行，请先处理现有任务。');
        if (saved.project.workflow.execution) saved.handlerVersion = 3;
        if (saved.nodes.some(node => node.kind === 'subflow')) {
          validateWorkflowComposition(saved.project.workflow);
          saved.handlerVersion = 3;
          saved.inspectionNodes = workflowNodesWithSubflows({ ...saved.project.workflow, nodes: saved.nodes });
          const selectedIds = new Set(saved.nodes.map(node => node.id));
          saved.inspectionEdges = workflowEdgesWithSubflows({ ...saved.project.workflow, nodes: saved.nodes, edges: saved.project.workflow.edges.filter(edge => selectedIds.has(edge.source) && selectedIds.has(edge.target)) });
          saved.inspectionThreads = Object.fromEntries(saved.inspectionNodes.map(node => { const split = node.id.lastIndexOf('/subflow/'); return [node.id, saved.nodes.some(outer => outer.id === node.id) ? id : subflowThreadId(id, node.id.slice(0, split))]; }));
        }
        if (saved.project.workflow.production) for (const node of saved.inspectionNodes ?? saved.nodes) validateExecutionModel(node, saved.models.find(model => model.id === node.modelId));
        const timestamp = now();
        const record: RunRecord = { id, projectId: value.id, projectRevision: value.revision, status: 'queued', workflowVersion: value.workflow.version, snapshotDigest: fingerprint(saved), parentRunId: input.parentRunId, selection: saved.selection, stepCount: saved.inspectionNodes?.length ?? nodes.length, createdAt: timestamp, updatedAt: timestamp, events: [], activities: [], ...(queueItem ? { productionQueueId: queueItem.queueId, productionQueueItemId: queueItem.id } : {}) };
        database.transaction(() => { if (queueClaim) productionQueue!.claim(queueClaim.item, queueClaim.queueRevision, id); store.put('run-snapshot', id, saved); store.put('run', id, record); })();
        recordEvent(id, 'run.created', '运行快照已保存'); schedule(id); return hydrateRun(record);
      }

      case 'render.editor.export': {
        const { editorExportInputSchema, exportEditorProject } = await import('./editor-export.js');
        const input = editorExportInputSchema.parse(rawParams), value = project(input.projectId); requireRevision(value, input.revision);
        if (closing || value.archived || batches.blocked(value.id) || projectBusy(value.id)) throw new Error('请先恢复项目或处理未完成的制作与队列任务。');
        const controller = new AbortController(); editorExports.set(value.id, controller); changed();
        try {
          return await exportEditorProject({ ...input, project: structuredClone(value), assets: structuredClone(store.list<AssetRecord>('asset').filter(asset => !asset.projectId || asset.projectId === value.id)), dataDirectory: directory, ffmpegPath: options.ffmpegPath, signal: controller.signal });
        } finally { editorExports.delete(value.id); changed(); }
      }
      case 'workflowAssistant.latest': {
        const input = entityId.extend({ nodeId: z.string().min(1) }).strict().parse(rawParams); project(input.projectId);
        const row = database.prepare("SELECT s.id FROM documents s JOIN documents r ON r.kind = 'run' AND r.id = s.id WHERE s.kind = 'run-snapshot' AND json_extract(s.body, '$.assistant.projectId') = ? AND json_extract(s.body, '$.assistant.baseline.id') = ? ORDER BY r.rowid DESC LIMIT 1").get(input.projectId, input.nodeId) as { id: string } | undefined;
        if (!row) return null;
        const saved = store.get<RunSnapshot>('run-snapshot', row.id)!;
        return { run: reads.runSummary(run(row.id)), nodeId: saved.nodes[0].id, context: saved.assistant, modelId: saved.nodes[0].modelId };
      }
      case 'workflowAssistant.start': {
        const input = entityId.extend({ revision: z.number().int().positive(), node: workflowNodeSchema, modelId: z.string().min(1), instruction: z.string().trim().min(1).max(10000), requestId: z.string().uuid() }).strict().parse(rawParams);
        const requestKey = fingerprint({ projectId: input.projectId, requestId: input.requestId }), inputHash = fingerprint(input);
        const existing = store.get<{ inputHash: string; runId: string; nodeId: string }>('workflow-assistant-request', requestKey);
        if (existing) {
          if (existing.inputHash !== inputHash) throw new Error('建议请求标识已用于其他输入，请新建建议任务。');
          return { run: reads.runSummary(run(existing.runId)), nodeId: existing.nodeId };
        }
        const value = project(input.projectId); requireRevision(value, input.revision);
        if (value.archived || batches.blocked(value.id) || projectBusy(value.id)) throw new Error('请先恢复项目或处理当前未完成的运行。');
        const models = availableModels(), model = models.find(model => model.id === input.modelId);
        if (!model) throw new Error('建议生成模型不存在。');
        const id = randomUUID(), timestamp = now();
        const prepared = prepareWorkflowAssistant({ project: value, baseline: input.node, instruction: input.instruction, model, models, nodeId: 'workflow-assistant' });
        const saved: RunSnapshot = { project: structuredClone(value), models: [model], skills: [], mcpServers: [], nodes: [prepared.node], handlerVersion: 1, assistant: prepared.context };
        const record: RunRecord = { id, projectId: value.id, projectRevision: value.revision, workflowVersion: value.workflow.version, snapshotDigest: fingerprint(saved), purpose: 'workflow-assistant', stepCount: 1, status: 'queued', createdAt: timestamp, updatedAt: timestamp, events: [], activities: [] };
        database.transaction(() => { store.put('run-snapshot', id, saved); store.put('run', id, record); store.put('workflow-assistant-request', requestKey, { inputHash, runId: id, nodeId: prepared.node.id }); })();
        recordEvent(id, 'run.created', '任务修改建议快照已保存，结果等待手动应用。'); schedule(id);
        return { run: reads.runSummary(record), nodeId: prepared.node.id };
      }
      case 'research.source.read': return readResearchSource(rawParams);
      case 'shot.regenerate': {
        const input = entityId.merge(regenerationInput).extend({ revision: z.number().int().positive(), source: z.object({ runId: z.string().min(1), nodeId: z.string().min(1), requestId: z.string().uuid() }).optional() }).parse(rawParams);
        if (input.source) {
          if (input.kind === 'script' || input.imageEdit) throw new Error('制作记录只支持重新生成所选镜头的图片或视频。');
          const source = input.source, requestHash = fingerprint({ projectId: input.projectId, shotId: input.shotId, kind: input.kind, instruction: input.instruction?.trim() ?? '', runId: source.runId, nodeId: source.nodeId });
          const repeated = () => {
            const row = database.prepare("SELECT body FROM documents WHERE kind = 'run' AND json_extract(body, '$.regenerationSource.requestId') = ? LIMIT 1").get(source.requestId) as { body: string } | undefined;
            if (!row) return undefined;
            const previous = runSchema.parse(JSON.parse(row.body)), snapshot = store.get<RunSnapshot>('run-snapshot', previous.id);
            if (snapshot?.sourceGeneration?.requestHash !== requestHash) throw new Error('生成请求标识已用于其他镜头或输入。');
            return previous;
          };
          const previous = repeated(); if (previous) return hydrateRun(previous);
          const value = project(input.projectId); requireRevision(value, input.revision);
          const baseline = value.shots.find(shot => shot.id === input.shotId);
          if (value.archived || !baseline || baseline.locked) throw new Error('请选择存在且已解锁的项目镜头。');
          const original = run(source.runId), frozen = store.get<RunSnapshot>('run-snapshot', original.id);
          if (original.projectId !== value.id || original.purpose && original.purpose !== 'production' || !frozen) throw new Error('原制作不属于当前项目或没有冻结配置。');
          const originalNode = store.get<WorkflowNode>('node-definition', `${original.id}:${source.nodeId}`) ?? (frozen.inspectionNodes ?? frozen.nodes).find(node => node.id === source.nodeId);
          const result = store.get<JsonValue>('node-result', `${original.id}:${source.nodeId}`), sourceProject = store.get<ProjectDocument>('node-project', `${original.id}:${source.nodeId}`);
          const sourceShot = sourceProject?.shots.find(shot => shot.id === input.shotId);
          if (!originalNode || originalNode.kind !== regenerationKinds[input.kind].nodeKind || journal.get(original.id, source.nodeId)?.status !== 'completed' || !sourceProject || !sourceShot || !result || !nodeResultAssets(result).some(asset => asset.shotId === input.shotId && asset.kind === input.kind)) throw new Error('原步骤没有这个镜头对应的已完成生成产物。');
          const model = frozen.models.find(model => model.id === originalNode.modelId);
          if (!model?.enabled || !model.capabilities.includes(regenerationKinds[input.kind].capability)) throw new Error('本次制作未保存可用的对应生成模型。');
          const pending = database.prepare("SELECT body FROM documents WHERE kind = 'run' AND json_extract(body, '$.projectId') = ? AND json_extract(body, '$.regenerationSource.runId') = ? AND json_extract(body, '$.regenerationSource.nodeId') = ? AND json_extract(body, '$.regenerationSource.shotId') = ? AND json_extract(body, '$.status') NOT IN ('succeeded','canceled') ORDER BY rowid DESC LIMIT 1").get(value.id, source.runId, source.nodeId, input.shotId) as { body: string } | undefined;
          if (pending) return hydrateRun(runSchema.parse(JSON.parse(pending.body)));
          const inputProject = { ...sourceProject, shots: [{ ...sourceShot, locked: false }] };
          const upstream = upstreamResults(original.id, originalNode, frozen);
          const selectedCharacters = (frozen.characters ?? []).filter(profile => sourceShot.characterIds?.includes(profile.id));
          const referenceIds = new Set([...selectedCharacters.flatMap(profile => profile.referenceAssetIds), ...creativeReferenceAssetIds(inputProject, sourceShot)]);
          const characterAssets = (frozen.characterAssets ?? []).filter(asset => referenceIds.has(asset.id));
          const ids = new Set([...inputProject.shots.flatMap(shot => [shot.assetId, shot.videoAssetId, shot.audioAssetId]), ...(inputProject.workflow.production.referenceAudioAssetIds ?? []), ...referenceIds].filter((id): id is string => Boolean(id)));
          const knownAssets = new Map([...(frozen.assets ?? []), ...(frozen.characterAssets ?? []), ...upstream.flatMap(item => nodeResultAssets(item.output))].map(asset => [asset.id, asset]));
          const assets = [...ids].map(id => knownAssets.get(id) ?? store.get<AssetRecord>('asset', id));
          if (assets.some(asset => !asset)) throw new Error('本次制作的参考素材记录缺失，请先恢复素材。');
          const frozenAssets = assets.filter((asset): asset is AssetRecord => Boolean(asset));
          await validatePromptAssets(frozenAssets);
          requireRevision(project(value.id), input.revision);
          const existing = repeated(); if (existing) return hydrateRun(existing);
          if (batches.blocked(value.id) || projectBusy(value.id) || [...active.keys()].some(runId => run(runId).projectId === value.id)) throw new Error('该项目已有未完成的制作，请先处理现有任务。');
          const id = randomUUID(), instruction = input.instruction?.trim();
          const node: WorkflowNode = { ...originalNode, id: 'regenerate', requiresReview: false, label: `重新生成镜头${regenerationKinds[input.kind].label}`, prompt: [originalNode.prompt, instruction].filter(Boolean).join('\n\n'), config: { ...originalNode.config, shotId: baseline.id, regenerationKind: input.kind, ...(instruction ? { instruction } : {}) } };
          const saved: RunSnapshot = { project: structuredClone(value), models: frozen.models, skills: frozen.skills, mcpServers: frozen.mcpServers, nodes: [node], handlerVersion: 4, characters: selectedCharacters, characterAssets, assets: frozenAssets,
            regeneration: { shotId: baseline.id, kind: input.kind, baseline: structuredClone(baseline), instruction }, sourceGeneration: { inputProject: structuredClone(inputProject), upstream: structuredClone(upstream), requestHash } };
          const createdAt = now();
          const record: RunRecord = { id, projectId: value.id, projectRevision: value.revision, workflowVersion: frozen.project.workflow.version, snapshotDigest: fingerprint(saved), parentRunId: original.id, status: 'queued', stepCount: 1, createdAt, updatedAt: createdAt, events: [], activities: [], regenerationSource: { ...source, shotId: baseline.id } };
          database.transaction(() => { store.put('run-snapshot', id, saved); store.put('run', id, record); })();
          recordEvent(id, 'run.created', `沿用本次制作，单独重新生成：${sourceShot.title}`, node.id); schedule(id); return hydrateRun(record);
        }
        return dispatch('run.start', { projectId: input.projectId, revision: input.revision, regeneration: { shotId: input.shotId, kind: input.kind, modelId: input.modelId, instruction: input.instruction, imageEdit: input.imageEdit } });
      }
      case 'shot.candidates': {
        const input = entityId.extend({ shotId: z.string().min(1), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20), source: z.object({ runId: z.string().min(1), nodeId: z.string().min(1) }).optional() }).parse(rawParams);
        if (!database.prepare("SELECT 1 FROM documents WHERE kind = 'project-summary' AND id = ?").get(input.projectId)) throw new Error('项目不存在或已被移除。');
        const sourceFilter = " AND (@sourceRun IS NULL OR json_extract(r.body, '$.regenerationSource.runId') = @sourceRun AND json_extract(r.body, '$.regenerationSource.nodeId') = @sourceNode)";
        const params = { projectId: input.projectId, shotId: input.shotId, sourceRun: input.source?.runId ?? null, sourceNode: input.source?.nodeId ?? null };
        const filter = "FROM documents c JOIN documents r ON r.kind = 'run' AND r.id = json_extract(c.body, '$.runId') WHERE c.kind = 'shot-candidate' AND json_extract(c.body, '$.projectId') = @projectId AND json_extract(c.body, '$.shotId') = @shotId AND json_extract(r.body, '$.status') = 'succeeded'" + sourceFilter;
        const total = database.prepare(`SELECT count(*) AS total ${filter}`).get(params) as { total: number };
        const rows = database.prepare(`SELECT c.body ${filter} ORDER BY json_extract(c.body, '$.createdAt') DESC, c.id DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit: input.limit, offset: input.offset }) as { body: string }[];
        const pending = database.prepare("SELECT r.body FROM documents r JOIN documents s ON s.kind = 'run-snapshot' AND s.id = r.id WHERE r.kind = 'run' AND json_extract(r.body, '$.projectId') = @projectId AND json_extract(s.body, '$.regeneration.shotId') = @shotId AND (json_extract(r.body, '$.status') IN ('queued','running','waiting_review','waiting_external','retry_scheduled') OR (@sourceRun IS NOT NULL AND json_extract(r.body, '$.status') IN ('failed','needs_attention')))" + sourceFilter + " ORDER BY json_extract(r.body, '$.createdAt') DESC, r.id DESC LIMIT 1").get(params) as { body: string } | undefined;
        return { items: rows.map(row => shotCandidateSchema.parse(JSON.parse(row.body))), total: total.total, ...(pending ? { activeRun: reads.runSummary(JSON.parse(pending.body) as RunRecord) } : {}) };
      }
      case 'shot.candidate.get': {
        const input = entityId.extend({ candidateId: z.string().min(1) }).parse(rawParams);
        if (!database.prepare("SELECT 1 FROM documents WHERE kind = 'project-summary' AND id = ?").get(input.projectId)) throw new Error('项目不存在或已被移除。');
        const result = await candidateFor(input.projectId, input.candidateId);
        requireCandidateAssets(result.assets);
        return result.candidate;
      }
      case 'shot.candidate.apply': {
        const input = entityId.extend({ candidateId: z.string().min(1), fields: z.array(shotCandidateFieldSchema).min(1).max(4).optional(), revision: z.number().int().positive() }).parse(rawParams);
        requireRevision(project(input.projectId), input.revision);
        const { candidate, assets } = await candidateFor(input.projectId, input.candidateId);
        const value = project(input.projectId); requireRevision(value, input.revision);
        requireCandidateAssets(assets);
        const current = value.shots.find(shot => shot.id === candidate.shotId);
        if (!current) throw new Error('待应用候选的镜头已移除。');
        const currentCharacters = characters.profilesFor({ shots: [current] }).characters;
        if (fingerprint(currentCharacters) !== fingerprint(candidate.characters ?? [])) throw new Error('生成后角色设定或参考图已修改，请重新生成后应用。');
        requireCandidateResearch(value, candidate);
        const candidateSnapshot = store.get<RunSnapshot>('run-snapshot', candidate.runId);
        const frozenContext = candidateSnapshot?.sourceGeneration?.inputProject ?? candidateSnapshot?.project;
        if (frozenContext && (shotCreativePrompt(frozenContext, candidate.baseline) !== shotCreativePrompt(value, current) || fingerprint(creativeReferenceAssetIds(frozenContext, candidate.baseline)) !== fingerprint(creativeReferenceAssetIds(value, current)))) throw new Error('生成后镜头的创作设定或连续性要求已修改，请重新生成候选。');
        if (candidate.baseline.clipEdit) {
          const oldPlanRow = database.prepare("SELECT p.value AS body FROM documents s, json_each(s.body, '$.project.clipEditPlans') p WHERE s.kind = 'run-snapshot' AND s.id = ? AND json_extract(p.value, '$.id') = ?").get(candidate.runId, candidate.baseline.clipEdit.planId) as { body: string } | undefined;
          const oldPlan = oldPlanRow ? JSON.parse(oldPlanRow.body) as NonNullable<ProjectDocument['clipEditPlans']>[number] : undefined;
          const currentPlan = value.clipEditPlans?.find(plan => plan.id === candidate.baseline.clipEdit?.planId);
          const oldSourceRow = oldPlan ? database.prepare("SELECT p.value AS body FROM documents s, json_each(s.body, '$.project.clipEditSources') p WHERE s.kind = 'run-snapshot' AND s.id = ? AND json_extract(p.value, '$.id') = ?").get(candidate.runId, oldPlan.sourceId) as { body: string } | undefined : undefined;
          const currentSource = oldPlan ? value.clipEditSources?.find(source => source.id === oldPlan.sourceId) : undefined;
          if (!oldPlan || !currentPlan || !oldSourceRow || !currentSource || fingerprint(oldPlan) !== fingerprint(currentPlan) || fingerprint(JSON.parse(oldSourceRow.body)) !== fingerprint(currentSource)) throw new Error('生成后原始剪辑或计划已变化，请重新生成候选。');
        }
        let usesProjectStyle = true;
        if (candidate.kind !== 'script') {
          const row = database.prepare("SELECT json_object('provider', json_extract(m.value, '$.provider'), 'requestTemplate', json_extract(m.value, '$.parameters.requestTemplate'), 'mappedPrompt', json_extract(m.value, '$.parameters.inputMapping.prompt')) AS body FROM documents s, json_each(s.body, '$.models') m WHERE s.kind = 'run-snapshot' AND s.id = ? AND json_extract(m.value, '$.id') = ?").get(candidate.runId, candidate.modelId ?? '') as { body: string } | undefined;
          const model = row ? JSON.parse(row.body) as { provider: string; requestTemplate: unknown; mappedPrompt: unknown } : undefined;
          if (model?.provider === 'custom-http') usesProjectStyle = containsPromptTemplate(model.requestTemplate);
          else if (model?.provider === 'comfyui') usesProjectStyle = typeof model.mappedPrompt === 'string';
        }
        if (usesProjectStyle) {
          const frozen = database.prepare("SELECT json_extract(body, '$.project.style') AS style FROM documents WHERE kind = 'run-snapshot' AND id = ?").get(candidate.runId) as { style: string } | undefined;
          if (!frozen || frozen.style !== value.style) throw new Error('生成后项目风格已修改，请基于当前风格重新生成后应用。');
        }
        let merged = applyShotCandidate(current, candidate, input.fields), next = value;
        if (candidate.kind === 'video') {
          next = bindMedia(value, current.id, assets[0]);
          const retimed = next.shots.find(shot => shot.id === current.id)!;
          merged = { ...merged, clipEdit: retimed.clipEdit, captionTrack: retimed.captionTrack };
          if (candidate.kind === 'video' && candidate.shot.audioProcessing?.version === 2 && candidate.shot.audioProcessing.videoAudio.enabled && !candidate.shot.audioAssetId) merged = { ...merged, audioAssetId: undefined, audioInUs: undefined, captionTrack: undefined };
        } else if (candidate.kind === 'script' && current.clipEdit && merged.durationUs !== current.durationUs) {
          next = trimShotInContext(value, current.id, { inUs: current.clipEdit.inUs, outUs: current.clipEdit.inUs + merged.durationUs }, value.profile.frameRate, undefined, () => randomUUID());
          const retimed = next.shots.find(shot => shot.id === current.id)!;
          merged = { ...merged, durationUs: retimed.durationUs, clipEdit: retimed.clipEdit, sourceInUs: retimed.sourceInUs, audioInUs: retimed.audioInUs, videoInUs: retimed.videoInUs, sceneInUs: retimed.sceneInUs };
        }
        return saveProject({ ...next, shots: next.shots.map(shot => shot.id === current.id ? merged : shot) });
      }
      case 'run.get': return reads.runSummary(run(runIdInput.parse(rawParams).runId));
      case 'run.step.retry': {
        const { runId, nodeId } = runIdInput.extend({ nodeId: z.string().min(1) }).strict().parse(rawParams);
        let value = run(runId);
        if (active.has(runId)) {
          if (value.stepRetry?.status === 'pending' && value.stepRetry.nodeId === nodeId) return hydrateRun(value);
          throw new Error('本次制作仍在执行，请等待当前步骤结束。');
        }
        const inspection = runInspectionSchema.parse(await runInspector.dispatch('run.inspect', { runId }));
        const step = inspection.steps.find(step => step.id === nodeId);
        if (!step?.retry?.allowed) throw new Error(step?.retry?.reason || '只能重试本次制作中选中的失败步骤。');
        value = run(runId);
        if (active.has(runId)) {
          if (value.stepRetry?.status === 'pending' && value.stepRetry.nodeId === nodeId) return hydrateRun(value);
          throw new Error('本次制作仍在执行，请等待当前步骤结束。');
        }
        if (value.updatedAt !== inspection.run.updatedAt || value.status !== inspection.run.status || value.currentNodeId !== nodeId) throw new Error('步骤状态已变化，请刷新后重试。');
        if (batches.blocked(value.projectId) || projectBusy(value.projectId, undefined, value.productionQueueItemId)) throw new Error('该项目已有其他未完成的运行，请先处理现有任务。');
        const previousRetry = value.stepRetry;
        const restoreResponse = modelResponses.prepareRetry(`${runId}:${nodeId}`);
        updateRun(runId, { stepRetry: { nodeId, status: 'pending' } });
        try {
          if (value.productionQueueItemId) await productionQueue!.resumeOwnedRun(runId);
          else { updateRun(runId, { status: 'queued', error: undefined }); schedule(runId, true); }
        } catch (error) {
          if (!active.has(runId)) { restoreResponse?.(); updateRun(runId, { stepRetry: previousRetry }); }
          throw error;
        }
        recordEvent(runId, 'run.step_retry_requested', `仅重试：${step.label}`, nodeId);
        return hydrateRun(run(runId));
      }
      case 'run.resume': {
        const { runId } = runIdInput.parse(rawParams); const value = run(runId);
        if (value.productionQueueItemId) { await productionQueue!.resumeOwnedRun(runId); return hydrateRun(run(runId)); }
        if (productionQueue!.activeForProject(value.projectId)) throw new Error('该项目已在生产队列中，请先从队列处理排队项。');
        const saved = store.get<RunSnapshot>('run-snapshot', runId);
        if (saved?.exportBatch) { await batches.dispatch('render.batch.resume', { batchId: saved.exportBatch.batchId }); return hydrateRun(run(runId)); }
        if (batches.blocked(value.projectId)) throw new Error('请先继续或取消当前批量导出，再恢复其他运行。');
        if (['succeeded', 'canceled'].includes(value.status)) throw new Error('该运行已经结束，请创建新的运行。');
        if (projectBusy(value.projectId, undefined, undefined, runId)) throw new Error('该项目已有其他未完成的运行，请先处理现有任务。');
        schedule(runId, true); return hydrateRun(run(runId));
      }
      case 'run.cancel': {
        const { runId } = runIdInput.parse(rawParams); const value = run(runId);
        const saved = store.get<RunSnapshot>('run-snapshot', runId);
        if (saved?.exportBatch) { await batches.dispatch('render.batch.cancel', { batchId: saved.exportBatch.batchId }); return hydrateRun(run(runId)); }
        if (value.status === 'succeeded') return hydrateRun(value);
        updateRun(runId, { status: 'canceled' }); active.get(runId)?.controller.abort();
        costs.cancelRun(runId);
        recordEvent(runId, 'run.canceled', '本地执行已停止；已提交的远端任务需按服务能力核对。');
        return hydrateRun(run(runId));
      }
      case 'run.replay': {
        const { runId } = runIdInput.parse(rawParams); const value = run(runId);
        const saved = store.get<RunSnapshot>('run-snapshot', runId);
        const outputs = Object.fromEntries(journal.list(runId).filter(record => record.status === 'completed').map(record => [record.activity_id, JSON.parse(record.result!)]));
        return { run: hydrateRun(value), snapshotDigest: saved ? fingerprint(saved) : null, matchesSnapshot: !!saved && fingerprint(saved) === value.snapshotDigest, outputs, externalCalls: 0 };
      }
      case 'model.discover': {
        const input = z.object({ model: modelSchema.partial().required({ provider: true, baseUrl: true, capabilities: true, connectionType: true }), secret: z.string().optional(), reuseSavedSecret: z.boolean().optional() }).parse(rawParams);
        const previous = input.model.id ? store.get<ModelProfile>('model', input.model.id) : undefined;
        const draft = modelSchema.parse({ id: 'discovery', name: '读取模型', model: 'discovery', createdAt: '', updatedAt: '', ...input.model });
        validateModelConnection(draft);
        let secret = input.secret ? rememberSecret(input.secret) : undefined;
        if (!secret && previous?.credentialRef) {
          if (previous.baseUrl !== draft.baseUrl && !input.reuseSavedSecret) return { source: 'remote', items: [], message: '服务地址已改变，请填写密钥后读取列表。' };
          secret = rememberSecret(await options.secretStore?.get(previous.credentialRef));
        }
        try { return await discoverModels(draft, secret); }
        catch (error) { return { source: 'remote', items: [], message: error instanceof Error && /^读取模型列表返回 HTTP \d+$/.test(error.message) ? error.message + '，请核对地址与密钥后重试。' : '暂时无法读取模型，请核对服务地址、密钥及接口支持后重试。' }; }
      }
      case 'model.save': {
        const input = z.object({ model: modelSchema.partial().required({ name: true, provider: true, baseUrl: true, model: true, capabilities: true, connectionType: true }), secret: z.string().optional() }).parse(rawParams);
        const id = input.model.id || randomUUID();
        const previous = store.get<ModelProfile>('model', id);
        validateModelConnection({ ...previous, ...input.model });
        validateModelParameters({ ...previous, ...input.model, parameters: input.model.parameters ?? previous?.parameters ?? {} });
        let credentialRef = previous?.credentialRef;
        let hasSecret = previous?.hasSecret ?? false;
        if (input.secret !== undefined) {
          rememberSecret(input.secret);
          if (!options.secretStore) throw new Error('当前环境未连接系统凭据库，请在桌面客户端保存密钥。');
          credentialRef = input.secret.trim() ? `model:${id}:${randomUUID()}` : previous?.credentialRef;
          if (!credentialRef) credentialRef = `model:${id}`;
          if (input.secret.trim()) { await options.secretStore.set(credentialRef, input.secret); hasSecret = true; }
          else { await options.secretStore.delete(credentialRef); credentialRef = undefined; hasSecret = false; }
        }
        const timestamp = now();
        const value = modelSchema.parse({ ...previous, ...input.model, id, credentialRef, hasSecret, capabilities: getModelCapabilities(input.model), parameters: input.model.parameters ?? previous?.parameters ?? {}, enabled: input.model.enabled ?? true, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp });
        store.put('model', id, value); changed(); return value;
      }
      case 'cost.list': case 'cost.update': case 'cost.summary': case 'cost.tasks': case 'cost.task.get': return costs.dispatch(method, rawParams);
      case 'promptLibrary.get': case 'promptLibrary.list': case 'promptLibrary.save': case 'promptLibrary.update': return promptLibrary.dispatch(method, rawParams);
      case 'prompt.preview': case 'promptSession.get': case 'promptSession.list': case 'promptSession.save': return promptWorkbench.dispatch(method, rawParams);
      case 'promptTrial.start': {
        const value = await promptWorkbench.dispatch(method, rawParams);
        return reads.runSummary(run(z.object({ id: z.string() }).parse(value).id));
      }
      case 'render.batch.start': case 'render.batch.get': case 'render.batch.list': case 'render.batch.cancel': case 'render.batch.resume': return batches.dispatch(method, rawParams);
      case 'character.list': case 'character.get': case 'character.references': case 'character.save': case 'character.archive': case 'character.restore': return characters.dispatch(method, rawParams);
      case 'workflowTemplate.list': case 'workflowTemplate.get': case 'workflowTemplate.save': case 'workflowTemplate.archive': case 'workflowTemplate.restore': return workflowTemplates.dispatch(method, rawParams);
      case 'seriesTemplate.list': case 'seriesTemplate.get': case 'seriesTemplate.save': case 'seriesTemplate.archive': case 'seriesTemplate.restore': return seriesTemplates.dispatch(method, rawParams);
      case 'model.test': {
        const { modelId } = z.object({ modelId: z.string() }).parse(rawParams);
        const model = store.get<ModelProfile>('model', modelId); if (!model) throw new Error('模型不存在。');
        return testModelConnection(model, model.credentialRef ? rememberSecret(await options.secretStore?.get(model.credentialRef)) : undefined);
      }
      case 'model.delete': {
        const { modelId } = z.object({ modelId: z.string() }).parse(rawParams);
        const model = store.get<ModelProfile>('model', modelId);
        if (model?.credentialRef) await options.secretStore?.delete(model.credentialRef);
        store.delete('model', modelId); changed(); return { deleted: true };
      }
      case 'skill.toggle': {
        const { skillId, enabled } = z.object({ skillId: z.string(), enabled: z.boolean() }).parse(rawParams);
        const skill = store.get<SkillPackage>('skill', skillId); if (!skill) throw new Error('Skill 不存在。');
        const value = { ...skill, enabled }; store.put('skill', skillId, value); changed(); return value;
      }
      case 'skill.update': {
        const { skillId, instructions, description } = z.object({ skillId: z.string(), instructions: z.string().max(2_000_000), description: z.string().optional() }).parse(rawParams);
        const skill = store.get<SkillPackage>('skill', skillId); if (!skill) throw new Error('Skill 不存在。');
        const contentHash = fingerprint({ instructions, resources: skill.resources });
        const value = { ...skill, instructions, description: description ?? skill.description, contentHash, version: contentHash.slice(0, 12) };
        store.put('skill', skillId, value); changed(); return value;
      }
      case 'skill.tool.toggle': {
        const { skillId, toolId, enabled } = z.object({ skillId: z.string(), toolId: z.string(), enabled: z.boolean() }).parse(rawParams);
        const skill = store.get<SkillPackage>('skill', skillId); if (!skill) throw new Error('Skill 不存在。');
        if (!skill.tools.some(item => item.id === toolId)) throw new Error('Skill 工具不存在。');
        if (enabled && !supportsSkillScript(toolId)) throw new Error('当前内置执行器支持 JavaScript 工具；其他格式请通过 MCP 接入。');
        const value = { ...skill, tools: skill.tools.map(item => item.id === toolId ? { ...item, enabled } : item) };
        store.put('skill', skillId, value); changed(); return value;
      }
      case 'tool.list': return store.list<McpServer>('mcp-server');
      case 'tool.register': {
        const input = z.object({ server: z.object(mcpServerSchema.shape).partial().required({ name: true, transport: true }), secret: z.string().optional() }).parse(rawParams);
        const id = input.server.id || randomUUID();
        const previous = store.get<McpServer>('mcp-server', id);
        let credentialRef = previous?.credentialRef; let hasSecret = previous?.hasSecret ?? false;
        if (input.secret !== undefined) {
          rememberSecret(input.secret);
          if (!options.secretStore) throw new Error('请在连接凭据库的环境中保存密钥。');
          credentialRef = input.secret ? `mcp:${id}:${randomUUID()}` : previous?.credentialRef;
          if (!credentialRef) credentialRef = `mcp:${id}`;
          if (input.secret) { await options.secretStore.set(credentialRef, input.secret); hasSecret = true; }
          else { await options.secretStore.delete(credentialRef); credentialRef = undefined; hasSecret = false; }
        }
        const value = mcpServerSchema.parse({ ...previous, ...input.server, id, args: input.server.args ?? previous?.args ?? [], enabled: input.server.enabled ?? previous?.enabled ?? false, credentialRef, hasSecret });
        store.put('mcp-server', id, value); changed(); return value;
      }
      case 'tool.toggle': {
        const { serverId, enabled } = z.object({ serverId: z.string(), enabled: z.boolean() }).parse(rawParams);
        const server = store.get<McpServer>('mcp-server', serverId); if (!server) throw new Error('MCP 服务不存在。');
        const value = { ...server, enabled }; store.put('mcp-server', serverId, value); changed(); return value;
      }
      case 'tool.delete': {
        const { serverId } = z.object({ serverId: z.string() }).parse(rawParams);
        const server = store.get<McpServer>('mcp-server', serverId); if (server?.credentialRef) await options.secretStore?.delete(server.credentialRef);
        store.delete('mcp-server', serverId); changed(); return { deleted: true };
      }
      case 'tool.inspect': {
        const { serverId } = z.object({ serverId: z.string() }).parse(rawParams);
        const server = store.get<McpServer>('mcp-server', serverId); if (!server) throw new Error('MCP 服务不存在。');
        if (!server.enabled) throw new Error('请先启用该 MCP 服务。');
        try {
          const connection = await connectMcp(server, server.credentialRef ? rememberSecret(await options.secretStore?.get(server.credentialRef)) : undefined);
          try { return { tools: connection.tools }; } finally { await connection.close(); }
        } catch (error) { throw new Error(redactError(error instanceof Error ? error.message : 'MCP 服务连接失败。', [], transientSecrets)); }
      }
      case 'asset.import': {
        const input = z.object({ path: z.string().min(1), projectId: z.string().optional(), shotId: z.string().optional(), kind: assetSchema.shape.kind.optional(), purpose: z.literal('reference-audio').optional() }).parse(rawParams);
        return importAsset(input);
      }
      case 'image.dimensions': return imageTools.dimensions(rawParams);
      case 'image.cutGrid': return trackWork(() => imageTools.cutGrid(rawParams));
      case 'image.createMask': return trackWork(() => imageTools.mask(rawParams));
      case 'asset.getMany': {
        const { assetIds } = z.object({ assetIds: z.array(z.string().min(1)).max(100) }).parse(rawParams);
        return [...new Set(assetIds)].flatMap(id => { const asset = store.get<AssetRecord>('asset', id); return asset ? [asset] : []; });
      }
      case 'asset.waveform': {
        const { assetId } = z.object({ assetId: z.string().min(1) }).parse(rawParams);
        const asset = store.get<AssetRecord>('asset', assetId);
        if (!asset) throw new Error('素材不存在。');
        if (asset.kind !== 'audio' && asset.kind !== 'video') throw new Error('请选择音频或视频素材读取波形。');
        if (!options.readAudioWaveform) throw new Error('音频波形读取器尚未连接。');
        const waveform = audioWaveformSchema.parse(await options.readAudioWaveform(asset));
        if (waveform.assetId !== asset.id || waveform.sha256 !== asset.sha256) throw new Error('波形与当前素材不匹配，请重新读取。');
        return waveform;
      }
      case 'asset.read': {
        const { assetId } = z.object({ assetId: z.string() }).parse(rawParams);
        const asset = store.get<AssetRecord>('asset', assetId); if (!asset) throw new Error('素材不存在。');
        if (asset.size > 50_000_000) throw new Error('该素材较大，请通过桌面文件预览打开。');
        return { dataUrl: `data:${asset.mimeType};base64,${(await readFile(asset.path)).toString('base64')}`, mimeType: asset.mimeType };
      }
      case 'asset.retain': {
        const { assetId, retained } = z.object({ assetId: z.string(), retained: z.boolean() }).parse(rawParams);
        const asset = store.get<AssetRecord>('asset', assetId); if (!asset) throw new Error('素材不存在。');
        const value = { ...asset, retained }; store.put('asset', assetId, value); changed(); return value;
      }
      case 'asset.select': {
        const { assetId, projectId, shotId, revision } = z.object({ assetId: z.string(), projectId: z.string(), shotId: z.string(), revision: z.number().int().optional() }).parse(rawParams);
        const asset = store.get<AssetRecord>('asset', assetId); if (!asset?.active) throw new Error('素材不存在或已移除。');
        const value = project(projectId); requireRevision(value, revision);
        if (asset.projectId && asset.projectId !== projectId) throw new Error('请先将其他项目的素材导入当前项目。');
        if (!value.shots.some(shot => shot.id === shotId)) throw new Error('镜头不存在。');
        if (!['image', 'audio', 'video'].includes(asset.kind)) throw new Error('该素材不能绑定到镜头。');
        return saveProject(bindMedia(value, shotId, asset));
      }
      case 'asset.delete': {
        const { assetId } = z.object({ assetId: z.string() }).parse(rawParams);
        const asset = store.get<AssetRecord>('asset', assetId); if (!asset) throw new Error('素材不存在。');
        if (asset.retained || reads.assetInUse(assetId) || reads.generationAssetInUse(assetId) || characters.assetInUse(assetId) || imageTools.assetsInUse([assetId]).has(assetId)) throw new Error('正在使用或已保留的素材不能移除。');
        store.put('asset', assetId, { ...asset, active: false }); changed(); return { deleted: true };
      }
      case 'project.backup': {
        const { projectId, destination } = entityId.extend({ destination: z.string().optional() }).parse(rawParams);
        const value = project(projectId);
        validateResearchProject(value, value);
        validateEdits(value, value);
        const bundle = characters.profilesFor(value);
        const referenced = new Set([...value.shots.flatMap(shot => [shot.assetId, shot.videoAssetId, shot.audioAssetId, shot.captionTrack?.sourceAssetId]), ...(value.clipEditSources ?? []).flatMap(clipSourceAssetIds), ...(value.musicClips ?? []).map(clip => clip.assetId), ...(value.workflow.production.referenceAudioAssetIds ?? []), ...creativeReferenceAssetIds(value), ...bundle.assets.map(asset => asset.id)]);
        const availableAssets = store.list<AssetRecord>('asset');
        for (const asset of availableAssets.filter(asset => asset.projectId === projectId)) referenced.add(asset.id);
        let added = true;
        while (added) { added = false; for (const asset of availableAssets) if (referenced.has(asset.id) && asset.derivation && !referenced.has(asset.derivation.sourceAssetId)) { referenced.add(asset.derivation.sourceAssetId); added = true; } }
        const assets = availableAssets.filter(asset => referenced.has(asset.id));
        const backupDirectory = resolve(destination ?? join(directory, 'backups', `${projectId}-${Date.now()}`));
        await mkdir(join(backupDirectory, 'assets'), { recursive: true });
        const portable = assets.map(asset => ({ ...asset, path: `assets/${createHash('sha256').update(asset.id).digest('hex')}${extname(asset.path).toLowerCase()}` }));
        for (let index = 0; index < assets.length; index++) {
          if (!existsSync(assets[index].path)) throw new Error(`素材「${assets[index].name}」缺失，无法创建完整备份。`);
          await copyFile(assets[index].path, join(backupDirectory, portable[index].path));
        }
        const hasPromptBindings = workflowNodesWithSubflows(value.workflow).some(node => node.promptBindings !== undefined || node.promptTemplate !== undefined);
        const schemaVersion = creativeReferenceAssetIds(value).length || assets.some(asset => asset.derivation) ? 8 : value.episode || value.episodeSource ? 7 : hasPromptBindings ? 6 : value.creativeContext || value.shots.some(shot => shot.creativeEntityKeys?.length) ? 5 : 4;
        await writeFile(join(backupDirectory, 'project.json'), JSON.stringify({ schemaVersion, project: value.episode ? { ...value, episodeSource: { ...value.episode, workTitle: works.get(value.episode.workId).title } } : value, assets: portable, characters: bundle.characters }, null, 2), { encoding: 'utf8', flag: 'wx' });
        return { path: backupDirectory, assets: portable.length };
      }
      case 'project.importBackup': {
        const { path } = z.object({ path: z.string().min(1) }).parse(rawParams);
        const entry = resolve(path);
        const source = (await stat(entry)).isDirectory() ? join(entry, 'project.json') : entry;
        const info = await stat(source);
        if (!info.isFile() || info.size > 30_000_000) throw new Error('项目备份文件无效或超过 30 MB。');
        const backup = z.object({ schemaVersion: z.union([z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8)], { error: '仅支持格式 4 至 8 的项目备份。' }), project: projectSchema, assets: z.array(assetSchema).max(2000), characters: z.array(characterProfileSchema).max(1000).default([]) }).parse(JSON.parse(await readFile(source, 'utf8')));
        if (backup.schemaVersion < 7 && (backup.project.episode || backup.project.episodeSource)) throw new Error('包含分集来源的项目需要格式 7 备份。');
        if (backup.schemaVersion < 6 && workflowNodesWithSubflows(backup.project.workflow).some(node => node.promptBindings !== undefined || node.promptTemplate !== undefined)) throw new Error('包含提示词绑定的项目需要格式 6 备份。');
        if (backup.schemaVersion === 4 && (backup.project.creativeContext || backup.project.shots.some(shot => shot.creativeEntityKeys?.length))) throw new Error('包含创作设定的项目需要格式 5 备份。');
        if (backup.schemaVersion < 8 && (creativeReferenceAssetIds(backup.project).length || backup.assets.some(asset => asset.derivation))) throw new Error('包含图片设定或裁切来源的项目需要格式 8 备份。');
        validateWorkflow(backup.project.workflow);
        validateResearchProject(backup.project, backup.project);
        validateClipEditContent(backup.project, backup.assets);
        const sourceRoot = dirname(source);
        const buffers: Array<{ asset: AssetRecord; bytes: Buffer }> = [];
        let totalBytes = 0;
        for (const asset of backup.assets) {
          if (isAbsolute(asset.path) || asset.path.includes('\\') || asset.path.split('/').some(part => part === '..' || part.includes(':'))) throw new Error('项目备份包含越界素材路径。');
          const file = resolve(sourceRoot, asset.path);
          if (relative(sourceRoot, file).startsWith('..')) throw new Error('项目备份包含越界素材路径。');
          const parts = asset.path.split('/').filter(Boolean);
          let candidate = sourceRoot;
          for (const part of parts) { candidate = join(candidate, part); if ((await lstat(candidate)).isSymbolicLink()) throw new Error('项目备份包含符号链接。'); }
          const fileInfo = await stat(file);
          totalBytes += fileInfo.size;
          if (!fileInfo.isFile() || totalBytes > 2_000_000_000) throw new Error('项目备份素材无效或总大小超过 2 GB。');
          const bytes = await readFile(file);
          if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256 || bytes.length !== asset.size) throw new Error(`素材“${asset.name}”缺失或校验失败，请使用完整备份。`);
          buffers.push({ asset, bytes });
        }
        const sources = new Map(buffers.map(entry => [entry.asset.id, entry]));
        if (buffers.some(entry => entry.asset.derivation)) {
          const { imageDimensions } = await import('@video-quickly/video/image-tools');
          const dimensions = new Map<string, { width: number; height: number }>();
          for (const { asset, bytes } of buffers) if (asset.derivation) {
            const provenance = asset.derivation, origin = sources.get(provenance.sourceAssetId);
            if (!origin || origin.asset.kind !== 'image' || origin.asset.sha256 !== provenance.sourceSha256 || !['image/png', 'image/jpeg', 'image/webp'].includes(origin.asset.mimeType)) throw new Error('备份中的图片来源缺失或哈希不匹配。');
            const size = dimensions.get(origin.asset.id) ?? await imageDimensions(origin.bytes); dimensions.set(origin.asset.id, size);
            if (size.width !== provenance.sourceWidth || size.height !== provenance.sourceHeight) throw new Error('备份中的图片来源尺寸不匹配。');
            const output = await imageDimensions(bytes), expected = provenance.kind === 'grid-crop' ? provenance.rectangle : size;
            if (asset.kind !== 'image' || output.width !== expected.width || output.height !== expected.height || asset.width !== undefined && asset.width !== output.width || asset.height !== undefined && asset.height !== output.height) throw new Error('备份中的裁切或遮罩尺寸不匹配。');
          }
        }
        const projectId = randomUUID();
        const assetDirectory = join(directory, 'projects', projectId, 'assets');
        await mkdir(assetDirectory, { recursive: true });
        const identifiers = new Map(buffers.map(({ asset }) => [asset.id, randomUUID()]));
        const clipAssetId = (id: string | undefined) => { if (!id) return undefined; const mapped = identifiers.get(id); if (!mapped) throw new Error('备份缺少原始剪辑素材，请使用完整备份。'); return mapped; };
        const importedCharacters = characters.prepareImport({ characters: backup.characters, assets: backup.assets }, identifiers);
        const characterReferences = new Set([...backup.characters.flatMap(profile => profile.referenceAssetIds), ...creativeReferenceAssetIds(backup.project)]);
        if (projectCharacterIds(backup.project).some(id => !importedCharacters.idMap.has(id))) throw new Error('备份缺少镜头或项目角色池使用的角色，请重新创建完整备份。');
        const restoredAssets: AssetRecord[] = [];
        const timestamp = now();
        for (const { asset, bytes } of buffers) {
          const id = identifiers.get(asset.id);
          if (!id) throw new Error('备份素材编号无效。');
          const destination = join(assetDirectory, `${id}${extname(asset.path)}`);
          await writeFile(destination, bytes, { flag: 'wx' });
          restoredAssets.push({ ...asset, id, projectId: characterReferences.has(asset.id) ? undefined : projectId, shotId: characterReferences.has(asset.id) ? undefined : asset.shotId, path: destination, createdAt: timestamp, ...(asset.derivation ? { derivation: { ...asset.derivation, sourceAssetId: clipAssetId(asset.derivation.sourceAssetId)! } } : {}) });
        }
        const restored = projectSchema.parse({ ...backup.project, episode: undefined, episodeSource: backup.project.episodeSource ?? (backup.project.episode ? { ...backup.project.episode, workTitle: '备份中的作品' } : undefined), workflow: { ...backup.project.workflow, production: { ...backup.project.workflow.production, referenceAudioAssetIds: backup.project.workflow.production.referenceAudioAssetIds?.map(id => clipAssetId(id)!) } }, id: projectId, title: `${backup.project.title.slice(0, 150)}（恢复）`, revision: 1, archived: false, createdAt: timestamp, updatedAt: timestamp,
          clipEditSources: backup.project.clipEditSources?.map(source => ({ ...source, original: { ...source.original, assetId: clipAssetId(source.original.assetId), audioAssetId: clipAssetId(source.original.audioAssetId), videoAssetId: clipAssetId(source.original.videoAssetId), captionTrack: source.original.captionTrack ? { ...source.original.captionTrack, sourceAssetId: clipAssetId(source.original.captionTrack.sourceAssetId) } : undefined }, assetHashes: source.assetHashes.map(hash => ({ ...hash, assetId: clipAssetId(hash.assetId)! })) })),
          creativeContext: backup.project.creativeContext ? { ...backup.project.creativeContext, characterIds: backup.project.creativeContext.characterIds.map(id => importedCharacters.idMap.get(id)!), entities: backup.project.creativeContext.entities.map(entity => ({ ...entity, ...(entity.referenceAssetIds ? { referenceAssetIds: entity.referenceAssetIds.map(id => clipAssetId(id)!) } : {}) })) } : backup.project.creativeContext,
          musicClips: backup.project.musicClips?.map(clip => ({ ...clip, assetId: identifiers.get(clip.assetId) })), shots: backup.project.shots.map(shot => ({ ...shot, characterIds: shot.characterIds?.map(id => importedCharacters.idMap.get(id)), assetId: shot.assetId ? identifiers.get(shot.assetId) : undefined, audioAssetId: shot.audioAssetId ? identifiers.get(shot.audioAssetId) : undefined, videoAssetId: shot.videoAssetId ? identifiers.get(shot.videoAssetId) : undefined, captionTrack: shot.captionTrack ? { ...shot.captionTrack, sourceAssetId: shot.captionTrack.sourceAssetId ? identifiers.get(shot.captionTrack.sourceAssetId) : undefined } : undefined })) });
        database.transaction(() => {
          for (const asset of restoredAssets) store.put('asset', asset.id, asset);
          for (const profile of importedCharacters.characters) store.put('character', profile.id, profile);
          characters.profilesFor(restored);
          validateEdits(restored);
          store.put('project', projectId, restored);
        })();
        changed(); return restored;
      }
      case 'node.result': {
        const { runId, nodeId } = z.object({ runId: z.string(), nodeId: z.string() }).parse(rawParams);
        return store.get('node-result', `${runId}:${nodeId}`) ?? null;
      }
      case 'node.apply': {
        const { runId, nodeId, revision, applicationId } = z.object({ runId: z.string(), nodeId: z.string(), revision: z.number().int().optional(), applicationId: z.string().min(1).max(160).optional() }).parse(rawParams);
        const applicationKey = applicationId ? fingerprint(applicationId) : undefined, applicationInput = { runId, nodeId, revision };
        const appliedReceipt = () => {
          const receipt = applicationKey ? store.get<{ input: typeof applicationInput; result: ProjectDocument }>('node-application', applicationKey) : undefined;
          if (receipt && fingerprint(receipt.input) !== fingerprint(applicationInput)) throw new Error('应用标识已用于不同的步骤或修订，请使用新的标识。');
          return receipt?.result;
        };
        const receipt = appliedReceipt(); if (receipt) return receipt;
        const saveApplied = (next: ProjectDocument, persist = true) => database.transaction(() => {
          const previous = appliedReceipt(); if (previous) return previous;
          const result = persist ? saveProject(next) : next;
          if (applicationKey) store.put('node-application', applicationKey, { input: applicationInput, result });
          return result;
        })();
        const record = run(runId); const value = project(record.projectId); requireRevision(value, revision);
        const saved = store.get<RunSnapshot>('run-snapshot', runId);
        if (saved?.assistant) throw new Error('任务修改建议请在预览中应用到编辑草稿。');
        if (saved?.trial && record.status !== 'succeeded') throw new Error('请等待试运行成功后再应用产物。');
        if ((saved?.inspectionNodes ?? saved?.nodes)?.some(node => node.id === nodeId && node.kind === 'research')) throw new Error('该历史资料产物仅支持查看。');
        if (saved?.regeneration) {
          if (applicationId) throw new Error('镜头候选请使用候选应用接口。');
          if (nodeId !== 'regenerate') throw new Error('未找到对应镜头候选。');
          const candidateId = `candidate-${createHash('sha256').update(`${runId}:${nodeId}`).digest('hex').slice(0, 32)}`;
          return dispatch('shot.candidate.apply', { projectId: record.projectId, candidateId, revision: revision ?? value.revision });
        }
        if (!saved) throw new Error('未找到本次制作的执行快照。');
        const node = store.get<WorkflowNode>('node-definition', `${runId}:${nodeId}`) ?? (saved.inspectionNodes ?? saved.nodes).find(item => item.id === nodeId);
        const media = node && ['assets', 'animation'].includes(node.kind);
        if (!media && value.revision !== saved.project.revision) throw new Error('项目已在生成后修改，请基于当前内容重新生成建议。');
        const frozenCharacters = saved.characters ?? [], frozenReferences = saved.characterAssets ?? [];
        await validateCharacterAssets(frozenCharacters, frozenReferences, creativeReferenceAssetIds(saved.project));
        const captured = appliedReceipt(); if (captured) return captured;
        const verifiedProject = () => {
          const current = project(record.projectId); requireRevision(current, revision ?? value.revision);
          if (!media && current.revision !== saved.project.revision) throw new Error('项目已在生成后修改，请基于当前内容重新生成建议。');
          requireCurrentCharacters(frozenCharacters); requireCandidateAssets(frozenReferences);
          return current;
        };
        const currentValue = verifiedProject();
        const result = store.get<JsonValue>('node-result', `${runId}:${nodeId}`);
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('步骤没有可应用的结果。');

        if (node?.kind === 'script' && Array.isArray(result.shots)) return saveApplied(projectAfterNode(currentValue, node, result, []));
        if (node && ['brief', 'style'].includes(node.kind) && typeof result.text === 'string') return saveApplied(projectAfterNode(currentValue, node, result, []));
        if (node && ['assets', 'animation'].includes(node.kind)) {
          const input = store.get<ProjectDocument>('node-project', `${runId}:${nodeId}`);
          if (!input) throw new Error('这个历史步骤没有保存执行输入，请重新生成后应用。');
          const assets = nodeResultAssets(result);
          // Older full runs may have generated a storyboard that was never saved.
          const restoreStoryboard = !saved.trial && isVideoGenerationNode(node) && assets.some(asset => asset.kind === 'video' && asset.shotId) && !sameJsonContent(input.shots, saved.project.shots)
            && projectContentDigest(currentValue) === projectContentDigest(saved.project);
          const checkedAssets = [...assets];
          if (restoreStoryboard) {
            const existing = productionMediaIds(saved.project);
            for (const asset of assets) existing.add(asset.id);
            const upstream = new Map(upstreamResults(runId, node, saved).flatMap(step => nodeResultAssets(step.output)).map(asset => [asset.id, asset]));
            for (const id of productionMediaIds(input)) {
              if (existing.has(id)) continue;
              const asset = upstream.get(id) ?? store.get<AssetRecord>('asset', id);
              if (!asset || asset.projectId && asset.projectId !== value.id) throw new Error('本次制作的分镜素材缺失或不属于当前项目。');
              checkedAssets.push(asset);
            }
          }
          requireCandidateAssets(checkedAssets);
          for (const asset of checkedAssets) {
            const info = await stat(asset.path).catch(() => undefined);
            if (!info?.isFile() || info.size !== asset.size) throw new Error('步骤产物素材缺失或已更改，请重新生成。');
            const hash = createHash('sha256');
            for await (const chunk of createReadStream(asset.path)) hash.update(chunk);
            if (hash.digest('hex') !== asset.sha256) throw new Error('步骤产物素材校验失败，请重新生成。');
          }
          const repeated = appliedReceipt(); if (repeated) return repeated;
          const latest = verifiedProject(); requireCandidateAssets(checkedAssets);
          const working = applyMediaResult(restoreStoryboard ? input : latest, input, node, result, assets);
          if (restoreStoryboard) return saveApplied({ ...latest, ...productionOutput(working) });
          return saveApplied(working, working !== latest);
        }
        throw new Error('此步骤结果无需写入项目。');
      }
      default: throw new Error(`未知操作：${method}`);
    }
  }

  logger.info('runtime.initialized');
  return {
    dispatch,
    subscribe(listener: (event: RuntimeEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async waitForIdle() { await skillLibrary.waitForIdle(); await assetRecovery.waitForIdle(); await readiness.waitForIdle(); await audioPreview.waitForIdle(); await batches.waitForIdle(); do { await productionQueue!.waitForIdle(); await drainWork(); } while (active.size || pendingWork.size || productionQueue!.hasPending()); },
    async close() {
      logger.info('runtime.stopping', { pendingCount: active.size + pendingWork.size });
      closing = true; productionQueue!.close();
      for (const controller of editorExports.values()) controller.abort();
      try {
        await productionQueue!.waitForIdle();
        await skillLibrary.close();
        await assetRecovery.close();
        await readiness.close();
        await audioPreview.close();
        await batches.close();
        for (const value of active.values()) value.controller.abort();
        await drainWork();
        database.close(); listeners.clear(); transientSecrets.clear();
        logger.info('runtime.stopped');
      } catch (error) { logger.error('runtime.shutdown_failed', { error: logError(error) }); throw error; }
    },
  };
}

function localNodeResult(node: WorkflowNode, project: ProjectDocument, assets: AssetRecord[]): JsonValue {
  switch (node.kind) {
    case 'brief': return { title: project.title, brief: project.brief, source: 'project' };
    case 'research': return { kind: 'research-summary', claims: project.claims as unknown as JsonValue, source: 'project', readonly: true, note: '这里只显示已保存的人工资料摘要；没有调用模型，也没有生成新证据候选。' };
    case 'style': return { style: project.style, source: 'project' };
    case 'script': {
      if (!project.shots.length) throw new Error('请先手工添加分镜，或为此步骤选择文本模型。');
      return { shots: project.shots as unknown as JsonValue, source: 'project' };
    }
    case 'assets': {
      const missing = project.shots.filter(shot => !assets.some(asset => asset.id === shot.assetId || asset.id === shot.videoAssetId));
      if (missing.length) throw new Error(`请为 ${missing.length} 个镜头导入画面素材，或配置图片模型。`);
      return { assetIds: project.shots.map(shot => shot.assetId ?? shot.videoAssetId ?? ''), source: 'project' };
    }

    case 'animation': return { shots: project.shots.map(shot => ({ id: shot.id, animation: shot.animation, durationUs: shot.durationUs })) as unknown as JsonValue };
    case 'export': throw new Error('请在桌面渲染器连接后导出成片。');
    case 'agent': throw new Error('请为 Agent 步骤选择具备文本能力的模型。');
    case 'condition': return { matched: node.config.value === true, field: typeof node.config.field === 'string' ? node.config.field : '' };
    case 'join': return { joined: true };
    case 'subflow': throw new Error('子流程须由持久化执行器调度。');
    case 'review': return { checked: true, source: 'workflow' };
  }
}

function validateWorkflow(workflow: WorkflowDefinition) {
  const ids = new Set(workflow.nodes.map(node => node.id));
  if (ids.size !== workflow.nodes.length) throw new Error('流程包含重复的步骤 ID。');
  for (const edge of workflow.edges) if (!ids.has(edge.source) || !ids.has(edge.target)) throw new Error('流程连接引用了不存在的步骤。');
  orderedNodes(workflow);
  validateWorkflowComposition(workflow);
}

function orderedNodes(workflow: WorkflowDefinition): WorkflowNode[] {
  const remaining = new Map(workflow.nodes.map(node => [node.id, node]));
  const completed = new Set<string>();
  const ordered: WorkflowNode[] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter(node => workflow.edges.filter(edge => edge.target === node.id).every(edge => completed.has(edge.source)));
    if (!ready.length) throw new Error('流程存在循环依赖，请检查连接。');
    for (const node of ready) { remaining.delete(node.id); completed.add(node.id); ordered.push(node); }
  }
  return ordered;
}

function mediaKind(extension: string): { kind: AssetRecord['kind']; mimeType: string } {
  const formats: Record<string, { kind: AssetRecord['kind']; mimeType: string }> = {
    '.svg': { kind: 'image', mimeType: 'image/svg+xml' }, '.png': { kind: 'image', mimeType: 'image/png' }, '.jpg': { kind: 'image', mimeType: 'image/jpeg' }, '.jpeg': { kind: 'image', mimeType: 'image/jpeg' }, '.webp': { kind: 'image', mimeType: 'image/webp' },
    '.mp4': { kind: 'video', mimeType: 'video/mp4' }, '.webm': { kind: 'video', mimeType: 'video/webm' }, '.mov': { kind: 'video', mimeType: 'video/quicktime' },
    '.mp3': { kind: 'audio', mimeType: 'audio/mpeg' }, '.wav': { kind: 'audio', mimeType: 'audio/wav' }, '.m4a': { kind: 'audio', mimeType: 'audio/mp4' }, '.ogg': { kind: 'audio', mimeType: 'audio/ogg' },
    '.srt': { kind: 'subtitle', mimeType: 'text/plain' }, '.ass': { kind: 'subtitle', mimeType: 'text/plain' }, '.pdf': { kind: 'document', mimeType: 'application/pdf' }, '.txt': { kind: 'document', mimeType: 'text/plain' }, '.md': { kind: 'document', mimeType: 'text/markdown' },
  };
  const value = formats[extension]; if (!value) throw new Error('暂不支持该文件格式。'); return value;
}

function redactError(message: string, models: ModelProfile[], secrets: Iterable<string> = [], maximum = 1200) {
  let safe = message.replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, '$1 [已隐藏]').replace(/sk-[a-z0-9_-]+/gi, '[已隐藏]');
  for (const secret of secrets) {
    if (!secret) continue;
    safe = safe.replaceAll(secret, '[已隐藏]').replaceAll(encodeURIComponent(secret), '[已隐藏]');
  }
  for (const model of models) {
    try { const url = new URL(model.baseUrl); if (url.search) safe = safe.replaceAll(model.baseUrl, `${url.origin}${url.pathname}`); } catch { /* Stored URLs are schema-validated; ignore historical invalid entries. */ }
  }
  return safe.slice(0, maximum);
}
