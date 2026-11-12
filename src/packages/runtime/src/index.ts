import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readGithubTrending, readResearchSource, selectResearchPassages, parseResearchResult, type GithubTrendingRanking } from '@video-quickly/integrations/research';
import type { MediaDiagnosticEvent } from '@video-quickly/integrations';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import {
  applyShotCandidate, assetSchema, characterProfileSchema, claimSchema, clipSourceAssetIds, DEFAULT_VIDEO_PROFILE, editorExportInputSchema, LockedShotChangeError, modelSchema, pageInputSchema, projectSchema, providerUsageSchema, runSchema, sumProviderUsage, runSelectionSchema, runStatusSchema, shotCandidateFieldSchema, shotCandidateKindSchema, shotCandidateSchema, shotSchema, validateClipEditContent, validateClipEditHistory, validateModelConnection, validateModelParameters, videoProfileSchema, workflowSchema,
  type AssetRecord, type AudioWaveform, type CharacterProfile, type JsonValue, type ModelCapability, type ModelProfile, type PreparedAudioMix, type ProjectDocument, type ReadinessIssue, type RunEvent, type RunPlan, type RunRecord, type RunSelection, type RunSummary, type RuntimeEvent, type RuntimeSystem, type Shot, type ShotCandidate, type SkillPackage, type WorkflowDefinition, type WorkflowNode, type WorkspaceSnapshot,
} from '@video-quickly/contracts';
import { ActivityJournal, AGENT_CONTINUATION_EXHAUSTED, AgentCompletionError, AmbiguousActivityError, fingerprint, SimulatedProcessExit, type ActivityHooks, type ActivitySafety } from './activities.js';
import { openDatabase, DocumentStore } from './database.js';
import { activityNodeId, createReadModels } from './read-models.js';
import { createExecutionGraph } from './graph.js';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { validateWorkflowComposition, workflowNodesWithSubflows, workflowEdgesWithSubflows, resolveSubflowInputs, substituteSubflowInputs, subflowNodeId, subflowThreadId, subflowValueAt, type SubflowDefinition } from '@video-quickly/contracts';
import { createWorkflowTemplateLibrary } from './workflow-templates.js';
import { buildWorkflowPrompt, parseWorkflowScript, withStoryboardTiming, type StoryboardPromptStage, type WorkflowUpstreamResult } from './workflow-prompts.js';
import { editingOutputSchema, legacyStoryboardJsonSchema, manualPlanningOutput, parseProductionDocument, productionDocumentContract, storyboardJsonSchema, validateProductionMediaOutput, validateProductionMediaPreview, WORKFLOW_OUTPUT_VERSION } from './workflow-outputs.js';
import { githubTrendingPrompt, githubTrendingRequest, githubTrendingSummary, validateGithubTrendingStoryboard } from './github-trending.js';
import { storyboardWebPrompt, storyboardWebRequest, type StoryboardWebReader, type StoryboardWebResearch } from './storyboard-research.js';
import { executeStoryboard, STORYBOARD_BATCH_SIZE, storyboardOutlineStage } from './storyboard-generation.js';
import { createModelResponses, ModelResponseValidationError } from './model-responses.js';
import { createRunProgress } from './run-progress.js';
import { creativeContextSchema, MediaRequestRejectedError, projectCharacterIds, shotCreativePrompt, validateCreativeReferences } from '@video-quickly/contracts';
import { executeMediaGraph } from './media-graph.js';
import { discoverModels, generateText, shouldRetryWithPromptFormat, testModelConnection, textIncompleteMessage, textModelWithTaskSchema, TextRequestRejectedError, type ModelRequestPhase, type TextProvider } from './providers.js';
import { seedExampleProject } from './seed.js';
import { seedBuiltInDramaTemplates } from './builtin-drama-templates.js';
import { createNativeVideoWorkflow, resolveProductionWorkflow, nativeReferenceStep, groupsNativeFirstFrames, groupsReferenceImages, isVideoGenerationNode, DEFAULT_AUDIO_PROCESSING, planReferenceImageSequences, planningDocumentSchemas, productionEditingSkillIds, productionEditingStep, productionPlanningStep, productionSettingsSchema, sameJsonContent, singleImageRequestModel, supportsProductionAgent, usesManualPlanning } from '@video-quickly/contracts';
import { createSkillLibrary } from './skill-library.js';
import { appendSkillContext, supportsSkillScript } from '@video-quickly/contracts';
import { connectMcp, mcpServerSchema, type McpServer } from './mcp.js';
import { createCostLedger, requestCostMetrics } from './costs.js';
import { createCharacterLibrary } from './characters.js';
import { createCharacterImageGenerator } from './character-image.js';
import { createExportBatchManager, verifyBatchRenderResult, type ExportBatchSnapshot } from './export-batches.js';
import { isLegacyTimelineAsset, omitLegacyExportTimeline } from './legacy-export-timeline.js';
import { validateResearchProject, researchPrompt, researchModelResponse } from './research.js';
import { createSeriesTemplateLibrary } from './series-templates.js';
import { usesFullAudioSource } from '@video-quickly/video/audio';
import { replaceShotMedia } from '@video-quickly/video/clip-edits';
import { trimShotInContext } from '@video-quickly/video/editing';
import { createAudioPreview, type AudioMixCallbacks } from './audio-preview.js';
import { createAssetLibrary } from './asset-library.js';
import { createAssetRecovery } from './asset-recovery.js';
import { hashFileSha256 } from './file-hash.js';
import { createProjectFileCleanup } from './project-file-cleanup.js';
import { createRunInspector, redactInspectionText } from './run-inspection.js';
import { createRunControl, runIdInput } from './run-control.js';
import { createRunStarter, regenerationInput, researchInput, shotRegenerationInput } from './run-start.js';
import type { FrozenProjectDocument, RunSnapshot } from './run-snapshot.js';
import { createLogger, logError, type DiagnosticLogger } from './logging.js';
import { createProjectReadiness } from './project-readiness.js';
import { validateExecutionModel } from './execution-model.js';
import { buildMediaPrompt, promptDraftSchema, resolvePromptBindings, supportsPromptExperiment, type PromptDraft, type PromptPreview, type PromptSession } from '@video-quickly/contracts';
import { createPromptLibrary } from './prompt-library.js';
import { createPromptWorkbench } from './prompt-workbench.js';
import { projectOriginalText, videoReferenceImages, type VideoReferenceReview } from '@video-quickly/contracts';
import { isChargeAction, isModelGenerationNode, type ChargeAction } from '@video-quickly/contracts';
import { chargePrompts, createChargeConfirmations } from './charge-confirmation.js';
import { plannedNodeCharge, summarizeCharge, type PlannedCharge } from './charge-estimate.js';
import { createImageTools } from './image-tools.js';
import { resolveImageEdit } from '@video-quickly/integrations/image-edit';
import { imageEditInputSchema, creativeReferenceAssetIds, getMediaAdapters, isCreativeReferenceAsset, needsComposedSceneFrame, singleFrameVideoModel, usesVideoSceneImage } from '@video-quickly/contracts';
import { prepareWorkflowAssistant, parseWorkflowAssistantResult } from './workflow-assistant.js';
import { workflowNodeSchema } from '@video-quickly/contracts';
import { legacyVideoAgentNode, videoEditingAgentNode, videoTaskNode } from './video-agent.js';
import { applyAgentTimelineEdits } from './video-agent-editing.js';
import type { AgentBusinessTools, AgentContinuation } from './agent.js';
import { agentToolOutputDirectory, materializeToolArtifact } from './tool-artifacts.js';
import { characterAppearanceShot, matchCastReferences, recurringCast } from './automatic-casting.js';
import { orderedNodes, resolveProductionNodes } from './production-nodes.js';

export { SimulatedProcessExit } from './activities.js';
export type { DiagnosticLogger } from './logging.js';
export type { RunSnapshot } from './run-snapshot.js';

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
  unifiedShotProfile?: boolean;
  legacyVideoReferences?: boolean;
  characters?: CharacterProfile[];
  promptOverride?: string;
  promptUpstream?: Record<string, JsonValue>;
  onProgress?: (value: number) => void;
  onAsset?: (asset: AssetRecord) => void;
  onDiagnostic?: (event: MediaDiagnosticEvent) => void;
  preparedAudioMix?: PreparedAudioMix;
  persistRemoteTask(id: string): void;
}

export interface RuntimeOptions {
  dataDirectory: string;
  requireChargeConfirmation?: boolean;
  logger?: DiagnosticLogger;
  mode?: 'desktop' | 'development';
  secretStore?: SecretStore;
  provider?: TextProvider;
  webResearch?: StoryboardWebReader;
  failpoint?: ActivityHooks['failpoint'];
  executeActivity?: (context: ActivityExecutionContext) => Promise<JsonValue>;
  preflightActivity?: (context: Pick<ActivityExecutionContext, 'project' | 'node' | 'assets' | 'model' | 'characters' | 'signal' | 'dataDirectory' | 'legacyVideoReferences'> & Partial<Pick<ActivityExecutionContext, 'operationId'>> & { pendingVideoInput?: boolean }) => void | Promise<void>;
  readAudioWaveform?: (asset: AssetRecord) => Promise<AudioWaveform>;
  audioMix?: AudioMixCallbacks;
  activitySafety?: (node: WorkflowNode) => ActivitySafety;
  hostCall?: (method: string, params: unknown) => Promise<unknown>;
  seed?: boolean;
  seedBuiltInTemplates?: boolean;
  ffmpegPath?: string;
}

