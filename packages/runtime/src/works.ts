import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { createNativeVideoWorkflow, episodeSchema, pageInputSchema, projectSchema, validateCreativeReferences, workDefaultsSchema, workSchema, type ProjectDocument, type StoryWork } from '@video-quickly/contracts';
import { fingerprint } from './activities.js';
import { DocumentStore } from './database.js';

const projectReference = z.object({ projectId: z.string().min(1), revision: z.number().int().positive() });
export function createWorkLibrary({ database, store, project, saveProject, validateDefaults, reserved, changed }: {
  database: Database.Database; store: DocumentStore; project(id: string): ProjectDocument; saveProject(value: ProjectDocument): ProjectDocument;
  validateDefaults(defaults: StoryWork['defaults']): void; reserved(projectId: string): boolean; changed(): void;
}) {
  function get(id: string): StoryWork {
    const value = store.get('story-work', id);
    if (!value) throw new Error('作品不存在。');
    return workSchema.parse(value);
  }
  function current(id: string, revision: number) {
    const value = get(id);
    if (value.revision !== revision) throw new Error('作品已修改，请刷新后重试。');
    return value;
  }
  function editableProject(reference: z.infer<typeof projectReference>) {
    const value = project(reference.projectId);
    if (value.revision !== reference.revision) throw new Error('分集项目已修改，请刷新后重试。');
    if (reserved(value.id)) throw new Error('该分集已在生产队列中，请先处理其排队项。');
    return value;
  }
  function requireNumber(workId: string, number: number, exceptId = '') {
    if (database.prepare("SELECT 1 FROM documents WHERE kind = 'project' AND json_extract(body, '$.episode.workId') = ? AND json_extract(body, '$.episode.number') = ? AND id <> ?").get(workId, number, exceptId)) throw new Error(`第 ${number} 集已存在，回收站中的分集也保留集数，请选择其他编号。`);
  }
  return {
    get,
    dispatch(method: string, params: unknown) {
      if (method === 'work.get') return get(z.object({ workId: z.string() }).parse(params).workId);
      if (method === 'work.list') {
        const input = pageInputSchema.extend({ archived: z.boolean().default(false) }).parse(params);
        const rows = database.prepare("SELECT rowid AS cursor, body FROM documents WHERE kind = 'story-work' AND json_extract(body, '$.archived') = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?").all(Number(input.archived), input.before ?? null, input.before ?? null, input.limit + 1) as { cursor: number; body: string }[];
        return { items: rows.slice(0, input.limit).map(row => workSchema.parse(JSON.parse(row.body))), nextCursor: rows.length > input.limit ? rows[input.limit - 1].cursor : null };
      }
      if (method === 'work.save') {
        const input = workSchema.pick({ title: true, description: true, defaults: true }).extend({ id: z.string().optional(), revision: z.number().int().positive().optional() }).parse(params);
        const result = database.transaction(() => {
          const previous = input.id ? current(input.id, input.revision ?? 0) : undefined;
          validateDefaults(input.defaults);
          const timestamp = new Date().toISOString();
          const value = workSchema.parse({ ...input, id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, archived: previous?.archived ?? false, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp });
          store.put('story-work', value.id, value); return value;
        })(); changed(); return result;
      }
      if (method === 'work.archive' || method === 'work.restore') {
        const input = z.object({ workId: z.string(), revision: z.number().int().positive() }).parse(params);
        const value = current(input.workId, input.revision);
        if (method === 'work.archive' && database.prepare("SELECT 1 FROM documents q JOIN documents i ON i.kind = 'production-queue-item' AND json_extract(i.body, '$.queueId') = q.id WHERE q.kind = 'production-queue' AND json_extract(q.body, '$.workId') = ? AND json_extract(i.body, '$.status') IN ('queued','running','needs_attention','failed')").get(value.id)) throw new Error('请先处理作品的生产队列。');
        const next = { ...value, archived: method === 'work.archive', revision: value.revision + 1, updatedAt: new Date().toISOString() };
        store.put('story-work', next.id, next); changed(); return next;
      }
      if (method === 'work.episodes.create') {
        const input = z.object({ workId: z.string(), revision: z.number().int().positive(), requestId: z.string().uuid(), episodes: z.array(z.object({ number: episodeSchema.shape.number, title: projectSchema.shape.title, originalText: episodeSchema.shape.originalText })).min(1).max(100) }).parse(params);
        const result = database.transaction(() => {
          const receipt = store.get<{ inputHash: string; projects: ProjectDocument[] }>('episode-create-request', input.requestId);
          if (receipt) { if (receipt.inputHash !== fingerprint(input)) throw new Error('批量建项标识已用于不同输入，请使用新的标识。'); return receipt.projects; }
          const work = current(input.workId, input.revision);
          if (work.archived) throw new Error('请先恢复作品。');
          if (new Set(input.episodes.map(episode => episode.number)).size !== input.episodes.length) throw new Error('本批分集编号不能重复。');
          validateDefaults(work.defaults);
          for (const episode of input.episodes) requireNumber(work.id, episode.number);
          const timestamp = new Date().toISOString();
          const projects = input.episodes.map(episode => projectSchema.parse({
            id: randomUUID(), title: episode.title, brief: episode.originalText, style: work.defaults.style, creativeContext: work.defaults.creativeContext,
            profile: work.defaults.profile, templateId: 'generic', revision: 1, shots: [], claims: [], workflow: { ...createNativeVideoWorkflow(), production: work.defaults.production },
            episode: { workId: work.id, number: episode.number, originalText: episode.originalText, defaultsRevision: work.revision }, createdAt: timestamp, updatedAt: timestamp,
          }));
          for (const value of projects) store.put('project', value.id, value);
          store.put('episode-create-request', input.requestId, { inputHash: fingerprint(input), projects }); return projects;
        })(); changed(); return result;
      }
      if (method === 'work.episode.attach') {
        const input = projectReference.extend({ workId: z.string(), workRevision: z.number().int().positive(), number: episodeSchema.shape.number, originalText: episodeSchema.shape.originalText.optional(), title: projectSchema.shape.title.optional() }).parse(params);
        return database.transaction(() => {
          const work = current(input.workId, input.workRevision), value = editableProject(input);
          if (work.archived || value.archived) throw new Error('请先恢复作品和项目。');
          requireNumber(work.id, input.number, value.id);
          return saveProject({ ...value, title: input.title ?? value.title, episode: { workId: work.id, number: input.number, originalText: input.originalText ?? value.episode?.originalText ?? value.episodeSource?.originalText ?? value.brief, ...(value.episode?.workId === work.id ? { defaultsRevision: value.episode.defaultsRevision } : {}) } });
        })();
      }
      if (method === 'work.episode.detach') {
        const input = projectReference.parse(params);
        return database.transaction(() => {
          const value = editableProject(input), work = value.episode ? get(value.episode.workId) : undefined;
          return saveProject({ ...value, episode: undefined, episodeSource: value.episode && work ? { ...value.episode, workTitle: work.title } : value.episodeSource });
        })();
      }
      if (method === 'work.defaults.apply') {
        const input = z.object({ workId: z.string(), revision: z.number().int().positive(), projects: z.array(projectReference).min(1).max(100), fields: z.array(z.enum(['style', 'creativeContext', 'profile', 'production'])).min(1).default(['style', 'creativeContext']) }).parse(params);
        return database.transaction(() => {
          const work = current(input.workId, input.revision); validateDefaults(work.defaults);
          if (work.archived) throw new Error('请先恢复作品。');
          if (new Set(input.projects.map(item => item.projectId)).size !== input.projects.length) throw new Error('分集不能重复。');
          const values = input.projects.map(reference => {
            const value = editableProject(reference);
            if (value.episode?.workId !== work.id || value.archived) throw new Error('请选择作品中可编辑的分集。');
            const next = { ...value, ...Object.fromEntries(input.fields.filter(field => field !== 'production').map(field => [field, work.defaults[field]])), episode: { ...value.episode, defaultsRevision: work.revision },
              ...(input.fields.includes('production') ? { workflow: { ...value.workflow, version: value.workflow.version + 1, production: { ...value.workflow.production, ...work.defaults.production } } } : {}) };
            validateCreativeReferences(next); return next;
          });
          return values.map(value => saveProject(value));
        })();
      }
      throw new Error('未知作品操作。');
    },
  };
}
