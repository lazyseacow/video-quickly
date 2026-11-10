import { z } from 'zod';
import { assetSchema, CHARACTER_REFERENCE_VIEW_LABELS, createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, isCreativeReferenceAsset, MediaRequestRejectedError, projectSchema, providerUsageSchema, workflowNodeSchema, type AssetRecord, type ModelProfile } from '@video-quickly/contracts';
import { fingerprint, SimulatedProcessExit, type ActivityJournal } from './activities.js';
import { requestCostMetrics, type createCostLedger } from './costs.js';
import type { DocumentStore } from './database.js';
import { validateExecutionModel } from './execution-model.js';
import type { createImageTools } from './image-tools.js';
import type { RuntimeOptions } from './index.js';
import { validateProductionMediaOutput } from './workflow-outputs.js';

const generationInput = z.object({
  requestId: z.string().uuid(), modelId: z.string().min(1), name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(10000), referenceAssetId: z.string().min(1).optional(),
}).strict().refine(input => input.description || input.referenceAssetId, '请填写角色设定或选择一张定妆参考图。');
const resultSchema = z.object({ assets: assetSchema.array().length(1), providerUsage: providerUsageSchema.optional() });

export function createCharacterViews({ directory, store, journal, costs, imageTools, execute, preflight, secret }: {
  directory: string; store: DocumentStore; journal: ActivityJournal; costs: ReturnType<typeof createCostLedger>;
  imageTools: ReturnType<typeof createImageTools>; execute: RuntimeOptions['executeActivity']; preflight: RuntimeOptions['preflightActivity'];
  secret(model: ModelProfile): Promise<string | undefined>;
}) {
  const controller = new AbortController();
  const pending = new Map<string, { hash: string; promise: Promise<AssetRecord[]> }>();

  async function generate(raw: unknown): Promise<AssetRecord[]> {
    const input = generationInput.parse(raw);
    const hash = fingerprint(input);
    const existing = pending.get(input.requestId);
    if (existing) {
      if (existing.hash !== hash) throw new Error('此生成请求已用于另一份角色设定。');
      return existing.promise;
    }

    const promise = generateViews(input);
    pending.set(input.requestId, { hash, promise });
    try { return await promise; } finally { pending.delete(input.requestId); }
  }

  async function generateViews(input: z.infer<typeof generationInput>) {
    if (!execute) throw new Error('当前运行环境无法生成参考图。');
    const model = store.get<ModelProfile>('model', input.modelId);
    if (!model?.enabled || !model.capabilities.includes('image')) throw new Error('请选择已启用的图片模型。');
    const reference = input.referenceAssetId ? store.get<AssetRecord>('asset', input.referenceAssetId) : undefined;
    if (input.referenceAssetId && !isCreativeReferenceAsset({}, reference)) throw new Error('请选择公共素材库中有效的角色参考图。');

    // Seedream relays use the same generation route for text and reference images.
    const seedream = model.provider === 'seedream' || model.provider === 'openai-compatible' && /^(?:doubao[-_.])?seedream(?:[-_.]|$)/i.test(model.model);
    const side = seedream ? 2048 : model.provider === 'openai-compatible' ? 1024 : 1536;
    const requestModel: ModelProfile = { ...model, provider: seedream ? 'seedream' : model.provider, parameters: { ...model.parameters } };
    if (seedream || model.provider === 'openai-compatible') {
      requestModel.parameters.size = `${side}x${side}`;
      delete requestModel.parameters.stream;
    }
    if (seedream) {
      delete requestModel.parameters.sequential_image_generation;
      delete requestModel.parameters.sequential_image_generation_options;
    }
    const node = workflowNodeSchema.parse({ id: 'character-views', kind: 'assets', label: 'AI 多视角定妆', modelId: model.id,
      config: { operation: 'prepare-references', referenceMode: 'generate' } });
    validateExecutionModel(node, requestModel);
    const project = projectSchema.parse({ id: 'library', title: '角色参考库', revision: 1, createdAt: model.createdAt, updatedAt: model.updatedAt,
      brief: '', style: '', profile: { ...DEFAULT_VIDEO_PROFILE, width: side, height: side }, workflow: createNativeVideoWorkflow(),
      ...(reference ? { creativeContext: { entities: [{ key: 'subject', kind: 'character', name: input.name,
        description: '同一个角色的外观与服装', referenceAssetIds: [reference.id] }] } } : {}),
      shots: [{
        id: 'views', title: input.name, durationUs: 1_000_000, narration: '', ...(reference ? { creativeEntityKeys: ['subject'] } : {}),
        visualPrompt: [
          `生成「${input.name}」的全彩四视角角色设定图。`,
          ...(input.description ? [`角色设定\n${input.description}`] : []),
          `以角色设定中指定的配色和背景为准。未指定的颜色根据角色设定${reference ? '和参考图' : ''}补齐，完整上色并表现清晰的明暗层次。`,
          '背景未指定时，选择与人物有明暗或色相对比的素色底，衬出人物轮廓。四个视角保持配色、背景和光照一致。',
          '在一张 1:1 正方形画布中绘制等宽等高的 2×2 四宫格。左上正面，右上四分之三侧面，左下完整侧面，右下背面。',
          '每格只画同一个角色的一张全身站姿，脸、发型、服装、配饰和比例统一。每个角色在自己的格内完整居中，头脚留白，不跨越画面中线。画面不加文字、标号、边框或分隔线。',
        ].join('\n'),
      }],
    });
    const runId = `character-views-${input.requestId}`;
    const operationId = `${runId}:${node.id}`;
    const signal = controller.signal;
    const context = { project, node, model: requestModel, assets: reference ? [reference] : [], dataDirectory: directory, signal };
    signal.throwIfAborted();
    let apiKey: string | undefined;
    if (journal.get(runId, node.id)?.status !== 'completed') {
      await preflight?.({ ...context, operationId });
      apiKey = await secret(model);
      if (model.hasSecret && !apiKey) throw new Error('图片模型凭据不可用，请重新保存模型连接。');
      signal.throwIfAborted();
    }

    const board = await journal.execute(runId, node.id, { input, model, reference }, 'external', async activity => {
      costs.begin({ operationId, runId, nodeId: node.id, projectId: project.id, model, capability: 'image', requestMetrics: requestCostMetrics(project, node, model) });
      try {
        const output = await execute({ ...context, runId, operationId, apiKey, remoteTaskId: activity.remoteId, persistRemoteTask: activity.recordRemoteId });
        const { assets: [{ projectId: _project, shotId: _shot, ...image }], providerUsage } = resultSchema.parse(validateProductionMediaOutput(output, 'image', project));
        costs.status(operationId, 'completed', providerUsage);
        return { ...image, name: `${input.name} · 四视角定妆原图.png` };
      } catch (error) {
        if (!(error instanceof SimulatedProcessExit)) costs.status(operationId, signal.aborted ? 'canceled' : error instanceof MediaRequestRejectedError ? 'failed' : 'unknown');
        throw error;
      }
    }, image => store.put('asset', image.id, image));
    return imageTools.cutGrid({ assetId: board.id, rows: 2, columns: 2 }, CHARACTER_REFERENCE_VIEW_LABELS.map(label => `${input.name} · ${label}.png`));
  }

  return { generate, close: () => controller.abort() };
}
