import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_SCHEMA, openDatabase, DocumentStore, WORKSPACE_MIGRATIONS, thumbnailShot } from '../src/database.js';
import { DatabaseMigrationError, migrateDatabase } from '../src/migrations.js';
import { createNativeVideoWorkflow, DEFAULT_CAPTION_STYLE, DEFAULT_VIDEO_PROFILE, projectDetailSchema, projectSchema, projectSummarySchema } from '@video-quickly/contracts';
import { createReadModels } from '../src/read-models.js';

const directories: string[] = [];
const currentVersion = WORKSPACE_MIGRATIONS.at(-1)?.version;
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'vq-migration-')); directories.push(path); return path; }

describe('workspace database upgrades', () => {
  it('opens a v19 project saved with the previous built-in production workflow', async () => {
    const path = await directory(), previous = new Database(join(path, 'workspace.sqlite'));
    previous.function('vq_thumbnail', { deterministic: true }, body => JSON.stringify(thumbnailShot(JSON.parse(String(body)))));
    migrateDatabase(previous, path, WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 19));
    const native = createNativeVideoWorkflow();
    const project = projectSchema.parse({ id: 'old-project', title: '旧项目', brief: '保留创意简报', revision: 8, profile: DEFAULT_VIDEO_PROFILE, workflow: native,
      shots: [{ id: 'shot', title: '旧镜头', narration: '保留旁白', visualPrompt: '', durationUs: 2_000_000, audioAssetId: 'recorded-audio' }], createdAt: '', updatedAt: '' });
    const nodes = ['brief', 'style', 'script', 'assets', 'voice', 'animation', 'export'].map((id, index) => ({
      id, kind: id, label: id, prompt: id === 'script' ? '保留用户的分镜要求' : '', modelId: id === 'script' ? 'saved-text' : id === 'voice' ? 'retired-tts' : undefined,
      position: { x: index * 270, y: 100 }, requiresReview: id === 'script',
    }));
    const legacy = { ...project, workflow: { id: 'history-handdrawn', version: 6, name: '历史手绘科普', nodes,
      edges: nodes.slice(1).map((node, index) => ({ id: `${nodes[index].id}-${node.id}`, source: nodes[index].id, target: node.id })) } };
    const store = new DocumentStore(previous);
    store.put('project', legacy.id, legacy);
    store.put('project', 'current', { ...project, id: 'current' });
    store.put('run-snapshot', 'old-run', { project: legacy, nodes: [nodes[2]], handlerVersion: 1 });
    const originalSnapshot = store.get('run-snapshot', 'old-run');
    previous.close();

    const upgraded = openDatabase(path);
    try {
      const documents = new DocumentStore(upgraded);
      const detail = projectDetailSchema.parse(createReadModels(upgraded, documents).projectDetail(project.id));
      expect(detail.project).toMatchObject({ ...project, revision: 9, workflow: { id: native.id, version: 7, production: { mode: 'native-video', subtitleMode: 'script' } } });
      expect(detail.project?.workflow.stages).toEqual(native.stages);
      expect(detail.project?.workflow.nodes.map(node => node.id)).toEqual(native.nodes.map(node => node.id));
      expect(detail.project?.workflow.nodes.find(node => node.id === 'script')).toMatchObject({ prompt: '保留用户的分镜要求', modelId: 'saved-text', requiresReview: false, config: { modelOverride: true } });
      expect(detail.project?.workflow.nodes.find(node => node.id === 'video')?.modelId).toBeUndefined();
      expect(documents.get('project', 'current')).toEqual({ ...project, id: 'current' });
      expect(documents.get('run-snapshot', 'old-run')).toEqual(originalSnapshot);
      expect(upgraded.prepare('SELECT asset_id FROM project_asset_references WHERE project_id = ?').all(project.id)).toEqual([{ asset_id: 'recorded-audio' }]);
    } finally { upgraded.close(); }
    const backups = await readdir(join(path, 'database-backups'));
    expect(backups).toHaveLength(1);
    const backup = new Database(join(path, 'database-backups', backups[0]), { readonly: true });
    try {
      expect(backup.pragma('user_version', { simple: true })).toBe(19);
      expect(new DocumentStore(backup).get('project', project.id)).toEqual(JSON.parse(JSON.stringify(legacy)));
    } finally { backup.close(); }
  });

  it('protects confirmed text rejections without guessing the outcome of old submitted receipts', async () => {
    const path = await directory(), previous = new Database(join(path, 'workspace.sqlite'));
    previous.function('vq_thumbnail', { deterministic: true }, body => JSON.stringify(thumbnailShot(JSON.parse(String(body)))));
    const legacy = WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 17);
    migrateDatabase(previous, path, legacy);
    new DocumentStore(previous).put('model-response', 'run:script:1', { attempt: 1, inputHash: 'fixed', status: 'submitted', submittedAt: 'original-time' });
    previous.prepare("INSERT INTO activities(run_id, activity_id, input_hash, safety, status, remote_id, started_at) VALUES ('run', 'script', 'fixed', 'external', 'unknown', 'model-response:run:script:1', 'original-time')").run();
    const rows = previous.prepare('SELECT * FROM activities').all(); previous.close();
    const upgraded = openDatabase(path);
    try {
      expect(upgraded.prepare('SELECT * FROM activities').all()).toEqual(rows);
      expect(new DocumentStore(upgraded).get('model-response', 'run:script:1')).toMatchObject({ status: 'submitted' });
      expect(upgraded.prepare("SELECT value FROM runtime_metadata WHERE key = 'text-request-rejections'").get()).toEqual({ value: '1' });
      expect(upgraded.prepare("SELECT value FROM runtime_metadata WHERE key = 'media-request-rejections'").get()).toEqual({ value: '1' });
      expect(() => migrateDatabase(upgraded, path, WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 18))).toThrow('高于此客户端支持的版本');
      expect(() => migrateDatabase(upgraded, path, legacy)).toThrow('高于此客户端支持的版本');
    } finally { upgraded.close(); }
  });
  it('preserves existing execution records and rejects clients without text response receipt recovery', async () => {
    const path = await directory(), previous = new Database(join(path, 'workspace.sqlite'));
    previous.function('vq_thumbnail', { deterministic: true }, body => JSON.stringify(thumbnailShot(JSON.parse(String(body)))));
    const legacy = WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 16);
    migrateDatabase(previous, path, legacy);
    new DocumentStore(previous).put('run-snapshot', 'script-run', { handlerVersion: 3, nodes: [{ id: 'script' }] });
    previous.prepare("INSERT INTO activities(run_id, activity_id, input_hash, safety, status, remote_id, started_at) VALUES ('script-run', 'script', 'fixed-hash', 'external', 'unknown', NULL, 'original-time')").run();
    const records = previous.prepare('SELECT * FROM activities').all(); previous.close();
    const upgraded = openDatabase(path);
    try {
      expect(upgraded.prepare('SELECT * FROM activities').all()).toEqual(records);
      expect(new DocumentStore(upgraded).get('run-snapshot', 'script-run')).toEqual({ handlerVersion: 3, nodes: [{ id: 'script' }] });
      expect(upgraded.prepare("SELECT value FROM runtime_metadata WHERE key = 'script-response-receipts'").get()).toEqual({ value: '1' });
      expect(() => migrateDatabase(upgraded, path, legacy)).toThrow('高于此客户端支持的版本');
    } finally { upgraded.close(); }
  });
  it('preserves v15 execution data and prevents older schedulers from consuming single-step retry checkpoints', async () => {
    const path = await directory(), previous = new Database(join(path, 'workspace.sqlite'));
    previous.function('vq_thumbnail', { deterministic: true }, body => JSON.stringify(thumbnailShot(JSON.parse(String(body)))));
    const legacy = WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 15);
    migrateDatabase(previous, path, legacy);
    const store = new DocumentStore(previous);
    store.put('run', 'frozen-run', { id: 'frozen-run', status: 'failed', currentNodeId: 'assets' });
    store.put('run-snapshot', 'frozen-run', { handlerVersion: 3, nodes: [{ id: 'assets' }], project: { id: 'project' } });
    store.put('node-project', 'frozen-run:assets', { brief: '本次生成的上游简报' });
    store.put('node-result', 'frozen-run:brief', { text: '本次生成的上游简报' });
    previous.exec("CREATE TABLE checkpoints (thread_id TEXT PRIMARY KEY, checkpoint BLOB); INSERT INTO checkpoints VALUES ('frozen-run', X'010203');");
    const documents = previous.prepare('SELECT rowid, kind, id, body FROM documents ORDER BY rowid').all(); previous.close();
    const upgraded = openDatabase(path);
    try {
      expect(upgraded.pragma('user_version', { simple: true })).toBe(currentVersion);
      expect(upgraded.prepare("SELECT value FROM runtime_metadata WHERE key = 'single-step-retry'").get()).toEqual({ value: '1' });
      expect(upgraded.prepare('SELECT rowid, kind, id, body FROM documents ORDER BY rowid').all()).toEqual(documents);
      expect(upgraded.prepare('SELECT hex(checkpoint) AS data FROM checkpoints').get()).toEqual({ data: '010203' });
      expect(() => migrateDatabase(upgraded, path, legacy)).toThrow('高于此客户端支持的版本');
    } finally { upgraded.close(); }
    expect((await readdir(join(path, 'database-backups'))).some(name => name.startsWith(`workspace-v15-to-v${currentVersion}-`))).toBe(true);
  });

  it('upgrades a v13 workspace, retains old snapshots and projects, and projects unique episode memberships', async () => {
    const path = await directory(), legacy = new Database(join(path, 'workspace.sqlite'));
    legacy.function('vq_thumbnail', { deterministic: true }, (body: unknown) => JSON.stringify(thumbnailShot(JSON.parse(String(body)))));
    const previousMigrations = WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 13);
    migrateDatabase(legacy, path, previousMigrations);
    const project = projectSchema.parse({ id: 'pre-work-project', revision: 1, title: '已有独立项目', brief: '', profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(), shots: [], createdAt: '', updatedAt: '' });
    new DocumentStore(legacy).put('project', project.id, project);
    new DocumentStore(legacy).put('run-snapshot', 'preserved-prompt-trial', { project, trial: { preview: { prompt: '固定的旧提示词' } } }); legacy.close();
    const upgraded = openDatabase(path), store = new DocumentStore(upgraded);
    try {
      expect(upgraded.prepare("SELECT value FROM runtime_metadata WHERE key = 'work-production'").get()).toEqual({ value: '1' });
      expect(store.get('project', project.id)).toEqual(project);
      expect(store.get('run-snapshot', 'preserved-prompt-trial')).toMatchObject({ trial: { preview: { prompt: '固定的旧提示词' } } });
      const member = { ...project, episode: { workId: 'work-fixture', number: 1, originalText: '原始文案' } };
      store.put('project', project.id, member);
      expect(projectSummarySchema.parse(store.get('project-summary', project.id)).episode).toEqual(member.episode);
      expect(() => store.put('project', 'duplicate-episode', { ...member, id: 'duplicate-episode' })).toThrow('UNIQUE');
      expect(() => migrateDatabase(upgraded, path, previousMigrations)).toThrow(DatabaseMigrationError);
    } finally { upgraded.close(); }
  });
  it('upgrades production workspaces before creative fields can be stored and rejects reopening with older parsers', async () => {
    const path = await directory(), previous = new Database(join(path, 'workspace.sqlite'));
    previous.function('vq_thumbnail', { deterministic: true }, (body: unknown) => {
      if (typeof body !== 'string') throw new Error('Expected a project document');
      return JSON.stringify(thumbnailShot(JSON.parse(body)));
    });
    const legacy = WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 11);
    migrateDatabase(previous, path, legacy);
    const snapshot = { project: { id: 'frozen', shots: [] }, characters: [], characterAssets: [] };
    new DocumentStore(previous).put('run-snapshot', 'old-run', snapshot); previous.close();
    const upgraded = openDatabase(path);
    try {
      expect(new DocumentStore(upgraded).get('run-snapshot', 'old-run')).toEqual(snapshot);
      expect(upgraded.prepare("SELECT value FROM runtime_metadata WHERE key = 'creative-context'").get()).toEqual({ value: '1' });
      expect(upgraded.prepare("SELECT value FROM runtime_metadata WHERE key = 'prompt-workbench'").get()).toEqual({ value: '1' });
      expect(() => migrateDatabase(upgraded, path, legacy)).toThrow('高于此客户端支持的版本');
    } finally { upgraded.close(); }
  });

  it('adds the active-run index to v7 without changing documents, rowids or checkpoints', async () => {
    const path = await directory(), previous = new Database(join(path, 'workspace.sqlite'));
    previous.function('vq_thumbnail', { deterministic: true }, body => {
      if (typeof body !== 'string') throw new Error('Expected a project document');
      return JSON.stringify(thumbnailShot(JSON.parse(body)));
    });
    migrateDatabase(previous, path, WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 7));
    const store = new DocumentStore(previous);
    const project = projectSchema.parse({ id: 'v7-project', title: '保留现有项目', brief: '', revision: 4, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(), shots: [], createdAt: '', updatedAt: '' });
    store.put('project', project.id, project);
    store.put('model', 'saved-connection', { id: 'saved-connection', credentialRef: 'opaque-reference' });
    store.put('asset', 'saved-asset', { id: 'saved-asset', projectId: project.id, path: '/isolated-fixture/keep.svg' });
    store.put('run', 'active-run', { id: 'active-run', projectId: project.id, status: 'waiting_review' });
    store.put('run', 'completed-run', { id: 'completed-run', projectId: project.id, status: 'succeeded' });
    previous.exec("CREATE TABLE checkpoints (thread_id TEXT PRIMARY KEY, checkpoint BLOB); INSERT INTO checkpoints VALUES ('active-run', X'010203');");
    const documents = previous.prepare('SELECT rowid, kind, id, body FROM documents ORDER BY rowid').all();
    previous.close();
    const upgraded = openDatabase(path);
    try {
      expect(upgraded.pragma('user_version', { simple: true })).toBe(currentVersion);
      expect(upgraded.prepare('SELECT rowid, kind, id, body FROM documents ORDER BY rowid').all()).toEqual(documents);
      expect(upgraded.prepare('SELECT hex(checkpoint) AS data FROM checkpoints').get()).toEqual({ data: '010203' });
      expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'documents_active_project_runs'").get()).toEqual({ name: 'documents_active_project_runs' });
      expect(upgraded.prepare("SELECT id FROM documents INDEXED BY documents_active_project_runs WHERE kind = 'run' AND json_extract(body, '$.status') IN ('queued','running','waiting_review','waiting_external','retry_scheduled') AND json_extract(body, '$.projectId') = ? ORDER BY rowid DESC").all(project.id)).toEqual([{ id: 'active-run' }]);
    } finally { upgraded.close(); }
    const backups = await readdir(join(path, 'database-backups')); expect(backups).toHaveLength(1);
    const backup = new Database(join(path, 'database-backups', backups[0]), { readonly: true });
    try {
      expect(backup.pragma('user_version', { simple: true })).toBe(7);
      expect(backup.prepare('SELECT rowid, kind, id, body FROM documents ORDER BY rowid').all()).toEqual(documents);
      expect(backup.prepare('SELECT hex(checkpoint) AS data FROM checkpoints').get()).toEqual({ data: '010203' });
    } finally { backup.close(); }
    openDatabase(path).close(); expect(await readdir(join(path, 'database-backups'))).toHaveLength(1);
  });

  it('upgrades the actual v6 schema and prevents older clients from dropping new document capabilities', async () => {
    const path = await directory(), previous = new Database(join(path, 'workspace.sqlite'));
    previous.function('vq_thumbnail', { deterministic: true }, body => {
      if (typeof body !== 'string') throw new Error('Expected a project document');
      return JSON.stringify(thumbnailShot(JSON.parse(body)));
    });
    migrateDatabase(previous, path, WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 6));
    const project = projectSchema.parse({ id: 'v6-project', title: '升级前的项目', brief: '', revision: 3, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(), shots: [], createdAt: '', updatedAt: '' });
    const store = new DocumentStore(previous); store.put('project', project.id, project);
    store.put('model', 'connection', { id: 'connection', credentialRef: 'opaque-reference' });
    previous.exec("CREATE TABLE checkpoints (thread_id TEXT PRIMARY KEY, checkpoint BLOB); INSERT INTO checkpoints VALUES ('original-run', X'010203');");
    previous.close();
    const upgraded = openDatabase(path);
    try {
      expect(upgraded.pragma('user_version', { simple: true })).toBe(currentVersion);
      expect(new DocumentStore(upgraded).get('project', project.id)).toEqual(project);
      expect(new DocumentStore(upgraded).get('model', 'connection')).toEqual({ id: 'connection', credentialRef: 'opaque-reference' });
      expect(upgraded.prepare('SELECT hex(checkpoint) AS value FROM checkpoints').get()).toEqual({ value: '010203' });
      expect(() => migrateDatabase(upgraded, path, WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 6))).toThrow('高于此客户端支持的版本');
      expect(upgraded.pragma('user_version', { simple: true })).toBe(currentVersion);
    } finally { upgraded.close(); }
    const backups = await readdir(join(path, 'database-backups')); expect(backups).toHaveLength(1);
    const backup = new Database(join(path, 'database-backups', backups[0]), { readonly: true });
    try { expect(backup.pragma('user_version', { simple: true })).toBe(6); expect(new DocumentStore(backup).get('project', project.id)).toEqual(project); } finally { backup.close(); }
  });

  it('creates a versioned database and does not back up on every reopen', async () => {
    const path = await directory(); const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(currentVersion);
    expect(db.prepare('SELECT name FROM schema_migrations ORDER BY version').all()).toEqual([{ name: 'workspace-baseline' }, { name: 'execution-event-index' }, { name: 'workspace-read-models' }, { name: 'audio-asset-references' }, { name: 'project-summary-caption-style' }, { name: 'clip-edit-references-and-first-frame' }, { name: 'workflow-composition-and-keyframe-capabilities' }, { name: 'active-project-runs-index' }, { name: 'workflow-layout' }, { name: 'native-video-production' }, { name: 'production-reference-audio' }, { name: 'project-creative-context' }, { name: 'prompt-workbench' }, { name: 'work-episodes-production-queue' }, { name: 'creative-reference-images-and-media-derivations' }, { name: 'single-step-retry-checkpoints' }, { name: 'script-response-receipts' }, { name: 'text-request-rejection-receipts' }, { name: 'media-request-rejection-receipts' }, { name: 'legacy-project-production-workflows' }, { name: 'asset-read-indexes' }, { name: 'manual-planning-inputs' }, { name: 'structured-planning-prefill' }]);
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
    const project = projectSchema.parse({ id: 'legacy', title: '旧项目', brief: '', revision: 7, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(), createdAt: '', updatedAt: '', shots: [{ id: 's', title: '旧镜头', narration: '', visualPrompt: '', durationUs: 2_000_000, assetId: 'used-image', audioAssetId: 'used-audio', captionTrack: { timeBase: 'source', alignment: 'manual', sourceAssetId: 'caption-origin-audio', cues: [] } }], musicClips: [{ id: 'legacy-music', assetId: 'used-music', durationUs: 2_000_000 }] });
    new DocumentStore(db).put('project', project.id, project); db.close();
    const upgraded = openDatabase(path);
    try {
      expect(new DocumentStore(upgraded).get('project', project.id)).toEqual(project);
      expect(new DocumentStore(upgraded).get('project-summary', project.id)).toMatchObject({ id: 'legacy', shotCount: 1, durationUs: 2_000_000, revision: 7, archived: false });
      expect(upgraded.prepare('SELECT asset_id FROM project_asset_references ORDER BY asset_id').all()).toEqual([{ asset_id: 'caption-origin-audio' }, { asset_id: 'used-audio' }, { asset_id: 'used-image' }, { asset_id: 'used-music' }]);
      expect(upgraded.pragma('user_version', { simple: true })).toBe(currentVersion);
    } finally { upgraded.close(); }
    expect(await readdir(join(path, 'database-backups'))).toHaveLength(1);
  });

  it('upgrades legacy v3 read models that predate the asset reference table', async () => {
    const path = await directory(), previous = new Database(join(path, 'workspace.sqlite'));
    migrateDatabase(previous, path, WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 3));
    const project = projectSchema.parse({ id: 'legacy-v3', title: '保留旧版项目', brief: '', revision: 4, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(), createdAt: '', updatedAt: '', shots: [{ id: 'shot', title: '镜头', narration: '', visualPrompt: '', durationUs: 2_000_000, assetId: 'image', audioAssetId: 'audio', videoAssetId: 'video', captionTrack: { timeBase: 'source', alignment: 'manual', sourceAssetId: 'caption-audio', cues: [] } }], musicClips: [{ id: 'music', assetId: 'music-audio', durationUs: 2_000_000 }] });
    const oldStore = new DocumentStore(previous); oldStore.put('project', project.id, project);
    oldStore.put('run', 'review', { status: 'waiting_review' }); oldStore.put('model', 'connection', { credentialRef: 'reference-only' });
    // The original v3 only maintained summaries. Its version and migration
    // history match later v3 databases, but there was no reference projection.
    previous.exec(`
      DROP TRIGGER project_summary_insert;
      DROP TRIGGER project_summary_update;
      DROP TRIGGER project_summary_delete;
      DROP TABLE project_asset_references;
      CREATE TRIGGER project_summary_insert AFTER INSERT ON documents WHEN new.kind = 'project' BEGIN
        INSERT OR REPLACE INTO documents(kind, id, body) VALUES ('project-summary', new.id, new.body);
      END;
      CREATE TRIGGER project_summary_update AFTER UPDATE OF body ON documents WHEN new.kind = 'project' BEGIN
        INSERT OR REPLACE INTO documents(kind, id, body) VALUES ('project-summary', new.id, new.body);
      END;
      CREATE TRIGGER project_summary_delete AFTER DELETE ON documents WHEN old.kind = 'project' BEGIN
        DELETE FROM documents WHERE kind = 'project-summary' AND id = old.id;
      END;
      CREATE TABLE checkpoints (thread_id TEXT PRIMARY KEY, checkpoint BLOB);
      INSERT INTO checkpoints VALUES ('review', X'010203');
    `);
    previous.close();
    const upgraded = openDatabase(path), store = new DocumentStore(upgraded);
    try {
      expect(upgraded.pragma('user_version', { simple: true })).toBe(currentVersion);
      expect(store.get('project', project.id)).toEqual(project);
      expect(store.get('run', 'review')).toEqual({ status: 'waiting_review' });
      expect(store.get('model', 'connection')).toEqual({ credentialRef: 'reference-only' });
      expect(upgraded.prepare('SELECT hex(checkpoint) AS value FROM checkpoints').get()).toEqual({ value: '010203' });
      expect(store.get('project-summary', project.id)).toMatchObject({ id: project.id, revision: 4, shotCount: 1 });
      expect(upgraded.prepare('SELECT asset_id FROM project_asset_references ORDER BY asset_id').all()).toEqual(['audio', 'caption-audio', 'image', 'music-audio', 'video'].map(asset_id => ({ asset_id })));
      store.put('project', project.id, { ...project, revision: 5, shots: [], musicClips: [] });
      expect(upgraded.prepare('SELECT * FROM project_asset_references').all()).toEqual([]);
      store.put('project', project.id, project); store.delete('project', project.id);
      expect(store.get('project-summary', project.id)).toBeUndefined();
      expect(upgraded.prepare('SELECT * FROM project_asset_references').all()).toEqual([]);
    } finally { upgraded.close(); }
    const backups = await readdir(join(path, 'database-backups')); expect(backups).toHaveLength(1);
    const backup = new Database(join(path, 'database-backups', backups[0]), { readonly: true });
    try {
      expect(backup.pragma('user_version', { simple: true })).toBe(3);
      expect(new DocumentStore(backup).get('project', project.id)).toEqual(project);
      expect(backup.prepare("SELECT 1 FROM sqlite_master WHERE name = 'project_asset_references'").get()).toBeUndefined();
    } finally { backup.close(); }
    openDatabase(path).close(); expect(await readdir(join(path, 'database-backups'))).toHaveLength(1);
  });

  it('upgrades actual v4 summaries without changing projects, assets, audio references or review checkpoints', async () => {
    const path = await directory(), previous = new Database(join(path, 'workspace.sqlite'));
    migrateDatabase(previous, path, WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 4));
    const oldStore = new DocumentStore(previous), content = '资料正文不得进入后台摘要。'.repeat(2_000);
    const project = projectSchema.parse({ id: 'styled-v4', title: '旧版样式项目', brief: '', revision: 7, profile: DEFAULT_VIDEO_PROFILE, captionStyle: { ...DEFAULT_CAPTION_STYLE, fontId: 'serif', position: 'top' }, workflow: createNativeVideoWorkflow(), createdAt: '', updatedAt: '', researchSources: [{ id: 'source', title: '资料标题', kind: 'text', content, sha256: createHash('sha256').update(content).digest('hex'), capturedAt: '2026-10-30T00:00:00.000Z' }], claims: [{ id: 'claim', text: '主张全文不得出现在摘要中', source: '资料标题', status: 'pending' }], shots: [{ id: 'shot', title: '旧镜头', narration: '', visualPrompt: '', durationUs: 2_000_000, assetId: 'used-image', audioAssetId: 'used-audio', claimIds: ['claim'], captionTrack: { timeBase: 'source', alignment: 'manual', sourceAssetId: 'caption-origin-audio', cues: [] } }], musicClips: [{ id: 'music', assetId: 'used-music', durationUs: 2_000_000 }] });
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
      expect(upgraded.pragma('user_version', { simple: true })).toBe(currentVersion); expect(store.get('project', project.id)).toEqual(project); expect(store.get('run', run.id)).toEqual(run); expect(store.list('asset')).toEqual(assets);
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
