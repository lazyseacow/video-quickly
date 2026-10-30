import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { pageInputSchema, subflowDefinitionSchema, subflowInputSchema, subflowOutputSchema, validateWorkflowComposition, workflowSchema, workflowTemplateSchema, type RecordPage, type WorkflowTemplate } from '@video-quickly/contracts';
import { DocumentStore } from './database.js';

export function createWorkflowTemplateLibrary({ database, store, onChanged }: { database: Database.Database; store: DocumentStore; onChanged(): void }) {
  const identity = z.object({ templateId: z.string().min(1) });
  function get(id: string, version?: number): WorkflowTemplate {
    const saved = store.get(version === undefined ? 'workflow-template' : 'workflow-template-version', version === undefined ? id : `${id}@${version}`);
    if (!saved) throw new Error('子流程模板或固定版本不存在。');
    return workflowTemplateSchema.parse(saved);
  }
  return {
    dispatch(method: string, params: unknown = {}): WorkflowTemplate | RecordPage<WorkflowTemplate> {
      switch (method) {
        case 'workflowTemplate.get': { const input = identity.extend({ version: z.number().int().positive().optional() }).parse(params); return get(input.templateId, input.version); }
        case 'workflowTemplate.list': {
          const input = pageInputSchema.extend({ archived: z.boolean().default(false) }).parse(params);
          const rows = database.prepare("SELECT rowid AS cursor, body FROM documents WHERE kind = 'workflow-template' AND json_extract(body, '$.archived') = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?").all(Number(input.archived), input.before ?? null, input.before ?? null, input.limit + 1) as { cursor: number; body: string }[];
          return { items: rows.slice(0, input.limit).map(row => workflowTemplateSchema.parse(JSON.parse(row.body))), nextCursor: rows.length > input.limit ? rows[input.limit - 1].cursor : null };
        }
        case 'workflowTemplate.save': {
          const input = z.object({ templateId: z.string().min(1).optional(), revision: z.number().int().positive().optional(), name: z.string().trim().min(1).max(120), description: z.string().max(10000).default(''), workflow: workflowSchema, inputs: z.array(subflowInputSchema).max(40).default([]), outputs: z.array(subflowOutputSchema).max(40).default([]) }).parse(params);
          const next = database.transaction(() => {
            const previous = input.templateId ? get(input.templateId) : undefined;
            if (previous && previous.revision !== input.revision) throw new Error('子流程模板已修改，请刷新后再保存新版本。');
            const id = previous?.id ?? randomUUID(), version = previous ? previous.definition.version + 1 : 1, timestamp = new Date().toISOString();
            const definition = subflowDefinitionSchema.parse({ id, version, name: input.name, description: input.description, inputs: input.inputs, outputs: input.outputs, nodes: input.workflow.nodes, edges: input.workflow.edges });
            const next = workflowTemplateSchema.parse({ id, revision: previous ? previous.revision + 1 : 1, definition, dependencies: input.workflow.subflows ?? [], archived: false, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp });
            validateWorkflowComposition({ id: 'template-validation', version: 1, name: input.name, nodes: [{ id: 'call', kind: 'subflow', label: input.name, description: '', prompt: '', config: {}, skillIds: [], position: { x: 0, y: 0 }, requiresReview: false, subflow: { id, version, inputs: Object.fromEntries(definition.inputs.map(input => [input.name, { literal: input.default ?? (input.type === 'string' ? '' : input.type === 'number' ? 0 : input.type === 'boolean' ? false : null) }])) } }], edges: [], subflows: [...next.dependencies, definition] });
            store.put('workflow-template-version', `${id}@${version}`, next); store.put('workflow-template', id, next); return next;
          })();
          onChanged(); return next;
        }
        case 'workflowTemplate.archive': case 'workflowTemplate.restore': {
          const input = identity.extend({ revision: z.number().int().positive() }).parse(params), previous = get(input.templateId);
          if (previous.revision !== input.revision) throw new Error('子流程模板已修改，请刷新后再操作。');
          const next = { ...previous, revision: previous.revision + 1, archived: method === 'workflowTemplate.archive', updatedAt: new Date().toISOString() };
          store.put('workflow-template', next.id, next); onChanged(); return next;
        }
        default: throw new Error('未知子流程模板操作。');
      }
    },
  };
}
