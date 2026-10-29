import type Database from 'better-sqlite3';
import { closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export interface DatabaseMigration { version: number; name: string; sql: string }
export class DatabaseMigrationError extends Error {
  constructor(message: string, readonly backupPath?: string, options?: ErrorOptions) { super(message, options); }
}

export function migrateDatabase(database: Database.Database, directory: string, migrations: readonly DatabaseMigration[]) {
  migrations.forEach((migration, index) => { if (migration.version !== index + 1) throw new Error('数据库迁移版本必须连续'); });
  const current = Number(database.pragma('user_version', { simple: true }));
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) throw new DatabaseMigrationError(`数据库版本 ${current} 高于此客户端支持的版本 ${latest}，请使用较新的客户端。`);
  if (current === latest) return;
  const hasTables = !!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
  let backupPath: string | undefined;
  if (hasTables) {
    const backups = join(directory, 'database-backups');
    mkdirSync(backups, { recursive: true });
    backupPath = join(backups, `workspace-v${current}-to-v${latest}-${randomUUID()}.sqlite`);
    try {
      // SQLite creates a consistent standalone snapshot, including committed WAL pages.
      database.prepare('VACUUM INTO ?').run(backupPath);
      const handle = openSync(backupPath, 'r+');
      try { fsyncSync(handle); } finally { closeSync(handle); }
    } catch (cause) { throw new DatabaseMigrationError('无法创建数据库升级备份，升级未执行。', undefined, { cause }); }
  }
  try {
    database.transaction(() => {
      database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      for (const migration of migrations) {
        if (migration.version <= current) continue;
        database.exec(migration.sql);
        database.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, new Date().toISOString());
        database.pragma(`user_version = ${migration.version}`);
      }
    }).immediate();
  } catch (cause) {
    throw new DatabaseMigrationError(`数据库升级失败，事务已回滚。${backupPath ? `迁移前备份：${backupPath}` : ''}`, backupPath, { cause });
  }
}