const entityId = z.object({ projectId: z.string().min(1) });
const projectIdsInput = z.object({ projectIds: z.array(entityId.shape.projectId).min(1) });
const projectUpdateInput = entityId.extend({
  revision: z.number().int().optional(),
  patch: z.object({
    title: z.string().min(1).max(160).optional(),
    brief: z.string().max(30000).optional(),
    originalText: projectSchema.shape.originalText,
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
const chargeStartInput = entityId.extend({
  nodeId: z.string().optional(), parentRunId: z.string().optional(), selection: runSelectionSchema.optional(),
  regeneration: regenerationInput.optional(), research: researchInput.optional(),
});
const now = () => new Date().toISOString();

function rpcIdentifiers(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
    ['projectId', 'runId', 'nodeId', 'shotId', 'modelId', 'assetId'].includes(entry[0]) && typeof entry[1] === 'string'));
}

const regenerationKinds = {
  script: { nodeKind: 'script', capability: 'text', label: '脚本', protocols: ['openai-compatible', 'ollama', 'custom-http'] },
  image: { nodeKind: 'assets', capability: 'image', label: '画面', protocols: getMediaAdapters(['image']).map(adapter => adapter.id) },
  video: { nodeKind: 'animation', capability: 'video', label: '视频', protocols: getMediaAdapters(['video']).map(adapter => adapter.id) },
} as const;

function supportsRegenerationModel(model: ModelProfile | undefined, kind: keyof typeof regenerationKinds): model is ModelProfile {
  if (!model?.enabled) return false;
  const { capability, protocols } = regenerationKinds[kind];
  return model.capabilities.includes(capability) && protocols.some(provider => provider === model.provider);
}

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
  if (options.seedBuiltInTemplates) {
    try { seedBuiltInDramaTemplates(directory, store); }
    catch (error) { database.close(); throw error; }
  }
  const reads = createReadModels(database, store);
  const projectFiles = createProjectFileCleanup(directory, store, logger);
  projectFiles.resume();
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const active = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  // Native graph cancellation can finish invoke before a node's local commit.
  // Keep ownership of that work until it settles, before closing SQLite.
  const pendingWork = new Set<Promise<unknown>>();
  const projectFileUsers = new Map<string, number>();
  function trackWork<T>(work: () => Promise<T>, projectId?: string): Promise<T> {
    const promise = work(); pendingWork.add(promise);
    if (projectId) projectFileUsers.set(projectId, (projectFileUsers.get(projectId) ?? 0) + 1);
    const release = () => {
      pendingWork.delete(promise);
      if (!projectId) return;
      const remaining = (projectFileUsers.get(projectId) ?? 1) - 1;
      if (remaining) projectFileUsers.set(projectId, remaining);
      else projectFileUsers.delete(projectId);
    };
    void promise.then(release, release);
    return promise;
  }
  async function drainWork() {
    while (active.size || pendingWork.size) await Promise.allSettled([...Array.from(active.values(), value => value.promise), ...pendingWork]);
  }
  const transientSecrets = new Set<string>();
  function rememberSecret(value: string | undefined) { if (value) transientSecrets.add(value); return value; }
  let closing = false;
  let workspaceVersion = 0;
  const editorExports = new Map<string, AbortController>();
  const changed = () => { workspaceVersion++; emit({ type: 'workspace.changed' }); };
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
  const assetLibrary = createAssetLibrary({
    directory, database, store, reads, project, readAudioWaveform: options.readAudioWaveform?.bind(options), trackWork, changed,
    characterAssetsInUse: characters.assetsInUse,
    imageToolAssetsInUse: imageTools.assetsInUse,
    bindImportedAsset(projectId, shotId, asset) {
      const currentProject = project(projectId);
      if (!currentProject.shots.some(shot => shot.id === shotId)) throw new Error('镜头已移除，无法关联导入素材。');
      saveProject(bindMedia(currentProject, shotId, asset));
    },
  });
  const characterImages = createCharacterImageGenerator({ directory, store, journal, costs, execute: options.executeActivity, preflight: options.preflightActivity,
    async secret(model) { return model.credentialRef ? rememberSecret(await options.secretStore?.get(model.credentialRef)) : undefined; } });
  const promptWorkbench = createPromptWorkbench({ database, store, prepare: preparePromptDraft, changed, start: (session, saved) => startPromptRun(session.draft, saved, session), schedule });
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
    if (!supportsRegenerationModel(model, input.kind)) throw new Error(`请为镜头${configuration.label}重新生成选择可用的对应模型。`);
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
      if (await hashFileSha256(asset.path) !== asset.sha256) throw new Error('实验输入素材校验失败，请修复后重新预览。');
    }
  }

  async function validateCharacterAssets(profiles: CharacterProfile[], references: AssetRecord[], project: Pick<ProjectDocument, 'id' | 'creativeContext'>, shot?: Shot) {
    const libraryIds = new Set(profiles.flatMap(profile => profile.referenceAssetIds));
    const ids = new Set([...libraryIds, ...creativeReferenceAssetIds(project, shot)]);
    if (ids.size !== references.length || references.some(asset => !ids.has(asset.id) || !isCreativeReferenceAsset(project, asset) || libraryIds.has(asset.id) && asset.projectId !== undefined)) throw new Error('角色参考图快照无效。');
    for (const reference of references) {
      const info = await stat(reference.path).catch(() => undefined);
      if (!info?.isFile() || info.size !== reference.size) throw new Error('角色参考图缺失或损坏。');
      if (await hashFileSha256(reference.path) !== reference.sha256) throw new Error('角色参考图校验失败，请重新生成。');
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
    const row = database.prepare("SELECT json_extract(body, '$.regeneration') AS regeneration, json_extract(body, '$.characters') AS characters, json_extract(body, '$.characterAssets') AS characterAssets, json_extract(body, '$.sourceGeneration.inputProject.shots[0]') AS sourceShot, CASE WHEN json_type(body, '$.sourceGeneration') = 'object' THEN json_extract(body, '$.sourceGeneration.inputProject.creativeContext') WHEN json_type(body, '$.trial') = 'object' THEN json_extract(body, '$.trial.inputProject.creativeContext') ELSE json_extract(body, '$.project.creativeContext') END AS creativeContext FROM documents WHERE kind = 'run-snapshot' AND id = ?").get(candidate.runId) as { regeneration: string | null; characters: string | null; characterAssets: string | null; creativeContext: string | null; sourceShot: string | null } | undefined;
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
    await validateCharacterAssets(profiles, references, { id: candidate.projectId, creativeContext: row?.creativeContext ? creativeContextSchema.parse(JSON.parse(row.creativeContext)) : undefined }, row?.sourceShot ? shotSchema.parse(JSON.parse(row.sourceShot)) : undefined);
    if (candidate.kind === 'script') {
      if (candidate.assetIds.length) throw new Error('脚本候选包含无效素材。');
      return { candidate, assets: references };
    }
    const key = candidate.kind === 'image' ? 'assetId' : 'videoAssetId';
    if (candidate.assetIds.length !== 1 || candidate.shot[key] !== candidate.assetIds[0]) throw new Error('候选缺少相应的生成素材。');
    const asset = store.get<AssetRecord>('asset', candidate.assetIds[0]);
    const info = asset ? await stat(asset.path).catch(() => undefined) : undefined;
    if (!asset?.active || asset.projectId !== projectId || asset.shotId !== candidate.shotId || asset.kind !== candidate.kind || !info?.isFile() || info.size !== asset.size) throw new Error('候选素材缺失、已更改或不属于当前镜头。');
    if (await hashFileSha256(asset.path) !== asset.sha256) throw new Error('候选素材校验失败，请重新生成。');
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

  function validateMusicAssets(projectId: string, clips: NonNullable<ProjectDocument['musicClips']>) {
    for (const { assetId } of clips) {
      const asset = store.get<AssetRecord>('asset', assetId);
      if (!asset?.active || asset.kind !== 'audio' || asset.projectId && asset.projectId !== projectId) throw new Error('背景音乐需要当前项目或公共素材库中的有效音频。');
    }
  }

  function writeProject(value: ProjectDocument, baseline = project(value.id)) {
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
    return saved;
  }

  function saveProject(value: ProjectDocument, previous?: ProjectDocument) {
    const saved = writeProject(value, previous);
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
    return result && typeof result === 'object' && !Array.isArray(result) && Array.isArray(result.assets) ? z.array(assetSchema).parse(result.assets.filter(asset => !isLegacyTimelineAsset(asset))) : [];
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

  function productionOutput({ brief, style, creativeContext, shots, clipEditSources, clipEditPlans, musicClips, workflow }: ProjectDocument, includePlanningFields = false, includeTimelineEdits = false) {
    const manualPlanningFields = includePlanningFields ? workflow.production.manualPlanningFields : undefined;
    return { brief, style, creativeContext, shots, clipEditSources, clipEditPlans, ...(manualPlanningFields ? { manualPlanningFields } : {}),
      ...(includeTimelineEdits ? { musicClips, subtitleMode: workflow.production.subtitleMode } : {}) };
  }

  function projectWithProductionOutput(current: ProjectDocument, { manualPlanningFields, subtitleMode, ...fields }: ReturnType<typeof productionOutput>): ProjectDocument {
    const workflow = manualPlanningFields || subtitleMode !== undefined ? { ...current.workflow, production: { ...current.workflow.production,
      ...(manualPlanningFields ? { manualPlanningFields } : {}), ...(subtitleMode !== undefined ? { subtitleMode } : {}),
    } } : current.workflow;
    return { ...current, ...fields, workflow };
  }

  function projectContentDigest({ revision: _revision, updatedAt: _updatedAt, workflow, ...content }: ProjectDocument) {
    const production = productionSettingsSchema.safeParse(workflow.production);
    return fingerprint({ ...content, workflow: production.success ? resolveProductionWorkflow({ ...workflow, production: production.data }) : workflow });
  }

  function productionMediaIds(value: ProjectDocument) {
    return new Set([...value.shots.flatMap(shot => [shot.assetId, shot.audioAssetId, shot.videoAssetId, shot.captionTrack?.sourceAssetId]),
      ...(value.clipEditSources ?? []).flatMap(clipSourceAssetIds)].filter((id): id is string => Boolean(id)));
  }

  function generatedVideoShot(shot: Shot, asset: AssetRecord, durationUs = asset.durationUs ?? shot.durationUs): Shot {
    return { ...shot, videoAssetId: asset.id, audioAssetId: undefined, audioInUs: undefined, captionTrack: undefined, sceneTemplate: undefined,
      durationUs, sourceInUs: undefined, videoInUs: 0,
      audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, version: 2, videoAudio: { enabled: true, gainDb: 0 } } };
  }

  function readVideoPreview(run: RunSummary | undefined, knownKey: string) {
    if (!run?.currentNodeId || !['running', 'waiting_external', 'retry_scheduled'].includes(run.status)) return;
    const id = `${run.id}:${run.currentNodeId}`;
    const node = store.get<WorkflowNode>('node-definition', id);
    if (!node || !isVideoGenerationNode(node) || node.config.agentTask) return;
    const progress = runProgress.detail(id);
    if (!progress?.completed) return;
    const assets = new Map(progress.assets.filter(asset => asset.kind === 'video' && asset.projectId === run.projectId).map(asset => [asset.id, asset]));
    const completed = new Map<string, AssetRecord>();
    for (const shot of progress.shots) {
      const asset = shot.status === 'completed' && shot.assetId ? assets.get(shot.assetId) : undefined;
      if (asset?.shotId === shot.id && (asset.durationUs === undefined || shotSchema.shape.durationUs.safeParse(asset.durationUs).success)) completed.set(shot.id, asset);
    }
    if (!completed.size) return;
    const key = fingerprint({ id, assets: [...completed.values()].map(asset => [asset.id, asset.version, asset.sha256]) });
    if (key === knownKey) return { runId: run.id, key };
    const input = store.get<ProjectDocument>('node-project', id);
    if (!input) return;
    const shots = input.shots.map(shot => {
      const asset = completed.get(shot.id);
      // The preview shows a new recording from its start. Authored cuts are
      // applied only when the full step is committed by the normal binding path.
      return asset && !shot.locked ? { ...generatedVideoShot(shot, asset), clipEdit: undefined } : shot;
    });
    return { runId: run.id, key, project: { ...input, shots } };
  }

  type VideoApplicationReceipt = { nodeIds: string[]; projectDigest: string; outputDigest: string };

  function applyProductionResult(runId: string, saved: RunSnapshot, videoNodeId?: string) {
    if (saved.assistant || saved.trial || saved.regeneration || saved.research || saved.exportBatch) return;
    if (!videoNodeId && (saved.selection || !saved.nodes.some(node => node.kind === 'agent') && (saved.inspectionNodes ?? saved.nodes).filter(node => node.kind !== 'subflow').length < 2)) return;
    const videoApplication = store.get<VideoApplicationReceipt>('run-video-application', runId);
    if (store.get('run-application', runId) || videoNodeId && videoApplication?.nodeIds.includes(videoNodeId)) return;
    const working = store.get<ProjectDocument>('run-project', runId);
    if (!working) return;
    const includePlanningFields = saved.outputContractVersion === 2;
    const includeTimelineEdits = saved.nodes.some(node => node.id === saved.videoEditingAgentId && node.config.timelineEdits === true);
    const output = productionOutput(working, includePlanningFields, includeTimelineEdits), outputDigest = fingerprint(output);
    if (outputDigest === (videoApplication?.outputDigest ?? fingerprint(productionOutput(saved.project, includePlanningFields, includeTimelineEdits)))) return;
    const current = project(saved.project.id);
    // An identical save advances the revision but leaves the generation inputs intact.
    if (projectContentDigest(current) !== (videoApplication?.projectDigest ?? projectContentDigest(saved.project))) {
      recordEvent(runId, videoNodeId ? 'node.apply_conflict' : 'project.apply_conflict', '项目在制作期间已修改，生成结果已保留在步骤详情中。', videoNodeId);
      return;
    }
    requireCurrentCharacters(saved.characters ?? []);
    database.transaction(() => {
      if (output.musicClips && !sameJsonContent(output.musicClips, current.musicClips)) validateMusicAssets(current.id, output.musicClips);
      const applied = saveProject(projectWithProductionOutput(current, output), current);
      if (videoNodeId) store.put('run-video-application', runId, { nodeIds: [...videoApplication?.nodeIds ?? [], videoNodeId], projectDigest: projectContentDigest(applied), outputDigest });
      else store.put('run-application', runId, { revision: applied.revision });
    })();
    recordEvent(runId, 'project.applied', videoNodeId ? '生成的视频已自动应用到项目。' : '制作结果已自动保存到项目。', videoNodeId);
  }

  async function preparePromptDraft(draft: PromptDraft, prefill = false): Promise<{ saved: RunSnapshot; preview: PromptPreview }> {
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
          if (await hashFileSha256(asset.path) !== asset.sha256) throw new Error('上游素材缺失或损坏，请修复后重新预览。');
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
    await validateCharacterAssets(bundle.characters, bundle.assets, inputProject);
    const model = availableModels().find(model => model.id === node.modelId);
    const videoInputs = model && isVideoGenerationNode(node) ? inputProject.shots.map(shot => videoReferenceImages(inputProject, node, model, shot, bundle.characters, assets)) : undefined;
    const sceneImageIds = videoInputs ? videoInputs.flatMap(input => input.frame ? [input.frame.id] : []) : inputProject.shots.flatMap(shot => shot.assetId && usesVideoSceneImage(inputProject, node, model, shot, bundle.characters) ? [shot.assetId] : []);
    for (const id of sceneImageIds) if (!assets.some(asset => asset.id === id && asset.active && asset.kind === 'image')) throw new Error('镜头参考图不可用，请重新选择后预览。');
    const audioIds = node.kind === 'animation' && (!model || model.provider === 'seedance') ? inputProject.workflow.production.referenceAudioAssetIds ?? [] : [];
    for (const id of audioIds) if (!assets.some(asset => asset.id === id && asset.active && asset.kind === 'audio')) throw new Error('参考音频不可用，请重新选择后预览。');
    const referenceIds = videoInputs ? videoInputs.flatMap(input => input.referenceIds) : bundle.assets.map(asset => asset.id);
    const requiredAssetIds = new Set([...referenceIds, ...sceneImageIds, ...audioIds]);
    const byAssetId = new Map(assets.map(asset => [asset.id, asset]));
    const frozenAssets = [...requiredAssetIds].flatMap(id => {
      const asset = byAssetId.get(id);
      return asset ? [asset] : [];
    });
    if (frozenAssets.length !== requiredAssetIds.size) throw new Error('实验参考素材不完整，请重新选择后预览。');
    await validatePromptAssets(frozenAssets);
    const skills = await skillLibrary.prepare(node.skillIds);
    if (skills.length !== new Set(node.skillIds).size) throw new Error('选用的 Skill 不存在或已停用，请重新选择。');
    if (media && model) await options.preflightActivity?.({ project: inputProject, node, model, assets: frozenAssets, characters: bundle.characters, dataDirectory: directory, signal: new AbortController().signal });
    const values = Object.fromEntries(upstream.map(result => [result.nodeId, result.output]));
    const shot = inputProject.shots.length === 1 ? inputProject.shots[0] : undefined;
    const resolved = resolvePromptBindings(node, inputProject, shot, values);
    const hasImage = Boolean(shot?.assetId && sceneImageIds.includes(shot.assetId));
    const outputContractVersion = baseline.workflow.id === 'native-video' ? WORKFLOW_OUTPUT_VERSION : undefined;
    const batchedStoryboard = prefill && node.kind === 'script' && !baselineShot;
    const originalText = baselineShot ? undefined : projectOriginalText(inputProject);
    const prompt = media ? appendSkillContext(buildMediaPrompt(inputProject, node, shot!, bundle.characters, model, hasImage, values, true, videoInputs?.[0]), node, skills)
      : buildWorkflowPrompt(inputProject, node, skills, Boolean(baselineShot), bundle.characters, upstream, outputContractVersion,
        batchedStoryboard ? storyboardOutlineStage(inputProject, false) : undefined, { originalText });
    const references = frozenAssets.map(({ id, name, kind }) => ({ id, name, kind }));
    const preview: PromptPreview = { digest: '', prompt: withStoryboardTiming(prompt, node.kind), node, model, skills, projectRevision: baseline.revision, variables: resolved.variables, references, upstream: upstream.map(({ nodeId, label, kind }) => ({ nodeId, label, kind })) };
    const saved: RunSnapshot = { project: baseline, models: model ? [model] : [], skills, mcpServers: [], nodes: [node], handlerVersion: 1, unifiedShotProfile: true, characters: bundle.characters, characterAssets: bundle.assets, assets: frozenAssets,
      includeProjectOriginalText: true, useOriginalVideoReferences: true,
      ...(outputContractVersion ? { outputContractVersion } : {}), ...(batchedStoryboard ? { storyboardBatchSize: STORYBOARD_BATCH_SIZE } : {}), selection: { nodeId: node.id, mode: 'node' }, ...(candidate ? { regeneration: { shotId: baselineShot.id, baseline: baselineShot, kind } } : {}), trial: { inputProject, upstream, preview } };
    preview.digest = fingerprint(saved);
    requireRevision(project(draft.projectId), draft.projectRevision);
    return { saved, preview };
  }

  function startPromptRun(draft: PromptDraft, saved: RunSnapshot, session?: PromptSession): RunRecord {
    const current = project(draft.projectId); requireRevision(current, draft.projectRevision);
    if (current.archived) throw new Error('请先恢复项目。');
    if (batches.blocked(current.id) || projectBusy(current.id)) throw new Error('该项目已有未完成的运行，请先完成或停止现有任务。');
    const node = saved.nodes[0], model = saved.models.find(model => model.id === node.modelId);
    if (!model?.enabled) throw new Error('请选择可用模型后重新预览。');
    validateExecutionModel(node, model);
    const id = randomUUID(), timestamp = now();
    const record: RunRecord = { id, projectId: current.id, projectRevision: current.revision, workflowVersion: current.workflow.version, snapshotDigest: fingerprint(saved), purpose: 'prompt-trial', ...(session ? { promptSessionId: session.id, promptSessionRevision: session.revision } : {}), selection: saved.selection, stepCount: 1, status: 'queued', createdAt: timestamp, updatedAt: timestamp, events: [], activities: [] };
    store.put('run-snapshot', id, saved); store.put('run', id, record);
    recordEvent(id, 'run.created', session ? '提示词实验快照已保存，结果等待手动应用。' : 'AI 填写草稿已开始。');
    return record;
  }

  function projectAfterNode(value: ProjectDocument, node: WorkflowNode, result: JsonValue, assets: AssetRecord[], videoDurations?: ReadonlyMap<string, number>): ProjectDocument {
    let working = value;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      if ((node.kind === 'brief' || node.kind === 'style') && typeof result.text === 'string') {
        working = { ...working, [node.kind]: result.text };
        const fields = planningDocumentSchemas[node.kind].safeParse(result.fields);
        if (fields.success) {
          const workflow = working.workflow, production = workflow.production;
          working = { ...working, workflow: { ...workflow, production: { ...production, manualPlanningFields: { ...production.manualPlanningFields, [node.kind]: fields.data } } } };
        }
      }
      if (node.kind === 'script' && Array.isArray(result.shots)) {
        const shots = z.array(shotSchema).parse(result.shots);
        if (value.shots.some((shot, index) => shot.locked && !isDeepStrictEqual(shot, shots[index]))) throw new LockedShotChangeError();
        working = { ...working, shots, ...(result.creativeContext ? { creativeContext: creativeContextSchema.parse(result.creativeContext) } : {}) };
      }
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
      if (asset.kind === 'video' && isVideoGenerationNode(node)) working = { ...working, shots: working.shots.map(item => item.id === asset.shotId ? generatedVideoShot(item, asset, videoDurations?.get(item.id)) : item) };
    }
    validateCreativeReferences(working);
    return working;
  }

  function applyMediaResult(current: ProjectDocument, input: ProjectDocument, node: WorkflowNode, result: JsonValue, assets: AssetRecord[]): ProjectDocument {
    const originalShots = new Map(input.shots.map(shot => [shot.id, shot]));
    const currentShots = new Map(current.shots.map(shot => [shot.id, shot]));
    const pending: AssetRecord[] = [];
    const fieldsByShot = new Map<string, Set<keyof Shot>>();
    const videoDurations = new Map<string, number>();
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
      const generatedVideo = asset.kind === 'video' && isVideoGenerationNode(node);
      fields.add(binding);
      if (asset.kind === 'audio' || asset.kind === 'video') {
        fields.add('sourceInUs'); fields.add('clipEdit');
        fields.add(asset.kind === 'audio' ? 'audioInUs' : 'videoInUs');
        if (original.clipEdit) fields.add('captionTrack');
        // A new video can cover an edited storyboard duration without rebasing any existing cut.
        const keepDuration = generatedVideo && shot.durationUs !== original.durationUs && !shot.videoAssetId && !shot.clipEdit
          && (shot.videoInUs ?? shot.sourceInUs ?? 0) === 0 && asset.durationUs !== undefined && shot.durationUs <= asset.durationUs;
        if (keepDuration) videoDurations.set(shot.id, shot.durationUs);
        else fields.add('durationUs');
      }
      if (generatedVideo) {
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
    return pending.length ? projectAfterNode(current, node, result, pending, videoDurations) : current;
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
  function availableModels(): ModelProfile[] { return store.list<ModelProfile>('model'); }

  function validateCompositionUpdate(value: WorkflowDefinition, previous: WorkflowDefinition) {
    validateWorkflow(value);
    for (const definition of value.subflows ?? []) {
      const before = previous.subflows?.find(item => item.id === definition.id && item.version === definition.version);
      if (before && !isDeepStrictEqual(before, definition)) throw new Error('已引用的子流程版本不能原地修改，请保存并插入新版本。');
      const library = store.get<{ definition: SubflowDefinition }>('workflow-template-version', `${definition.id}@${definition.version}`);
      if (library && !isDeepStrictEqual(library.definition, definition)) throw new Error('子流程副本与固定版本不一致，请重新插入。');
    }
  }

  function videoEditingAgent(value: ProjectDocument, models: ModelProfile[], mcpServers: McpServer[]): WorkflowNode | undefined {
    const step = productionEditingStep(value.workflow);
    const { textModelId, agentMcpServerIds } = value.workflow.production;
    const model = models.find(model => model.id === textModelId && supportsProductionAgent(model));
    if (!step || !model) return;
    const agentSkillIds = productionEditingSkillIds(value.workflow);
    const hasConnection = mcpServers.some(server => server.enabled && (!agentMcpServerIds.length || agentMcpServerIds.includes(server.id)));
    // Plain library Skills can inform an explicitly bound project. With no
    // bindings, an enabled tool gives the editing Agent work beyond the preset.
    const hasSkill = store.list<SkillPackage>('skill').some(skill => skill.enabled && (agentSkillIds.length
      ? agentSkillIds.includes(skill.id) : skill.tools.some(tool => tool.enabled && supportsSkillScript(tool.id))));
    return hasConnection || hasSkill ? videoEditingAgentNode(step, model.id, { agentSkillIds, agentMcpServerIds }) : undefined;
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
    if (batches.blocked(value.id)) return { category: 'project', message: '该项目已有未完成的批量导出，请继续或停止该批次。', fix: 'batch-export' };
    if (projectBusy(value.id)) return { category: 'project', message: '该项目已有未完成的任务，请继续或停止现有任务。', fix: 'production' };
    const ids = new Set(nodes.map(node => node.id));
    const unavailableBinding = nodes.find(node => node.kind === 'subflow' && Object.values(node.subflow?.inputs ?? {}).some(binding => 'nodeId' in binding && !ids.has(binding.nodeId)));
    if (unavailableBinding) return { category: 'workflow', nodeId: unavailableBinding.id, message: '子流程输入引用了范围外的上游产物，请包含上游步骤或改用明确输入值。', fix: 'step' };
    return undefined;
  }
  async function prepareRunSelection(value: ProjectDocument, selection: RunSelection): Promise<{ plan: RunPlan; saved: RunSnapshot }> {
    const { nodes } = resolveProductionNodes(value, { selection });
    const ids = new Set(nodes.map(node => node.id));
    const composedNodes = workflowNodesWithSubflows({ ...value.workflow, nodes });
    const modelIds = new Set(composedNodes.flatMap(node => node.modelId ? [node.modelId] : []));
    const bundle = characters.profilesFor(value);
    const saved: RunSnapshot = {
      project: structuredClone(value), nodes, selection, handlerVersion: nodes.some(node => node.kind === 'subflow') ? 3 : 2,
      unifiedShotProfile: true,
      includeProjectOriginalText: true,
      useOriginalVideoReferences: true,
      ...(value.workflow.id === 'native-video' ? { outputContractVersion: WORKFLOW_OUTPUT_VERSION } : {}),
      ...(value.workflow.id === 'native-video' && nodes.some(node => node.kind === 'script' && node.modelId) ? { storyboardBatchSize: STORYBOARD_BATCH_SIZE } : {}),
      models: availableModels().filter(model => composedNodes.some(node => node.kind === 'agent') || modelIds.has(model.id)),
      ...await skillLibrary.prepareForNodes(composedNodes, { allowUnavailable: true }),
      mcpServers: store.list<McpServer>('mcp-server'), characters: bundle.characters, characterAssets: bundle.assets,
      assets: store.list<AssetRecord>('asset').filter(asset => !asset.projectId || asset.projectId === value.id),
    };
    const missingModel = composedNodes.find(node => node.modelId && !saved.models.some(model => model.id === node.modelId && model.enabled));
    const missingSkill = composedNodes.find(node => node.skillIds.some(id => !saved.skills.some(skill => skill.id === id && skill.enabled)));
    let blockedReason = productionBlockIssue(value, nodes)?.message || (missingModel ? `「${missingModel.label}」的模型不可用，请重新选择模型。` : missingSkill ? `「${missingSkill.label}」选用的 Skill 不可用，请重新选择。` : '');
    if (!blockedReason) {
      try { for (const node of nodes) manualPlanningOutput(value, node); }
      catch (error) { blockedReason = error instanceof Error ? error.message : '手动策划内容校验失败。'; }
    }
    const hasConditions = workflowEdgesWithSubflows({ ...value.workflow, nodes, edges: value.workflow.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) }).some(edge => Boolean(edge.condition));
    const work = blockedReason ? [] : workflowChargeWork(value, composedNodes, saved.models, { hasConditions });
    return { saved, plan: {
      projectId: value.id, projectTitle: value.title, projectRevision: value.revision, workflowVersion: value.workflow.version,
      selection, digest: fingerprint(saved),
      steps: composedNodes.map(node => ({ id: node.id, label: node.label, kind: node.kind, requiresReview: false, modelName: node.modelId ? saved.models.find(model => model.id === node.modelId)?.name ?? '模型不可用' : undefined })),
      boundary: value.workflow.edges.filter(edge => !ids.has(edge.source) && ids.has(edge.target)).map(edge => ({
        sourceId: edge.source, sourceLabel: value.workflow.nodes.find(node => node.id === edge.source)?.label ?? edge.source,
        targetId: edge.target, targetLabel: value.workflow.nodes.find(node => node.id === edge.target)?.label ?? edge.target,
      })),
      shotCount: value.shots.length, lockedShotCount: value.shots.filter(shot => shot.locked).length,
      hasConditions, blockedReason, ...(work.length ? { chargeEstimate: summarizeCharge(work) } : {}),
    } };
  }

  const readiness = createProjectReadiness({ system, directory, hasMediaExecutor: Boolean(options.executeActivity), preflight: options.preflightActivity,
    redactText: (text, models) => redactError(text, models, transientSecrets),
    snapshot(projectId, selection) {
      const value = project(projectId), models = availableModels();
      const { nodes } = resolveProductionNodes(value, {
        selection,
        editingAgent: () => videoEditingAgent(value, models, store.list<McpServer>('mcp-server')),
        automaticCasting: Boolean(options.executeActivity),
      });
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
    return { projects: store.list<ProjectDocument>('project'), models: availableModels(), skills: store.list<SkillPackage>('skill'), skillGroups: skillLibrary.groups(), skillImports: skillLibrary.jobs(), runs: store.list<RunRecord>('run').map(hydrateRun).reverse(), assets: store.list<AssetRecord>('asset').filter(asset => !isLegacyTimelineAsset(asset)), events: events(), system };
  }

  function agentBusinessTools(runId: string, parent: WorkflowNode, saved: RunSnapshot, controller: AbortController, skills: SkillPackage[], autonomous: boolean): AgentBusinessTools {
    const readProject = () => store.get<ProjectDocument>('run-project', runId) ?? saved.project;
    const snapshotAssets = saved.assets && new Map(saved.assets.map(asset => [asset.id, asset]));
    const listAudioAssets: AgentBusinessTools['listAudioAssets'] = parent.config.timelineEdits === true ? ({ before, limit }) => {
      const page = reads.assets({ projectId: saved.project.id, kind: 'audio', before, limit });
      const items = page.items.filter(asset => !snapshotAssets || snapshotAssets.has(asset.id)).map(({ id, name, projectId, durationUs }) => ({
        id, name, scope: projectId === undefined ? 'library' : 'project', ...(durationUs === undefined ? {} : { durationUs }),
      }));
      return { items, nextCursor: page.nextCursor };
    } : undefined;
    // LangChain may dispatch several tool calls together. Project mutations must
    // retain the same serial ordering as the existing workflow executor.
    let pending: Promise<unknown> = Promise.resolve();
    let fatalError: unknown;
    let stopped = false;
    return { readProject,
      models: saved.models.filter(model => model.enabled).map(({ id, name, capabilities }) => ({ id, name, capabilities })),
      ...(autonomous ? { isComplete: () => store.get<{ projectDigest: string }>('agent-export', `${runId}:${parent.id}`)?.projectDigest === fingerprint(readProject()) } : { operations: ['image', 'video', 'edit', 'import'] as const }),
      // Pending tool calls in older snapshots still use the original edit schema.
      boundaryTransitions: parent.config.boundaryTransitions === true,
      listAudioAssets,
      execute(input) {
        const work = pending.then(async () => {
          if (stopped) throw fatalError;
          controller.signal.throwIfAborted();
          if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.requestId)) throw new Error('requestId 需要 1–100 位字母、数字、下划线或连字符。');
          if (!autonomous && ['image', 'video'].includes(input.operation) && !input.shotId) throw new Error('剪辑阶段重新生成素材时，请指定单个镜头。');
          if ((input.transitions || input.timeline) && input.operation !== 'edit') throw new Error('请用 edit 操作调整剪辑。');
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
              const musicAssets = new Map<string, AssetRecord>();
              result = await journal.execute(runId, node.id, input, 'local', async () => {
                if (input.operation === 'import') {
                  if (!input.shotId) throw new Error('导入素材需要目标镜头编号。');
                  const localOutputDirectory = input.path === undefined ? undefined : await agentToolOutputDirectory(directory, runId);
                  const path = await materializeToolArtifact(input, join(directory, 'projects', previous.id, 'tool-artifacts'), controller.signal, { localOutputDirectory, ffmpegPath: options.ffmpegPath });
                  try {
                    const asset = await assetLibrary.importToolAsset({ path, projectId: previous.id, shotId: input.shotId, name: input.path && basename(input.path) });
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
                const { timeline, transitions } = input;
                const needsTiming = Boolean(timeline || transitions?.length);
                const audioIds = needsTiming ? edited.shots.flatMap(shot => shot.audioAssetId && usesFullAudioSource(shot) ? [shot.audioAssetId] : []) : [];
                const assets = [...new Set(audioIds)].flatMap(id => {
                  const asset = snapshotAssets?.get(id) ?? store.get<AssetRecord>('asset', id);
                  return asset ? [asset] : [];
                });
                const output = needsTiming
                  ? await applyAgentTimelineEdits(edited, timeline, transitions, { assets, ffmpegPath: options.ffmpegPath, signal: controller.signal, getMusicAsset(id) {
                    const asset = snapshotAssets ? snapshotAssets.get(id) : store.get<AssetRecord>('asset', id);
                    if (asset) musicAssets.set(id, asset);
                    return asset;
                  } })
                  : { editedProject: edited };
                controller.signal.throwIfAborted();
                validateEdits(output.editedProject, previous);
                return output as unknown as JsonValue;
              }, output => {
                requireCandidateAssets([...musicAssets.values()]);
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

  type PreparedCasting = { project: ProjectDocument; assets: AssetRecord[]; libraryAssets: AssetRecord[]; frameModelId?: string };

  function readCasting(runId: string): PreparedCasting | undefined {
    const record = journal.get(runId, 'assets:casting');
    return record?.status === 'completed' && record.result ? JSON.parse(record.result) as PreparedCasting : undefined;
  }

  async function prepareCasting(runId: string, node: WorkflowNode, saved: RunSnapshot, project: ProjectDocument, signal: AbortSignal): Promise<PreparedCasting | undefined> {
    const execute = options.executeActivity;
    const video = saved.nodes.find(item => item.id === 'video' && isVideoGenerationNode(item));
    if (!execute || !video) return;
    const videoModel = saved.models.find(model => model.id === video.modelId);
    const profiles = saved.characters ?? [];
    const cast = recurringCast(project, profiles);
    const mode = node.config.referenceMode;
    const needsSceneFrame = (value: ProjectDocument, shot: Shot) => !saved.useOriginalVideoReferences && !shot.locked && singleFrameVideoModel(videoModel, value) && needsComposedSceneFrame(value, shot, profiles);
    const bindingsChanged = cast.project.shots.some((shot, index) => shot !== project.shots[index]);
    if (!cast.missing.length && !bindingsChanged && (mode === 'generate' || !cast.project.shots.some(shot => needsSceneFrame(cast.project, shot)))) return;
    const allowImplicitModel = !saved.useOriginalVideoReferences || !nativeReferenceStep(project.workflow);
    const input = { project, video, videoModel, modelId: node.modelId ?? (allowImplicitModel ? project.workflow.production.imageModelId : undefined) };
    const libraryAssets = await journal.execute(runId, `${node.id}:casting:matches`, { projectId: project.id, roles: cast.missing }, 'local', async () => {
      if (!cast.missing.length) return [];
      return matchCastReferences(cast.missing, profiles, store.list<CharacterProfile>('character'), store.list<AssetRecord>('asset'), signal);
    });
    return journal.execute<PreparedCasting>(runId, `${node.id}:casting`, input, 'local', async () => {
      const references = new Map(libraryAssets.map(({ key, asset }) => [key, asset]));
      requireCandidateAssets([...references.values()]);
      const assets = [...new Map([
        ...(saved.assets ?? store.list<AssetRecord>('asset')).filter(asset => !asset.projectId || asset.projectId === project.id),
        ...saved.characterAssets ?? [], ...references.values(),
      ].map(asset => [asset.id, asset])).values()];
      const missing = cast.missing.filter(role => !references.has(role.key));
      const configuredModel = castingImageModel(saved.models, input.modelId, allowImplicitModel);
      const imageModel = configuredModel && (node.config.useFirstShotReference === true || groupsNativeFirstFrames(project.workflow, node))
        ? singleImageRequestModel(configuredModel) : configuredModel;
      const canGenerate = Boolean(imageModel) || allowImplicitModel;
      const generate = async (kind: 'looks' | 'frames', imageProject: ProjectDocument, imageAssets: AssetRecord[]) => {
        if (!imageModel) throw new Error('生成定妆图或合成镜头首帧需要图片模型。请在「制作设置 → 模型与素材」选择可用的图片模型，再开始制作。');
        const task = workflowNodeSchema.parse({ id: `${node.id}:casting:${kind}`, kind: 'assets', label: kind === 'looks' ? '人物定妆' : '角色镜头首帧',
          modelId: imageModel.id, prompt: kind === 'looks' ? '生成统一的人物定妆参考。' : node.prompt, config: { operation: 'prepare-references', referenceMode: 'generate' }, position: node.position });
        validateExecutionModel(task, imageModel);
        const apiKey = imageModel.credentialRef ? rememberSecret(await options.secretStore?.get(imageModel.credentialRef)) : undefined;
        if (imageModel.hasSecret && !apiKey) throw new Error('自动定妆的图片模型凭据不可用，请重新保存模型连接。');
        const operationId = `${runId}:${task.id}`;
        await options.preflightActivity?.({ project: imageProject, node: task, assets: imageAssets, model: imageModel, characters: profiles, signal, dataDirectory: directory, operationId });
        return journal.execute(runId, task.id, { project: imageProject, model: imageModel, references: imageAssets.map(asset => [asset.id, asset.sha256]) }, options.activitySafety?.(task) ?? 'external', async context => {
          recordEvent(runId, 'node.casting', `${task.label} · ${imageProject.shots.length} 张`, node.id);
          costs.begin({ operationId, runId, nodeId: node.id, projectId: project.id, model: imageModel, capability: 'image', requestMetrics: requestCostMetrics(imageProject, task, imageModel) });
          try {
            const result = validateProductionMediaOutput(await execute({ project: imageProject, node: task, runId, operationId, signal, dataDirectory: directory,
              remoteTaskId: context.remoteId, persistRemoteTask: context.recordRemoteId, assets: imageAssets, model: imageModel, apiKey, characters: profiles }), 'image', imageProject);
            const usage = providerUsageSchema.safeParse(result && typeof result === 'object' && !Array.isArray(result) ? result.providerUsage : undefined);
            costs.status(operationId, 'completed', usage.success ? usage.data : undefined);
            return nodeResultAssets(result);
          } catch (error) {
            if (!(error instanceof SimulatedProcessExit)) costs.status(operationId, signal.aborted ? 'canceled' : error instanceof MediaRequestRejectedError ? 'failed' : 'unknown');
            throw error;
          }
        });
      };
      const looks = canGenerate && missing.length ? await generate('looks', { ...project, creativeContext: undefined, shots: missing.map(characterAppearanceShot) }, []) : [];
      const appearances = looks.map(({ shotId, ...asset }) => {
        const role = missing.find(item => item.key === shotId)!;
        const look = { ...asset, name: `${role.name} · 定妆图.png` };
        references.set(role.key, look);
        return look;
      });
      const creativeContext = cast.project.creativeContext && { ...cast.project.creativeContext, entities: cast.project.creativeContext.entities.map(entity => {
        const asset = references.get(entity.key);
        return asset ? { ...entity, referenceAssetIds: [asset.id] } : entity;
      }) };
      const prepared = { ...cast.project, creativeContext };
      const frames = mode !== 'generate' ? prepared.shots.filter(shot => needsSceneFrame(prepared, shot)
        && (mode === 'none' || !assets.some(asset => asset.id === shot.assetId && asset.active && asset.kind === 'image'))) : [];
      const frameReferences = new Set(frames.flatMap(shot => [...creativeReferenceAssetIds(prepared, shot),
        ...profiles.filter(profile => shot.characterIds?.includes(profile.id)).flatMap(profile => profile.referenceAssetIds)]));
      const frameAssets = canGenerate && frames.length ? await generate('frames', { ...prepared, shots: frames }, [...assets, ...appearances].filter(asset => frameReferences.has(asset.id))) : [];
      const firstFrames = new Map(frameAssets.map(asset => [asset.shotId, asset.id]));
      const shots = prepared.shots.map(shot => firstFrames.has(shot.id) ? { ...shot, assetId: firstFrames.get(shot.id) } : shot);
      return { project: { ...prepared, shots }, assets: [...appearances, ...frameAssets],
        libraryAssets: libraryAssets.map(({ asset }) => asset), ...(frameAssets.length ? { frameModelId: imageModel?.id } : {}) };
    });
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
    const frozenInput = store.get<ProjectDocument>('node-project', `${runId}:${node.id}`);
    const initialProject = frozenInput ?? store.get<ProjectDocument>('run-project', runId) ?? saved.sourceGeneration?.inputProject ?? saved.trial?.inputProject ?? scopedProject;
    const casting = node.id === 'assets' && node.config.automaticCasting === true && !frozenInput
      ? await prepareCasting(runId, node, saved, initialProject, controller.signal) : readCasting(runId);
    const executionProject: FrozenProjectDocument = node.id === 'assets' && !frozenInput ? casting?.project ?? initialProject : initialProject;
    const nativeFirstFrames = groupsNativeFirstFrames(executionProject.workflow, node);
    const mediaProject = node.config.agentTask && typeof node.config.shotId === 'string'
      ? { ...executionProject, shots: executionProject.shots.filter(shot => shot.id === node.config.shotId) }
      : nativeFirstFrames || node.config.useFirstShotReference === true && groupsReferenceImages(node)
        ? { ...executionProject, shots: executionProject.shots.filter(shot => !shot.locked) } : executionProject;
    // Keep locked shots as group boundaries without expecting newly generated assets for them.
    const mediaInputProject = nativeFirstFrames ? executionProject : mediaProject;
    store.put('node-project', `${runId}:${node.id}`, executionProject);
    if (saved.trial || saved.sourceGeneration) await validatePromptAssets(saved.assets ?? []);
    if (node.config.imageEdit !== undefined && (!saved.regeneration?.imageEdit || fingerprint(node.config.imageEdit) !== fingerprint(saved.regeneration.imageEdit))) throw new Error('局部改图输入须由镜头候选冻结，请重新选择改图区域。');
    const selectedModel = node.modelId ? saved.models.find(model => model.id === node.modelId) : undefined;
    validateExecutionModel(node, selectedModel);
    const usesProvider = !!selectedModel && ['brief', 'research', 'style', 'script', 'agent'].includes(node.kind);
    const storyboardBatchSize = usesProvider && node.kind === 'script' && !saved.regeneration ? saved.storyboardBatchSize : undefined;
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
      ...casting?.assets ?? [],
      ...casting?.libraryAssets ?? [],
    ].map(asset => [asset.id, asset])).values()] : [];
    if (media && selectedModel) await options.preflightActivity?.({ project: mediaInputProject, node, assets: activityAssets, model: selectedModel, characters: executionCharacters, signal: controller.signal, dataDirectory: directory, operationId: `${runId}:${node.id}`, legacyVideoReferences: !saved.useOriginalVideoReferences });
    if (media && cached?.status === 'completed' && cached.result) {
      const result: unknown = JSON.parse(cached.result);

      const cachedAssets = result && typeof result === 'object' && 'assets' in result && Array.isArray(result.assets) ? result.assets : [];
      let invalid = false;
      for (const candidate of cachedAssets) {
        if (node.kind === 'export' && isLegacyTimelineAsset(candidate)) continue;
        const asset = assetSchema.parse(candidate);
        const bytes = await readFile(asset.path).catch(() => undefined);
        if (!bytes || bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) { invalid = true; break; }
      }
      if (invalid) {
        if (safety === 'external') throw new Error('已完成的生成素材缺失或损坏，请显式重新生成此镜头；恢复不会重新提交模型请求。');
        database.prepare("UPDATE activities SET status = 'failed', result = NULL, error = '本地渲染文件需要重建' WHERE run_id = ? AND activity_id = ?").run(runId, node.id);
      }
    }
    const deepAgent = node.kind === 'agent' && supportsProductionAgent(selectedModel);
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
    const fixedOutputs = Boolean(saved.outputContractVersion);
    const document = productionDocumentContract(node, saved.outputContractVersion);
    const scriptJsonSchema = fixedOutputs ? storyboardJsonSchema : legacyStoryboardJsonSchema;
    const outputSchema = node.kind === 'script' && !storyboardBatchSize ? scriptJsonSchema : document?.jsonSchema;
    const input = { project: executionProject, node, model: selectedModel ?? null, skills: saved.skills.filter(skill => node.skillIds.includes(skill.id)), handlerVersion: saved.handlerVersion, ...(fixedOutputs ? { outputContractVersion: saved.outputContractVersion } : {}), ...(storyboardBatchSize ? { storyboardBatchSize } : {}), ...(saved.unifiedShotProfile ? { unifiedShotProfile: true } : {}), ...(saved.exportBatch ? { exportBatch: saved.exportBatch, assets: saved.assets } : {}), ...(githubTrending ? { githubTrending } : {}), ...(webResearch ? { webResearch } : {}) };
    const retryIssues = outputSchema ? modelResponses.retryIssues(`${runId}:${node.id}`) : undefined;
    const upstream = usesProvider && !saved.assistant && !researchContext ? upstreamResults(runId, node, saved) : [];
    const originalText = saved.includeProjectOriginalText ? projectOriginalText(saved.trial?.inputProject ?? saved.project)
      : saved.includeEpisodeOriginalText ? (saved.project.episode ?? saved.project.episodeSource)?.originalText : undefined;
    const workflowPrompt = (project: ProjectDocument, stage?: StoryboardPromptStage) => buildWorkflowPrompt(project, node, saved.skills, Boolean(saved.regeneration), executionCharacters, upstream, saved.outputContractVersion, stage,
      { unifiedShotProfile: Boolean(saved.unifiedShotProfile), originalText, originalTextLabel: saved.includeProjectOriginalText ? '项目原文' : '本集原文' });
    const outlineStage = storyboardBatchSize ? storyboardOutlineStage(executionProject, Boolean(githubTrending), node.config.automaticCasting === true) : undefined;
    const originalScript = outlineStage && node.config.automaticCasting === true && !(saved.includeProjectOriginalText && originalText?.trim())
      ? (saved.includeProjectOriginalText ? saved.project.brief : saved.project.episode?.originalText || saved.project.brief).trim() : '';
    const basePrompt = saved.assistant ? node.prompt
      : researchContext ? researchPrompt(executionProject, node, saved.skills, researchContext)
      : usesProvider ? [workflowPrompt(executionProject, outlineStage),
        originalScript && originalScript !== executionProject.brief ? `项目原始剧本或创作要求：\n${originalScript}` : ''].filter(Boolean).join('\n\n') : '';
    const webPrompt = githubTrending ? githubTrendingPrompt(githubTrending) : webResearch ? storyboardWebPrompt(webResearch) : '';
    const resultLabel = document?.label ?? '分镜';
    const correction = retryIssues?.length ? `\n\n上次${resultLabel}返回的字段校验错误：${JSON.stringify(retryIssues)}\n本次请修正上述字段，${document ? '' : '仍依据本次已完成的简报与风格'}返回完整 JSON 对象，不要只返回修补片段。` : '';
    const prompt = `${basePrompt}${webPrompt ? `\n\n${webPrompt}` : ''}${correction}`;
    if (!cached || cached.status === 'prepared') runInspector.captureInput(runId, node.id, { inputHash: fingerprint(input), recordedAt: now(),
      prompt: usesProvider || saved.trial ? redactInspectionText(saved.trial?.preview.prompt ?? withStoryboardTiming(prompt, node.kind), text => redactError(text, saved.models, transientSecrets, Number.POSITIVE_INFINITY)) : undefined });
    const capability: ModelCapability | undefined = node.kind === 'assets' ? 'image' : node.kind === 'animation' ? 'video' : usesProvider ? 'text' : undefined;
    const responseAttempt = outputSchema ? modelResponses.attempt(`${runId}:${node.id}`) : undefined;
    const costOperation = selectedModel && capability && !deepAgent && !storyboardBatchSize ? `${runId}:${node.id}${responseAttempt ? `:response:${responseAttempt}` : ''}` : undefined;
    if (costOperation && selectedModel && capability) {
      const existing = costs.get(costOperation);
      if (cached?.status !== 'completed' || existing) costs.begin({ operationId: costOperation, runId, nodeId: node.id, shotId: saved.regeneration?.shotId ?? (typeof node.config.shotId === 'string' ? node.config.shotId : undefined), projectId: saved.project.id, model: selectedModel, capability, requestMetrics: requestCostMetrics(executionProject, node, selectedModel, executionCharacters) });
      if (cached?.status === 'completed' && existing) costs.status(costOperation, 'completed');
    }
    try {
    const result = await journal.execute(runId, node.id, input, storyboardBatchSize ? 'local' : safety, async context => {
      runProgress.begin(context.operationId, mediaProject, selectedModel && node.kind === 'assets' ? 'image' : selectedModel && isVideoGenerationNode(node) ? 'video' : undefined, activityAssets);
      if (usesProvider) {
        runProgress.phase(context.operationId, 'requesting');
        const requestText = async (request: { prompt: string; operationId: string; outputSchema?: Record<string, unknown>; outputSchemaName?: string }, receipt?: { operationId: string; attempt: number }) => {
          runProgress.phase(context.operationId, 'requesting');
          // Apply timing guidance after the storyboard journal has fingerprinted its prompt.
          const modelPrompt = withStoryboardTiming(request.prompt, node.kind);
          if (request.outputSchema) runInspector.captureInput(runId, node.id, { inputHash: fingerprint(input), recordedAt: now(), prompt: redactInspectionText(modelPrompt, text => redactError(text, saved.models, transientSecrets, Number.POSITIVE_INFINITY)) });
          const started = performance.now();
          let requestPhase: ModelRequestPhase | undefined;
          nodeLogger.info('provider.request_started', { phase: 'submit' });
          try {
            const model = storyboardBatchSize && request.outputSchema && request.outputSchemaName
              ? textModelWithTaskSchema(selectedModel, request.outputSchema, request.outputSchemaName) : selectedModel;
            const usePromptFormat = () => {
              modelResponses.usePromptFormat(context.operationId);
              nodeLogger.info('provider.output_format_fallback');
            };
            let promptOutputFormat = Boolean(request.outputSchema) && modelResponses.promptFormat(context.operationId);
            if (request.outputSchema && !promptOutputFormat && receipt && receipt.attempt > 1) {
              const previous = modelResponses.current(receipt.operationId, receipt.attempt - 1)?.response;
              if (shouldRetryWithPromptFormat(model, previous)) {
                usePromptFormat();
                promptOutputFormat = true;
              }
            }
            const result = await (options.provider ?? generateText)({ ...request, prompt: modelPrompt, model, secret, signal: controller.signal, promptOutputFormat, onOutputFormatFallback: usePromptFormat, onRequestPhase: phase => {
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
        if (storyboardBatchSize) {
          const storyboard = await executeStoryboard({
            journal, responses: modelResponses, progress: runProgress, runId, nodeId: node.id, inputHash: fingerprint(input), batchSize: storyboardBatchSize,
            project: executionProject, characters: executionCharacters, ranking: githubTrending, signal: controller.signal, safety, outlinePrompt: prompt, automaticCasting: node.config.automaticCasting === true,
            batchPrompt: (stage, creativeContext, repositories) => {
              const sources = githubTrending ? `本批对应的 GitHub Trending 资料：${JSON.stringify(repositories)}` : webPrompt;
              return [workflowPrompt({ ...executionProject, creativeContext }, stage), sources].filter(Boolean).join('\n\n');
            },
            canRetryWithPromptFormat: response => !modelResponses.promptFormat(context.operationId) && shouldRetryWithPromptFormat(selectedModel, response),
            request: async ({ operationId, attempt, ...request }) => {
              const id = `${operationId}:response:${attempt}`;
              costs.begin({ operationId: id, runId, nodeId: node.id, projectId: saved.project.id, model: selectedModel, capability: 'text', requestMetrics: requestCostMetrics(executionProject, node, selectedModel) });
              try {
                const response = await requestText({ ...request, operationId: id }, { operationId, attempt });
                costs.status(id, 'completed', typeof response === 'string' ? undefined : response.usage);
                return response;
              } catch (error) {
                costs.status(id, controller.signal.aborted ? 'canceled' : error instanceof TextRequestRejectedError ? 'failed' : 'unknown');
                throw error;
              }
            },
          });
          return { ...storyboard, source: 'model', modelId: selectedModel.id } as unknown as JsonValue;
        }
        const generate = () => requestText(
          { prompt, operationId: responseAttempt ? `${context.operationId}:response:${responseAttempt}` : context.operationId, outputSchema, outputSchemaName: document?.name },
          responseAttempt ? { operationId: context.operationId, attempt: responseAttempt } : undefined,
        );
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
          : outputSchema ? await modelResponses.generate({ operationId: context.operationId, inputHash: fingerprint(input), recordReceipt: context.recordRemoteId, generate }) : await generate();
        const text = typeof generated === 'string' ? generated : generated.text;
        runProgress.phase(context.operationId, 'validating', true);
        const usage = typeof generated === 'string' ? undefined : generated.usage;
        if (costOperation) costs.status(costOperation, 'completed', usage);
        const metadata = { source: 'model', modelId: selectedModel.id, ...(usage ? { providerUsage: usage } : {}) };
        if (outputSchema) {
          try {
            if (typeof generated !== 'string' && generated.incomplete) throw new ModelResponseValidationError([{
              path: '$', message: textIncompleteMessage(generated.incompleteReason ?? 'unknown', document ? 'document' : 'storyboard'),
            }], resultLabel);
            if (document) return { ...parseProductionDocument(text, document), ...metadata } as JsonValue;
            const script = parseWorkflowScript(text, executionProject, Boolean(saved.regeneration), executionCharacters, fixedOutputs);
            if (githubTrending) validateGithubTrendingStoryboard(script.shots, githubTrending);
            return { text, ...metadata, ...script } as JsonValue;
          } catch (error) {
            if (error instanceof ModelResponseValidationError) modelResponses.validationFailed(context.operationId, error.issues);
            throw error;
          }
        }
        if (!text.trim()) throw new Error('模型没有返回可用内容，请检查模型配置后重试。');
        if (researchContext) return { ...parseResearchResult(text, executionProject, researchContext, runId, node.id), ...(usage ? { providerUsage: usage } : {}) } as unknown as JsonValue;
        const summary = fixedOutputs && node.id === saved.videoEditingAgentId ? editingOutputSchema.parse({ text }) : { text };
        return { ...summary, ...metadata } as JsonValue;
      }
      if (media && options.executeActivity) {
        const batch = saved.exportBatch;
        const executeActivity = options.executeActivity;
        const outputKind = fixedOutputs && selectedModel && (node.kind === 'assets' || isVideoGenerationNode(node)) ? node.kind === 'assets' ? 'image' : 'video' : undefined;
        const publishAsset = (value: AssetRecord, project: ProjectDocument) => {
          const asset = outputKind ? validateProductionMediaPreview(value, outputKind, project) : assetSchema.parse(value);
          if (!outputKind && (asset.projectId !== project.id || !project.shots.some(shot => shot.id === asset.shotId))) throw new Error('生成进度素材不属于本次镜头。');
          runProgress.asset(context.operationId, asset);
        };
        const activityContext: ActivityExecutionContext = { project: mediaInputProject, node, skills: saved.skills.filter(skill => node.skillIds.includes(skill.id)), runId, operationId: context.operationId, signal: controller.signal, remoteTaskId: context.remoteId, persistRemoteTask: context.recordRemoteId, dataDirectory: directory, assets: activityAssets, model: selectedModel, apiKey: secret, characters: executionCharacters, promptUpstream: Object.fromEntries(upstreamResults(runId, node, saved).map(result => [result.nodeId, result.output])),
          unifiedShotProfile: saved.unifiedShotProfile, legacyVideoReferences: !saved.useOriginalVideoReferences,
          onDiagnostic: event => {
            const { event: name, level, ...fields } = event;
            nodeLogger[level](name, { ...fields, shotCount: mediaProject.shots.length });
            runProgress.media(context.operationId, event);
            if (name === 'media.render_started') runProgress.phase(context.operationId, 'rendering');
          },
          onAsset: value => publishAsset(value, outputKind ? mediaProject : executionProject),
          ...(node.kind === 'export' ? { preparedAudioMix: audioPreview.ready(executionProject, activityAssets) } : {}),
          onProgress: value => { if (batch) batches.progress(batch.batchId, batch.targetId, value); runProgress.phase(context.operationId, 'rendering', false, value); } };
        let output: JsonValue;
        const legacyScheduling = executionProject.workflow.execution;
        const groupedImages = legacyScheduling && groupsReferenceImages(node) && planReferenceImageSequences(activityContext).some(sequence => sequence.seedream || sequence.batches.length > 1);
        if (saved.handlerVersion >= 3 && legacyScheduling && selectedModel && ['assets', 'animation'].includes(node.kind) && !node.config.agentTask && !groupedImages) {
          // Each Send owns a stable shot identity. The adapter keeps its existing
          // parent operation + shot receipts, including ambiguous POST protection.
          const shots = mediaProject.shots;
          const scheduling = new AbortController();
          const outputs = await executeMediaGraph({ database, runId, nodeId: node.id, shotIds: shots.map(shot => shot.id), concurrency: legacyScheduling.maxConcurrentShots, signal: controller.signal,
            execute: async shotId => {
              const shot = shots.find(shot => shot.id === shotId);
              if (!shot) throw new Error('运行快照缺少并行镜头。');
              const project = { ...mediaProject, shots: [shot] };
              try {
                const output = await trackWork(() => executeActivity({ ...activityContext, project, onAsset: outputKind ? value => publishAsset(value, project) : activityContext.onAsset, queueSignal: scheduling.signal, onFailure: error => scheduling.abort(error) }), project.id);
                return outputKind ? validateProductionMediaOutput(output, outputKind, project) : output;
              } catch (error) { scheduling.abort(error); throw error; }
            } });
          const assets: AssetRecord[] = [], usages = [];
          for (const shot of shots) {
            const result = outputs[shot.id], generated = nodeResultAssets(result);
            if (generated.length !== 1 || generated[0].projectId !== executionProject.id || generated[0].shotId !== shot.id) throw new Error('并行步骤须为每个镜头返回对应的一份素材。');
            const asset = generated[0], info = await stat(asset.path).catch(() => undefined);
            if (!info?.isFile() || info.size !== asset.size) throw new Error('已完成的生成素材缺失或损坏，请显式重新生成此镜头；恢复不会重新提交模型请求。');
            if (await hashFileSha256(asset.path) !== asset.sha256) throw new Error('已完成的生成素材缺失或损坏，请显式重新生成此镜头；恢复不会重新提交模型请求。');
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
        const validated = outputKind ? validateProductionMediaOutput(output, outputKind, mediaProject) : output;
        if (node.id === 'assets' && casting?.assets.length && validated && typeof validated === 'object' && !Array.isArray(validated)) {
          return { ...validated, ...(casting.frameModelId ? { source: 'model', modelId: casting.frameModelId } : {}),
            assets: [...nodeResultAssets(validated), ...casting.assets] } as unknown as JsonValue;
        }
        return validated;
      }
      const manual = fixedOutputs ? manualPlanningOutput(saved.project, node, saved.outputContractVersion) : undefined;
      return manual ?? localNodeResult(node, executionProject, store.list<AssetRecord>('asset'));
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
      execute: child => trackWork(() => executeNode(runId, child, saved, controller), saved.project.id),
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
        execute: node => trackWork(() => executeNode(runId, node, saved, controller), saved.project.id),
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

  function projectBusy(projectId: string, exceptBatchId?: string, exceptRunId = '') {
    if (editorExports.has(projectId)) return true;
    return Boolean(database.prepare("SELECT 1 FROM documents r LEFT JOIN documents s ON s.kind = 'run-snapshot' AND s.id = r.id WHERE r.kind = 'run' AND r.id <> ? AND json_extract(r.body, '$.projectId') = ? AND (json_extract(r.body, '$.status') IN ('queued','running','waiting_review','waiting_external','retry_scheduled') OR r.id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR coalesce(json_extract(s.body, '$.exportBatch.batchId'), '') <> ?) LIMIT 1").get(exceptRunId, projectId, JSON.stringify([...active.keys()]), exceptBatchId ?? null, exceptBatchId ?? null));
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

  function stepMayCharge(node: WorkflowNode, allowImplicitModel: boolean): boolean {
    return Boolean(node.modelId && isModelGenerationNode(node) || allowImplicitModel && node.id === 'assets' && node.config.automaticCasting === true);
  }
  function castingImageModel(models: ModelProfile[], modelId: string | undefined, allowFallback: boolean) {
    if (!modelId && !allowFallback) return;
    const adapters = getMediaAdapters(['image']);
    const images = models.filter(model => model.enabled && model.capabilities.includes('image') && adapters.some(adapter => adapter.id === model.provider));
    return modelId ? images.find(model => model.id === modelId) : images.length === 1 ? images[0] : undefined;
  }
  function workflowChargeWork(value: ProjectDocument, nodes: WorkflowNode[], models: ModelProfile[], scope: {
    runId?: string; nodeId?: string; threads?: RunSnapshot['inspectionThreads']; hasConditions?: boolean; legacyVideoReferences?: boolean;
  } = {}): PlannedCharge[] {
    const work: PlannedCharge[] = [];
    let shotsMayChange = false, durationMayChange = false;
    for (const node of nodes) {
      if (scope.nodeId && node.id !== scope.nodeId && !node.id.startsWith(`${scope.nodeId}/subflow/`)) continue;
      const thread = scope.threads?.[node.id] ?? scope.runId;
      const recorded = thread ? journal.get(thread, node.id) : undefined;
      if (recorded?.status === 'completed') continue;
      const model = models.find(item => item.id === node.modelId);
      if (node.id === 'assets' && node.config.automaticCasting === true && options.executeActivity
        && (!thread || journal.get(thread, `${node.id}:casting`)?.status !== 'completed')) {
        const video = nodes.find(item => item.id === 'video' && isVideoGenerationNode(item));
        if (video) {
          const videoModel = models.find(item => item.id === video.modelId);
          const profiles = characters.profilesFor(value).characters;
          const cast = recurringCast(value, profiles);
          const needsFrames = scope.legacyVideoReferences && node.config.referenceMode !== 'generate' && singleFrameVideoModel(videoModel, value)
            && cast.project.shots.some(shot => !shot.locked && needsComposedSceneFrame(cast.project, shot, profiles));
          const allowImplicitModel = Boolean(scope.legacyVideoReferences) || !nativeReferenceStep(value.workflow);
          const imageModel = castingImageModel(models, node.modelId ?? (allowImplicitModel ? value.workflow.production.imageModelId : undefined), allowImplicitModel);
          if ((imageModel || allowImplicitModel) && (shotsMayChange || cast.missing.length || needsFrames)) work.push({ kind: 'image', model: imageModel });
        }
      }
      if (node.modelId && isModelGenerationNode(node)) {
        const line = plannedNodeCharge(node, model, shotsMayChange || recorded || scope.hasConditions ? undefined : value);
        work.push(scope.hasConditions ? { ...line, count: undefined } : durationMayChange && line.kind === 'video' ? { ...line, videoSeconds: undefined } : line);
      }
      if (node.kind === 'script' && !usesManualPlanning(value.workflow, node)) shotsMayChange = true;
      if (node.modelId && isVideoGenerationNode(node)) durationMayChange = true;
    }
    return work;
  }

  function reviewVideoReferences(value: ProjectDocument, nodes: WorkflowNode[], models: ModelProfile[], frozen?: Pick<RunSnapshot, 'characters' | 'characterAssets' | 'assets'>): VideoReferenceReview | undefined {
    const videoNodes = nodes.flatMap(node => {
      const model = isVideoGenerationNode(node) ? models.find(item => item.id === node.modelId) : undefined;
      return model ? [{ node, model }] : [];
    });
    if (!videoNodes.length) return;
    const profiles = frozen?.characters ?? characters.profilesFor(value).characters;
    const assets = [...new Map([...(frozen?.assets ?? store.list<AssetRecord>('asset')).filter(asset => !asset.projectId || asset.projectId === value.id), ...frozen?.characterAssets ?? []].map(asset => [asset.id, asset])).values()];
    const assetMap = new Map(assets.map(asset => [asset.id, asset]));
    const shots: Extract<VideoReferenceReview, { status: 'ready' }>['shots'] = [];
    let textShots = 0;
    for (const { node, model } of videoNodes) {
      const prior = nodes.slice(0, nodes.indexOf(node));
      if (prior.some(step => step.kind === 'script' && step.modelId && !usesManualPlanning(value.workflow, step))) return { status: 'pending', until: 'storyboard' };
      const preparesFrame = value.workflow.production.referenceMode !== 'none' && prior.some(step => step.kind === 'assets' && step.modelId && isModelGenerationNode(step));
      const preparesCast = prior.some(step => step.id === 'assets' && step.config.automaticCasting === true) && recurringCast(value, profiles).missing.length > 0;
      if (preparesFrame || preparesCast) return { status: 'pending', until: 'references' };
      for (const shot of value.shots) {
        if (shot.locked && assets.some(asset => asset.active && asset.kind === 'video' && asset.projectId === value.id && asset.shotId === shot.id)) continue;
        const plan = videoReferenceImages(value, node, model, shot, profiles, assets);
        if (plan.mode === 'text') { textShots++; continue; }
        const images = plan.referenceIds.map(id => {
          const asset = assetMap.get(id);
          if (!asset?.active || asset.kind !== 'image') throw new Error(`镜头「${shot.title}」的参考图不可用，请恢复或重新选择图片。`);
          return asset;
        });
        if (plan.frame && !plan.referenceIds.includes(plan.frame.id)) images.push(plan.frame);
        shots.push({ id: `${node.id}:${shot.id}`, title: videoNodes.length === 1 ? shot.title : `${node.label} · ${shot.title}`, mode: plan.mode, images: images.map(({ id, name, path, sha256 }) => ({ id, name, path, sha256 })) });
      }
    }
    return shots.length || textShots ? { status: 'ready', shots, textShots } : undefined;
  }

  type ChargeWork = { work: PlannedCharge[]; videoReferences?: VideoReferenceReview };

  function productionChargeWork(value: ProjectDocument, models: ModelProfile[], nodeId?: string, selection?: RunSelection): ChargeWork {
    const { nodes: scoped } = resolveProductionNodes(value, {
      nodeId, selection,
      editingAgent: () => videoEditingAgent(value, models, store.list<McpServer>('mcp-server')),
      automaticCasting: Boolean(options.executeActivity),
    });
    const ids = new Set(scoped.map(node => node.id));
    const workflow = { ...value.workflow, nodes: scoped, edges: value.workflow.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) };
    const expanded = workflowNodesWithSubflows(workflow);
    const hasConditions = workflowEdgesWithSubflows(workflow).some(edge => Boolean(edge.condition));
    return { work: workflowChargeWork(value, expanded, models, { hasConditions }),
      videoReferences: hasConditions ? undefined : reviewVideoReferences(value, expanded, models) };
  }

  function snapshotChargeWork(saved: RunSnapshot, runId?: string, nodeId?: string): PlannedCharge[] {
    const base = (runId && store.get<ProjectDocument>('run-project', runId)) || saved.sourceGeneration?.inputProject || saved.trial?.inputProject || saved.project;
    const value = saved.regeneration ? { ...base, shots: base.shots.filter(shot => shot.id === saved.regeneration!.shotId) } : base;
    const nodes = saved.inspectionNodes ?? workflowNodesWithSubflows({ ...saved.project.workflow, nodes: saved.nodes });
    return workflowChargeWork(value, nodes, saved.models, { runId, nodeId, threads: saved.inspectionThreads, legacyVideoReferences: !saved.useOriginalVideoReferences,
      hasConditions: !nodeId && (saved.inspectionEdges ?? saved.project.workflow.edges).some(edge => Boolean(edge.condition)) });
  }

  function startChargeWork(input: z.infer<typeof chargeStartInput>): ChargeWork {
    const value = project(input.projectId);
    const previous = input.parentRunId ? store.get<RunSnapshot>('run-snapshot', input.parentRunId) : undefined;
    if (previous?.sourceGeneration) return { work: snapshotChargeWork(previous), videoReferences: previous.useOriginalVideoReferences ? reviewVideoReferences(previous.sourceGeneration.inputProject, previous.nodes, previous.models, previous) : undefined };
    const regeneration = input.regeneration ?? (previous?.regeneration && { ...previous.regeneration, modelId: previous.nodes.find(node => node.id === 'regenerate')?.modelId });
    if (regeneration) {
      const node = regenerationNode(value, regeneration);
      const model = node.modelId ? store.get<ModelProfile>('model', node.modelId) : undefined;
      const scope = { ...value, shots: value.shots.filter(shot => shot.id === regeneration.shotId) };
      return { work: [plannedNodeCharge(node, model, scope)], videoReferences: model && reviewVideoReferences(scope, [node], [model]) };
    }
    const researchModel = input.research?.modelId ?? (previous?.research && previous.nodes.find(node => node.kind === 'research')?.modelId);
    if (researchModel) return { work: [{ kind: 'text', count: 1, model: store.get<ModelProfile>('model', researchModel) }] };
    const single = previous && !previous.selection && previous.nodes.length === 1 && previous.project.workflow.nodes.length > 1
      && !(previous.autonomousVideo ?? previous.nodes[0].config.videoAgent) ? previous.nodes[0] : undefined;
    return productionChargeWork(value, availableModels(), input.nodeId ?? single?.id, input.selection);
  }

  function shotChargeWork(params: unknown): ChargeWork {
    const input = shotRegenerationInput.parse(params);
    if (!input.source) return startChargeWork({ projectId: input.projectId, regeneration: input });
    const { runId, nodeId } = input.source;
    const saved = store.get<RunSnapshot>('run-snapshot', runId);
    const node = store.get<WorkflowNode>('node-definition', `${runId}:${nodeId}`) ?? (saved?.inspectionNodes ?? saved?.nodes)?.find(item => item.id === nodeId);
    const source = store.get<ProjectDocument>('node-project', `${runId}:${nodeId}`);
    const shot = source?.shots.find(item => item.id === input.shotId);
    const castModel = input.kind === 'image' && node?.id === 'assets' ? readCasting(runId)?.frameModelId : undefined;
    const model = saved?.models.find(item => item.id === (node?.modelId ?? castModel));
    if (model && !supportsRegenerationModel(model, input.kind)) throw new Error('本次制作未保存可用的对应生成模型。');
    if (!node || !source || !shot) return { work: [{ kind: regenerationKinds[input.kind].capability, model, count: 1 }] };
    const scope = { ...source, shots: [{ ...shot, locked: false }] };
    return { work: [plannedNodeCharge(node, model, scope)], videoReferences: saved?.useOriginalVideoReferences && model ? reviewVideoReferences(scope, [node], [model], { ...saved, assets: undefined }) : undefined };
  }

  function requiresChargeConfirmation(method: ChargeAction, params: unknown): boolean {
    if (method === 'run.start') {
      const input = chargeStartInput.parse(params);
      if (input.regeneration || input.research) return true;
      if (input.parentRunId) {
        const previous = store.get<RunSnapshot>('run-snapshot', input.parentRunId);
        if (previous?.exportBatch || previous && !previous.selection && !previous.regeneration && !previous.research && !isAutonomousVideoRun(previous)
          && previous.nodes.length === 1 && previous.nodes[0].kind === 'export' && !previous.nodes[0].modelId) return false;
        // A restart can resolve models from the current project as well as the original task.
        if (!input.selection) return true;
      }
      const value = project(input.projectId);
      const { nodes: scoped } = resolveProductionNodes(value, {
        nodeId: input.nodeId, selection: input.selection, automaticCasting: Boolean(options.executeActivity),
      });
      if (workflowNodesWithSubflows({ ...value.workflow, nodes: scoped }).some(node => stepMayCharge(node, !nativeReferenceStep(value.workflow)))) return true;
      if (input.nodeId || input.selection) return false;
      return Boolean(videoEditingAgent(value, availableModels(), store.list<McpServer>('mcp-server')));
    }
    if (method === 'run.resume' || method === 'run.step.retry') {
      const { runId, nodeId } = runIdInput.extend({ nodeId: z.string().optional() }).parse(params);
      const saved = store.get<RunSnapshot>('run-snapshot', runId);
      const nodes = saved ? saved.inspectionNodes ?? workflowNodesWithSubflows({ ...saved.project.workflow, nodes: saved.nodes }) : [];
      return nodes.some(node => (method === 'run.resume' || node.id === nodeId || node.id.startsWith(`${nodeId}/subflow/`))
        && stepMayCharge(node, !saved?.useOriginalVideoReferences || !nativeReferenceStep(saved.project.workflow)));
    }
    if (method === 'planning.prefill.start') {
      // Reopening the same request only reads its run. A retry has its own confirmation.
      const { requestId } = z.object({ requestId: z.string().uuid() }).parse(params);
      return !store.get('planning-prefill-request', requestId);
    }
    if (method === 'workflowAssistant.start') {
      const request = entityId.extend({ requestId: z.string().uuid() }).parse(params);
      return !store.get('workflow-assistant-request', fingerprint(request));
    }
    return true;
  }

  const chargeConfirmations = createChargeConfirmations((method, params) => {
    if (!requiresChargeConfirmation(method, params)) return null;
    const prompt = chargePrompts[method];
    if (method === 'cost.update') return prompt;
    if (method === 'run.resume' || method === 'run.step.retry') {
      const { runId, nodeId } = runIdInput.extend({ nodeId: z.string().optional() }).parse(params);
      const saved = store.get<RunSnapshot>('run-snapshot', runId);
      return { ...prompt, estimate: summarizeCharge(saved ? snapshotChargeWork(saved, runId, nodeId) : []) };
    }
    if (method === 'run.start' || method === 'shot.regenerate') {
      const { work, videoReferences } = method === 'run.start' ? startChargeWork(chargeStartInput.parse(params)) : shotChargeWork(params);
      return { ...prompt, estimate: summarizeCharge(work), videoReferences };
    }
    if (method === 'promptTrial.start') {
      const { sessionId, revision } = z.object({ sessionId: z.string(), revision: z.number().int() }).parse(params);
      const saved = store.get<RunSnapshot>('prompt-session-snapshot', `${sessionId}@${revision}`);
      return { ...prompt, estimate: summarizeCharge(saved ? snapshotChargeWork(saved) : []) };
    }
    const { modelId } = (method === 'planning.prefill.start'
      ? z.object({ node: z.object({ modelId: z.string().optional() }) }).transform(input => input.node)
      : z.object({ modelId: z.string() })).parse(params);
    const model = modelId ? store.get<ModelProfile>('model', modelId) : undefined;
    const work: PlannedCharge = method === 'character.generateImage'
      ? { kind: 'image', model: model && singleImageRequestModel(model), count: 1 }
      : { kind: 'text', model, count: 1 };
    return { ...prompt, estimate: summarizeCharge([work]) };
  });

  const runControl = createRunControl({
    store, run, project, projectBusy, batches, modelResponses, updateRun, schedule, recordEvent, hydrateRun,
    isActive: runId => active.has(runId),
    abortActive: runId => active.get(runId)?.controller.abort(),
    inspectRun: runId => runInspector.dispatch('run.inspect', { runId }),
    cancelCosts: runId => costs.cancelRun(runId),
  });

  const runStarter = createRunStarter({
    database, store, project, run, requireRevision, availableModels, prepareRunSelection,
    videoEditingAgent, regenerationNode, hydrateRun,
    projectOccupied: projectId => batches.blocked(projectId) || projectBusy(projectId),
    canExecuteActivities: () => Boolean(options.executeActivity),
    profilesFor: characters.profilesFor,
    prepareSkills: skillLibrary.prepareForNodes,
    regenerateShot(request) {
      requireOpenRuntime();
      return regenerateShot(request);
    },
    resumeExportBatch: batchId => batches.dispatch('render.batch.resume', { batchId }),
    onRunCreated(runId) {
      recordEvent(runId, 'run.created', '运行快照已保存');
      schedule(runId);
    },
  });

  function requireOpenRuntime() {
    if (closing) throw new Error('运行环境正在关闭。');
  }

  async function regenerateShot(rawParams: unknown): Promise<RunRecord> {
    const input = shotRegenerationInput.parse(rawParams);
    if (!input.source) {
      requireOpenRuntime();
      return runStarter.start({
        projectId: input.projectId,
        revision: input.revision,
        regeneration: { shotId: input.shotId, kind: input.kind, modelId: input.modelId, instruction: input.instruction, imageEdit: input.imageEdit },
      });
    }
    if (input.kind === 'script' || input.imageEdit) throw new Error('沿用原步骤重新生成时，请选择镜头图片或视频。');
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
    const result = store.get<JsonValue>('node-result', `${original.id}:${source.nodeId}`), sourceProject = store.get<FrozenProjectDocument>('node-project', `${original.id}:${source.nodeId}`);
    const sourceShot = sourceProject?.shots.find(shot => shot.id === input.shotId);
    if (!originalNode || originalNode.kind !== regenerationKinds[input.kind].nodeKind || journal.get(original.id, source.nodeId)?.status !== 'completed' || !sourceProject || !sourceShot || !result || !nodeResultAssets(result).some(asset => asset.shotId === input.shotId && asset.kind === input.kind)) throw new Error('原步骤没有这个镜头对应的已完成生成产物。');
    const casting = readCasting(original.id);
    const generatedFrameModel = input.kind === 'image' && originalNode.id === 'assets' ? casting?.frameModelId : undefined;
    const model = frozen.models.find(model => model.id === (originalNode.modelId ?? generatedFrameModel));
    if (!supportsRegenerationModel(model, input.kind)) throw new Error('本次制作未保存可用的对应生成模型。');
    const pending = database.prepare("SELECT body FROM documents WHERE kind = 'run' AND json_extract(body, '$.projectId') = ? AND json_extract(body, '$.regenerationSource.runId') = ? AND json_extract(body, '$.regenerationSource.nodeId') = ? AND json_extract(body, '$.regenerationSource.shotId') = ? AND json_extract(body, '$.status') NOT IN ('succeeded','canceled') ORDER BY rowid DESC LIMIT 1").get(value.id, source.runId, source.nodeId, input.shotId) as { body: string } | undefined;
    if (pending) return hydrateRun(runSchema.parse(JSON.parse(pending.body)));
    const { execution: _legacyScheduling, ...workflow } = sourceProject.workflow;
    const inputProject = { ...sourceProject, workflow, shots: [{ ...sourceShot, locked: false }] };
    const upstream = upstreamResults(original.id, originalNode, frozen);
    const selectedCharacters = (frozen.characters ?? []).filter(profile => sourceShot.characterIds?.includes(profile.id));
    const referenceIds = new Set([...selectedCharacters.flatMap(profile => profile.referenceAssetIds), ...creativeReferenceAssetIds(inputProject, sourceShot)]);
    const ids = new Set([...inputProject.shots.flatMap(shot => [shot.assetId, shot.videoAssetId, shot.audioAssetId]), ...(inputProject.workflow.production.referenceAudioAssetIds ?? []), ...referenceIds].filter((id): id is string => Boolean(id)));
    const knownAssets = new Map([...(frozen.assets ?? []), ...(frozen.characterAssets ?? []), ...upstream.flatMap(item => nodeResultAssets(item.output)), ...casting?.assets ?? [], ...casting?.libraryAssets ?? []].map(asset => [asset.id, asset]));
    const assets = [...ids].map(id => knownAssets.get(id) ?? store.get<AssetRecord>('asset', id));
    if (assets.some(asset => !asset)) throw new Error('本次制作的参考素材记录缺失，请先恢复素材。');
    const frozenAssets = assets.filter((asset): asset is AssetRecord => Boolean(asset));
    const characterAssets = frozenAssets.filter(asset => referenceIds.has(asset.id));
    await validatePromptAssets(frozenAssets);
    requireRevision(project(value.id), input.revision);
    const existing = repeated(); if (existing) return hydrateRun(existing);
    if (batches.blocked(value.id) || projectBusy(value.id) || [...active.keys()].some(runId => run(runId).projectId === value.id)) throw new Error('该项目已有未完成的制作，请先处理现有任务。');
    const id = randomUUID(), instruction = input.instruction?.trim();
    const node: WorkflowNode = { ...originalNode, id: 'regenerate', modelId: model.id, requiresReview: false, label: `重新生成镜头${regenerationKinds[input.kind].label}`, prompt: [originalNode.prompt, instruction].filter(Boolean).join('\n\n'), config: { ...originalNode.config, ...(generatedFrameModel ? { referenceMode: 'generate' } : {}), shotId: baseline.id, regenerationKind: input.kind, ...(instruction ? { instruction } : {}) } };
    const saved: RunSnapshot = { project: structuredClone(value), models: frozen.models, skills: frozen.skills, mcpServers: frozen.mcpServers, nodes: [node], handlerVersion: 4, unifiedShotProfile: true, characters: selectedCharacters, characterAssets, assets: frozenAssets,
      ...(frozen.outputContractVersion ? { outputContractVersion: frozen.outputContractVersion } : {}), ...(frozen.useOriginalVideoReferences ? { useOriginalVideoReferences: true } : {}), regeneration: { shotId: baseline.id, kind: input.kind, baseline: structuredClone(baseline), instruction }, sourceGeneration: { inputProject: structuredClone(inputProject), upstream: structuredClone(upstream), requestHash } };
    const createdAt = now();
    const record: RunRecord = { id, projectId: value.id, projectRevision: value.revision, workflowVersion: frozen.project.workflow.version, snapshotDigest: fingerprint(saved), parentRunId: original.id, status: 'queued', stepCount: 1, createdAt, updatedAt: createdAt, events: [], activities: [], regenerationSource: { ...source, shotId: baseline.id } };
    database.transaction(() => { store.put('run-snapshot', id, saved); store.put('run', id, record); })();
    recordEvent(id, 'run.created', `沿用本次制作，单独重新生成：${sourceShot.title}`, node.id); schedule(id); return hydrateRun(record);
  }

  function dispatch(method: string, rawParams: unknown = {}, context?: { requestId?: string | number }): Promise<unknown> {
    const requestLogger = logger.child({ ...rpcIdentifiers(rawParams), requestId: context?.requestId ?? randomUUID(), method });
    const started = performance.now();
    const read = method === 'billing.prepare' || /\.(?:get|list|summary|snapshot|inspect|payload|versions|plan|replay|status|read|references|tasks|events|activities|candidates|voices|waveform|result)$/.test(method);
    requestLogger[read ? 'debug' : 'info']('rpc.started');
    return trackWork(async () => {
      try {
        if (method === 'billing.prepare') return chargeConfirmations.prepare(rawParams);
        if (method === 'billing.cancel') return chargeConfirmations.cancel(rawParams);
        let params = rawParams;
        if (isChargeAction(method)) {
          if (params && typeof params === 'object' && 'chargeConfirmationId' in params) {
            params = chargeConfirmations.consume(method, params);
          } else if (options.requireChargeConfirmation && requiresChargeConfirmation(method, params)) {
            throw new Error('请先确认此操作的费用影响。');
          }
        }
        const result = await dispatchRequest(method, params);
        const idField = { 'project.create': 'projectId', 'run.start': 'runId', 'run.resume': 'runId', 'run.cancel': 'runId', 'model.save': 'modelId' }[method];
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
  async function dispatchRequest(method: string, rawParams: unknown): Promise<unknown> {
    requireOpenRuntime();
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
        const input = entityId.extend({ revision: z.number().int().positive().optional(), assetsVersion: z.number().int().nonnegative().optional(), videoPreviewKey: z.string().optional() }).parse(rawParams);
        const detail = reads.projectDetail(input.projectId, input.revision, input.assetsVersion);
        return input.videoPreviewKey === undefined ? detail : { ...detail, videoPreview: readVideoPreview(detail.latestRun, input.videoPreviewKey) };
      }
      case 'run.list': {
        const input = pageInputSchema.extend({ projectId: z.string().optional(), purpose: z.enum(['production', 'prompt-trial', 'workflow-assistant']).optional(), promptSessionId: z.string().optional(), status: runStatusSchema.optional() }).parse(rawParams);
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
      case 'project.create': {
        const input = z.object({ title: z.string().min(1).max(160), brief: z.string().max(30000).default(''), originalText: projectSchema.shape.originalText, profile: videoProfileSchema.optional(), skillIds: z.array(z.string().min(1)).max(500).optional(), templateId: z.string().optional(), seriesTemplateId: z.string().min(1).optional(), seriesTemplateRevision: z.number().int().positive().optional() }).refine(value => Boolean(value.seriesTemplateId) === (value.seriesTemplateRevision !== undefined), '请选择系列模板及其当前修订。').parse(rawParams);
        const template = input.seriesTemplateId ? seriesTemplates.forCreation(input.seriesTemplateId, input.seriesTemplateRevision) : undefined;
        const defaults = template?.creationDefaults;
        const selectedSkills = input.skillIds ?? defaults?.skillIds.filter(id => store.get<SkillPackage>('skill', id)?.enabled) ?? [];
        const skillIds = skillLibrary.resolveSkills(selectedSkills).map(skill => skill.id);
        const workflow = createNativeVideoWorkflow();
        const timestamp = now();
        const value = projectSchema.parse({ id: randomUUID(), title: input.title, brief: input.brief, originalText: input.originalText, templateId: input.templateId ?? 'generic', revision: 1, profile: input.profile ?? defaults?.profile ?? DEFAULT_VIDEO_PROFILE, ...(input.templateId === 'history-handdrawn' ? {} : { style: '' }), ...template?.settings, shots: [], claims: [], workflow: {
          ...workflow,
          production: { ...workflow.production, agentSkillIds: skillIds },
          nodes: workflow.nodes.map(node => ['brief', 'style', 'script', 'agent'].includes(node.kind) ? { ...node, skillIds } : node),
        }, createdAt: timestamp, updatedAt: timestamp, archived: false });
        store.put('project', value.id, value); changed(); return value;
      }
      case 'project.update': {
        const input = projectUpdateInput.parse(rawParams);
        const value = project(input.projectId); requireRevision(value, input.revision);
        if (input.patch.workflow) validateCompositionUpdate(input.patch.workflow, value.workflow);
        if (input.patch.musicClips) validateMusicAssets(value.id, input.patch.musicClips);
        return saveProject({ ...value, ...input.patch, workflow: input.patch.workflow ?? value.workflow }, value);
      }
      case 'project.archive':
      case 'project.archiveMany':
      case 'project.restore':
      case 'project.restoreMany': {
        const batch = method === 'project.archiveMany' || method === 'project.restoreMany';
        const archived = method === 'project.archive' || method === 'project.archiveMany';
        const ids = batch
          ? [...new Set(projectIdsInput.parse(rawParams).projectIds)]
          : [entityId.parse(rawParams).projectId];
        const saved = database.transaction(() => {
          const activeProjects = new Set([...active.keys()].map(id => run(id).projectId));
          const projects = ids.map(project).filter(value => !batch || value.archived !== archived);
          for (const value of projects) {
            if (activeProjects.has(value.id)) {
              const subject = batch ? `“${value.title}”有未结束的任务。` : '';
              throw new Error(`${subject}请先停止项目任务。`);
            }
          }
          return projects.map(value => writeProject({ ...value, archived }, value));
        }).immediate();
        if (saved.length) changed();
        if (!batch) return saved[0];
        return archived ? { archived: saved.length } : { restored: saved.length };
      }
      case 'project.deleteMany': {
        const ids = [...new Set(projectIdsInput.parse(rawParams).projectIds)];
        const { cleanup, mixes } = database.transaction(() => {
          const projects = ids.map(project);
          for (const value of projects) {
            if (!value.archived) throw new Error(`只能彻底删除回收站中的项目。“${value.title}”已不在回收站。`);
            if (projectBusy(value.id) || batches.blocked(value.id)) throw new Error(`“${value.title}”有未结束的任务。请先处理制作或导出任务。`);
            if (projectFileUsers.has(value.id) || assetRecovery.repairing(value.id)) throw new Error(`“${value.title}”正在处理本地文件，请等待完成后重试。`);
          }
          const assets = store.list<AssetRecord>('asset'), mixes = audioPreview.projectJobs(projects, assets);
          if (mixes.some(mix => mix.status === 'queued' || mix.status === 'running')) throw new Error('所选项目正在准备声音试听，请等待完成后重试。');
          for (const id of ids) store.delete('project', id);
          const cleanup = projectFiles.stage(projects, assets, mixes);
          for (const mix of mixes) store.delete('audio-mix-job', mix.id);
          return { cleanup, mixes };
        }).immediate();
        audioPreview.forget(mixes);
        changed();
        const cleanupPending = cleanup ? projectFiles.finish(cleanup) : 0;
        return { deleted: ids.length, ...(cleanupPending ? { cleanupPending } : {}) };
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
      case 'render.export': return runStarter.exportVideo(rawParams);
      case 'run.start': return runStarter.start(rawParams);

      case 'render.editor.export': {
        const { exportEditorProject } = await import('./editor-export.js');
        const input = editorExportInputSchema.parse(rawParams), value = project(input.projectId); requireRevision(value, input.revision);
        if (closing || value.archived || batches.blocked(value.id) || projectBusy(value.id)) throw new Error('请先恢复项目或处理未完成的制作。');
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
      case 'shot.regenerate': return regenerateShot(rawParams);
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
      case 'run.step.retry': return runControl.retryStep(rawParams);
      case 'run.resume': return runControl.resume(rawParams);
      case 'run.cancel': return runControl.cancel(rawParams);
      case 'run.replay': {
        const { runId } = runIdInput.parse(rawParams); const value = run(runId);
        const saved = store.get<RunSnapshot>('run-snapshot', runId);
        const outputs = Object.fromEntries(journal.list(runId).filter(record => record.status === 'completed').map(record => [record.activity_id, JSON.parse(record.result!)]));
        return { run: hydrateRun(value), snapshotDigest: saved ? fingerprint(saved) : null, matchesSnapshot: !!saved && fingerprint(saved) === value.snapshotDigest, outputs, externalCalls: 0 };
      }
      case 'model.discover': {
        const input = z.object({ model: modelSchema.partial().required({ provider: true, baseUrl: true, capabilities: true, connectionType: true }), secret: z.string().optional() }).parse(rawParams);
        const previous = input.model.id ? store.get<ModelProfile>('model', input.model.id) : undefined;
        const draft = modelSchema.parse({ id: 'discovery', name: '读取模型', model: 'discovery', createdAt: '', updatedAt: '', ...input.model });
        validateModelConnection(draft);
        let secret = rememberSecret(input.secret?.trim());
        if (input.secret === undefined && previous?.credentialRef && new URL(previous.baseUrl).origin === new URL(draft.baseUrl).origin) {
          secret = rememberSecret(await options.secretStore?.get(previous.credentialRef));
        }
        try { return await discoverModels(draft, secret); }
        catch (error) { return { source: 'remote', items: [], message: error instanceof Error && /^读取模型列表返回 HTTP \d+$/.test(error.message) ? `${error.message}。可手动填写模型 ID，或核对地址与密钥后重试。` : '暂时无法读取模型列表。可手动填写模型 ID，或核对连接后重试。' }; }
      }
      case 'model.save': {
        const input = z.object({ model: modelSchema.partial().required({ name: true, provider: true, baseUrl: true, model: true, capabilities: true, connectionType: true }), secret: z.string().optional() }).parse(rawParams);
        const id = input.model.id || randomUUID();
        const previous = store.get<ModelProfile>('model', id);
        const configuration = { ...previous, ...input.model, parameters: input.model.parameters ?? previous?.parameters ?? {} };
        validateModelConnection(configuration);
        validateModelParameters(configuration);
        const sameOrigin = previous && new URL(previous.baseUrl).origin === new URL(input.model.baseUrl).origin;
        let credentialRef = sameOrigin ? previous.credentialRef : undefined;
        let hasSecret = Boolean(credentialRef);
        if (input.secret !== undefined) {
          const secret = rememberSecret(input.secret.trim());
          if (secret) {
            if (!options.secretStore) throw new Error('当前环境未连接系统凭据库，请在桌面客户端保存密钥。');
            credentialRef = `model:${id}:${randomUUID()}`;
            await options.secretStore.set(credentialRef, secret);
          } else {
            if (credentialRef) await options.secretStore?.delete(credentialRef);
            credentialRef = undefined;
          }
          hasSecret = Boolean(credentialRef);
        }
        const timestamp = now();
        const value = modelSchema.parse({ ...configuration, id, credentialRef, hasSecret, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp });
        store.put('model', id, value); changed(); return value;
      }
      case 'cost.list': case 'cost.update': case 'cost.summary': case 'cost.tasks': case 'cost.task.get': return costs.dispatch(method, rawParams);
      case 'promptLibrary.get': case 'promptLibrary.list': case 'promptLibrary.save': case 'promptLibrary.update': return promptLibrary.dispatch(method, rawParams);
      case 'prompt.preview': case 'promptSession.get': case 'promptSession.list': case 'promptSession.save': return promptWorkbench.dispatch(method, rawParams);
      case 'promptTrial.start': {
        const value = await promptWorkbench.dispatch(method, rawParams);
        return reads.runSummary(run(z.object({ id: z.string() }).parse(value).id));
      }
      case 'planning.prefill.start': {
        const { requestId, ...draft } = promptDraftSchema.omit({ shotId: true, upstreamRunId: true }).extend({ requestId: z.string().uuid() }).strict().parse(rawParams);
        const inputHash = fingerprint(draft);
        const replay = () => {
          const receipt = store.get<{ inputHash: string; runId: string }>('planning-prefill-request', requestId);
          if (receipt && receipt.inputHash !== inputHash) throw new Error('草稿请求标识已用于其他输入，请重新生成。');
          return receipt ? run(receipt.runId) : undefined;
        };
        const previous = replay();
        if (previous) return reads.runSummary(previous);
        if (!productionPlanningStep(project(draft.projectId).workflow, draft.node)) throw new Error('AI 填写支持内置制作的简报、风格和分镜。');
        const { saved } = await preparePromptDraft(draft, true);
        const repeated = replay();
        if (repeated) return reads.runSummary(repeated);
        const record = database.transaction(() => {
          const record = startPromptRun(draft, saved);
          store.put('planning-prefill-request', requestId, { inputHash, runId: record.id });
          return record;
        })();
        schedule(record.id);
        return reads.runSummary(record);
      }
      case 'render.batch.start': case 'render.batch.get': case 'render.batch.list': case 'render.batch.cancel': case 'render.batch.resume': return batches.dispatch(method, rawParams);
      case 'character.generateImage': return trackWork(() => characterImages.generate(rawParams));
      case 'character.list': case 'character.get': case 'character.getMany': case 'character.references':
      case 'character.save': case 'character.archive': case 'character.restore': case 'character.delete': return characters.dispatch(method, rawParams);
      case 'workflowTemplate.list': case 'workflowTemplate.get': case 'workflowTemplate.save': case 'workflowTemplate.archive': case 'workflowTemplate.restore': return workflowTemplates.dispatch(method, rawParams);
      case 'seriesTemplate.list': case 'seriesTemplate.get': case 'seriesTemplate.save': case 'seriesTemplate.archive': case 'seriesTemplate.restore': return seriesTemplates.dispatch(method, rawParams);
      case 'model.test': {
        const { modelId } = z.object({ modelId: z.string() }).parse(rawParams);
        const model = store.get<ModelProfile>('model', modelId); if (!model) throw new Error('模型不存在。');
        validateModelConnection(model);
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
      case 'image.dimensions': return imageTools.dimensions(rawParams);
      case 'image.createMask': {
        const { assetId } = z.object({ assetId: z.string().min(1) }).parse(rawParams);
        return trackWork(() => imageTools.mask(rawParams), store.get<AssetRecord>('asset', assetId)?.projectId);
      }
      case 'asset.list':
      case 'asset.import':
      case 'asset.getMany':
      case 'asset.waveform':
      case 'asset.read':
      case 'asset.retain':
      case 'asset.delete':
      case 'asset.deleteMany':
      case 'asset.restore': return assetLibrary.dispatch(method, rawParams);
      case 'project.backup': {
        const { projectId, destination } = entityId.extend({ destination: z.string().optional() }).parse(rawParams);
        return trackWork(async () => {
          const value = project(projectId);
          validateResearchProject(value, value);
          validateEdits(value, value);
          const bundle = characters.profilesFor(value);
          const referenced = new Set([...value.shots.flatMap(shot => [shot.assetId, shot.videoAssetId, shot.audioAssetId, shot.captionTrack?.sourceAssetId]), ...(value.clipEditSources ?? []).flatMap(clipSourceAssetIds), ...(value.musicClips ?? []).map(clip => clip.assetId), ...(value.workflow.production.referenceAudioAssetIds ?? []), ...creativeReferenceAssetIds(value), ...bundle.assets.map(asset => asset.id)]);
          const availableAssets = store.list<AssetRecord>('asset').filter(asset => !isLegacyTimelineAsset(asset));
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
          const { manualPlanningSteps, manualPlanningFields } = value.workflow.production;
          const schemaVersion = manualPlanningSteps?.length || manualPlanningFields ? 9 : creativeReferenceAssetIds(value).length || assets.some(asset => asset.derivation) ? 8 : value.episode || value.episodeSource ? 7 : hasPromptBindings ? 6 : value.creativeContext || value.shots.some(shot => shot.creativeEntityKeys?.length) ? 5 : 4;
          await writeFile(join(backupDirectory, 'project.json'), JSON.stringify({ schemaVersion, project: { ...value, originalText: projectOriginalText(value) }, assets: portable, characters: bundle.characters }, null, 2), { encoding: 'utf8', flag: 'wx' });
          return { path: backupDirectory, assets: portable.length };
        }, projectId);
      }
      case 'node.result': {
        const { runId, nodeId } = z.object({ runId: z.string(), nodeId: z.string() }).parse(rawParams);
        return omitLegacyExportTimeline(store.get<JsonValue>('node-result', `${runId}:${nodeId}`) ?? null);
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
        const record = run(runId), value = project(record.projectId);
        // A scoped video step can apply itself before the caller records the application acknowledgement.
        const automatic = applicationKey && revision === record.projectRevision && value.revision === record.projectRevision + 1
          ? store.get<VideoApplicationReceipt>('run-video-application', runId) : undefined;
        if (automatic?.nodeIds.includes(nodeId) && automatic.projectDigest === projectContentDigest(value)) return saveApplied(value, false);
        requireRevision(value, revision);
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
        await validateCharacterAssets(frozenCharacters, frozenReferences, saved.project);
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
          // Restore unsaved storyboard output across workflow configuration changes while protecting authored content.
          const baseline = saved.project;
          const restoreStoryboard = !saved.trial && isVideoGenerationNode(node) && assets.some(asset => asset.kind === 'video' && asset.shotId)
            && !sameJsonContent(input.shots, baseline.shots)
            && sameJsonContent(currentValue.workflow.production.manualPlanningFields, baseline.workflow.production?.manualPlanningFields)
            && projectContentDigest({ ...currentValue, workflow: baseline.workflow }) === projectContentDigest(baseline);
          const checkedAssets = [...assets];
          if (restoreStoryboard) {
            const existing = productionMediaIds(baseline);
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
            if (await hashFileSha256(asset.path) !== asset.sha256) throw new Error('步骤产物素材校验失败，请重新生成。');
          }
          const repeated = appliedReceipt(); if (repeated) return repeated;
          const latest = verifiedProject(); requireCandidateAssets(checkedAssets);
          const working = applyMediaResult(restoreStoryboard ? input : latest, input, node, result, assets);
          if (restoreStoryboard) return saveApplied(projectWithProductionOutput(latest, productionOutput(working, saved.outputContractVersion === 2)));
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
    async waitForIdle() { await skillLibrary.waitForIdle(); await assetRecovery.waitForIdle(); await readiness.waitForIdle(); await audioPreview.waitForIdle(); await batches.waitForIdle(); await drainWork(); },
    async close() {
      logger.info('runtime.stopping', { pendingCount: active.size + pendingWork.size });
      closing = true;
      characterImages.close();
      for (const controller of editorExports.values()) controller.abort();
      try {
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
