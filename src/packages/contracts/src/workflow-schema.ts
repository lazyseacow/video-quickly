import { z } from 'zod';
import { jsonValueSchema } from './json-content.js';
import { productionSettingsSchema } from './production.js';

export const nodeKindSchema = z.enum(['brief', 'research', 'style', 'script', 'assets', 'animation', 'review', 'export', 'agent', 'condition', 'join', 'subflow']);
export const workflowValueBindingSchema = z.union([
  z.object({ literal: jsonValueSchema }),
  z.object({ nodeId: z.string().min(1), path: z.array(z.string().min(1)).max(20).default([]) }),
]);
export const subflowReferenceSchema = z.object({ id: z.string().min(1), version: z.number().int().positive(), inputs: z.record(z.string(), workflowValueBindingSchema).default({}) });
const promptPathSchema = z.array(z.string().min(1).max(120).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value), '不支持此字段路径。')).max(20);
export const promptBindingsSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), z.union([
  z.object({ literal: jsonValueSchema }).strict(),
  z.object({ projectPath: promptPathSchema.min(1) }).strict(),
  z.object({ shotPath: promptPathSchema.min(1) }).strict(),
  z.object({ nodeId: z.string().min(1), path: promptPathSchema.optional().default([]) }).strict(),
])).refine(value => Object.keys(value).length <= 40, '提示词变量不能超过 40 个。');
export type PromptBindings = z.infer<typeof promptBindingsSchema>;
export const promptTemplateReferenceSchema = z.object({ id: z.string().min(1), version: z.number().int().positive() });
export const workflowNodeSchema = z.object({
  id: z.string().min(1), kind: nodeKindSchema, label: z.string().min(1), description: z.string().default(''),
  prompt: z.string().default(''), modelId: z.string().optional(), skillIds: z.array(z.string()).default([]),
  config: z.record(z.string(), jsonValueSchema).default({}).refine(config => config.operation === undefined || ['prepare-references', 'generate-native-video', 'prepare-edit', 'regenerate', 'research'].includes(String(config.operation)), '不支持的制作任务类型。'),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }), requiresReview: z.boolean().default(false),
  subflow: subflowReferenceSchema.optional(),
  promptBindings: promptBindingsSchema.optional(), promptTemplate: promptTemplateReferenceSchema.optional(),
});
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

const workflowEdgesSchema = z.array(z.object({ id: z.string(), source: z.string(), target: z.string(), condition: z.string().optional() }));
export const subflowInputSchema = z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), type: z.enum(['string', 'number', 'boolean', 'json']), required: z.boolean().default(true), default: jsonValueSchema.optional() }).superRefine((value, context) => { if (value.default !== undefined && value.type !== 'json' && typeof value.default !== value.type) context.addIssue({ code: 'custom', message: '输入默认值与声明类型不一致。', path: ['default'] }); });
export const subflowOutputSchema = z.object({ type: z.enum(['string', 'number', 'boolean', 'json']).default('json'), name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), nodeId: z.string().min(1), path: z.array(z.string().min(1)).max(20).default([]) });
export const subflowDefinitionSchema = z.object({
  id: z.string().min(1), version: z.number().int().positive(), name: z.string().trim().min(1).max(120), description: z.string().max(10000).default(''),
  inputs: z.array(subflowInputSchema).max(40).default([]), outputs: z.array(subflowOutputSchema).max(40).default([]),
  nodes: z.array(workflowNodeSchema).min(1).max(100), edges: workflowEdgesSchema,
});
export const workflowStageSchema = z.object({
  id: z.string().min(1), label: z.string().min(1).max(120), description: z.string().max(10000).default(''),
  nodeIds: z.array(z.string().min(1)).min(1).max(100).refine(ids => new Set(ids).size === ids.length, '阶段中的任务不能重复'),
});
export type WorkflowStage = z.infer<typeof workflowStageSchema>;
export const workflowSchema = z.object({
  id: z.string(), version: z.number().int().positive(), name: z.string(),
  nodes: z.array(workflowNodeSchema).min(1).max(100),
  edges: workflowEdgesSchema,
  subflows: z.array(subflowDefinitionSchema).max(100).optional(),
  production: productionSettingsSchema,
  stages: z.array(workflowStageSchema).max(100).refine(stages => new Set(stages.map(stage => stage.id)).size === stages.length, '阶段编号不能重复').optional(),
});
export const promptLibraryItemSchema = z.object({
  id: z.string().min(1), revision: z.number().int().positive(), version: z.number().int().positive(),
  kind: z.enum(['template', 'snippet']), name: z.string().trim().min(1).max(120), prompt: z.string().min(1).max(100000),
  nodeKinds: z.array(nodeKindSchema).min(1).max(13), bindings: promptBindingsSchema.optional(),
  favorite: z.boolean().default(false), archived: z.boolean().default(false), createdAt: z.string(), updatedAt: z.string(),
});
export type PromptLibraryItem = z.infer<typeof promptLibraryItemSchema>;
export type WorkflowDefinition = z.infer<typeof workflowSchema>;
export type SubflowDefinition = z.infer<typeof subflowDefinitionSchema>;
export type SubflowReference = z.infer<typeof subflowReferenceSchema>;
export const workflowTemplateSchema = z.object({
  id: z.string().min(1), revision: z.number().int().positive(), definition: subflowDefinitionSchema, dependencies: z.array(subflowDefinitionSchema).max(100),
  archived: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
});
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;
