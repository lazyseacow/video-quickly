import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { LockedShotChangeError, TranscriptionTimestampError } from '@video-quickly/contracts';
import { DocumentStore } from './database.js';

export type ActivitySafety = 'local' | 'idempotent' | 'external';
export interface ActivityRecord {
  run_id: string;
  activity_id: string;
  input_hash: string;
  safety: ActivitySafety;
  status: 'prepared' | 'dispatched' | 'completed' | 'failed' | 'unknown';
  result: string | null;
  remote_id: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export class AmbiguousActivityError extends Error {
  constructor(readonly activityId: string) {
    super('上次请求的结果尚未确认，请先核对服务端任务，再决定是否重新生成。');
    this.name = 'AmbiguousActivityError';
  }
}

export class ActivityInputChangedError extends Error {
  constructor(activityId: string) {
    super(`活动 ${activityId} 的输入与运行快照不一致，请创建新的运行。`);
    this.name = 'ActivityInputChangedError';
  }
}

export class SimulatedProcessExit extends Error {}

export interface ActivityContext {
  operationId: string;
  remoteId?: string;
  recordRemoteId(id: string): void;
}

export interface ActivityHooks {
  failpoint?: (point: 'before-dispatch' | 'after-dispatch' | 'after-result' | 'after-commit', activityId: string) => void;
  onEvent?: (event: unknown) => void;
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export class ActivityJournal {
  readonly store: DocumentStore;
  constructor(readonly database: Database.Database, readonly hooks: ActivityHooks = {}) {
    this.store = new DocumentStore(database);
  }

  list(runId: string): ActivityRecord[] {
    return this.database.prepare('SELECT * FROM activities WHERE run_id = ? ORDER BY rowid').all(runId) as ActivityRecord[];
  }

  get(runId: string, activityId: string) {
    return this.database.prepare('SELECT * FROM activities WHERE run_id = ? AND activity_id = ?').get(runId, activityId) as ActivityRecord | undefined;
  }

  async execute<T>(runId: string, activityId: string, input: unknown, safety: ActivitySafety, action: (context: ActivityContext) => Promise<T>, commit?: (result: T) => void): Promise<T> {
    const inputHash = fingerprint(input);
    const previous = this.get(runId, activityId);
    if (previous && previous.input_hash !== inputHash) throw new ActivityInputChangedError(activityId);
    if (previous?.status === 'completed') return JSON.parse(previous.result!) as T;
    if (previous && ['dispatched', 'unknown'].includes(previous.status) && safety === 'external' && !previous.remote_id) {
      this.database.prepare("UPDATE activities SET status = 'unknown' WHERE run_id = ? AND activity_id = ?").run(runId, activityId);
      throw new AmbiguousActivityError(activityId);
    }
    if (!previous) {
      this.database.prepare("INSERT INTO activities(run_id, activity_id, input_hash, safety, status, started_at) VALUES (?, ?, ?, ?, 'prepared', ?)").run(runId, activityId, inputHash, safety, new Date().toISOString());
    }
    this.hooks.failpoint?.('before-dispatch', activityId);
    this.database.prepare("UPDATE activities SET status = 'dispatched', error = NULL WHERE run_id = ? AND activity_id = ?").run(runId, activityId);
    this.hooks.failpoint?.('after-dispatch', activityId);
    const context: ActivityContext = {
      operationId: `${runId}:${activityId}`,
      remoteId: previous?.remote_id ?? undefined,
      recordRemoteId: id => { this.database.prepare('UPDATE activities SET remote_id = ? WHERE run_id = ? AND activity_id = ?').run(id, runId, activityId); },
    };
    try {
      const result = await action(context);
      this.hooks.failpoint?.('after-result', activityId);
      const event = this.database.transaction(() => {
        commit?.(result);
        this.database.prepare("UPDATE activities SET status = 'completed', result = ?, completed_at = ?, error = NULL WHERE run_id = ? AND activity_id = ?").run(JSON.stringify(result), new Date().toISOString(), runId, activityId);
        return this.store.event(runId, 'activity.completed', { activityId });
      })();
      this.hooks.onEvent?.(event);
      this.hooks.failpoint?.('after-commit', activityId);
      return result;
    } catch (error) {
      if (error instanceof SimulatedProcessExit) throw error;
      const message = error instanceof TranscriptionTimestampError || error instanceof LockedShotChangeError ? error.message : safety === 'external' ? '外部调用未完成，结果需要核对。' : error instanceof Error ? error.message : '活动执行失败';
      this.database.prepare('UPDATE activities SET status = ?, error = ? WHERE run_id = ? AND activity_id = ?').run(safety === 'external' ? 'unknown' : 'failed', message, runId, activityId);
      // LangGraph also persists thrown errors in pending writes. Replace the
      // error before crossing that boundary; redacting only UI logs is too late.
      if (safety === 'external') throw new Error(message);
      throw error;
    }
  }
}
