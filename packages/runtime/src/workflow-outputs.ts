import { z } from 'zod';
import { assetSchema, creativeContextSchema, creativeEntityKeysSchema, creativeEntitySchema, formatPlanningDocument, MAX_STORYBOARD_SHOTS, planningDocumentSchemas, productionPlanningStep, providerUsageSchema, shotSchema, validateCreativeReferences, type AssetRecord, type JsonValue, type ProjectDocument, type WorkflowNode } from '@video-quickly/contracts';
import { ModelResponseValidationError, parseModelJson, responseIssues } from './model-responses.js';

const documentText = z.string().min(1).max(30_000).regex(/\S/);
const briefOutputSchema = z.strictObject({ text: documentText.describe('完整的中文创意简报正文') });
const styleOutputSchema = z.strictObject({ text: documentText.describe('完整的中文风格与角色正文') });

export const editingOutputSchema = z.strictObject({ text: z.string().regex(/\S/).describe('剪辑 Agent 的操作摘要') });

export type WorkflowOutputVersion = 1 | 2;
export const WORKFLOW_OUTPUT_VERSION = 2;

const documentContracts = {
  brief: { kind: 'brief' as const, label: '创意简报', name: 'video_brief', schema: briefOutputSchema, jsonSchema: z.toJSONSchema(briefOutputSchema), fieldOutput: false },
  style: { kind: 'style' as const, label: '风格与角色', name: 'video_style', schema: styleOutputSchema, jsonSchema: z.toJSONSchema(styleOutputSchema), fieldOutput: false },
};
const planningJsonSchemas = {
  brief: planningJsonSchema(planningDocumentSchemas.brief),
  style: planningJsonSchema(planningDocumentSchemas.style),
};
function planningJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, { io: 'input', override({ jsonSchema }) {
    delete jsonSchema.placeholder;
    delete jsonSchema.rows;
  } });
}

export function productionDocumentContract(node: WorkflowNode, version?: WorkflowOutputVersion) {
  if (!version || node.config.modelBinding !== 'default' || node.id !== node.kind || (node.kind !== 'brief' && node.kind !== 'style')) return undefined;
  const contract = documentContracts[node.kind];
  if (version === 1) return contract;
  return { ...contract, schema: planningDocumentSchemas[node.kind], jsonSchema: planningJsonSchemas[node.kind], fieldOutput: true };
}

export function parseProductionDocument(text: string, contract: NonNullable<ReturnType<typeof productionDocumentContract>>) {
  const result = contract.schema.safeParse(parseModelJson(text, contract.label));
  if (!result.success) throw new ModelResponseValidationError(responseIssues(result.error), contract.label);
  if ('text' in result.data) return result.data;
  return { text: formatPlanningDocument(contract.kind, result.data), fields: result.data };
}

function validateOutput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ModelResponseValidationError(responseIssues(result.error), label);
  return result.data;
}

const generatedShotSchema = shotSchema.pick({ title: true, narration: true, visualPrompt: true, soundPrompt: true, durationUs: true }).partial({ durationUs: true }).extend({
  id: z.string().min(1).optional(),
  characterKeys: z.array(z.string().min(1)).max(8).refine(keys => new Set(keys).size === keys.length, '镜头角色键不能重复。').optional(),
  entityKeys: creativeEntityKeysSchema.optional(),
});
const generatedShots = z.array(generatedShotSchema).min(1).max(MAX_STORYBOARD_SHOTS);
export const legacyStoryboardOutputSchema = z.object({ shots: generatedShots, entities: creativeContextSchema.shape.entities });
const { key, kind, name, description } = creativeEntitySchema.shape;
const generatedEntity = { key, kind, name, description };
export const legacyStoryboardJsonSchema = z.toJSONSchema(legacyStoryboardOutputSchema.extend({ entities: z.array(z.object(generatedEntity)).max(100).default([]) }), { io: 'output', unrepresentable: 'any' });

// Reference IDs and other application-managed fields are not model outputs.
export const storyboardOutputSchema = z.strictObject({
  shots: z.array(z.strictObject(generatedShotSchema.shape)).min(1).max(MAX_STORYBOARD_SHOTS),
  entities: z.array(z.strictObject(generatedEntity)).max(100)
    .refine(entities => new Set(entities.map(entity => entity.key)).size === entities.length, '创作设定编号不能重复。').default([]),
});
export const storyboardJsonSchema = z.toJSONSchema(storyboardOutputSchema, { io: 'input' });

