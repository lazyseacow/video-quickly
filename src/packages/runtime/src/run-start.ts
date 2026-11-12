import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { imageEditInputSchema, runSelectionSchema, shotCandidateKindSchema, subflowThreadId, validateWorkflowComposition, videoProfileSchema, workflowEdgesWithSubflows, workflowNodesWithSubflows,
  type AssetRecord, type ModelProfile, type ProjectDocument, type RunPlan, type RunRecord, type RunSelection, type WorkflowNode,
} from '@video-quickly/contracts';
import { resolveImageEdit } from '@video-quickly/integrations/image-edit';
import { selectResearchPassages } from '@video-quickly/integrations/research';
import { fingerprint } from './activities.js';
import type { createCharacterLibrary } from './characters.js';
import type { DocumentStore } from './database.js';
import { validateExecutionModel } from './execution-model.js';
import type { McpServer } from './mcp.js';
import { resolveProductionNodes } from './production-nodes.js';
import { validateResearchProject } from './research.js';
import type { RunSnapshot } from './run-snapshot.js';
import type { createSkillLibrary } from './skill-library.js';
import { STORYBOARD_BATCH_SIZE } from './storyboard-generation.js';
import { manualPlanningOutput, WORKFLOW_OUTPUT_VERSION } from './workflow-outputs.js';

const projectIdInput = z.object({ projectId: z.string().min(1) });
const videoExportInput = projectIdInput.extend({ profile: videoProfileSchema.optional(), destination: z.string().optional(), revision: z.number().int().optional() });
export const regenerationInput = z.object({ shotId: z.string().min(1), kind: shotCandidateKindSchema, modelId: z.string().min(1).optional(), instruction: z.string().max(10_000).optional(), imageEdit: imageEditInputSchema.optional() });
export const researchInput = z.object({ modelId: z.string().min(1), sourceIds: z.array(z.string().min(1)).min(1).max(20).optional(), instruction: z.string().max(10_000).optional() });
export const shotRegenerationInput = projectIdInput.merge(regenerationInput).extend({ revision: z.number().int().positive(),
  source: z.object({ runId: z.string().min(1), nodeId: z.string().min(1), requestId: z.string().uuid() }).optional() });
