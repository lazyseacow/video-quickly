import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { pageInputSchema, promptDraftSchema, promptSessionSchema, type PromptDraft, type PromptPreview, type PromptSession, type RunRecord } from '@video-quickly/contracts';
import { fingerprint } from './activities.js';
import { DocumentStore } from './database.js';
import type { RunSnapshot } from './index.js';

interface Prepared { saved: RunSnapshot; preview: PromptPreview }
export function createPromptWorkbench({ database, store, prepare, start, schedule, changed }: {
  database: Database.Database; store: DocumentStore; prepare(draft: PromptDraft): Promise<Prepared>;
  start(session: PromptSession, saved: RunSnapshot): RunRecord; schedule(runId: string): void; changed(): void;
}) {
  function get(id: string) {
    const item = store.get('prompt-session', id);
    if (!item) throw new Error('提示词实验会话不存在。');
    return promptSessionSchema.parse(item);
  }
  return {
    async dispatch(method: string, params: unknown) {
      if (method === 'prompt.preview') return (await prepare(promptDraftSchema.parse(params))).preview;
      if (method === 'promptSession.get') return get(z.object({ id: z.string() }).parse(params).id);
      if (method === 'promptSession.list') {
        const input = pageInputSchema.extend({ projectId: z.string().min(1), nodeId: z.string().optional() }).parse(params);
        const rows = database.prepare("SELECT rowid AS cursor, body FROM documents WHERE kind = 'prompt-session' AND json_extract(body, '$.draft.projectId') = ? AND (? IS NULL OR json_extract(body, '$.draft.node.id') = ?) AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?").all(input.projectId, input.nodeId ?? null, input.nodeId ?? null, input.before ?? null, input.before ?? null, input.limit + 1) as { cursor: number; body: string }[];
        return { items: rows.slice(0, input.limit).map(row => promptSessionSchema.parse(JSON.parse(row.body))), nextCursor: rows.length > input.limit ? rows[input.limit - 1].cursor : null };
      }
      if (method === 'promptSession.save') {
        const input = z.object({ id: z.string().optional(), revision: z.number().int().positive().optional(), draft: promptDraftSchema, previewDigest: z.string() }).parse(params);
        const prepared = await prepare(input.draft);
        if (prepared.preview.digest !== input.previewDigest) throw new Error('实验输入已变化，请重新预览后保存。');
        const next = database.transaction(() => {
          const previous = input.id ? get(input.id) : undefined;
          if (previous && (previous.revision !== input.revision || previous.draft.projectId !== input.draft.projectId)) throw new Error('实验会话已修改，请刷新后保存。');
          const timestamp = new Date().toISOString();
          const session = promptSessionSchema.parse({ id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, draft: input.draft, preview: prepared.preview, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp });
          store.put('prompt-session-snapshot', `${session.id}@${session.revision}`, prepared.saved);
          store.put('prompt-session', session.id, session); return session;
        })();
        changed(); return next;
      }
      if (method === 'promptTrial.start') {
        const input = z.object({ sessionId: z.string(), revision: z.number().int().positive(), requestId: z.string().uuid() }).parse(params);
        const previous = store.get<{ inputHash: string; runId: string }>('prompt-trial-request', input.requestId);
        if (previous) {
          if (previous.inputHash !== fingerprint(input)) throw new Error('试运行标识已用于其他实验，请使用新的标识。');
          return store.get<RunRecord>('run', previous.runId);
        }
        const session = get(input.sessionId);
        if (session.revision !== input.revision) throw new Error('实验会话已修改，请刷新后试运行。');
        const saved = store.get<RunSnapshot>('prompt-session-snapshot', `${session.id}@${session.revision}`);
        if (!saved) throw new Error('实验快照不存在，请重新预览。');
        const record = database.transaction(() => {
          const record = start(session, saved);
          store.put('prompt-trial-request', input.requestId, { inputHash: fingerprint(input), runId: record.id });
          return record;
        })();
        schedule(record.id); return record;
      }
      throw new Error('未知提示词实验操作。');
    },
  };
}
