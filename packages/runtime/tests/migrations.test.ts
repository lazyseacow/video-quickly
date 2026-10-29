import Database from 'better-sqlite3';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { INITIAL_SCHEMA, openDatabase, DocumentStore } from '../src/database.js';
import { DatabaseMigrationError, migrateDatabase } from '../src/migrations.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'vq-migration-')); directories.push(path); return path; }

describe('workspace database upgrades', () => {
  it('creates a versioned database and does not back up on every reopen', async () => {
    const path = await directory(); const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(db.prepare('SELECT name FROM schema_migrations ORDER BY version').all()).toEqual([{ name: 'workspace-baseline' }, { name: 'execution-event-index' }]);
    db.close(); openDatabase(path).close();
    expect(await readdir(path)).not.toContain('database-backups');
  });

  it('backs up a legacy WAL database with project, credentials references, review and graph checkpoint intact', async () => {
    const path = await directory(); const db = new Database(join(path, 'workspace.sqlite'));
    db.pragma('journal_mode = WAL'); db.exec(INITIAL_SCHEMA);
    const store = new DocumentStore(db);
    for (const [kind, id, value] of [['project', 'p', { revision: 4 }], ['model', 'm', { credentialRef: 'reference-only' }], ['run', 'r', { status: 'waiting_review' }]] as const) store.put(kind, id, value);
    db.exec("CREATE TABLE checkpoints (thread_id TEXT PRIMARY KEY, checkpoint BLOB); INSERT INTO checkpoints VALUES ('r', X'010203');");
    // Keep the original connection open to prove the backup reads committed WAL data.
    const upgraded = openDatabase(path);
    expect(new DocumentStore(upgraded).get('run', 'r')).toEqual({ status: 'waiting_review' });
    expect(upgraded.prepare('SELECT hex(checkpoint) AS data FROM checkpoints').get()).toEqual({ data: '010203' });
    upgraded.close(); db.close();
    const files = await readdir(join(path, 'database-backups')); expect(files).toHaveLength(1);
    const backup = new Database(join(path, 'database-backups', files[0]), { readonly: true });
    try {
      expect(backup.pragma('user_version', { simple: true })).toBe(0);
      expect(backup.pragma('quick_check', { simple: true })).toBe('ok');
      expect(new DocumentStore(backup).get('project', 'p')).toEqual({ revision: 4 });
      expect(new DocumentStore(backup).get('model', 'm')).toEqual({ credentialRef: 'reference-only' });
      expect(backup.prepare('SELECT hex(checkpoint) AS data FROM checkpoints').get()).toEqual({ data: '010203' });
    } finally { backup.close(); }
    openDatabase(path).close(); expect(await readdir(join(path, 'database-backups'))).toHaveLength(1);
  });

  it('rolls all pending changes back on failure and leaves a usable recovery snapshot', async () => {
    const path = await directory(); const db = new Database(join(path, 'workspace.sqlite'));
    db.exec(INITIAL_SCHEMA); new DocumentStore(db).put('project', 'p', { title: '保留的项目' });
    let failure: unknown;
    try { migrateDatabase(db, path, [{ version: 1, name: 'change', sql: 'ALTER TABLE documents ADD COLUMN extra TEXT;' }, { version: 2, name: 'fail', sql: 'INVALID MIGRATION' }]); } catch (error) { failure = error; }
    try {
      expect(failure).toBeInstanceOf(DatabaseMigrationError);
      expect(db.pragma('user_version', { simple: true })).toBe(0);
      expect(db.prepare('SELECT name FROM pragma_table_info(?)').all('documents')).not.toContainEqual({ name: 'extra' });
      expect(new DocumentStore(db).get('project', 'p')).toEqual({ title: '保留的项目' });
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get()).toBeUndefined();
      const recovery = new Database((failure as DatabaseMigrationError).backupPath!, { readonly: true });
      try { expect(new DocumentStore(recovery).get('project', 'p')).toEqual({ title: '保留的项目' }); } finally { recovery.close(); }
    } finally { db.close(); }
  });

  it('rejects newer databases without changing their data or version', async () => {
    const path = await directory(); const db = openDatabase(path);
    new DocumentStore(db).put('project', 'p', { title: '新版本项目' }); db.pragma('user_version = 99'); db.close();
    expect(() => openDatabase(path)).toThrow('高于此客户端支持的版本');
    const original = new Database(join(path, 'workspace.sqlite'), { readonly: true });
    try { expect(original.pragma('user_version', { simple: true })).toBe(99); expect(new DocumentStore(original).get('project', 'p')).toEqual({ title: '新版本项目' }); } finally { original.close(); }
  });
});
