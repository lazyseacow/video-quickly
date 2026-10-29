import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrateDatabase } from './migrations.js';

export const INITIAL_SCHEMA = `
    CREATE TABLE IF NOT EXISTS documents (
      kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind, id)
    );
    CREATE TABLE IF NOT EXISTS activities (
      run_id TEXT NOT NULL, activity_id TEXT NOT NULL, input_hash TEXT NOT NULL,
      safety TEXT NOT NULL, status TEXT NOT NULL, result TEXT, remote_id TEXT, error TEXT,
      started_at TEXT NOT NULL, completed_at TEXT, PRIMARY KEY(run_id, activity_id)
    );
    CREATE TABLE IF NOT EXISTS execution_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
      type TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function openDatabase(directory: string) {
  mkdirSync(directory, { recursive: true });
  const database = new Database(join(directory, 'workspace.sqlite'));
  try {
    database.pragma('busy_timeout = 5000');
    database.pragma('foreign_keys = ON');
    database.pragma('synchronous = FULL');
    migrateDatabase(database, directory, [
      { version: 1, name: 'workspace-baseline', sql: INITIAL_SCHEMA },
      { version: 2, name: 'execution-event-index', sql: 'CREATE INDEX execution_events_run_sequence ON execution_events(run_id, sequence);' },
    ]);
    database.pragma('journal_mode = WAL');
    return database;
  } catch (error) { database.close(); throw error; }
}

export class DocumentStore {
  constructor(readonly database: Database.Database) {}

  get<T>(kind: string, id: string): T | undefined {
    const value = this.database.prepare('SELECT body FROM documents WHERE kind = ? AND id = ?').get(kind, id) as { body: string } | undefined;
    return value ? JSON.parse(value.body) as T : undefined;
  }

  list<T>(kind: string): T[] {
    const rows = this.database.prepare('SELECT body FROM documents WHERE kind = ? ORDER BY rowid').all(kind) as { body: string }[];
    return rows.map(row => JSON.parse(row.body) as T);
  }

  put(kind: string, id: string, value: unknown) {
    this.database.prepare('INSERT INTO documents(kind, id, body) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body').run(kind, id, JSON.stringify(value));
  }

  delete(kind: string, id: string) {
    this.database.prepare('DELETE FROM documents WHERE kind = ? AND id = ?').run(kind, id);
  }

  event(runId: string, type: string, body: unknown) {
    const createdAt = new Date().toISOString();
    const result = this.database.prepare('INSERT INTO execution_events(run_id, type, body, created_at) VALUES (?, ?, ?, ?)').run(runId, type, JSON.stringify(body), createdAt);
    return { sequence: Number(result.lastInsertRowid), runId, type, body, createdAt };
  }
}