const runStartInput = videoExportInput.extend({
  nodeId: z.string().optional(),
  parentRunId: z.string().optional(),
  regeneration: regenerationInput.optional(),
  research: researchInput.optional(),
  selection: runSelectionSchema.extend({ previewDigest: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
}).strict();

type RunStartInput = z.infer<typeof runStartInput>;
type ParentRunScope = Pick<RunSnapshot, 'exportBatch' | 'regeneration' | 'research' | 'nodes' | 'selection'> & {
  profile: ProjectDocument['profile'];
  workflowNodeCount: number | null;
  autonomousVideo: number | null;
};
type InheritedScope =
  | { kind: 'run'; useCurrentRevision?: true; requiredStep?: WorkflowNode; exportStep?: WorkflowNode }
  | { kind: 'source-regeneration'; request: z.input<typeof shotRegenerationInput> }
  | { kind: 'export-batch'; batchId: string; parentRunId: string };

interface RunStarterOptions {
  database: Database.Database;
  store: DocumentStore;
  project(projectId: string): ProjectDocument;
  run(runId: string): RunRecord;
  requireRevision(project: ProjectDocument, revision?: number): void;
  projectOccupied(projectId: string): boolean;
  availableModels(): ModelProfile[];
  prepareRunSelection(project: ProjectDocument, selection: RunSelection): Promise<{ plan: RunPlan; saved: RunSnapshot }>;
  videoEditingAgent(project: ProjectDocument, models: ModelProfile[], mcpServers: McpServer[]): WorkflowNode | undefined;
  regenerationNode(project: ProjectDocument, input: z.infer<typeof regenerationInput>): WorkflowNode;
  canExecuteActivities(): boolean;
  profilesFor: ReturnType<typeof createCharacterLibrary>['profilesFor'];
  prepareSkills: ReturnType<typeof createSkillLibrary>['prepareForNodes'];
  regenerateShot(input: z.input<typeof shotRegenerationInput>): Promise<RunRecord>;
  resumeExportBatch(batchId: string): Promise<unknown>;
  onRunCreated(runId: string): void;
  hydrateRun(run: RunRecord): RunRecord;
}

function hasExplicitTask(input: RunStartInput) {
  return [input.nodeId, input.profile, input.destination, input.regeneration, input.research, input.selection].some(value => value !== undefined);
}

export function createRunStarter({
  database, store, project, run, requireRevision, projectOccupied, availableModels, prepareRunSelection,
  videoEditingAgent, regenerationNode, canExecuteActivities,
  profilesFor, prepareSkills, regenerateShot, resumeExportBatch, onRunCreated, hydrateRun,
}: RunStarterOptions) {
  function inheritRunScope(input: RunStartInput, parentRunId: string): InheritedScope {
    const parent = run(parentRunId);
    if (parent.purpose && parent.purpose !== 'production') throw new Error('请在提示词实验中创建新试运行，实验不能接续正式制作。');
    if (parent.projectId !== input.projectId) throw new Error('父运行不属于当前项目。');

    // Read only the scope, without decoding the parent's full project or asset snapshot.
    const row = database.prepare("SELECT json_object('exportBatch', json_extract(body, '$.exportBatch'), 'regeneration', json_extract(body, '$.regeneration'), 'research', json_extract(body, '$.research'), 'nodes', json_extract(body, '$.nodes'), 'selection', json_extract(body, '$.selection'), 'profile', json_extract(body, '$.project.profile'), 'workflowNodeCount', json_array_length(body, '$.project.workflow.nodes'), 'autonomousVideo', json_extract(body, '$.autonomousVideo')) AS body FROM documents WHERE kind = 'run-snapshot' AND id = ?").get(parent.id) as { body: string } | undefined;
    if (!row) throw new Error('父运行快照不存在，无法确认重新制作范围。');
    const saved = JSON.parse(row.body) as ParentRunScope;
    if (parent.regenerationSource && saved.regeneration) {
      if (parent.status !== 'canceled') throw new Error('请先停止原镜头候选，再重新生成。');
      if (hasExplicitTask(input)) throw new Error('重新生成必须保留原镜头与制作来源。');
      return { kind: 'source-regeneration', request: {
        projectId: parent.projectId,
        revision: input.revision ?? project(parent.projectId).revision,
        shotId: parent.regenerationSource.shotId,
        kind: saved.regeneration.kind,
        instruction: saved.regeneration.instruction,
        source: { runId: parent.regenerationSource.runId, nodeId: parent.regenerationSource.nodeId, requestId: randomUUID() },
      } };
    }

    const originalNodeCount = saved.workflowNodeCount ?? 0;
    if (saved.selection && (!input.selection || saved.selection.nodeId !== input.selection.nodeId || saved.selection.mode !== input.selection.mode)) throw new Error('请先预览原任务的执行范围，再重新制作。');
    const singleStep = !saved.selection && !saved.exportBatch && !saved.regeneration && !saved.research && saved.nodes.length === 1
      && !(saved.autonomousVideo ?? saved.nodes[0].config.videoAgent) ? saved.nodes[0] : undefined;
    if (singleStep && originalNodeCount < 1) throw new Error('原任务的流程范围不完整，请在项目中确认后重新执行。');
    if ((saved.exportBatch || saved.regeneration || saved.research) && hasExplicitTask(input)) throw new Error('特殊任务重新制作必须保留原任务范围，请从对应编辑器创建其他任务。');
    if (saved.exportBatch) return { kind: 'export-batch', batchId: saved.exportBatch.batchId, parentRunId: parent.id };
    if (saved.regeneration) {
      const modelId = saved.nodes.find(node => node.id === 'regenerate')?.modelId;
      if (!modelId) throw new Error('原镜头生成模型缺失，请从镜头编辑器选择模型后重新生成。');
      input.regeneration = { shotId: saved.regeneration.shotId, kind: saved.regeneration.kind, instruction: saved.regeneration.instruction, imageEdit: saved.regeneration.imageEdit, modelId };
      return { kind: 'run', useCurrentRevision: true };
    }
    if (saved.research) {
      const modelId = saved.nodes.find(node => node.kind === 'research')?.modelId;
      if (!modelId) throw new Error('原资料整理模型缺失，请在资料审阅中重新选择模型。');
      input.research = { ...saved.research, modelId };
      return { kind: 'run', useCurrentRevision: true };
    }
    if (singleStep?.kind === 'export') {
      if (hasExplicitTask(input)) throw new Error('导出任务重新制作必须保留原规格和路径，请从导出面板创建其他任务。');
      input.profile = videoProfileSchema.parse(saved.profile);
      return { kind: 'run', useCurrentRevision: true, exportStep: singleStep };
    }
    if (singleStep && originalNodeCount > 1) {
      if (input.selection) {
        if (input.selection.nodeId !== singleStep.id || input.selection.mode !== 'node') throw new Error('请保留原单步骤范围，或在项目中创建新的执行任务。');
      } else {
        if (hasExplicitTask(input)) throw new Error('请保留原单步骤范围，或在项目中创建新的执行任务。');
        input.nodeId = singleStep.id;
        return { kind: 'run', useCurrentRevision: true, requiredStep: singleStep };
      }
    }
    return { kind: 'run' };
  }

  function researchStep(project: ProjectDocument, request: NonNullable<RunStartInput['research']>): WorkflowNode {
    const model = store.get<ModelProfile>('model', request.modelId);
    if (!model?.enabled || !model.capabilities.includes('text') || !['openai-compatible', 'ollama', 'custom-http'].includes(model.provider)) throw new Error('请选择可用的文本模型整理实际资料。');
    const template = project.workflow.nodes.find(node => node.kind === 'research');
    const node: WorkflowNode = {
      id: 'research', kind: 'research', label: '资料证据候选', description: template?.description ?? '',
      prompt: [template?.prompt, request.instruction].filter(Boolean).join('\n\n'), skillIds: template?.skillIds ?? [],
      modelId: model.id,
      config: { ...template?.config, operation: 'research', ...(request.sourceIds ? { sourceIds: request.sourceIds } : {}) },
      position: { x: 0, y: 0 }, requiresReview: false,
    };
    selectResearchPassages(project, request.sourceIds, request.instruction);
    return node;
  }

  async function launchRun<Result>(
    input: RunStartInput,
    { requiredStep, exportStep, useCurrentRevision }: Extract<InheritedScope, { kind: 'run' }>,
    isStandaloneExport: boolean,
    toResult: (record: RunRecord) => Result,
  ): Promise<Result> {
    const original = project(input.projectId);
    if (requiredStep && !original.workflow.nodes.some(node => node.id === requiredStep.id && node.kind === requiredStep.kind)) throw new Error('原单步骤已删除或变更类型，请在项目中确认后重新执行。');
    validateResearchProject(original, original);
    const requestedRevision = input.revision ?? (useCurrentRevision ? original.revision : undefined);
    if (input.regeneration && requestedRevision === undefined) throw new Error('镜头重新生成需要当前修订，且不能同时识别字幕。');
    if (input.research && (input.regeneration || requestedRevision === undefined)) throw new Error('资料整理需要当前修订，且不能同时启动其他特殊任务。');
    requireRevision(original, requestedRevision);
    const runProject = input.profile ? { ...original, profile: input.profile } : original;
    if (runProject.archived) throw new Error('请先恢复项目。');
    if (isStandaloneExport && !runProject.shots.length) throw new Error('请先添加镜头后再导出视频。');
    if (projectOccupied(runProject.id)) throw new Error('该项目已有未完成的运行或批量导出，请先处理现有任务。');

    const selection = input.selection;
    const prepared = selection ? await prepareRunSelection(runProject, { nodeId: selection.nodeId, mode: selection.mode }) : undefined;
    if (prepared && selection) {
      if (prepared.plan.digest !== selection.previewDigest) throw new Error('项目或执行配置已变化，请重新预览执行范围后确认。');
      if (prepared.plan.blockedReason) throw new Error(prepared.plan.blockedReason);
    }

    const models = prepared?.saved.models ?? availableModels();
    const mcpServers = prepared?.saved.mcpServers ?? store.list<McpServer>('mcp-server');
    const isFullProduction = !input.nodeId && !prepared && !input.regeneration && !input.research && !exportStep;
    const localExport: WorkflowNode | undefined = isStandaloneExport
      ? { id: 'export', kind: 'export', label: '导出成片', description: '', prompt: '', config: input.destination ? { destination: input.destination } : {}, skillIds: [], position: { x: 0, y: 0 }, requiresReview: false }
      : undefined;
    const exportNode = exportStep ?? localExport;
    const frozenNodes = exportNode ? [exportNode] : prepared?.saved.nodes;
    const resolved = frozenNodes ? { nodes: frozenNodes, agent: undefined } : resolveProductionNodes(runProject, {
      nodeId: input.nodeId,
      exportDestination: input.destination,
      editingAgent: isFullProduction ? () => videoEditingAgent(runProject, models, mcpServers) : undefined,
      automaticCasting: isFullProduction && canExecuteActivities(),
    });
    const { agent } = resolved;
    let { nodes } = resolved;
    if (input.regeneration) nodes = [regenerationNode(runProject, input.regeneration)];
    if (input.research) nodes = [researchStep(runProject, input.research)];
    if (!nodes.length) throw new Error('未找到所选步骤。');
    if (nodes.some(node => node.kind === 'subflow' && Object.values(node.subflow?.inputs ?? {}).some(binding => 'nodeId' in binding && !nodes.some(source => source.id === binding.nodeId)))) throw new Error('子流程输入引用了范围外的上游产物，请包含上游步骤或改用明确输入值。');

    const runId = randomUUID();
    const baselineShot = input.regeneration ? runProject.shots.find(shot => shot.id === input.regeneration?.shotId) : undefined;
    const shotsInScope = input.research ? [] : baselineShot ? [baselineShot] : runProject.shots;
    const bundle = prepared ? { characters: prepared.saved.characters, assets: prepared.saved.characterAssets } : profilesFor({
      id: runProject.id,
      shots: shotsInScope,
      ...(input.regeneration ? { creativeContext: runProject.creativeContext ? { ...runProject.creativeContext, characterIds: [] } : undefined } : !input.research ? { creativeContext: runProject.creativeContext } : {}),
    });
    const nodeSelection: RunSelection | undefined = input.nodeId && !input.profile && !input.destination && !input.regeneration && !input.research && nodes[0].kind !== 'export'
      ? { nodeId: input.nodeId, mode: 'node' } : undefined;
    const imageEdit = input.regeneration?.imageEdit;
    const snapshot: RunSnapshot = prepared?.saved ?? {
      project: structuredClone(runProject),
      unifiedShotProfile: true,
      ...(runProject.workflow.production.referenceAudioAssetIds?.length || imageEdit ? {
        assets: store.list<AssetRecord>('asset').filter(asset => imageEdit
          ? [imageEdit.sourceAssetId, imageEdit.maskAssetId].includes(asset.id)
          : !asset.projectId || asset.projectId === runProject.id),
      } : {}),
      models,
      ...await prepareSkills(workflowNodesWithSubflows({ ...runProject.workflow, nodes })),
      mcpServers,
      nodes,
      autonomousVideo: false,
      ...(agent ? { videoEditingAgentId: agent.id } : {}),
      handlerVersion: 1,
      characters: bundle.characters,
      characterAssets: bundle.assets,
      selection: nodeSelection,
      ...(input.research ? { research: { sourceIds: input.research.sourceIds, instruction: input.research.instruction } } : {}),
      ...(input.regeneration && baselineShot ? { regeneration: {
        shotId: baselineShot.id, baseline: structuredClone(baselineShot), kind: input.regeneration.kind,
        instruction: input.regeneration.instruction?.trim(), ...(imageEdit ? { imageEdit } : {}),
      } } : {}),
    };
    if (runProject.workflow.id === 'native-video') snapshot.outputContractVersion = WORKFLOW_OUTPUT_VERSION;
    snapshot.useOriginalVideoReferences = true;
    if (!snapshot.regeneration) snapshot.includeProjectOriginalText = true;
    if (runProject.workflow.id === 'native-video' && !snapshot.regeneration && snapshot.nodes.some(node => node.kind === 'script' && node.modelId)) snapshot.storyboardBatchSize = STORYBOARD_BATCH_SIZE;
    if (imageEdit) {
      await resolveImageEdit({ project: snapshot.project, node: snapshot.nodes[0], assets: snapshot.assets ?? [], model: snapshot.models.find(model => model.id === snapshot.nodes[0].modelId) });
      requireRevision(project(runProject.id), runProject.revision);
      if (projectOccupied(runProject.id)) throw new Error('该项目已有未完成的运行，请先处理现有任务。');
    }
    // Snapshot preparation can await Skills or assets. Recheck before the synchronous write.
    requireRevision(project(runProject.id), runProject.revision);
    if (projectOccupied(runProject.id)) throw new Error('该项目已有未完成的运行，请先处理现有任务。');
    if (snapshot.nodes.some(node => node.kind === 'subflow')) {
      validateWorkflowComposition(snapshot.project.workflow);
      snapshot.handlerVersion = 3;
      snapshot.inspectionNodes = workflowNodesWithSubflows({ ...snapshot.project.workflow, nodes: snapshot.nodes });
      const selectedIds = new Set(snapshot.nodes.map(node => node.id));
      snapshot.inspectionEdges = workflowEdgesWithSubflows({ ...snapshot.project.workflow, nodes: snapshot.nodes, edges: snapshot.project.workflow.edges.filter(edge => selectedIds.has(edge.source) && selectedIds.has(edge.target)) });
      snapshot.inspectionThreads = Object.fromEntries(snapshot.inspectionNodes.map(node => {
        const parentPath = node.id.slice(0, node.id.lastIndexOf('/subflow/'));
        return [node.id, selectedIds.has(node.id) ? runId : subflowThreadId(runId, parentPath)];
      }));
    }
    for (const node of snapshot.inspectionNodes ?? snapshot.nodes) {
      manualPlanningOutput(snapshot.project, node);
      validateExecutionModel(node, snapshot.models.find(model => model.id === node.modelId));
    }
    const timestamp = new Date().toISOString();
    const record: RunRecord = {
      id: runId, projectId: runProject.id, projectRevision: runProject.revision, status: 'queued',
      workflowVersion: runProject.workflow.version, snapshotDigest: fingerprint(snapshot), parentRunId: input.parentRunId,
      selection: snapshot.selection, stepCount: snapshot.inspectionNodes?.length ?? nodes.length,
      createdAt: timestamp, updatedAt: timestamp, events: [], activities: [],
    };
    database.transaction(() => {
      store.put('run-snapshot', runId, snapshot);
      store.put('run', runId, record);
    })();
    onRunCreated(runId);
    return toResult(record);
  }

  async function start(rawParams: unknown): Promise<RunRecord> {
    const input = runStartInput.parse(rawParams);
    if (input.selection && [input.nodeId, input.profile, input.destination, input.regeneration, input.research].some(value => value !== undefined)) throw new Error('执行范围不能同时指定其他制作任务。');
    const scope: InheritedScope = input.parentRunId ? inheritRunScope(input, input.parentRunId) : { kind: 'run' };
    if (scope.kind === 'source-regeneration') return regenerateShot(scope.request);
    if (scope.kind === 'export-batch') {
      await resumeExportBatch(scope.batchId);
      return hydrateRun(run(scope.parentRunId));
    }
    return launchRun(input, scope, false, hydrateRun);
  }

  function exportVideo(rawParams: unknown): Promise<{ runId: string }> {
    const input = runStartInput.parse({ ...videoExportInput.parse(rawParams), nodeId: 'export' });
    return launchRun(input, { kind: 'run' }, true, record => ({ runId: record.id }));
  }

  return { start, exportVideo };
}
