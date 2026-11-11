import { extname } from 'node:path';
import { z } from 'zod';
import { assetSchema, createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, isCreativeReferenceAsset, MediaRequestRejectedError, projectSchema, providerUsageSchema, workflowNodeSchema, type AssetRecord, type ModelProfile } from '@video-quickly/contracts';
import { fingerprint, SimulatedProcessExit, type ActivityJournal } from './activities.js';
import { requestCostMetrics, type createCostLedger } from './costs.js';
import type { DocumentStore } from './database.js';
import { validateExecutionModel } from './execution-model.js';
import { readAssetImageDimensions } from './image-tools.js';
import type { RuntimeOptions } from './index.js';
import { validateProductionMediaOutput } from './workflow-outputs.js';

const generationInput = z.object({
  requestId: z.string().uuid(), modelId: z.string().min(1), name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().max(10000), referenceAssetId: z.string().min(1).optional(),
}).strict().refine(input => input.prompt || input.referenceAssetId, '请填写生成提示词或选择一张参考图。');
const resultSchema = z.object({ assets: assetSchema.array().length(1), providerUsage: providerUsageSchema.optional() });

export function characterImageModel(model: ModelProfile): ModelProfile {
  // Seedream relays use the same endpoint for text and reference images.
  const provider = model.provider === 'openai-compatible' && /^(?:doubao[-_.])?seedream(?:[-_.]|$)/i.test(model.model) ? 'seedream' : model.provider;
  if (provider !== 'seedream' && provider !== 'openai-compatible') return model;
  const { stream: _stream, sequential_image_generation: _grouping, sequential_image_generation_options: _options, ...parameters } = model.parameters;
  return { ...model, provider, parameters };
}

export function createCharacterImageGenerator({ directory, store, journal, costs, execute, preflight, secret }: {
  directory: string; store: DocumentStore; journal: ActivityJournal; costs: ReturnType<typeof createCostLedger>;
  execute: RuntimeOptions['executeActivity']; preflight: RuntimeOptions['preflightActivity'];
  secret(model: ModelProfile): Promise<string | undefined>;
}) {
  const controller = new AbortController();
  const pending = new Map<string, { hash: string; promise: Promise<AssetRecord> }>();

  async function generate(raw: unknown): Promise<AssetRecord> {
    const input = generationInput.parse(raw);
    const hash = fingerprint(input);
    const existing = pending.get(input.requestId);
    if (existing) {
      if (existing.hash !== hash) throw new Error('此生成请求已用于其他输入。');
      return existing.promise;
    }

    const promise = generateImage(input);
    pending.set(input.requestId, { hash, promise });
    try { return await promise; } finally { pending.delete(input.requestId); }
  }

  async function generateImage(input: z.infer<typeof generationInput>) {
    if (!execute) throw new Error('当前运行环境无法生成参考图。');
    const model = store.get<ModelProfile>('model', input.modelId);
    if (!model?.enabled || !model.capabilities.includes('image')) throw new Error('请选择已启用的图片模型。');
    const reference = input.referenceAssetId ? store.get<AssetRecord>('asset', input.referenceAssetId) : undefined;
    if (input.referenceAssetId && !isCreativeReferenceAsset({}, reference)) throw new Error('请选择公共素材库中有效的角色参考图。');

    const requestModel = characterImageModel(model);
    const side = requestModel.provider === 'seedream' ? 2048 : requestModel.provider === 'openai-compatible' ? 1024 : 1536;
    const prompt = input.prompt || `根据参考图生成「${input.name}」的角色参考图。`;
    const node = workflowNodeSchema.parse({ id: 'character-image', kind: 'assets', label: '生成角色参考图', modelId: model.id,
      config: { operation: 'prepare-references', referenceMode: 'generate' } });
    validateExecutionModel(node, requestModel);
    const project = projectSchema.parse({ id: 'library', title: '角色参考库', revision: 1, createdAt: model.createdAt, updatedAt: model.updatedAt,
      brief: '', style: '', profile: { ...DEFAULT_VIDEO_PROFILE, width: side, height: side }, workflow: createNativeVideoWorkflow(),
      ...(reference ? { creativeContext: { entities: [{ key: 'subject', kind: 'character', name: input.name,
        description: '', referenceAssetIds: [reference.id] }] } } : {}),
      shots: [{
        id: 'reference', title: input.name, durationUs: 1_000_000, narration: '', visualPrompt: prompt,
        ...(reference ? { creativeEntityKeys: ['subject'] } : {}),
      }],
    });
    const runId = `character-image-${input.requestId}`;
    const operationId = `${runId}:${node.id}`;
    const signal = controller.signal;
    const context = { project, node, model: requestModel, promptOverride: prompt, assets: reference ? [reference] : [], dataDirectory: directory, signal };
    signal.throwIfAborted();
    let apiKey: string | undefined;
    if (journal.get(runId, node.id)?.status !== 'completed') {
      await preflight?.({ ...context, operationId });
      apiKey = await secret(model);
      if (model.hasSecret && !apiKey) throw new Error('图片模型凭据不可用，请重新保存模型连接。');
      signal.throwIfAborted();
    }

    return journal.execute(runId, node.id, { input, model, reference }, 'external', async activity => {
      costs.begin({ operationId, runId, nodeId: node.id, projectId: project.id, model: requestModel, capability: 'image', requestMetrics: requestCostMetrics(project, node, requestModel) });
      try {
        const output = await execute({ ...context, runId, operationId, apiKey, remoteTaskId: activity.remoteId, persistRemoteTask: activity.recordRemoteId });
        const { assets: [{ projectId: _project, shotId: _shot, ...image }], providerUsage } = resultSchema.parse(validateProductionMediaOutput(output, 'image', project));
        costs.status(operationId, 'completed', providerUsage);
        const { width, height } = await readAssetImageDimensions(image);
        return { ...image, width, height, name: `${input.name} · 参考图${extname(image.path)}` };
      } catch (error) {
        if (!(error instanceof SimulatedProcessExit)) costs.status(operationId, signal.aborted ? 'canceled' : error instanceof MediaRequestRejectedError ? 'failed' : 'unknown');
        throw error;
      }
    }, image => store.put('asset', image.id, image));
  }

  return { generate, close: () => controller.abort() };
}
