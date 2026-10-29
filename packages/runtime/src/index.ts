import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile, rename, lstat } from 'node:fs/promises';
import { basename, extname, join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import {
  assetSchema, claimSchema, createHistoryWorkflow, DEFAULT_VIDEO_PROFILE, modelSchema, projectSchema, shotSchema, videoProfileSchema, workflowSchema,
  type AssetRecord, type JsonValue, type ModelProfile, type ProjectDocument, type RunEvent, type RunRecord, type RuntimeEvent, type RuntimeSystem, type SkillPackage, type WorkflowDefinition, type WorkflowNode, type WorkspaceSnapshot,
} from '@video-quickly/contracts';
import { ActivityJournal, AmbiguousActivityError, fingerprint, SimulatedProcessExit, type ActivityHooks, type ActivitySafety } from './activities.js';
import { openDatabase, DocumentStore } from './database.js';
import { Command, createExecutionGraph } from './graph.js';
import { generateText, testModelConnection, type TextProvider } from './providers.js';
import { seedHistoryProject } from './seed.js';
import { importSkill } from './skills.js';
import { connectMcp, mcpServerSchema, type McpServer } from './mcp.js';

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
  persistRemoteTask(id: string): void;
}

export interface RuntimeOptions {
  dataDirectory: string;
  mode?: 'desktop' | 'development';
  secretStore?: SecretStore;
  provider?: TextProvider;
  failpoint?: ActivityHooks['failpoint'];
  executeActivity?: (context: ActivityExecutionContext) => Promise<JsonValue>;
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
}

const entityId = z.object({ projectId: z.string().min(1) });
const runIdInput = z.object({ runId: z.string().min(1) });
const now = () => new Date().toISOString();

