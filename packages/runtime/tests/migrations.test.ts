import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_SCHEMA, openDatabase, DocumentStore, WORKSPACE_MIGRATIONS, thumbnailShot } from '../src/database.js';
import { DatabaseMigrationError, migrateDatabase } from '../src/migrations.js';
import { createHistoryWorkflow, DEFAULT_CAPTION_STYLE, DEFAULT_VIDEO_PROFILE, projectSchema, projectSummarySchema } from '@video-quickly/contracts';
import { createReadModels } from '../src/read-models.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'vq-migration-')); directories.push(path); return path; }

describe('workspace database upgrades', () => {
  it('upgrades the actual v6 schema and prevents older clients from dropping new document capabilities', async () => {
    const path = await directory(), previous = new Database(join(path, 'workspace.sqlite'));
    previous.function('vq_thumbnail', { deterministic: true }, body => {
      if (typeof body !== 'string') throw new Error('Expected a project document');
      return JSON.stringify(thumbnailShot(JSON.parse(body)));
    });
    migrateDatabase(previous, path, WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 6));
    const project = projectSchema.parse({ id: 'v6-project', title: '升级前的项目', brief: '', revision: 3, profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), shots: [], createdAt: '', updatedAt: '' });
    const store = new DocumentStore(previous); store.put('project', project.id, project);
    store.put('model', 'connection', { id: 'connection', credentialRef: 'opaque-reference' });
    previous.exec("CREATE TABLE checkpoints (thread_id TEXT PRIMARY KEY, checkpoint BLOB); INSERT INTO checkpoints VALUES ('original-run', X'010203');");
    previous.close();
    const upgraded = openDatabase(path);
    try {
      expect(upgraded.pragma('user_version', { simple: true })).toBe(7);
      expect(new DocumentStore(upgraded).get('project', project.id)).toEqual(project);
      expect(new DocumentStore(upgraded).get('model', 'connection')).toEqual({ id: 'connection', credentialRef: 'opaque-reference' });
      expect(upgraded.prepare('SELECT hex(checkpoint) AS value FROM checkpoints').get()).toEqual({ value: '010203' });
      expect(() => migrateDatabase(upgraded, path, WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 6))).toThrow('高于此客户端支持的版本');
      expect(upgraded.pragma('user_version', { simple: true })).toBe(7);
    } finally { upgraded.close(); }
    const backups = await readdir(join(path, 'database-backups')); expect(backups).toHaveLength(1);
    const backup = new Database(join(path, 'database-backups', backups[0]), { readonly: true });
    try { expect(backup.pragma('user_version', { simple: true })).toBe(6); expect(new DocumentStore(backup).get('project', project.id)).toEqual(project); } finally { backup.close(); }
  });

  it('creates a versioned database and does not back up on every reopen', async () => {
    const path = await directory(); const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(7);
    expect(db.prepare('SELECT name FROM schema_migrations ORDER BY version').all()).toEqual([{ name: 'workspace-baseline' }, { name: 'execution-event-index' }, { name: 'workspace-read-models' }, { name: 'audio-asset-references' }, { name: 'project-summary-caption-style' }, { name: 'clip-edit-references-and-first-frame' }, { name: 'workflow-composition-and-keyframe-capabilities' }]);
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

  it('backfills project summaries and asset references when upgrading the previous version', async () => {
    const path = await directory(); const db = new Database(join(path, 'workspace.sqlite'));
    db.exec(`${INITIAL_SCHEMA} CREATE INDEX execution_events_run_sequence ON execution_events(run_id, sequence); PRAGMA user_version = 2;`);
    const project = projectSchema.parse({ id: 'legacy', title: '旧项目', brief: '', revision: 7, profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), createdAt: '', updatedAt: '', shots: [{ id: 's', title: '旧镜头', narration: '', visualPrompt: '', durationUs: 2_000_000, assetId: 'used-image', audioAssetId: 'used-audio', captionTrack: { timeBase: 'source', alignment: 'manual', sourceAssetId: 'caption-origin-audio', cues: [] } }], musicClips: [{ id: 'legacy-music', assetId: 'used-music', durationUs: 2_000_000 }] });
    new DocumentStore(db).put('project', project.id, project); db.close();
    const upgraded = openDatabase(path);
    try {
      expect(new DocumentStore(upgraded).get('project', project.id)).toEqual(project);
      expect(new DocumentStore(upgraded).get('project-summary', project.id)).toMatchObject({ id: 'legacy', shotCount: 1, durationUs: 2_000_000, revision: 7, archived: false });
      expect(upgraded.prepare('SELECT asset_id FROM project_asset_references ORDER BY asset_id').all()).toEqual([{ asset_id: 'caption-origin-audio' }, { asset_id: 'used-audio' }, { asset_id: 'used-image' }, { asset_id: 'used-music' }]);
      expect(upgraded.pragma('user_version', { simple: true })).toBe(7);
    } finally { upgraded.close(); }
    expect(await readdir(join(path, 'database-backups'))).toHaveLength(1);
  });

  it('upgrades actual v4 summaries without changing projects, assets, audio references or review checkpoints', async () => {
    const path = await directory(), previous = new Database(join(path, 'workspace.sqlite'));
    migrateDatabase(previous, path, WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 4));
    const oldStore = new DocumentStore(previous), content = '资料正文不得进入后台摘要。'.repeat(2_000);
    const project = projectSchema.parse({ id: 'styled-v4', title: '旧版样式项目', brief: '', revision: 7, profile: DEFAULT_VIDEO_PROFILE, captionStyle: { ...DEFAULT_CAPTION_STYLE, fontId: 'serif', position: 'top' }, workflow: createHistoryWorkflow(), createdAt: '', updatedAt: '', researchSources: [{ id: 'source', title: '资料标题', kind: 'text', content, sha256: createHash('sha256').update(content).digest('hex'), capturedAt: '2026-10-30T00:00:00.000Z' }], claims: [{ id: 'claim', text: '主张全文不得出现在摘要中', source: '资料标题', status: 'pending' }], shots: [{ id: 'shot', title: '旧镜头', narration: '', visualPrompt: '', durationUs: 2_000_000, assetId: 'used-image', audioAssetId: 'used-audio', claimIds: ['claim'], captionTrack: { timeBase: 'source', alignment: 'manual', sourceAssetId: 'caption-origin-audio', cues: [] } }], musicClips: [{ id: 'music', assetId: 'used-music', durationUs: 2_000_000 }] });
    oldStore.put('project', project.id, project);
    const assets = ['used-image', 'used-audio', 'used-music', 'caption-origin-audio'].map(id => ({ id, name: id, projectId: project.id, kind: id === 'used-image' ? 'image' : 'audio', path: `/fixture/${id}`, mimeType: 'application/octet-stream', size: 1, sha256: createHash('sha256').update(id).digest('hex'), version: 1, createdAt: '', provenance: 'migration fixture', retained: false, active: true }));
    for (const asset of assets) oldStore.put('asset', asset.id, asset);
    const run = { id: 'review-run', projectId: project.id, status: 'waiting_review', projectRevision: 7, workflowVersion: 1, snapshotDigest: 'frozen-digest', createdAt: '', updatedAt: '', events: [], activities: [] };
    oldStore.put('run', run.id, run);
    previous.exec("CREATE TABLE checkpoints (thread_id TEXT PRIMARY KEY, checkpoint BLOB); INSERT INTO checkpoints VALUES ('review-run', X'010203');");
    expect(oldStore.get('project-summary', project.id)).not.toHaveProperty('captionStyle');
    const rowid = previous.prepare("SELECT rowid FROM documents WHERE kind = 'project-summary' AND id = ?").get(project.id), originalReferences = previous.prepare('SELECT asset_id FROM project_asset_references ORDER BY asset_id').all();
    previous.close();
    const upgraded = openDatabase(path), store = new DocumentStore(upgraded);
    try {
      expect(upgraded.pragma('user_version', { simple: true })).toBe(7); expect(store.get('project', project.id)).toEqual(project); expect(store.get('run', run.id)).toEqual(run); expect(store.list('asset')).toEqual(assets);
      expect(upgraded.prepare('SELECT hex(checkpoint) AS data FROM checkpoints').get()).toEqual({ data: '010203' });
      expect(upgraded.prepare('SELECT asset_id FROM project_asset_references ORDER BY asset_id').all()).toEqual(originalReferences); expect(originalReferences).toEqual([{ asset_id: 'caption-origin-audio' }, { asset_id: 'used-audio' }, { asset_id: 'used-image' }, { asset_id: 'used-music' }]);
      expect(upgraded.prepare("SELECT rowid FROM documents WHERE kind = 'project-summary' AND id = ?").get(project.id)).toEqual(rowid);
      const read = vi.spyOn(store, 'get'), summary = projectSummarySchema.parse(createReadModels(upgraded, store).projects()[0]); expect(summary.captionStyle).toEqual(project.captionStyle); expect(read).not.toHaveBeenCalledWith('project', project.id);
      expect(summary).not.toHaveProperty('researchSources'); expect(summary).not.toHaveProperty('claims'); expect(JSON.stringify(summary)).not.toContain(content); expect(JSON.stringify(summary)).not.toContain(project.claims[0].text); expect(JSON.stringify(summary).length).toBeLessThan(2_000);
      const nextStyle = { ...DEFAULT_CAPTION_STYLE, textColor: '#123456' }, changed = { ...project, revision: 8, captionStyle: nextStyle, shots: project.shots.map(shot => ({ ...shot, audioAssetId: 'next-audio', captionTrack: { ...shot.captionTrack!, sourceAssetId: 'next-caption' } })), musicClips: [{ ...project.musicClips![0], assetId: 'next-music' }] };
      store.put('project', project.id, changed); expect(store.get('project-summary', project.id)).toMatchObject({ revision: 8, captionStyle: nextStyle });
      expect(upgraded.prepare('SELECT asset_id FROM project_asset_references ORDER BY asset_id').all()).toEqual([{ asset_id: 'next-audio' }, { asset_id: 'next-caption' }, { asset_id: 'next-music' }, { asset_id: 'used-image' }]);
      store.put('project', 'inserted', { ...project, id: 'inserted', captionStyle: nextStyle, shots: [], musicClips: [] }); expect(store.get('project-summary', 'inserted')).toMatchObject({ captionStyle: nextStyle, shotCount: 0 });
      store.put('project', project.id, { ...changed, captionStyle: null }); expect(store.get('project-summary', project.id)).toHaveProperty('captionStyle', null);
      store.delete('project', project.id); expect(store.get('project-summary', project.id)).toBeUndefined(); expect(upgraded.prepare('SELECT 1 FROM project_asset_references WHERE project_id = ?').get(project.id)).toBeUndefined();
    } finally { upgraded.close(); }
    const backups = await readdir(join(path, 'database-backups')); expect(backups).toHaveLength(1);
    const backup = new Database(join(path, 'database-backups', backups[0]), { readonly: true });
    try { expect(backup.pragma('user_version', { simple: true })).toBe(4); expect(new DocumentStore(backup).get('project', project.id)).toEqual(project); expect(new DocumentStore(backup).get('project-summary', project.id)).not.toHaveProperty('captionStyle'); } finally { backup.close(); }
    openDatabase(path).close(); expect(await readdir(join(path, 'database-backups'))).toHaveLength(1);
  });

  it('rejects newer databases without changing their data or version', async () => {
    const path = await directory(); const db = openDatabase(path);
    new DocumentStore(db).put('project', 'p', { title: '新版本项目' }); db.pragma('user_version = 99'); db.close();
    expect(() => openDatabase(path)).toThrow('高于此客户端支持的版本');
    const original = new Database(join(path, 'workspace.sqlite'), { readonly: true });
    try { expect(original.pragma('user_version', { simple: true })).toBe(99); expect(new DocumentStore(original).get('project', 'p')).toEqual({ title: '新版本项目' }); } finally { original.close(); }
  });
});