export function manualPlanningOutput(project: ProjectDocument, node: WorkflowNode, version?: WorkflowOutputVersion): JsonValue | undefined {
  const step = productionPlanningStep(project.workflow, node);
  if (!step || !project.workflow.production.manualPlanningSteps?.includes(step)) return undefined;
  if (step === 'script') {
    const shots = project.shots.map(({ id, title, narration, visualPrompt, soundPrompt, durationUs, creativeEntityKeys }) => ({ id, title, narration, visualPrompt, soundPrompt, durationUs, entityKeys: creativeEntityKeys }));
    const entities = project.creativeContext?.entities.map(({ key, kind, name, description }) => ({ key, kind, name, description }));
    validateOutput(storyboardOutputSchema, { shots, entities }, '手动分镜');
    if (new Set(shots.map(shot => shot.id)).size !== shots.length) throw new ModelResponseValidationError([{ path: 'shots', message: '镜头编号须唯一。' }], '手动分镜');
    validateCreativeReferences(project);
    return { shots: project.shots, ...(project.creativeContext ? { creativeContext: project.creativeContext } : {}), source: 'project' } as unknown as JsonValue;
  }
  const contract = documentContracts[step];
  const fields = version === 2 ? project.workflow.production.manualPlanningFields?.[step] : undefined;
  return { ...validateOutput(contract.schema, { text: project[step] }, `手动${contract.label}`), ...(fields && formatPlanningDocument(step, fields) === project[step] ? { fields } : {}), source: 'project' };
}

const boundAsset = assetSchema.extend({ id: z.string().min(1), projectId: z.string().min(1), shotId: z.string().min(1) });
const referenceImageAssetSchema = boundAsset.extend({ kind: z.literal('image') });
const shotVideoAssetSchema = boundAsset.extend({ kind: z.literal('video') });
const modelMediaMetadata = {
  source: z.literal('model').optional(),
  modelId: z.string().min(1).optional(),
  providerUsage: providerUsageSchema.optional(),
};
const referenceImageOutputSchema = z.strictObject({
  assets: z.array(referenceImageAssetSchema),
  ...modelMediaMetadata,
});
const shotVideoOutputSchema = z.strictObject({
  assets: z.array(shotVideoAssetSchema),
  ...modelMediaMetadata,
});

const mediaContracts = {
  image: { label: '参考图', asset: referenceImageAssetSchema, output: referenceImageOutputSchema },
  video: { label: '镜头视频', asset: shotVideoAssetSchema, output: shotVideoOutputSchema },
};
type MediaProject = Pick<ProjectDocument, 'id' | 'shots'>;

export function validateProductionMediaPreview(value: AssetRecord, kind: keyof typeof mediaContracts, project: MediaProject): AssetRecord {
  const { asset, label } = mediaContracts[kind];
  const result = asset.safeParse(value);
  if (!result.success) throw new ModelResponseValidationError(responseIssues(result.error), label);
  if (result.data.projectId !== project.id || !project.shots.some(shot => shot.id === result.data.shotId)) {
    throw new ModelResponseValidationError([{ path: 'shotId', message: '预览素材须属于本次生成的镜头。' }], label);
  }
  return result.data;
}

export function validateProductionMediaOutput(value: JsonValue, kind: keyof typeof mediaContracts, project: MediaProject): JsonValue {
  const { output, label } = mediaContracts[kind];
  const result = output.safeParse(value);
  if (!result.success) throw new ModelResponseValidationError(responseIssues(result.error), label);
  const remaining = new Set(project.shots.map(shot => shot.id));
  const assetIds = new Set<string>();
  for (const [index, asset] of result.data.assets.entries()) {
    if (asset.projectId !== project.id) {
      throw new ModelResponseValidationError([{ path: `assets[${index}].projectId`, message: '素材须属于本次项目。' }], label);
    }
    if (!remaining.delete(asset.shotId)) {
      throw new ModelResponseValidationError([{ path: `assets[${index}].shotId`, message: '素材须对应本次项目中的唯一镜头。' }], label);
    }
    if (assetIds.has(asset.id)) throw new ModelResponseValidationError([{ path: `assets[${index}].id`, message: '素材编号须唯一。' }], label);
    assetIds.add(asset.id);
  }
  if (remaining.size) throw new ModelResponseValidationError([{ path: 'assets', message: '每个生成镜头须有一份素材。' }], label);
  return result.data;
}
