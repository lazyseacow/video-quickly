import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { dramaTopicInputSchema, dramaTopicSchema, pageInputSchema, type DramaTopic, type RecordPage } from '@video-quickly/contracts';
import type { DocumentStore } from './database.js';

const identity = z.object({ topicId: z.string().min(1) });

export function createDramaTopicLibrary({ database, store, changed }: { database: Database.Database; store: DocumentStore; changed(): void }) {
  function get(id: string): DramaTopic {
    const saved = store.get('drama-topic', id);
    if (!saved) throw new Error('短剧选题不存在。');
    return dramaTopicSchema.parse(saved);
  }
  function requireRevision(topic: DramaTopic, revision: number | undefined) {
    if (topic.revision !== revision) throw new Error('选题已在其他视图修改，请刷新后重新保存。');
  }
  return {
    get,
    dispatch(method: string, raw: unknown = {}): DramaTopic | RecordPage<DramaTopic> {
      switch (method) {
        case 'dramaTopic.get': return get(identity.parse(raw).topicId);
        case 'dramaTopic.list': {
          const input = pageInputSchema.extend({ archived: z.boolean().default(false), search: z.string().trim().max(200).default('') }).parse(raw);
          const rows = database.prepare(`SELECT rowid AS cursor, body FROM documents topic
            WHERE kind = 'drama-topic' AND coalesce(json_extract(body, '$.archived'), 0) = ?
            AND (? IS NULL OR rowid < ?)
            AND (? = '' OR instr(lower(json_extract(body, '$.title')), lower(?)) > 0
              OR instr(lower(json_extract(body, '$.logline')), lower(?)) > 0
              OR instr(lower(json_extract(body, '$.description')), lower(?)) > 0
              OR EXISTS (SELECT 1 FROM json_each(topic.body, '$.tags') tag WHERE instr(lower(tag.value), lower(?)) > 0))
            ORDER BY rowid DESC LIMIT ?`).all(Number(input.archived), input.before ?? null, input.before ?? null,
            input.search, input.search, input.search, input.search, input.search, input.limit + 1) as { cursor: number; body: string }[];
          return { items: rows.slice(0, input.limit).map(row => dramaTopicSchema.parse(JSON.parse(row.body))), nextCursor: rows.length > input.limit ? rows[input.limit - 1].cursor : null };
        }
        case 'dramaTopic.save': {
          const { topic } = z.object({ topic: dramaTopicInputSchema }).parse(raw);
          const saved = database.transaction(() => {
            const previous = topic.id ? get(topic.id) : undefined;
            if (previous) requireRevision(previous, topic.revision);
            if (previous?.archived) throw new Error('选题已归档，请恢复后再编辑。');
            const time = new Date().toISOString();
            const next = dramaTopicSchema.parse({ ...previous, ...topic, id: previous?.id ?? randomUUID(), revision: previous ? previous.revision + 1 : 1,
              createdAt: previous?.createdAt ?? time, updatedAt: time, archived: false });
            store.put('drama-topic', next.id, next); return next;
          }).immediate();
          changed(); return saved;
        }
        case 'dramaTopic.archive':
        case 'dramaTopic.restore': {
          const input = identity.extend({ revision: z.number().int().positive() }).parse(raw);
          const saved = database.transaction(() => {
            const previous = get(input.topicId); requireRevision(previous, input.revision);
            // Existing works retain their topic identity and frozen creation context.
            const next = { ...previous, archived: method === 'dramaTopic.archive', revision: previous.revision + 1, updatedAt: new Date().toISOString() };
            store.put('drama-topic', next.id, next); return next;
          }).immediate();
          changed(); return saved;
        }
        default: throw new Error(`未知短剧选题方法：${method}`);
      }
    },
  };
}
