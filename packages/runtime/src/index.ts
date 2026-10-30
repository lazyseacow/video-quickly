import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile, rename, lstat } from 'node:fs/promises';
import { basename, extname, join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readResearchSource, searchWikipedia, selectResearchPassages, parseResearchResult } from '@video-quickly/integrations/research';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import {
  applyShotCandidate, assetSchema, audioWaveformSchema, captionTrackSchema, characterProfileSchema, claimSchema, clipSourceAssetIds, createHistoryWorkflow, createSceneTemplate, DEFAULT_VIDEO_PROFILE, modelSchema, pageInputSchema, projectSchema, providerUsageSchema, shotCandidateFieldSchema, shotCandidateKindSchema, shotCandidateSchema, shotSchema, validateClipEditContent, validateClipEditHistory, validateModelParameters, videoProfileSchema, workflowSchema,
  type AssetRecord, type AudioWaveform, type CharacterProfile, type JsonValue, type ModelCapability, type ModelProfile, type PreparedAudioMix, type ProjectDocument, type RunEvent, type RunRecord, type RuntimeEvent, type RuntimeSystem, type Shot, type ShotCandidate, type ShotCandidateKind, type SkillPackage, type WorkflowDefinition, type WorkflowNode, type WorkspaceSnapshot,
} from '@video-quickly/contracts';
import { ActivityJournal, AmbiguousActivityError, fingerprint, SimulatedProcessExit, type ActivityHooks, type ActivitySafety } from './activities.js';
import { openDatabase, DocumentStore } from './database.js';
import { createReadModels } from './read-models.js';
import { Command, createExecutionGraph } from './graph.js';
import { generateText, testModelConnection, type TextProvider } from './providers.js';
import { seedHistoryProject } from './seed.js';
import { importSkill } from './skills.js';
import { connectMcp, mcpServerSchema, type McpServer } from './mcp.js';
import { createCostLedger, requestCostMetrics } from './costs.js';
import { createCharacterLibrary } from './characters.js';
import { createExportBatchManager, verifyBatchRenderResult, type ExportBatchSnapshot } from './export-batches.js';
import { validateResearchProject, researchPrompt, researchModelResponse } from './research.js';
import { createSeriesTemplateLibrary } from './series-templates.js';
import { replaceShotMedia } from '@video-quickly/video/clip-edits';
import { trimShotInContext } from '@video-quickly/video/editing';
import { createAudioPreview, type AudioMixCallbacks } from './audio-preview.js';

export { ActivityJournal, AmbiguousActivityError, SimulatedProcessExit } from './activities.js';
export type { ActivityContext } from './activities.js';

export interface SecretStore {
  persistent?: boolean;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ActivityExecutionContext {
  project: ProjectDocument;
  node: WorkflowNode;
  runId: string;
  operationId: string;
  signal: AbortSignal;
  remoteTaskId?: string;
  dataDirectory: string;
  assets: AssetRecord[];
  model?: ModelProfile;
  apiKey?: string;
  characters?: CharacterProfile[];
  onProgress?: (value: number) => void;
  preparedAudioMix?: PreparedAudioMix;
  persistRemoteTask(id: string): void;
}

export interface RuntimeOptions {
  dataDirectory: string;
  mode?: 'desktop' | 'development';
  secretStore?: SecretStore;
  provider?: TextProvider;
  failpoint?: ActivityHooks['failpoint'];
  executeActivity?: (context: ActivityExecutionContext) => Promise<JsonValue>;
  preflightActivity?: (context: Pick<ActivityExecutionContext, 'project' | 'node' | 'assets' | 'model' | 'characters' | 'signal' | 'dataDirectory'>) => void | Promise<void>;
  readAudioWaveform?: (asset: AssetRecord) => Promise<AudioWaveform>;
  audioMix?: AudioMixCallbacks;
  activitySafety?: (node: WorkflowNode) => ActivitySafety;
  hostCall?: (method: string, params: unknown) => Promise<unknown>;
  seed?: boolean;
  ffmpegPath?: string;
}

interface RunSnapshot {
  project: ProjectDocument;
  models: ModelProfile[];
  skills: SkillPackage[];
  mcpServers: McpServer[];
  nodes: WorkflowNode[];
  handlerVersion: number;
  regeneration?: { shotId: string; kind: ShotCandidateKind; baseline: Shot; instruction?: string };
  characters?: CharacterProfile[];
  characterAssets?: AssetRecord[];
  assets?: AssetRecord[];
  exportBatch?: { batchId: string; targetId: string };
  research?: { sourceIds?: string[]; instruction?: string };
}

const entityId = z.object({ projectId: z.string().min(1) });
const runIdInput = z.object({ runId: z.string().min(1) });
const regenerationInput = z.object({ shotId: z.string().min(1), kind: shotCandidateKindSchema, modelId: z.string().min(1).optional(), instruction: z.string().max(10_000).optional() });
const researchInput = z.object({ modelId: z.string().min(1), sourceIds: z.array(z.string().min(1)).min(1).max(20).optional(), instruction: z.string().max(10_000).optional() });
const now = () => new Date().toISOString();

const regenerationKinds = {
  script: { nodeKind: 'script', capability: 'text', label: '脚本', protocols: ['openai-compatible', 'ollama', 'custom-http'] },
  image: { nodeKind: 'assets', capability: 'image', label: '画面', protocols: ['openai-compatible', 'seedream', 'comfyui', 'custom-http'] },
  audio: { nodeKind: 'voice', capability: 'tts', label: '配音', protocols: ['openai-compatible', 'qwen-tts', 'custom-http'] },
  video: { nodeKind: 'animation', capability: 'video', label: '视频', protocols: ['openai-compatible', 'seedance', 'comfyui', 'custom-http'] },
} as const;

function containsPromptTemplate(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{prompt}}');
  if (Array.isArray(value)) return value.some(containsPromptTemplate);
  return Boolean(value && typeof value === 'object' && Object.values(value).some(containsPromptTemplate));
}

