import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { pageInputSchema, seriesTemplateSchema, type RecordPage, type SeriesSettings, type SeriesTemplate } from '@video-quickly/contracts';
import { DocumentStore } from './database.js';

export function createSeriesTemplateLibrary({ database, store, onChanged }: { database: Database.Database; store: DocumentStore; onChanged(): void }) {
  const editable = seriesTemplateSchema.pick({ name: true, description: true, settings: true });
  const identity = z.object({ templateId: z.string().min(1) });
  function get(id: string): SeriesTemplate {
    const saved = store.get('series-template', id);
    if (!saved) throw new Error('系列模板不存在。');
    return seriesTemplateSchema.parse(saved);
  }
  function requireRevision(template: SeriesTemplate, revision: number | undefined) {
    if (template.revision !== revision) throw new Error('系列模板已在其他视图修改，请刷新后重新保存。');
  }
  return {
    settingsFor(id: string, revision: number | undefined): SeriesSettings {
      const template = get(id); requireRevision(template, revision);
      if (template.archived) throw new Error('系列模板已归档，请先恢复后再用于新项目。');
      // Projects own copied settings. Library changes never alter existing work or runs.
      return structuredClone(template.settings);
    },
    dispatch(method: string, rawParams: unknown = {}): SeriesTemplate | RecordPage<SeriesTemplate> {
      switch (method) {
        case 'seriesTemplate.get': return get(identity.parse(rawParams).templateId);
        case 'seriesTemplate.list': {
          const input = pageInputSchema.extend({ archived: z.boolean().default(false) }).parse(rawParams);
          const rows = database.prepare("SELECT rowid AS cursor, body FROM documents WHERE kind = 'series-template' AND coalesce(json_extract(body, '$.archived'), 0) = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?").all(Number(input.archived), input.before ?? null, input.before ?? null, input.limit + 1) as { cursor: number; body: string }[];
          return { items: rows.slice(0, input.limit).map(row => seriesTemplateSchema.parse(JSON.parse(row.body))), nextCursor: rows.length > input.limit ? rows[input.limit - 1].cursor : null };
        }
        case 'seriesTemplate.save': {
          const { template } = z.object({ template: editable.extend({ id: z.string().min(1).optional(), revision: z.number().int().positive().optional() }) }).parse(rawParams);
          const saved = database.transaction(() => {
            const previous = template.id ? get(template.id) : undefined;
            if (previous) requireRevision(previous, template.revision);
            const timestamp = new Date().toISOString();
            const next = seriesTemplateSchema.parse({ ...template, id: previous?.id ?? randomUUID(), revision: previous ? previous.revision + 1 : 1, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, archived: previous?.archived ?? false });
            store.put('series-template', next.id, next); return next;
          })();
          onChanged(); return saved;
        }
        case 'seriesTemplate.archive':
        case 'seriesTemplate.restore': {
          const input = identity.extend({ revision: z.number().int().positive() }).parse(rawParams);
          const saved = database.transaction(() => {
            const previous = get(input.templateId); requireRevision(previous, input.revision);
            const next = { ...previous, archived: method === 'seriesTemplate.archive', revision: previous.revision + 1, updatedAt: new Date().toISOString() };
            store.put('series-template', next.id, next); return next;
          })();
          onChanged(); return saved;
        }
        default: throw new Error(`未知系列模板方法：${method}`);
      }
    },
  };
}
