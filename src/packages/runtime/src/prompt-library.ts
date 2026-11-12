import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { pageInputSchema, promptLibraryItemSchema, type PromptLibraryItem, type RecordPage } from '@video-quickly/contracts';
import { DocumentStore } from './database.js';

export function createPromptLibrary(database: Database.Database, store: DocumentStore, changed: () => void) {
  function get(id: string, version?: number): PromptLibraryItem {
    const item = store.get(version === undefined ? 'prompt-library' : 'prompt-library-version', version === undefined ? id : `${id}@${version}`);
    if (!item) throw new Error('提示词模板或版本不存在。');
    return promptLibraryItemSchema.parse(item);
  }
  return {
    get,
    dispatch(method: string, params: unknown): PromptLibraryItem | RecordPage<PromptLibraryItem> {
      if (method === 'promptLibrary.get') {
        const input = z.object({ id: z.string().min(1), version: z.number().int().positive().optional() }).parse(params);
        return get(input.id, input.version);
      }
      if (method === 'promptLibrary.list') {
        const input = pageInputSchema.extend({ archived: z.boolean().default(false), favorite: z.boolean().optional(), nodeKind: promptLibraryItemSchema.shape.nodeKinds.element.optional(), kind: promptLibraryItemSchema.shape.kind.optional() }).parse(params);
        const rows = database.prepare(`SELECT rowid AS cursor, body FROM documents WHERE kind = 'prompt-library'
          AND json_extract(body, '$.archived') = @archived AND (@favorite IS NULL OR json_extract(body, '$.favorite') = @favorite)
          AND (@kind IS NULL OR json_extract(body, '$.kind') = @kind) AND (@nodeKind IS NULL OR EXISTS (SELECT 1 FROM json_each(body, '$.nodeKinds') WHERE value = @nodeKind))
          AND (@before IS NULL OR rowid < @before) ORDER BY rowid DESC LIMIT @limit`).all({ archived: Number(input.archived), favorite: input.favorite === undefined ? null : Number(input.favorite), kind: input.kind ?? null, nodeKind: input.nodeKind ?? null, before: input.before ?? null, limit: input.limit + 1 }) as { cursor: number; body: string }[];
        return { items: rows.slice(0, input.limit).map(row => promptLibraryItemSchema.parse(JSON.parse(row.body))), nextCursor: rows.length > input.limit ? rows[input.limit - 1].cursor : null };
      }
      if (method === 'promptLibrary.save') {
        const input = promptLibraryItemSchema.pick({ kind: true, name: true, prompt: true, nodeKinds: true, bindings: true }).extend({ id: z.string().optional(), revision: z.number().int().positive().optional() }).parse(params);
        const result = database.transaction(() => {
          const previous = input.id ? get(input.id) : undefined;
          if (previous && previous.revision !== input.revision) throw new Error('提示词已修改，请刷新后保存新版本。');
          if (previous && previous.kind !== input.kind) throw new Error('提示词类型不能更改。');
          const timestamp = new Date().toISOString();
          const next = promptLibraryItemSchema.parse({ ...input, id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, version: (previous?.version ?? 0) + 1, favorite: previous?.favorite ?? false, archived: false, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp });
          store.put('prompt-library-version', `${next.id}@${next.version}`, next); store.put('prompt-library', next.id, next); return next;
        })();
        changed(); return result;
      }
      if (method === 'promptLibrary.update') {
        const input = z.object({ id: z.string(), revision: z.number().int().positive(), favorite: z.boolean().optional(), archived: z.boolean().optional() }).parse(params);
        const next = database.transaction(() => {
          const previous = get(input.id);
          if (previous.revision !== input.revision) throw new Error('提示词已修改，请刷新后操作。');
          const next = { ...previous, favorite: input.favorite ?? previous.favorite, archived: input.archived ?? previous.archived, revision: previous.revision + 1, updatedAt: new Date().toISOString() };
          store.put('prompt-library', next.id, next); return next;
        })();
        changed(); return next;
      }
      throw new Error('未知提示词库操作。');
    },
  };
}