export function createRuntime(options: RuntimeOptions) {
  const directory = resolve(options.dataDirectory);
  const database = openDatabase(directory);
  const store = new DocumentStore(database);
  const reads = createReadModels(database, store);
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const active = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  const transientSecrets = new Set<string>();
  function rememberSecret(value: string | undefined) { if (value) transientSecrets.add(value); return value; }
  let closing = false;
  let workspaceVersion = 0;
  const changed = () => { workspaceVersion++; emit({ type: 'workspace.changed' }); };
  function emit(event: RuntimeEvent) { for (const listener of listeners) listener(event); }
  const journal = new ActivityJournal(database, { failpoint: options.failpoint, onEvent: changed });
  const costs = createCostLedger({ database, store, onChanged: changed });
  const characters = createCharacterLibrary({ database, store, onChanged: changed });
  const seriesTemplates = createSeriesTemplateLibrary({ database, store, onChanged: changed });
  const audioPreview = createAudioPreview({ directory, store, callbacks: options.audioMix, project, validate: value => { validateEdits(value, project(value.id)); validateResearchProject(value, project(value.id)); characters.profilesFor(value); } });

  if (options.seed !== false && !store.get('metadata', 'initialized')) {
    database.transaction(() => {
      const seed = seedHistoryProject(directory);
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
    }
  }

  function project(id: string) {
    const value = store.get<ProjectDocument>('project', id);
    if (!value) throw new Error('项目不存在或已被移除。');
    return value;
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
    const template = value.workflow.nodes.find(node => node.kind === configuration.nodeKind && node.config.operation !== 'transcribe');
    const modelId = input.modelId ?? template?.modelId;
    const model = modelId ? store.get<ModelProfile>('model', modelId) : undefined;
    const protocols: readonly string[] = configuration.protocols;
    if (!model?.enabled || !model.capabilities.includes(configuration.capability) || !protocols.includes(model.provider)) throw new Error(`请为镜头${configuration.label}重新生成选择可用的对应模型。`);
    const instruction = input.instruction?.trim();
    if (input.kind === 'audio' && model.provider === 'qwen-tts' && instruction) throw new Error('当前 Qwen-TTS 接口不支持单镜头调整要求，请留空或改用支持语音指令的模型。');
    return {
      id: 'regenerate', kind: configuration.nodeKind, label: `重新生成镜头${configuration.label}`,
      description: template?.description ?? '', prompt: [template?.prompt, instruction].filter(Boolean).join('\n\n'),
      modelId: model.id, skillIds: template?.skillIds ?? [], position: template?.position ?? { x: 0, y: 0 }, requiresReview: false,
      config: { ...template?.config, operation: 'regenerate', shotId: shot.id, regenerationKind: input.kind, ...(instruction ? { instruction } : {}) },
    };
  }

  function requireCandidateAssets(assets: AssetRecord[]) {
    for (const asset of assets) {
      const current = store.get<AssetRecord>('asset', asset.id);
      const keys = ['projectId', 'shotId', 'kind', 'path', 'sha256', 'size', 'version'] as const;
      if (!current?.active || keys.some(key => current[key] !== asset[key])) throw new Error('候选素材读取期间已更改或移除，请重新读取。');
    }
  }

  async function validateCharacterAssets(profiles: CharacterProfile[], references: AssetRecord[]) {
    const ids = new Set(profiles.flatMap(profile => profile.referenceAssetIds));
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
    const rows = database.prepare("SELECT c.value AS body FROM documents s, json_each(s.body, '$.project.claims') c WHERE s.kind = 'run-snapshot' AND s.id = ? AND json_extract(c.value, '$.id') IN (SELECT value FROM json_each(?)) ORDER BY json_extract(c.value, '$.id')").all(candidate.runId, JSON.stringify(claimIds)) as { body: string }[];
    const parsedClaims = rows.map(row => claimSchema.parse(JSON.parse(row.body)));
    const claims = claimIds.map(id => parsedClaims.find(claim => claim.id === id));
    const current = claimIds.map(id => value.claims.find(claim => claim.id === id));
    if (claims.some(claim => !claim) || fingerprint(claims) !== fingerprint(current)) throw new Error('生成后镜头引用的主张或核验结论已变化，请基于当前资料重新生成。');
    const sourceIds = [...new Set(parsedClaims.flatMap(claim => claim.evidence?.map(evidence => evidence.sourceId) ?? []))].sort();
    if (!sourceIds.length) return;
    const sources = database.prepare("SELECT json_object('id', json_extract(c.value, '$.id'), 'title', json_extract(c.value, '$.title'), 'kind', json_extract(c.value, '$.kind'), 'sha256', json_extract(c.value, '$.sha256'), 'capturedAt', json_extract(c.value, '$.capturedAt'), 'url', json_extract(c.value, '$.url'), 'fileName', json_extract(c.value, '$.fileName')) AS body FROM documents s, json_each(s.body, '$.project.researchSources') c WHERE s.kind = 'run-snapshot' AND s.id = ? AND json_extract(c.value, '$.id') IN (SELECT value FROM json_each(?)) ORDER BY json_extract(c.value, '$.id')").all(candidate.runId, JSON.stringify(sourceIds)) as { body: string }[];
    const metadata = sourceIds.map(id => { const source = value.researchSources?.find(source => source.id === id); return source ? { id: source.id, title: source.title, kind: source.kind, sha256: source.sha256, capturedAt: source.capturedAt, url: source.url ?? null, fileName: source.fileName ?? null } : undefined; });
    const parsedSources = sources.map(row => JSON.parse(row.body) as { id: string });
    if (sources.length !== sourceIds.length || fingerprint(sourceIds.map(id => parsedSources.find(source => source.id === id))) !== fingerprint(metadata)) throw new Error('生成后镜头证据来源已变化，请基于当前资料重新生成。');
  }

  async function candidateFor(projectId: string, candidateId: string): Promise<{ candidate: ShotCandidate; assets: AssetRecord[] }> {
    const stored = store.get('shot-candidate', candidateId);
    if (!stored) throw new Error('候选不存在。');
    const candidate = shotCandidateSchema.parse(stored);
    const record = store.get<RunRecord>('run', candidate.runId);
    const row = database.prepare("SELECT json_extract(body, '$.regeneration') AS regeneration, json_extract(body, '$.characters') AS characters, json_extract(body, '$.characterAssets') AS characterAssets FROM documents WHERE kind = 'run-snapshot' AND id = ?").get(candidate.runId) as { regeneration: string | null; characters: string | null; characterAssets: string | null } | undefined;
    const metadata = row?.regeneration ? z.object({ shotId: z.string(), kind: shotCandidateKindSchema, baseline: shotSchema }).parse(JSON.parse(row.regeneration)) : undefined;
    const activity = journal.get(candidate.runId, candidate.nodeId);
    if (candidate.projectId !== projectId || record?.projectId !== projectId || record.status !== 'succeeded' || activity?.status !== 'completed' || metadata?.shotId !== candidate.shotId || metadata.kind !== candidate.kind || fingerprint(metadata.baseline) !== fingerprint(candidate.baseline) || candidate.shot.id !== candidate.shotId) throw new Error('候选未完成或不属于当前镜头项目。');
    const profiles = row?.characters ? z.array(characterProfileSchema).parse(JSON.parse(row.characters)) : [];
    if (fingerprint(profiles) !== fingerprint(candidate.characters ?? [])) throw new Error('候选角色与生成快照不匹配。');
    const references = row?.characterAssets ? z.array(assetSchema).parse(JSON.parse(row.characterAssets)) : [];
    await validateCharacterAssets(profiles, references);
    if (candidate.kind === 'script') {
      if (candidate.assetIds.length) throw new Error('脚本候选包含无效素材。');
      return { candidate, assets: references };
    }
    const key = candidate.kind === 'image' ? 'assetId' : candidate.kind === 'audio' ? 'audioAssetId' : 'videoAssetId';
    if (candidate.assetIds.length !== 1 || candidate.shot[key] !== candidate.assetIds[0]) throw new Error('候选缺少相应的生成素材。');
    const asset = store.get<AssetRecord>('asset', candidate.assetIds[0]);
    const info = asset ? await stat(asset.path).catch(() => undefined) : undefined;
    if (!asset?.active || asset.projectId !== projectId || asset.shotId !== candidate.shotId || asset.kind !== candidate.kind || !info?.isFile() || info.size !== asset.size) throw new Error('候选素材缺失、已更改或不属于当前镜头。');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(asset.path)) hash.update(chunk);
    if (hash.digest('hex') !== asset.sha256) throw new Error('候选素材校验失败，请重新生成。');
    return { candidate, assets: [...references, asset] };
  }

  function requireRevision(value: ProjectDocument, revision?: number) {
    if (revision !== undefined && revision !== value.revision) throw new Error('项目已在其他视图修改，请刷新后重新保存。');
  }

  function validateEdits(value: ProjectDocument, previous?: ProjectDocument) {
    const ids = new Set((value.clipEditSources ?? []).flatMap(clipSourceAssetIds));
    const assets = [...ids].map(id => {
      const asset = store.get<AssetRecord>('asset', id);
      if (!asset?.active || asset.projectId && asset.projectId !== value.id) throw new Error('原始剪辑素材已移除或不属于当前项目。');
      return asset;
    });
    validateClipEditContent(value, assets);
    if (previous) validateClipEditHistory(value, previous);
  }

  function saveProject(value: ProjectDocument) {
    const saved = projectSchema.parse({ ...value, revision: value.revision + 1, updatedAt: now() });
    validateResearchProject(saved, project(value.id));
    validateEdits(saved, project(value.id));
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

  function updateRun(id: string, patch: Partial<RunRecord>) {
    const updated = { ...run(id), ...patch, updatedAt: now() };
    store.put('run', id, updated);
    changed();
    return updated;
  }

  function recordEvent(runId: string, type: string, message: string, nodeId?: string) {
    const record = run(runId);
    const created = store.event(runId, type, { message, nodeId });
    const event: RunEvent = { id: `event-${created.sequence}`, runId, projectId: record.projectId, sequence: created.sequence, type, message, nodeId, createdAt: created.createdAt };
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
    return { ...value, events: events(value.id), activities: journal.list(value.id).map(row => ({ id: row.activity_id, runId: row.run_id, nodeId: row.activity_id.split(':')[0], status: row.status === 'dispatched' ? 'submitted' : row.status === 'unknown' ? 'unknown' : row.status, inputHash: row.input_hash, result: row.result ? JSON.parse(row.result) as JsonValue : undefined, remoteTaskId: row.remote_id ?? undefined, attempt: 1, createdAt: row.started_at, updatedAt: row.completed_at ?? row.started_at, error: row.error ?? undefined })) };
  }

  function systemStatus(): RuntimeSystem {
    const executable = options.ffmpegPath ?? process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
    const probe = spawnSync(executable, ['-version'], { windowsHide: true, timeout: 3000, encoding: 'utf8' });
    return { platform: process.platform, runtimeVersion: process.version, dataDirectory: directory, ffmpegAvailable: probe.status === 0, ffmpegPath: probe.status === 0 ? executable : undefined, secureStorageAvailable: !!options.secretStore && options.secretStore.persistent !== false, mode: options.mode ?? 'desktop' };
  }

  const system = systemStatus();
  function snapshot(): WorkspaceSnapshot {
    return { projects: store.list<ProjectDocument>('project'), models: store.list<ModelProfile>('model'), skills: store.list<SkillPackage>('skill'), runs: store.list<RunRecord>('run').map(hydrateRun).reverse(), assets: store.list<AssetRecord>('asset'), events: events(), system };
  }

  async function executeNode(runId: string, node: WorkflowNode, saved: RunSnapshot, controller: AbortController): Promise<JsonValue> {
    if (controller.signal.aborted || run(runId).status === 'canceled') throw new Error('任务已停止。');
    updateRun(runId, { status: 'running', currentNodeId: node.id, error: undefined });
    recordEvent(runId, 'node.started', `开始：${node.label}`, node.id);
    const scopedProject = saved.regeneration ? { ...saved.project, shots: [saved.regeneration.baseline] } : node.config.operation === 'transcribe' ? { ...saved.project, shots: saved.project.shots.filter(shot => shot.id === node.config.shotId) } : saved.project;
    const executionProject = store.get<ProjectDocument>('node-project', `${runId}:${node.id}`) ?? store.get<ProjectDocument>('run-project', runId) ?? scopedProject;
    store.put('node-project', `${runId}:${node.id}`, executionProject);
    const selectedModel = node.modelId ? saved.models.find(model => model.id === node.modelId) : undefined;
    if (node.modelId && (!selectedModel || !selectedModel.enabled)) throw new Error('该步骤选择的模型不可用，请修改配置后创建新的运行。');
    if (selectedModel) validateModelParameters(selectedModel);
    const usesProvider = !!selectedModel && ['brief', 'research', 'style', 'script', 'agent'].includes(node.kind);
    if (usesProvider && !selectedModel.capabilities.includes('text')) throw new Error('此步骤需要具备文本能力的模型。');
    if (node.kind === 'agent' && selectedModel && !selectedModel.capabilities.includes('tools')) throw new Error('Agent 步骤需要具备工具调用能力的模型。');
    if (selectedModel) {
      const capability = node.config.operation === 'transcribe' ? 'asr' : node.kind === 'assets' ? 'image' : node.kind === 'voice' ? 'tts' : node.kind === 'animation' ? 'video' : undefined;
      if (capability && !selectedModel.capabilities.includes(capability)) throw new Error('所选模型不具备此步骤需要的生成能力，请修改配置后创建新的运行。');
      const protocols: Record<string, string[]> = { assets: ['openai-compatible', 'seedream', 'comfyui', 'custom-http'], voice: ['openai-compatible', 'qwen-tts', 'custom-http'], animation: ['openai-compatible', 'seedance', 'comfyui', 'custom-http'] };
      if (protocols[node.kind] && !protocols[node.kind].includes(selectedModel.provider)) throw new Error('所选模型的服务协议不适用于此步骤，请修改配置后创建新的运行。');
    }
    const secret = selectedModel?.credentialRef ? rememberSecret(await options.secretStore?.get(selectedModel.credentialRef)) : undefined;
    if (selectedModel?.hasSecret && !secret) throw new Error('模型凭据不可用，请重新保存密钥后创建新的运行。');
    const media = ['assets', 'voice', 'animation', 'export'].includes(node.kind);
    const safety = options.activitySafety?.(node) ?? (usesProvider || (media && !!selectedModel) ? 'external' : 'local');
    const input = { project: executionProject, node, model: selectedModel ?? null, skills: saved.skills.filter(skill => node.skillIds.includes(skill.id)), handlerVersion: saved.handlerVersion, ...(saved.exportBatch ? { exportBatch: saved.exportBatch, assets: saved.assets } : {}) };
    const cached = journal.get(runId, node.id);
    const selectedCharacterIds = new Set(node.kind === 'research' || node.kind === 'export' && !selectedModel ? [] : executionProject.shots.flatMap(shot => shot.characterIds ?? []));
    const executionCharacters = (saved.characters ?? []).filter(profile => selectedCharacterIds.has(profile.id));
    if (executionCharacters.length !== selectedCharacterIds.size) throw new Error('运行快照缺少镜头角色，请基于当前角色新建运行。');
    const referenceIds = new Set(executionCharacters.flatMap(profile => profile.referenceAssetIds));
    const characterAssets = (saved.characterAssets ?? []).filter(asset => referenceIds.has(asset.id));
    const assetIds = saved.regeneration ? new Set(executionProject.shots.flatMap(shot => [shot.assetId, shot.audioAssetId, shot.videoAssetId]).filter((id): id is string => Boolean(id))) : undefined;
    const activityAssets = media && options.executeActivity ? [...new Map([
      ...(saved.assets ?? (assetIds ? [...assetIds].map(id => store.get<AssetRecord>('asset', id)).filter((asset): asset is AssetRecord => Boolean(asset)) : store.list<AssetRecord>('asset'))).filter(asset => !asset.projectId || asset.projectId === saved.project.id),
      ...characterAssets,
    ].map(asset => [asset.id, asset])).values()] : [];
    if (media && selectedModel) await options.preflightActivity?.({ project: executionProject, node, assets: activityAssets, model: selectedModel, characters: executionCharacters, signal: controller.signal, dataDirectory: directory });
    if (media && cached?.status === 'completed' && cached.result) {
      const result: unknown = JSON.parse(cached.result);
      if (node.config.operation === 'transcribe') {
        const track = captionTrackSchema.safeParse(result && typeof result === 'object' && 'captionTrack' in result ? result.captionTrack : undefined);
        const shot = executionProject.shots.find(shot => shot.id === node.config.shotId);
        const audio = shot?.audioAssetId ? store.get<AssetRecord>('asset', shot.audioAssetId) : undefined;
        const bytes = audio ? await readFile(audio.path).catch(() => undefined) : undefined;
        if (!track.success || !audio?.active || track.data.sourceAssetId !== audio.id || track.data.sourceSha256 !== audio.sha256 || !bytes || createHash('sha256').update(bytes).digest('hex') !== audio.sha256) throw new Error('已完成字幕识别的源音频已更换或损坏，请基于当前音频重新识别。');
      }
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
    const deepAgent = node.kind === 'agent' && selectedModel?.capabilities.includes('tools') && selectedModel.provider === 'openai-compatible';
    const capability: ModelCapability | undefined = usesProvider ? 'text' : node.config.operation === 'transcribe' ? 'asr' : node.kind === 'assets' ? 'image' : node.kind === 'voice' ? 'tts' : node.kind === 'animation' ? 'video' : undefined;
    const researchContext = usesProvider && node.kind === 'research' ? selectResearchPassages(executionProject, saved.research?.sourceIds ?? (Array.isArray(node.config.sourceIds) ? node.config.sourceIds.filter((id): id is string => typeof id === 'string') : undefined), saved.research?.instruction ?? node.prompt) : undefined;
    const prompt = usesProvider ? researchContext ? researchPrompt(executionProject, node, saved.skills, researchContext) : buildPrompt(executionProject, node, saved.skills, Boolean(saved.regeneration), executionCharacters) : '';
    const costOperation = selectedModel && capability && !deepAgent ? `${runId}:${node.id}` : undefined;
    if (costOperation && selectedModel && capability) {
      const existing = costs.get(costOperation);
      if (cached?.status !== 'completed' || existing) costs.begin({ operationId: costOperation, runId, nodeId: node.id, shotId: saved.regeneration?.shotId ?? (typeof node.config.shotId === 'string' ? node.config.shotId : undefined), projectId: saved.project.id, model: selectedModel, capability, requestMetrics: requestCostMetrics(executionProject, node, selectedModel) });
      if (cached?.status === 'completed' && existing) costs.status(costOperation, 'completed');
    }
    try {
    const result = await journal.execute(runId, node.id, input, safety, async context => {
      if (usesProvider) {
        const generated = researchContext
          ? await researchModelResponse({ dataDirectory: directory, projectId: executionProject.id, operationId: context.operationId, inputHash: fingerprint({ prompt, model: selectedModel }), recordReceipt: context.recordRemoteId, generate: () => (options.provider ?? generateText)({ model: selectedModel, secret, prompt, operationId: context.operationId, signal: controller.signal }) })
          : deepAgent
          ? await (async () => {
              context.recordRemoteId(`langgraph:${runId}:${node.id}:agent`);
              const { executeDeepAgent } = await import('./agent.js');
              const selectedServers = Array.isArray(node.config.mcpServerIds) ? node.config.mcpServerIds.filter((value): value is string => typeof value === 'string') : [];
              const mcpServers = await Promise.all((saved.mcpServers ?? []).filter(server => server.enabled && selectedServers.includes(server.id)).map(async server => ({ ...server, secret: server.credentialRef ? rememberSecret(await options.secretStore?.get(server.credentialRef)) : undefined })));
              return executeDeepAgent({ database, model: selectedModel, secret, prompt, signal: controller.signal, runId, nodeId: node.id, project: executionProject, skills: saved.skills.filter(skill => skill.enabled && node.skillIds.includes(skill.id)), mcpServers, dataDirectory: directory, failpoint: options.failpoint, costs });
            })()
          : await (options.provider ?? generateText)({ model: selectedModel, secret, prompt, operationId: context.operationId, signal: controller.signal });
        const text = typeof generated === 'string' ? generated : generated.text;
        const usage = typeof generated === 'string' ? undefined : generated.usage;
        if (costOperation) costs.status(costOperation, 'completed', usage);
        if (researchContext) return { ...parseResearchResult(text, executionProject, researchContext, runId, node.id), ...(usage ? { providerUsage: usage } : {}) } as unknown as JsonValue;
        return { text, source: 'model', modelId: selectedModel.id, ...(usage ? { providerUsage: usage } : {}), ...(node.kind === 'script' ? { shots: parseShots(text, executionProject.shots, Boolean(saved.regeneration), executionProject.scenePreset) } : {}) } as JsonValue;
      }
      if (media && options.executeActivity) {
        const batch = saved.exportBatch;
        const output = await options.executeActivity({ project: executionProject, node, runId, operationId: context.operationId, signal: controller.signal, remoteTaskId: context.remoteId, persistRemoteTask: context.recordRemoteId, dataDirectory: directory, assets: activityAssets, model: selectedModel, apiKey: secret, characters: executionCharacters,
          ...(node.kind === 'export' ? { preparedAudioMix: audioPreview.ready(executionProject, activityAssets) } : {}),
          ...(batch ? { onProgress: value => batches.progress(batch.batchId, batch.targetId, value) } : {}) });
        const usage = providerUsageSchema.safeParse(output && typeof output === 'object' && !Array.isArray(output) ? output.providerUsage : undefined);
        if (costOperation) costs.status(costOperation, 'completed', usage.success ? usage.data : undefined);
        return output;
      }
      return localNodeResult(node, executionProject, store.list<AssetRecord>('asset'));
    }, output => {
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
          if (asset.kind === 'audio') shot = { ...baseline, audioAssetId: asset.id, audioInUs: 0 };
          if (asset.kind === 'video') shot = { ...baseline, videoAssetId: asset.id, videoInUs: 0 };
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
      let working = executionProject;
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        if (Array.isArray(output.shots) && node.kind === 'script') working = { ...working, shots: z.array(shotSchema).parse(output.shots) };
        if (node.kind === 'style' && typeof output.text === 'string') working = { ...working, style: output.text };
      }
      if (output && typeof output === 'object' && !Array.isArray(output) && Array.isArray(output.assets)) {
        for (const candidate of output.assets) {
          const asset = assetSchema.parse(candidate);
          if (asset.projectId !== saved.project.id) throw new Error('生成素材与当前项目不匹配。');
          store.put('asset', asset.id, asset);
          if (asset.shotId && ['image', 'audio', 'video'].includes(asset.kind)) {
            working = asset.kind === 'image' ? { ...working, shots: working.shots.map(shot => shot.id === asset.shotId ? { ...shot, assetId: asset.id } : shot) } : bindMedia(working, asset.shotId, asset, false);
          }
        }
      }
      store.put('run-project', runId, working);
      store.put('node-result', `${runId}:${node.id}`, output);
    });
    return result;
    } catch (error) {
      if (costOperation && !(error instanceof SimulatedProcessExit)) costs.status(costOperation, controller.signal.aborted ? 'canceled' : 'unknown');
      throw error;
    }
  }

  function schedule(runId: string, review?: boolean) {
    if (active.has(runId)) return;
    if (closing) throw new Error('运行环境正在关闭。');
    const saved = store.get<RunSnapshot>('run-snapshot', runId);
    if (!saved || saved.handlerVersion !== 1) throw new Error('运行版本不兼容，请复制项目并创建新的运行。');
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      updateRun(runId, { status: 'running', error: undefined });
      const nodeIds = new Set(saved.nodes.map(node => node.id));
      const workflow = { ...saved.project.workflow, nodes: saved.nodes, edges: saved.project.workflow.edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)) };
      const graph = createExecutionGraph(database, workflow, {
        execute: node => executeNode(runId, node, saved, controller),
        waiting: node => {
          if (controller.signal.aborted) throw new Error('任务已停止。');
          updateRun(runId, { status: 'waiting_review', currentNodeId: node.id });
          recordEvent(runId, 'review.waiting', `等待审阅：${node.label}`, node.id);
        },
        reviewed: (node, approved) => {
          recordEvent(runId, 'review.completed', approved ? `已通过：${node.label}` : `需修改：${node.label}`, node.id);
          updateRun(runId, { status: approved ? 'running' : 'needs_attention' });
        },
        advanced: node => recordEvent(runId, 'node.completed', `已完成：${node.label}`, node.id),
      });
      const config = { configurable: { thread_id: runId }, durability: 'sync' as const, signal: controller.signal, recursionLimit: 400 };
      const state = await graph.getState(config);
      if (review !== undefined) await graph.invoke(new Command<unknown, { completed?: string[]; skipped?: string[]; currentNodeId?: string; outputs?: Record<string, JsonValue>; pendingReview?: boolean }, 'dispatch' | 'execute' | 'review' | '__start__'>({ resume: { approved: review } }), config);
      else await graph.invoke(state.values && Object.keys(state.values).length ? null : { completed: [], skipped: [], currentNodeId: '', outputs: {}, pendingReview: false }, config);
      const latest = run(runId);
      if (latest.status !== 'waiting_review' && latest.status !== 'canceled') {
        updateRun(runId, { status: 'succeeded', currentNodeId: undefined });
        recordEvent(runId, 'run.completed', '所选步骤已完成');
      }
    }).catch(error => {
      if (error instanceof SimulatedProcessExit) return;
      const latest = run(runId);
      if (latest.status === 'canceled') return;
      const message = redactError(error instanceof Error ? error.message : '运行失败', store.list<ModelProfile>('model'), transientSecrets);
      const status = error instanceof AmbiguousActivityError || message.includes('请') || message.includes('先') ? 'needs_attention' : 'failed';
      updateRun(runId, { status, error: message });
      recordEvent(runId, 'run.failed', message, latest.currentNodeId);
    }).finally(() => { active.delete(runId); });
    active.set(runId, { promise, controller });
  }

  function projectBusy(projectId: string, exceptBatchId?: string) {
    return Boolean(database.prepare("SELECT 1 FROM documents r LEFT JOIN documents s ON s.kind = 'run-snapshot' AND s.id = r.id WHERE r.kind = 'run' AND json_extract(r.body, '$.projectId') = ? AND json_extract(r.body, '$.status') IN ('queued','running','waiting_review','waiting_external','retry_scheduled') AND (? IS NULL OR coalesce(json_extract(s.body, '$.exportBatch.batchId'), '') <> ?) LIMIT 1").get(projectId, exceptBatchId ?? null, exceptBatchId ?? null));
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

  async function dispatch(method: string, rawParams: unknown = {}): Promise<unknown> {
    if (method.startsWith('audio.mix.') || method === 'audio.silence') return audioPreview.dispatch(method, rawParams);
    if (closing) throw new Error('运行环境正在关闭。');
    switch (method) {
      case 'workspace.snapshot': return snapshot();
      case 'workspace.summary': return { projects: reads.projects(), models: store.list<ModelProfile>('model'), skills: store.list<SkillPackage>('skill'), system, version: workspaceVersion, assetsVersion: reads.assetsVersion() };
      case 'project.get': {
        const input = entityId.extend({ revision: z.number().int().positive().optional(), assetsVersion: z.number().int().nonnegative().optional() }).parse(rawParams);
        return reads.projectDetail(input.projectId, input.revision, input.assetsVersion);
      }
      case 'run.list': {
        const input = pageInputSchema.extend({ projectId: z.string().optional() }).parse(rawParams);
        return reads.runs(input.before, input.limit, input.projectId);
      }
      case 'run.events':
      case 'run.activities': {
        const input = pageInputSchema.extend({ runId: z.string().min(1) }).parse(rawParams);
        const value = run(input.runId);
        return method === 'run.events' ? reads.events(value, input.before, input.limit) : reads.activities(value.id, input.before, input.limit);
      }
      case 'asset.list': {
        const input = pageInputSchema.extend({ kind: assetSchema.shape.kind.optional() }).parse(rawParams);
        const result = reads.assets(input.before, input.limit, input.kind);
        return { ...result, items: result.items.map(asset => ({ ...asset, inUse: asset.inUse || characters.assetInUse(asset.id) })) };
      }
      case 'system.status': return system;
      case 'project.create': {
        const input = z.object({ title: z.string().min(1).max(160), brief: z.string().max(30000).default(''), profile: videoProfileSchema.optional(), templateId: z.string().optional(), seriesTemplateId: z.string().min(1).optional(), seriesTemplateRevision: z.number().int().positive().optional() }).refine(value => Boolean(value.seriesTemplateId) === (value.seriesTemplateRevision !== undefined), '请选择系列模板及其当前修订。').parse(rawParams);
        const settings = input.seriesTemplateId ? seriesTemplates.settingsFor(input.seriesTemplateId, input.seriesTemplateRevision) : undefined;
        const timestamp = now();
        const value = projectSchema.parse({ id: randomUUID(), title: input.title, brief: input.brief, templateId: input.templateId ?? 'history-handdrawn', revision: 1, profile: input.profile ?? DEFAULT_VIDEO_PROFILE, ...(settings ?? {}), shots: [], claims: [], workflow: createHistoryWorkflow(), createdAt: timestamp, updatedAt: timestamp, archived: false });
        store.put('project', value.id, value); changed(); return value;
      }
      case 'project.update': {
        const input = entityId.extend({ revision: z.number().int().optional(), patch: z.object({ title: z.string().min(1).max(160).optional(), brief: z.string().max(30000).optional(), profile: videoProfileSchema.optional(), style: z.string().optional(), workflow: workflowSchema.optional(), captionStyle: projectSchema.shape.captionStyle, scenePreset: projectSchema.shape.scenePreset, claims: z.array(claimSchema).optional(), shots: z.array(shotSchema).optional(), researchSources: projectSchema.shape.researchSources, referenceDisplay: projectSchema.shape.referenceDisplay, musicClips: projectSchema.shape.musicClips, audioMix: projectSchema.shape.audioMix, clipEditSources: projectSchema.shape.clipEditSources, clipEditPlans: projectSchema.shape.clipEditPlans }) }).parse(rawParams);
        const value = project(input.projectId); requireRevision(value, input.revision);
        if (input.patch.workflow) validateWorkflow(input.patch.workflow);
        const workflow = input.patch.workflow && !isDeepStrictEqual({ ...value.workflow, version: 0 }, { ...input.patch.workflow, version: 0 }) ? { ...input.patch.workflow, version: value.workflow.version + 1 } : value.workflow;
        for (const clip of input.patch.musicClips ?? []) {
          const asset = store.get<AssetRecord>('asset', clip.assetId);
          if (!asset?.active || asset.kind !== 'audio' || asset.projectId && asset.projectId !== value.id) throw new Error('背景音乐需要当前项目或公共素材库中的有效音频。');
        }
        return saveProject({ ...value, ...input.patch, workflow });
      }
      case 'project.saveShot': {
        const input = entityId.extend({ revision: z.number().int().optional(), shot: shotSchema }).parse(rawParams);
        const value = project(input.projectId); requireRevision(value, input.revision);
        const index = value.shots.findIndex(shot => shot.id === input.shot.id);
        const shots = [...value.shots];
        if (index === -1) shots.push(input.shot); else shots[index] = input.shot;
        return saveProject({ ...value, shots });
      }
      case 'project.archive':
      case 'project.restore': {
        const input = entityId.parse(rawParams); const value = project(input.projectId);
        if (store.list<RunRecord>('run').some(record => record.projectId === value.id && active.has(record.id))) throw new Error('请先停止项目任务。');
        return saveProject({ ...value, archived: method === 'project.archive' });
      }
      case 'workflow.save': {
        const input = entityId.extend({ revision: z.number().int().optional(), workflow: workflowSchema }).parse(rawParams);
        const value = project(input.projectId); requireRevision(value, input.revision); validateWorkflow(input.workflow);
        return saveProject({ ...value, workflow: { ...input.workflow, version: value.workflow.version + 1 } });
      }
      case 'render.export': {
        const input = entityId.extend({ profile: videoProfileSchema.optional(), destination: z.string().optional() }).parse(rawParams);
        const result = await dispatch('run.start', { projectId: input.projectId, nodeId: 'export', profile: input.profile, destination: input.destination }) as RunRecord;
        return { runId: result.id };
      }
      case 'run.start': {
        const input = entityId.extend({ nodeId: z.string().optional(), parentRunId: z.string().optional(), profile: videoProfileSchema.optional(), destination: z.string().optional(), revision: z.number().int().optional(), transcription: z.object({ shotId: z.string(), modelId: z.string() }).optional(), regeneration: regenerationInput.optional(), research: researchInput.optional() }).parse(rawParams);
        let inheritedScope = false;
        if (input.parentRunId) {
          const parent = run(input.parentRunId);
          if (parent.projectId !== input.projectId) throw new Error('父运行不属于当前项目。');
          // Read only the scope, without decoding the parent's full project or asset snapshot.
          const row = database.prepare("SELECT json_object('exportBatch', json_extract(body, '$.exportBatch'), 'regeneration', json_extract(body, '$.regeneration'), 'research', json_extract(body, '$.research'), 'nodes', json_extract(body, '$.nodes')) AS body FROM documents WHERE kind = 'run-snapshot' AND id = ?").get(parent.id) as { body: string } | undefined;
          if (!row) throw new Error('父运行快照不存在，无法确认重新制作范围。');
          const saved = JSON.parse(row.body) as Pick<RunSnapshot, 'exportBatch' | 'regeneration' | 'research' | 'nodes'>;
          const caption = saved.nodes.length === 1 && saved.nodes[0].config.operation === 'transcribe' ? saved.nodes[0] : undefined;
          if ((saved.exportBatch || saved.regeneration || saved.research || caption) && [input.nodeId, input.profile, input.destination, input.regeneration, input.transcription, input.research].some(value => value !== undefined)) throw new Error('特殊任务重新制作必须保留原任务范围，请从对应编辑器创建其他任务。');
          if (saved.exportBatch) { await batches.dispatch('render.batch.resume', { batchId: saved.exportBatch.batchId }); return hydrateRun(run(parent.id)); }
          if (saved.regeneration) {
            const modelId = saved.nodes.find(node => node.id === 'regenerate')?.modelId;
            if (!modelId) throw new Error('原镜头生成模型缺失，请从镜头编辑器选择模型后重新生成。');
            input.regeneration = { shotId: saved.regeneration.shotId, kind: saved.regeneration.kind, instruction: saved.regeneration.instruction, modelId };
            inheritedScope = true;
          } else if (caption) {
            if (typeof caption.config.shotId !== 'string' || !caption.modelId) throw new Error('原语音识别任务范围缺失，请从字幕编辑器重新识别。');
            input.transcription = { shotId: caption.config.shotId, modelId: caption.modelId };
            inheritedScope = true;
          } else if (saved.research) {
            const modelId = saved.nodes.find(node => node.kind === 'research')?.modelId;
            if (!modelId) throw new Error('原资料整理模型缺失，请在资料审阅中重新选择模型。');
            input.research = { ...saved.research, modelId }; inheritedScope = true;
          }
        }
        const original = project(input.projectId);
        validateResearchProject(original, original);
        if (inheritedScope && input.revision === undefined) input.revision = original.revision;
        if (input.regeneration && (input.transcription || input.revision === undefined)) throw new Error('镜头重新生成需要当前修订，且不能同时识别字幕。');
        if (input.research && (input.regeneration || input.transcription || input.revision === undefined)) throw new Error('资料整理需要当前修订，且不能同时启动其他特殊任务。');
        requireRevision(original, input.revision);
        const value = input.profile ? { ...original, profile: input.profile } : original;
        if (value.archived) throw new Error('请先恢复项目。');
        if (batches.blocked(value.id) || projectBusy(value.id)) throw new Error('该项目已有未完成的运行或批量导出，请继续或停止现有运行。');
        let nodes = (input.nodeId ? value.workflow.nodes.filter(node => node.id === input.nodeId) : orderedNodes(value.workflow)).map(node => input.destination && node.kind === 'export' ? { ...node, config: { ...node.config, destination: input.destination } } : node);
        if (input.transcription) {
          const shot = value.shots.find(shot => shot.id === input.transcription?.shotId);
          const audio = shot?.audioAssetId ? store.get<AssetRecord>('asset', shot.audioAssetId) : undefined;
          const model = store.get<ModelProfile>('model', input.transcription.modelId);
          if (!audio?.active || audio.kind !== 'audio' || audio.projectId && audio.projectId !== value.id) throw new Error('请先为镜头关联有效的旁白音频。');
          if (!model?.enabled || !model.capabilities.includes('asr') || model.provider !== 'openai-compatible') throw new Error('请选择支持时间戳的 OpenAI 兼容 ASR 模型。');
          nodes = [{ id: 'caption', kind: 'voice', label: '语音对齐字幕', description: '', prompt: '', skillIds: [], modelId: model.id, config: { operation: 'transcribe', shotId: input.transcription.shotId }, position: { x: 0, y: 0 }, requiresReview: false }];
        }
        if (input.regeneration) nodes = [regenerationNode(value, input.regeneration)];
        if (input.research) {
          const model = store.get<ModelProfile>('model', input.research.modelId);
          if (!model?.enabled || !model.capabilities.includes('text') || !['openai-compatible', 'ollama', 'custom-http'].includes(model.provider)) throw new Error('请选择可用的文本模型整理实际资料。');
          const template = value.workflow.nodes.find(node => node.kind === 'research');
          nodes = [{ id: 'research', kind: 'research', label: '资料证据候选', description: template?.description ?? '', prompt: [template?.prompt, input.research.instruction].filter(Boolean).join('\n\n'), skillIds: template?.skillIds ?? [], modelId: model.id, config: { ...template?.config, operation: 'research', ...(input.research.sourceIds ? { sourceIds: input.research.sourceIds } : {}) }, position: { x: 0, y: 0 }, requiresReview: false }];
          selectResearchPassages(value, input.research.sourceIds, input.research.instruction);
        }
        if (!nodes.length) throw new Error('未找到所选步骤。');
        const id = randomUUID();
        const baseline = input.regeneration ? value.shots.find(shot => shot.id === input.regeneration?.shotId) : undefined;
        const scope = input.research ? [] : baseline ? [baseline] : input.transcription ? value.shots.filter(shot => shot.id === input.transcription?.shotId) : value.shots;
        const bundle = characters.profilesFor({ shots: scope });
        const saved: RunSnapshot = { project: structuredClone(value), models: store.list<ModelProfile>('model'), skills: store.list<SkillPackage>('skill'), mcpServers: store.list<McpServer>('mcp-server'), nodes, handlerVersion: 1, characters: bundle.characters, characterAssets: bundle.assets, ...(input.research ? { research: { sourceIds: input.research.sourceIds, instruction: input.research.instruction } } : {}), ...(input.regeneration && baseline ? { regeneration: { shotId: baseline.id, baseline: structuredClone(baseline), kind: input.regeneration.kind, instruction: input.regeneration.instruction?.trim() } } : {}) };
        const timestamp = now();
        const record: RunRecord = { id, projectId: value.id, projectRevision: value.revision, status: 'queued', workflowVersion: value.workflow.version, snapshotDigest: fingerprint(saved), parentRunId: input.parentRunId, createdAt: timestamp, updatedAt: timestamp, events: [], activities: [] };
        database.transaction(() => { store.put('run-snapshot', id, saved); store.put('run', id, record); })();
        recordEvent(id, 'run.created', '运行快照已保存'); schedule(id); return hydrateRun(record);
      }
      case 'caption.transcribe': {
        const input = entityId.extend({ shotId: z.string(), modelId: z.string(), revision: z.number().int().positive() }).parse(rawParams);
        return dispatch('run.start', { projectId: input.projectId, revision: input.revision, transcription: { shotId: input.shotId, modelId: input.modelId } });
      }
      case 'research.source.read': return readResearchSource(rawParams);
      case 'research.search': return searchWikipedia(rawParams);
      case 'research.analyze': {
        const input = entityId.merge(researchInput).extend({ revision: z.number().int().positive() }).parse(rawParams);
        return dispatch('run.start', { projectId: input.projectId, revision: input.revision, research: { modelId: input.modelId, sourceIds: input.sourceIds, instruction: input.instruction } });
      }
      case 'shot.regenerate': {
        const input = entityId.merge(regenerationInput).extend({ revision: z.number().int().positive() }).parse(rawParams);
        return dispatch('run.start', { projectId: input.projectId, revision: input.revision, regeneration: { shotId: input.shotId, kind: input.kind, modelId: input.modelId, instruction: input.instruction } });
      }
      case 'shot.candidates': {
        const input = entityId.extend({ shotId: z.string().min(1), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }).parse(rawParams);
        if (!database.prepare("SELECT 1 FROM documents WHERE kind = 'project-summary' AND id = ?").get(input.projectId)) throw new Error('项目不存在或已被移除。');
        const filter = "FROM documents c JOIN documents r ON r.kind = 'run' AND r.id = json_extract(c.body, '$.runId') WHERE c.kind = 'shot-candidate' AND json_extract(c.body, '$.projectId') = ? AND json_extract(c.body, '$.shotId') = ? AND json_extract(r.body, '$.status') = 'succeeded'";
        const total = database.prepare(`SELECT count(*) AS total ${filter}`).get(input.projectId, input.shotId) as { total: number };
        const rows = database.prepare(`SELECT c.body ${filter} ORDER BY json_extract(c.body, '$.createdAt') DESC, c.id DESC LIMIT ? OFFSET ?`).all(input.projectId, input.shotId, input.limit, input.offset) as { body: string }[];
        const pending = database.prepare("SELECT r.body FROM documents r JOIN documents s ON s.kind = 'run-snapshot' AND s.id = r.id WHERE r.kind = 'run' AND json_extract(r.body, '$.projectId') = ? AND json_extract(s.body, '$.regeneration.shotId') = ? AND json_extract(r.body, '$.status') IN ('queued','running','waiting_review','waiting_external','retry_scheduled') ORDER BY json_extract(r.body, '$.createdAt') DESC, r.id DESC LIMIT 1").get(input.projectId, input.shotId) as { body: string } | undefined;
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
        if (candidate.baseline.clipEdit) {
          const oldPlanRow = database.prepare("SELECT p.value AS body FROM documents s, json_each(s.body, '$.project.clipEditPlans') p WHERE s.kind = 'run-snapshot' AND s.id = ? AND json_extract(p.value, '$.id') = ?").get(candidate.runId, candidate.baseline.clipEdit.planId) as { body: string } | undefined;
          const oldPlan = oldPlanRow ? JSON.parse(oldPlanRow.body) as NonNullable<ProjectDocument['clipEditPlans']>[number] : undefined;
          const currentPlan = value.clipEditPlans?.find(plan => plan.id === candidate.baseline.clipEdit?.planId);
          const oldSourceRow = oldPlan ? database.prepare("SELECT p.value AS body FROM documents s, json_each(s.body, '$.project.clipEditSources') p WHERE s.kind = 'run-snapshot' AND s.id = ? AND json_extract(p.value, '$.id') = ?").get(candidate.runId, oldPlan.sourceId) as { body: string } | undefined : undefined;
          const currentSource = oldPlan ? value.clipEditSources?.find(source => source.id === oldPlan.sourceId) : undefined;
          if (!oldPlan || !currentPlan || !oldSourceRow || !currentSource || fingerprint(oldPlan) !== fingerprint(currentPlan) || fingerprint(JSON.parse(oldSourceRow.body)) !== fingerprint(currentSource)) throw new Error('生成后原始剪辑或计划已变化，请重新生成候选。');
        }
        let usesProjectStyle = candidate.kind !== 'audio';
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
        if (candidate.kind === 'audio' || candidate.kind === 'video') {
          next = bindMedia(value, current.id, assets[0]);
          const retimed = next.shots.find(shot => shot.id === current.id)!;
          merged = { ...merged, clipEdit: retimed.clipEdit, captionTrack: retimed.captionTrack };
        } else if (candidate.kind === 'script' && current.clipEdit && merged.durationUs !== current.durationUs) {
          next = trimShotInContext(value, current.id, { inUs: current.clipEdit.inUs, outUs: current.clipEdit.inUs + merged.durationUs }, value.profile.frameRate, undefined, () => randomUUID());
          const retimed = next.shots.find(shot => shot.id === current.id)!;
          merged = { ...merged, durationUs: retimed.durationUs, clipEdit: retimed.clipEdit, sourceInUs: retimed.sourceInUs, audioInUs: retimed.audioInUs, videoInUs: retimed.videoInUs, sceneInUs: retimed.sceneInUs };
        }
        return saveProject({ ...next, shots: next.shots.map(shot => shot.id === current.id ? merged : shot) });
      }
      case 'run.get': return reads.runSummary(run(runIdInput.parse(rawParams).runId));
      case 'run.resume': {
        const { runId } = runIdInput.parse(rawParams); const value = run(runId);
        const saved = store.get<RunSnapshot>('run-snapshot', runId);
        if (saved?.exportBatch) { await batches.dispatch('render.batch.resume', { batchId: saved.exportBatch.batchId }); return hydrateRun(run(runId)); }
        if (batches.blocked(value.projectId)) throw new Error('请先继续或取消当前批量导出，再恢复其他运行。');
        if (value.status === 'waiting_review') throw new Error('请先完成当前步骤的审阅。');
        if (['succeeded', 'canceled'].includes(value.status)) throw new Error('该运行已经结束，请创建新的运行。');
        schedule(runId); return hydrateRun(run(runId));
      }
      case 'run.review': {
        const { runId, approved } = runIdInput.extend({ approved: z.boolean() }).parse(rawParams);
        if (run(runId).status !== 'waiting_review') throw new Error('当前运行没有待审阅步骤。');
        if (batches.blocked(run(runId).projectId)) throw new Error('请先继续或取消当前批量导出。');
        schedule(runId, approved); return hydrateRun(run(runId));
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
      case 'model.save': {
        const input = z.object({ model: modelSchema.partial().required({ name: true, provider: true, baseUrl: true, model: true, capabilities: true }), secret: z.string().optional() }).parse(rawParams);
        const id = input.model.id || randomUUID();
        const previous = store.get<ModelProfile>('model', id);
        validateModelParameters({ provider: input.model.provider, capabilities: input.model.capabilities, parameters: input.model.parameters ?? previous?.parameters ?? {} });
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
        const value = modelSchema.parse({ ...previous, ...input.model, id, credentialRef, hasSecret, parameters: input.model.parameters ?? previous?.parameters ?? {}, enabled: input.model.enabled ?? true, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp });
        store.put('model', id, value); changed(); return value;
      }
      case 'cost.list': case 'cost.update': case 'cost.summary': case 'cost.tasks': case 'cost.task.get': return costs.dispatch(method, rawParams);
      case 'render.batch.start': case 'render.batch.get': case 'render.batch.list': case 'render.batch.cancel': case 'render.batch.resume': return batches.dispatch(method, rawParams);
      case 'character.list': case 'character.get': case 'character.references': case 'character.save': case 'character.archive': case 'character.restore': return characters.dispatch(method, rawParams);
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
      case 'skill.import': {
        const input = z.object({ path: z.string().min(1).optional(), url: z.string().url().optional() }).refine(value => !!value.path !== !!value.url, '请选择目录或 GitHub 链接。').parse(rawParams);
        const value = await importSkill(input, directory); store.put('skill', value.id, value); changed(); return value;
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
        if (enabled && !['.js', '.mjs', '.cjs'].includes(extname(toolId).toLowerCase())) throw new Error('当前内置执行器支持 JavaScript 工具；其他格式请通过 MCP 接入。');
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
        const input = z.object({ path: z.string().min(1), projectId: z.string().optional(), shotId: z.string().optional(), kind: assetSchema.shape.kind.optional() }).parse(rawParams);
        const source = resolve(input.path); const info = await stat(source);
        if (!info.isFile() || info.size > 2_000_000_000) throw new Error('请选择不超过 2 GB 的文件。');
        const projectValue = input.projectId ? project(input.projectId) : undefined;
        if (input.shotId && !projectValue?.shots.some(shot => shot.id === input.shotId)) throw new Error('镜头不存在。');
        const id = randomUUID(); const extension = extname(source).toLowerCase();
        const metadata = mediaKind(extension); const destinationDirectory = join(directory, 'projects', input.projectId ?? 'library', 'assets');
        if (input.kind && input.kind !== metadata.kind) throw new Error('文件格式与所选素材类型不一致。');
        await mkdir(destinationDirectory, { recursive: true });
        const destination = join(destinationDirectory, `${id}${extension}`); await copyFile(source, `${destination}.part`);
        const data = await readFile(`${destination}.part`); await rename(`${destination}.part`, destination);
        const value = assetSchema.parse({ id, projectId: input.projectId, shotId: input.shotId, name: basename(source), kind: input.kind ?? metadata.kind, path: destination, mimeType: metadata.mimeType, size: info.size, sha256: createHash('sha256').update(data).digest('hex'), version: 1, createdAt: now(), provenance: '用户导入', retained: false, active: true });
        database.transaction(() => {
          store.put('asset', id, value);
          if (projectValue && input.shotId && ['image', 'audio', 'video'].includes(value.kind)) {
            const currentProject = project(projectValue.id);
            if (!currentProject.shots.some(shot => shot.id === input.shotId)) throw new Error('镜头已移除，无法关联导入素材。');
            saveProject(bindMedia(currentProject, input.shotId, value));
          }
        })(); changed(); return value;
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
        if (asset.retained || reads.assetInUse(assetId) || characters.assetInUse(assetId)) throw new Error('正在使用或已保留的素材不能移除。');
        store.put('asset', assetId, { ...asset, active: false }); changed(); return { deleted: true };
      }
      case 'project.backup': {
        const { projectId, destination } = entityId.extend({ destination: z.string().optional() }).parse(rawParams);
        const value = project(projectId);
        validateResearchProject(value, value);
        validateEdits(value, value);
        const bundle = characters.profilesFor(value);
        const referenced = new Set([...value.shots.flatMap(shot => [shot.assetId, shot.videoAssetId, shot.audioAssetId, shot.captionTrack?.sourceAssetId]), ...(value.clipEditSources ?? []).flatMap(clipSourceAssetIds), ...(value.musicClips ?? []).map(clip => clip.assetId), ...bundle.assets.map(asset => asset.id)]);
        const assets = store.list<AssetRecord>('asset').filter(asset => asset.projectId === projectId || !asset.projectId && referenced.has(asset.id));
        const backupDirectory = resolve(destination ?? join(directory, 'backups', `${projectId}-${Date.now()}`));
        await mkdir(join(backupDirectory, 'assets'), { recursive: true });
        const portable = assets.map(asset => ({ ...asset, path: `assets/${createHash('sha256').update(asset.id).digest('hex')}${extname(asset.path).toLowerCase()}` }));
        for (let index = 0; index < assets.length; index++) {
          if (!existsSync(assets[index].path)) throw new Error(`素材「${assets[index].name}」缺失，无法创建完整备份。`);
          await copyFile(assets[index].path, join(backupDirectory, portable[index].path));
        }
        const schemaVersion = value.clipEditSources?.length || value.clipEditPlans?.length || value.audioMix || value.shots.some(shot => shot.clipEdit || shot.audioProcessing) ? 2 : 1;
        await writeFile(join(backupDirectory, 'project.json'), JSON.stringify({ schemaVersion, project: value, assets: portable, characters: bundle.characters }, null, 2), { encoding: 'utf8', flag: 'wx' });
        return { path: backupDirectory, assets: portable.length };
      }
      case 'project.importBackup': {
        const { path } = z.object({ path: z.string().min(1) }).parse(rawParams);
        const entry = resolve(path);
        const source = (await stat(entry)).isDirectory() ? join(entry, 'project.json') : entry;
        const info = await stat(source);
        if (!info.isFile() || info.size > 30_000_000) throw new Error('项目备份文件无效或超过 30 MB。');
        const backup = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), project: projectSchema, assets: z.array(assetSchema).max(2000), characters: z.array(characterProfileSchema).max(1000).default([]) }).parse(JSON.parse(await readFile(source, 'utf8')));
        if (backup.schemaVersion === 1 && (backup.project.clipEditSources?.length || backup.project.clipEditPlans?.length || backup.project.audioMix || backup.project.shots.some(shot => shot.clipEdit || shot.audioProcessing))) throw new Error('包含剪辑或声音处理的备份必须使用格式 2，请重新创建完整备份。');
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
        const projectId = randomUUID();
        const assetDirectory = join(directory, 'projects', projectId, 'assets');
        await mkdir(assetDirectory, { recursive: true });
        const identifiers = new Map(buffers.map(({ asset }) => [asset.id, randomUUID()]));
        const clipAssetId = (id: string | undefined) => { if (!id) return undefined; const mapped = identifiers.get(id); if (!mapped) throw new Error('备份缺少原始剪辑素材，请使用完整备份。'); return mapped; };
        const importedCharacters = characters.prepareImport({ characters: backup.characters, assets: backup.assets }, identifiers);
        const characterReferences = new Set(backup.characters.flatMap(profile => profile.referenceAssetIds));
        if (backup.project.shots.some(shot => shot.characterIds?.some(id => !importedCharacters.idMap.has(id)))) throw new Error('备份缺少镜头使用的角色，请重新创建完整备份。');
        const restoredAssets: AssetRecord[] = [];
        const timestamp = now();
        for (const { asset, bytes } of buffers) {
          const id = identifiers.get(asset.id);
          if (!id) throw new Error('备份素材编号无效。');
          const destination = join(assetDirectory, `${id}${extname(asset.path)}`);
          await writeFile(destination, bytes, { flag: 'wx' });
          restoredAssets.push({ ...asset, id, projectId: characterReferences.has(asset.id) ? undefined : projectId, shotId: characterReferences.has(asset.id) ? undefined : asset.shotId, path: destination, createdAt: timestamp });
        }
        const restored = projectSchema.parse({ ...backup.project, id: projectId, title: `${backup.project.title.slice(0, 150)}（恢复）`, revision: 1, archived: false, createdAt: timestamp, updatedAt: timestamp,
          clipEditSources: backup.project.clipEditSources?.map(source => ({ ...source, original: { ...source.original, assetId: clipAssetId(source.original.assetId), audioAssetId: clipAssetId(source.original.audioAssetId), videoAssetId: clipAssetId(source.original.videoAssetId), captionTrack: source.original.captionTrack ? { ...source.original.captionTrack, sourceAssetId: clipAssetId(source.original.captionTrack.sourceAssetId) } : undefined }, assetHashes: source.assetHashes.map(hash => ({ ...hash, assetId: clipAssetId(hash.assetId)! })) })),
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
        const { runId, nodeId, revision } = z.object({ runId: z.string(), nodeId: z.string(), revision: z.number().int().optional() }).parse(rawParams);
        const record = run(runId); const value = project(record.projectId); requireRevision(value, revision);
        const saved = store.get<RunSnapshot>('run-snapshot', runId);
        if (saved?.nodes.some(node => node.id === nodeId && node.kind === 'research')) throw new Error('请在“资料与事实主张”中比较证据候选，选择后加入草稿并人工核验。');
        if (saved?.regeneration) {
          if (nodeId !== 'regenerate') throw new Error('未找到对应镜头候选。');
          const candidateId = `candidate-${createHash('sha256').update(`${runId}:${nodeId}`).digest('hex').slice(0, 32)}`;
          return dispatch('shot.candidate.apply', { projectId: record.projectId, candidateId, revision: revision ?? value.revision });
        }
        if (!saved || value.revision !== saved.project.revision) throw new Error('项目已在生成后修改，请基于当前内容重新生成建议。');
        const frozenCharacters = saved.characters ?? [], frozenReferences = saved.characterAssets ?? [];
        await validateCharacterAssets(frozenCharacters, frozenReferences);
        const verifiedProject = () => {
          const current = project(record.projectId); requireRevision(current, revision);
          if (current.revision !== saved.project.revision) throw new Error('项目已在生成后修改，请基于当前内容重新生成建议。');
          requireCurrentCharacters(frozenCharacters); requireCandidateAssets(frozenReferences);
          return current;
        };
        const currentValue = verifiedProject();
        const result = store.get<JsonValue>('node-result', `${runId}:${nodeId}`);
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('步骤没有可应用的结果。');
        const node = saved.nodes.find(item => item.id === nodeId);
        if (node?.config.operation === 'transcribe') {
          const track = captionTrackSchema.parse(result.captionTrack);
          const shot = currentValue.shots.find(shot => shot.id === node.config.shotId);
          const audio = shot?.audioAssetId ? store.get<AssetRecord>('asset', shot.audioAssetId) : undefined;
          const bytes = audio ? await readFile(audio.path).catch(() => undefined) : undefined;
          if (!shot || !audio?.active || track.sourceAssetId !== audio.id || track.sourceSha256 !== audio.sha256 || !bytes || createHash('sha256').update(bytes).digest('hex') !== audio.sha256) throw new Error('字幕识别的源音频已更换或损坏，请重新识别。');
          const latest = verifiedProject();
          return saveProject({ ...latest, shots: latest.shots.map(item => item.id === shot.id ? { ...item, captionTrack: track } : item) });
        }
        if (node?.kind === 'script' && Array.isArray(result.shots)) return saveProject({ ...currentValue, shots: z.array(shotSchema).parse(result.shots) });
        if (node?.kind === 'style' && typeof result.text === 'string') return saveProject({ ...currentValue, style: result.text });
        const working = store.get<ProjectDocument>('run-project', runId);
        if (working && ['assets', 'voice', 'animation'].includes(node?.kind ?? '')) return saveProject({ ...currentValue, shots: working.shots, clipEditSources: working.clipEditSources, clipEditPlans: working.clipEditPlans });
        throw new Error('此步骤结果用于审阅，无需写入项目。');
      }
      default: throw new Error(`未知操作：${method}`);
    }
  }

  return {
    dispatch,
    subscribe(listener: (event: RuntimeEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async waitForIdle() { await audioPreview.waitForIdle(); await batches.waitForIdle(); await Promise.allSettled([...active.values()].map(value => value.promise)); },
    async close() {
      closing = true;
      await audioPreview.close();
      await batches.close();
      for (const value of active.values()) value.controller.abort();
      await Promise.allSettled([...active.values()].map(value => value.promise));
      database.close(); listeners.clear(); transientSecrets.clear();
    },
  };
}

function buildPrompt(project: ProjectDocument, node: WorkflowNode, skills: SkillPackage[], singleShot = false, characters: CharacterProfile[] = []) {
  const selected = skills.filter(skill => skill.enabled && node.skillIds.includes(skill.id));
  const contract = node.kind === 'script' ? `\n只返回 JSON：{"shots":[{"title":"标题","narration":"旁白","visualPrompt":"画面描述","durationUs":8000000}]}。${singleShot ? '只编辑给出的目标镜头，必须恰好返回一条镜头，不增删其他镜头。' : '保持已锁定镜头。'}` : '\n输出可供人工审阅的中文结果。未经查证的来源与主张标为待核验，不编造引用。';
  const referenced = new Set(project.shots.flatMap(shot => shot.claimIds));
  const promptShots = project.shots.map(({ captionStyle: _captionStyle, ...shot }) => shot);
  return [`你正在执行视频制作步骤：${node.label}。`, project.brief, `系列风格：${project.style}`, `现有分镜：${JSON.stringify(promptShots)}`, `镜头已引用的事实主张（保留核验状态，pending/disputed不得表述为已核实）：${JSON.stringify(project.claims.filter(claim => referenced.has(claim.id)))}`, ...(characters.length ? [`镜头已选择的角色文字设定（仅文字，没有发送参考图）：\n${characters.map(profile => `${profile.name}：${profile.description}`).join('\n')}`] : []), ...selected.map(skill => `Skill ${skill.name}:\n${skill.instructions}`), node.prompt, contract].filter(Boolean).join('\n\n');
}

function parseShots(text: string, previous: ProjectDocument['shots'], singleShot = false, preset?: ProjectDocument['scenePreset']) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let payload: unknown;
  try { payload = JSON.parse(cleaned); } catch { throw new Error('分镜结果不是有效 JSON，请调整模型或提示词后重试。'); }
  const parsed = z.object({ shots: z.array(shotSchema.omit({ id: true }).partial().required({ title: true, narration: true, visualPrompt: true })).min(1).max(100) }).parse(payload);
  if (singleShot) {
    const baseline = previous[0];
    if (parsed.shots.length !== 1 || !baseline) throw new Error('单镜头重新生成必须恰好返回一条镜头。');
    const shot = parsed.shots[0];
    return [shotSchema.parse({ ...baseline, title: shot.title, narration: shot.narration, visualPrompt: shot.visualPrompt, durationUs: shot.durationUs ?? baseline.durationUs })];
  }
  return parsed.shots.map((shot, index) => {
    if (previous[index]?.locked) return previous[index];
    const sceneTemplate = previous[index] ? previous[index].sceneTemplate : preset ? { ...createSceneTemplate(preset.kind), palette: preset.palette, motion: preset.motion } : undefined;
    const before = previous[index];
    return shotSchema.parse({ ...before, title: shot.title, narration: shot.narration, visualPrompt: shot.visualPrompt, captionStyle: before?.captionStyle, claimIds: before?.claimIds ?? [], characterIds: before?.characterIds, sceneTemplate, id: before?.id ?? `shot-${index + 1}`, durationUs: before?.clipEdit ? before.durationUs : shot.durationUs ?? before?.durationUs ?? 8_000_000 });
  });
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
    case 'voice': {
      const missing = project.shots.filter(shot => !assets.some(asset => asset.id === shot.audioAssetId));
      if (missing.length) throw new Error(`请为 ${missing.length} 个镜头导入旁白录音，或配置配音模型。`);
      return { audioAssetIds: project.shots.map(shot => shot.audioAssetId ?? ''), source: 'project' };
    }
    case 'animation': return { shots: project.shots.map(shot => ({ id: shot.id, animation: shot.animation, durationUs: shot.durationUs })) as unknown as JsonValue };
    case 'export': throw new Error('请在桌面渲染器连接后导出成片。');
    case 'agent': throw new Error('请为 Agent 步骤选择具备文本能力的模型。');
    case 'condition': return { matched: node.config.value === true, field: typeof node.config.field === 'string' ? node.config.field : '' };
    case 'join': return { joined: true };
    case 'review': return { reviewed: false };
  }
}

export function validateWorkflow(workflow: WorkflowDefinition) {
  const ids = new Set(workflow.nodes.map(node => node.id));
  if (ids.size !== workflow.nodes.length) throw new Error('流程包含重复的步骤 ID。');
  for (const edge of workflow.edges) if (!ids.has(edge.source) || !ids.has(edge.target)) throw new Error('流程连接引用了不存在的步骤。');
  orderedNodes(workflow);
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

function redactError(message: string, models: ModelProfile[], secrets: Iterable<string> = []) {
  let safe = message.replace(/Bearer\s+[^\s]+/gi, 'Bearer [已隐藏]').replace(/sk-[a-z0-9_-]+/gi, '[已隐藏]');
  for (const secret of secrets) {
    if (!secret) continue;
    safe = safe.replaceAll(secret, '[已隐藏]').replaceAll(encodeURIComponent(secret), '[已隐藏]');
  }
  for (const model of models) {
    try { const url = new URL(model.baseUrl); if (url.search) safe = safe.replaceAll(model.baseUrl, `${url.origin}${url.pathname}`); } catch { /* Stored URLs are schema-validated; ignore historical invalid entries. */ }
  }
  return safe.slice(0, 1200);
}