export function createRuntime(options: RuntimeOptions) {
  const directory = resolve(options.dataDirectory);
  const database = openDatabase(directory);
  const store = new DocumentStore(database);
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const active = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  const transientSecrets = new Set<string>();
  function rememberSecret(value: string | undefined) { if (value) transientSecrets.add(value); return value; }
  let closing = false;
  const changed = () => emit({ type: 'workspace.changed' });
  function emit(event: RuntimeEvent) { for (const listener of listeners) listener(event); }
  const journal = new ActivityJournal(database, { failpoint: options.failpoint, onEvent: changed });

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

  function requireRevision(value: ProjectDocument, revision?: number) {
    if (revision !== undefined && revision !== value.revision) throw new Error('项目已在其他视图修改，请刷新后重新保存。');
  }

  function saveProject(value: ProjectDocument) {
    const saved = projectSchema.parse({ ...value, revision: value.revision + 1, updatedAt: now() });
    store.put('project', saved.id, saved);
    changed();
    return saved;
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
    const executionProject = store.get<ProjectDocument>('node-project', `${runId}:${node.id}`) ?? store.get<ProjectDocument>('run-project', runId) ?? saved.project;
    store.put('node-project', `${runId}:${node.id}`, executionProject);
    const selectedModel = node.modelId ? saved.models.find(model => model.id === node.modelId) : undefined;
    if (node.modelId && (!selectedModel || !selectedModel.enabled)) throw new Error('该步骤选择的模型不可用，请修改配置后创建新的运行。');
    const usesProvider = !!selectedModel && ['brief', 'research', 'style', 'script', 'agent'].includes(node.kind);
    if (usesProvider && !selectedModel.capabilities.includes('text')) throw new Error('此步骤需要具备文本能力的模型。');
    if (node.kind === 'agent' && selectedModel && !selectedModel.capabilities.includes('tools')) throw new Error('Agent 步骤需要具备工具调用能力的模型。');
    if (selectedModel) {
      const capability = node.kind === 'assets' ? 'image' : node.kind === 'voice' ? 'tts' : node.kind === 'animation' ? 'video' : undefined;
      if (capability && !selectedModel.capabilities.includes(capability)) throw new Error('所选模型不具备此步骤需要的生成能力，请修改配置后创建新的运行。');
      const protocols: Record<string, string[]> = { assets: ['openai-compatible', 'seedream', 'comfyui', 'custom-http'], voice: ['openai-compatible', 'qwen-tts', 'custom-http'], animation: ['openai-compatible', 'seedance', 'comfyui', 'custom-http'] };
      if (protocols[node.kind] && !protocols[node.kind].includes(selectedModel.provider)) throw new Error('所选模型的服务协议不适用于此步骤，请修改配置后创建新的运行。');
    }
    const secret = selectedModel?.credentialRef ? rememberSecret(await options.secretStore?.get(selectedModel.credentialRef)) : undefined;
    if (selectedModel?.hasSecret && !secret) throw new Error('模型凭据不可用，请重新保存密钥后创建新的运行。');
    const media = ['assets', 'voice', 'animation', 'export'].includes(node.kind);
    const safety = options.activitySafety?.(node) ?? (usesProvider || (media && !!selectedModel) ? 'external' : 'local');
    const input = { project: executionProject, node, model: selectedModel ?? null, skills: saved.skills.filter(skill => node.skillIds.includes(skill.id)), handlerVersion: saved.handlerVersion };
    const cached = journal.get(runId, node.id);
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
    const result = await journal.execute(runId, node.id, input, safety, async context => {
      if (usesProvider) {
        const prompt = buildPrompt(executionProject, node, saved.skills);
        const text = node.kind === 'agent' && selectedModel.capabilities.includes('tools') && selectedModel.provider === 'openai-compatible'
          ? await (async () => {
              context.recordRemoteId(`langgraph:${runId}:${node.id}:agent`);
              const { executeDeepAgent } = await import('./agent.js');
              const selectedServers = Array.isArray(node.config.mcpServerIds) ? node.config.mcpServerIds.filter((value): value is string => typeof value === 'string') : [];
              const mcpServers = await Promise.all((saved.mcpServers ?? []).filter(server => server.enabled && selectedServers.includes(server.id)).map(async server => ({ ...server, secret: server.credentialRef ? rememberSecret(await options.secretStore?.get(server.credentialRef)) : undefined })));
              return executeDeepAgent({ database, model: selectedModel, secret, prompt, signal: controller.signal, runId, nodeId: node.id, project: executionProject, skills: saved.skills.filter(skill => skill.enabled && node.skillIds.includes(skill.id)), mcpServers, dataDirectory: directory, failpoint: options.failpoint });
            })()
          : await (options.provider ?? generateText)({ model: selectedModel, secret, prompt, operationId: context.operationId, signal: controller.signal });
        return { text, source: 'model', modelId: selectedModel.id, ...(node.kind === 'script' ? { shots: parseShots(text, executionProject.shots) } : {}) } as JsonValue;
      }
      if (media && options.executeActivity) {
        return options.executeActivity({ project: executionProject, node, runId, operationId: context.operationId, signal: controller.signal, remoteTaskId: context.remoteId, persistRemoteTask: context.recordRemoteId, dataDirectory: directory, assets: store.list<AssetRecord>('asset').filter(asset => asset.projectId === saved.project.id), model: selectedModel, apiKey: secret });
      }
      return localNodeResult(node, executionProject, store.list<AssetRecord>('asset'));
    }, output => {
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
            const key = asset.kind === 'image' ? 'assetId' : asset.kind === 'audio' ? 'audioAssetId' : 'videoAssetId';
            working = { ...working, shots: working.shots.map(shot => shot.id === asset.shotId ? { ...shot, [key]: asset.id } : shot) };
          }
        }
      }
      store.put('run-project', runId, working);
      store.put('node-result', `${runId}:${node.id}`, output);
    });
    return result;
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

  async function dispatch(method: string, rawParams: unknown = {}): Promise<unknown> {
    if (closing) throw new Error('运行环境正在关闭。');
    switch (method) {
      case 'workspace.snapshot': return snapshot();
      case 'system.status': return system;
      case 'project.create': {
        const input = z.object({ title: z.string().min(1).max(160), brief: z.string().max(30000).default(''), profile: videoProfileSchema.optional(), templateId: z.string().optional() }).parse(rawParams);
        const timestamp = now();
        const value = projectSchema.parse({ id: randomUUID(), title: input.title, brief: input.brief, templateId: input.templateId ?? 'history-handdrawn', revision: 1, profile: input.profile ?? DEFAULT_VIDEO_PROFILE, shots: [], claims: [], workflow: createHistoryWorkflow(), createdAt: timestamp, updatedAt: timestamp, archived: false });
        store.put('project', value.id, value); changed(); return value;
      }
      case 'project.update': {
        const input = entityId.extend({ revision: z.number().int().optional(), patch: z.object({ title: z.string().min(1).max(160).optional(), brief: z.string().max(30000).optional(), profile: videoProfileSchema.optional(), style: z.string().optional(), claims: z.array(claimSchema).optional(), shots: z.array(shotSchema).optional() }) }).parse(rawParams);
        const value = project(input.projectId); requireRevision(value, input.revision);
        return saveProject({ ...value, ...input.patch });
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
        const input = entityId.extend({ nodeId: z.string().optional(), parentRunId: z.string().optional(), profile: videoProfileSchema.optional(), destination: z.string().optional() }).parse(rawParams);
        const original = project(input.projectId);
        const value = input.profile ? { ...original, profile: input.profile } : original;
        if (value.archived) throw new Error('请先恢复项目。');
        if (store.list<RunRecord>('run').some(record => record.projectId === value.id && ['queued', 'running', 'waiting_review', 'waiting_external', 'retry_scheduled'].includes(record.status))) throw new Error('该项目已有未完成的运行，请继续或停止现有运行。');
        const nodes = (input.nodeId ? value.workflow.nodes.filter(node => node.id === input.nodeId) : orderedNodes(value.workflow)).map(node => input.destination && node.kind === 'export' ? { ...node, config: { ...node.config, destination: input.destination } } : node);
        if (!nodes.length) throw new Error('未找到所选步骤。');
        const id = randomUUID();
        const saved: RunSnapshot = { project: structuredClone(value), models: store.list<ModelProfile>('model'), skills: store.list<SkillPackage>('skill'), mcpServers: store.list<McpServer>('mcp-server'), nodes, handlerVersion: 1 };
        const timestamp = now();
        const record: RunRecord = { id, projectId: value.id, projectRevision: value.revision, status: 'queued', workflowVersion: value.workflow.version, snapshotDigest: fingerprint(saved), parentRunId: input.parentRunId, createdAt: timestamp, updatedAt: timestamp, events: [], activities: [] };
        database.transaction(() => { store.put('run-snapshot', id, saved); store.put('run', id, record); })();
        recordEvent(id, 'run.created', '运行快照已保存'); schedule(id); return hydrateRun(record);
      }
      case 'run.resume': {
        const { runId } = runIdInput.parse(rawParams); const value = run(runId);
        if (value.status === 'waiting_review') throw new Error('请先完成当前步骤的审阅。');
        if (['succeeded', 'canceled'].includes(value.status)) throw new Error('该运行已经结束，请创建新的运行。');
        schedule(runId); return hydrateRun(run(runId));
      }
      case 'run.review': {
        const { runId, approved } = runIdInput.extend({ approved: z.boolean() }).parse(rawParams);
        if (run(runId).status !== 'waiting_review') throw new Error('当前运行没有待审阅步骤。');
        schedule(runId, approved); return hydrateRun(run(runId));
      }
      case 'run.cancel': {
        const { runId } = runIdInput.parse(rawParams); const value = run(runId);
        if (value.status === 'succeeded') return hydrateRun(value);
        updateRun(runId, { status: 'canceled' }); active.get(runId)?.controller.abort();
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
            const key = value.kind === 'image' ? 'assetId' : value.kind === 'audio' ? 'audioAssetId' : 'videoAssetId';
            store.put('project', projectValue.id, projectSchema.parse({ ...projectValue, revision: projectValue.revision + 1, updatedAt: now(), shots: projectValue.shots.map(shot => shot.id === input.shotId ? { ...shot, [key]: id } : shot) }));
          }
        })(); changed(); return value;
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
        const asset = store.get<AssetRecord>('asset', assetId); if (!asset) throw new Error('素材不存在。');
        const value = project(projectId); requireRevision(value, revision);
        if (asset.projectId && asset.projectId !== projectId) throw new Error('请先将其他项目的素材导入当前项目。');
        if (!value.shots.some(shot => shot.id === shotId)) throw new Error('镜头不存在。');
        if (!['image', 'audio', 'video'].includes(asset.kind)) throw new Error('该素材不能绑定到镜头。');
        const key = asset.kind === 'image' ? 'assetId' : asset.kind === 'audio' ? 'audioAssetId' : 'videoAssetId';
        return saveProject({ ...value, shots: value.shots.map(shot => shot.id === shotId ? { ...shot, [key]: assetId } : shot) });
      }
      case 'asset.delete': {
        const { assetId } = z.object({ assetId: z.string() }).parse(rawParams);
        const asset = store.get<AssetRecord>('asset', assetId); if (!asset) throw new Error('素材不存在。');
        if (asset.retained || store.list<ProjectDocument>('project').some(value => value.shots.some(shot => [shot.assetId, shot.audioAssetId, shot.videoAssetId].includes(assetId)))) throw new Error('正在使用或已保留的素材不能移除。');
        store.put('asset', assetId, { ...asset, active: false }); changed(); return { deleted: true };
      }
      case 'project.backup': {
        const { projectId, destination } = entityId.extend({ destination: z.string().optional() }).parse(rawParams);
        const value = project(projectId); const assets = store.list<AssetRecord>('asset').filter(asset => asset.projectId === projectId);
        const backupDirectory = resolve(destination ?? join(directory, 'backups', `${projectId}-${Date.now()}`));
        await mkdir(join(backupDirectory, 'assets'), { recursive: true });
        for (const asset of assets) if (existsSync(asset.path)) await copyFile(asset.path, join(backupDirectory, 'assets', basename(asset.path)));
        const portable = assets.map(asset => ({ ...asset, path: `assets/${basename(asset.path)}` }));
        await writeFile(join(backupDirectory, 'project.json'), JSON.stringify({ schemaVersion: 1, project: value, assets: portable }, null, 2), { encoding: 'utf8', flag: 'wx' });
        return { path: backupDirectory, assets: portable.length };
      }
      case 'project.importBackup': {
        const { path } = z.object({ path: z.string().min(1) }).parse(rawParams);
        const entry = resolve(path);
        const source = (await stat(entry)).isDirectory() ? join(entry, 'project.json') : entry;
        const info = await stat(source);
        if (!info.isFile() || info.size > 30_000_000) throw new Error('项目备份文件无效或超过 30 MB。');
        const backup = z.object({ schemaVersion: z.literal(1), project: projectSchema, assets: z.array(assetSchema).max(2000) }).parse(JSON.parse(await readFile(source, 'utf8')));
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
        const identifiers = new Map<string, string>();
        const restoredAssets: AssetRecord[] = [];
        const timestamp = now();
        for (const { asset, bytes } of buffers) {
          const id = randomUUID(); identifiers.set(asset.id, id);
          const destination = join(assetDirectory, `${id}${extname(asset.path)}`);
          await writeFile(destination, bytes, { flag: 'wx' });
          restoredAssets.push({ ...asset, id, projectId, path: destination, createdAt: timestamp });
        }
        const restored = projectSchema.parse({ ...backup.project, id: projectId, title: `${backup.project.title.slice(0, 150)}（恢复）`, revision: 1, archived: false, createdAt: timestamp, updatedAt: timestamp, shots: backup.project.shots.map(shot => ({ ...shot, assetId: shot.assetId ? identifiers.get(shot.assetId) : undefined, audioAssetId: shot.audioAssetId ? identifiers.get(shot.audioAssetId) : undefined, videoAssetId: shot.videoAssetId ? identifiers.get(shot.videoAssetId) : undefined })) });
        database.transaction(() => { store.put('project', projectId, restored); for (const asset of restoredAssets) store.put('asset', asset.id, asset); })();
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
        if (!saved || value.revision !== saved.project.revision) throw new Error('项目已在生成后修改，请基于当前内容重新生成建议。');
        const result = store.get<JsonValue>('node-result', `${runId}:${nodeId}`);
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('步骤没有可应用的结果。');
        const node = saved.nodes.find(item => item.id === nodeId);
        if (node?.kind === 'script' && Array.isArray(result.shots)) return saveProject({ ...value, shots: z.array(shotSchema).parse(result.shots) });
        if (node?.kind === 'style' && typeof result.text === 'string') return saveProject({ ...value, style: result.text });
        const working = store.get<ProjectDocument>('run-project', runId);
        if (working && ['assets', 'voice', 'animation'].includes(node?.kind ?? '')) return saveProject({ ...value, shots: working.shots });
        throw new Error('此步骤结果用于审阅，无需写入项目。');
      }
      default: throw new Error(`未知操作：${method}`);
    }
  }

  return {
    dispatch,
    subscribe(listener: (event: RuntimeEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async waitForIdle() { await Promise.allSettled([...active.values()].map(value => value.promise)); },
    async close() {
      closing = true;
      for (const value of active.values()) value.controller.abort();
      await Promise.allSettled([...active.values()].map(value => value.promise));
      database.close(); listeners.clear(); transientSecrets.clear();
    },
  };
}

function buildPrompt(project: ProjectDocument, node: WorkflowNode, skills: SkillPackage[]) {
  const selected = skills.filter(skill => skill.enabled && node.skillIds.includes(skill.id));
  const contract = node.kind === 'script' ? '\n只返回 JSON：{"shots":[{"title":"标题","narration":"旁白","visualPrompt":"画面描述","durationUs":8000000}]}。保持已锁定镜头。' : '\n输出可供人工审阅的中文结果。未经查证的来源与主张标为待核验，不编造引用。';
  return [`你正在执行视频制作步骤：${node.label}。`, project.brief, `系列风格：${project.style}`, `现有分镜：${JSON.stringify(project.shots)}`, ...selected.map(skill => `Skill ${skill.name}:\n${skill.instructions}`), node.prompt, contract].filter(Boolean).join('\n\n');
}

function parseShots(text: string, previous: ProjectDocument['shots']) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let payload: unknown;
  try { payload = JSON.parse(cleaned); } catch { throw new Error('分镜结果不是有效 JSON，请调整模型或提示词后重试。'); }
  const parsed = z.object({ shots: z.array(shotSchema.omit({ id: true }).partial().required({ title: true, narration: true, visualPrompt: true })).min(1).max(100) }).parse(payload);
  return parsed.shots.map((shot, index) => previous[index]?.locked ? previous[index] : shotSchema.parse({ ...shot, id: previous[index]?.id ?? `shot-${index + 1}`, durationUs: shot.durationUs ?? 8_000_000 }));
}

function localNodeResult(node: WorkflowNode, project: ProjectDocument, assets: AssetRecord[]): JsonValue {
  switch (node.kind) {
    case 'brief': return { title: project.title, brief: project.brief, source: 'project' };
    case 'research': return { claims: project.claims as unknown as JsonValue, note: '已整理项目中的主张，核验状态需人工确认。' };
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
