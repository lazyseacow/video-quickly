import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrateDatabase, type DatabaseMigration } from './migrations.js';
import type { ProjectDocument, Shot } from '@video-quickly/contracts';
import { clipEditSource, resolveShotTime } from '@video-quickly/video/clip-edits';
import { projectCaptionCues } from '@video-quickly/video';

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

const summaryBody = (body: string) => `json_object(
  'id', json_extract(${body}, '$.id'), 'title', json_extract(${body}, '$.title'), 'brief', json_extract(${body}, '$.brief'),
  'templateId', json_extract(${body}, '$.templateId'), 'revision', json_extract(${body}, '$.revision'), 'profile', json_extract(${body}, '$.profile'),
  'createdAt', json_extract(${body}, '$.createdAt'), 'updatedAt', json_extract(${body}, '$.updatedAt'), 'archived', json(CASE WHEN json_extract(${body}, '$.archived') = 1 THEN 'true' ELSE 'false' END),
  'shotCount', coalesce(json_array_length(${body}, '$.shots'), 0), 'durationUs', coalesce((SELECT sum(json_extract(value, '$.durationUs')) FROM json_each(${body}, '$.shots')), 0),
  'workflowNodeCount', coalesce(json_array_length(${body}, '$.workflow.nodes'), 0), 'thumbnailShot', json_extract(${body}, '$.shots[0]')
)`;

const READ_MODEL_SCHEMA = `
  CREATE TABLE project_asset_references (project_id TEXT NOT NULL, asset_id TEXT NOT NULL, PRIMARY KEY(project_id, asset_id));
  CREATE INDEX project_asset_references_asset ON project_asset_references(asset_id);
  INSERT OR IGNORE INTO project_asset_references(project_id, asset_id)
    SELECT documents.id, field.value FROM documents, json_each(documents.body, '$.shots') shot, json_each(shot.value) field
    WHERE documents.kind = 'project' AND field.key IN ('assetId', 'audioAssetId', 'videoAssetId') AND field.type = 'text';
  INSERT OR REPLACE INTO documents(kind, id, body) SELECT 'project-summary', id, ${summaryBody('body')} FROM documents WHERE kind = 'project' ORDER BY rowid;
  CREATE TRIGGER project_summary_insert AFTER INSERT ON documents WHEN new.kind = 'project' BEGIN
    INSERT INTO documents(kind, id, body) VALUES ('project-summary', new.id, ${summaryBody('new.body')}) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body;
    INSERT OR IGNORE INTO project_asset_references(project_id, asset_id)
      SELECT new.id, field.value FROM json_each(new.body, '$.shots') shot, json_each(shot.value) field
      WHERE field.key IN ('assetId', 'audioAssetId', 'videoAssetId') AND field.type = 'text';
  END;
  CREATE TRIGGER project_summary_update AFTER UPDATE OF body ON documents WHEN new.kind = 'project' BEGIN
    INSERT INTO documents(kind, id, body) VALUES ('project-summary', new.id, ${summaryBody('new.body')}) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body;
    DELETE FROM project_asset_references WHERE project_id = new.id;
    INSERT OR IGNORE INTO project_asset_references(project_id, asset_id)
      SELECT new.id, field.value FROM json_each(new.body, '$.shots') shot, json_each(shot.value) field
      WHERE field.key IN ('assetId', 'audioAssetId', 'videoAssetId') AND field.type = 'text';
  END;
  CREATE TRIGGER project_summary_delete AFTER DELETE ON documents WHEN old.kind = 'project' BEGIN
    DELETE FROM documents WHERE kind = 'project-summary' AND id = old.id;
    DELETE FROM project_asset_references WHERE project_id = old.id;
  END;
  INSERT INTO runtime_metadata(key, value) VALUES ('assets-version', '0');
  CREATE TRIGGER asset_version_insert AFTER INSERT ON documents WHEN new.kind = 'asset' BEGIN
    UPDATE runtime_metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'assets-version';
  END;
  CREATE TRIGGER asset_version_update AFTER UPDATE OF body ON documents WHEN new.kind = 'asset' BEGIN
    UPDATE runtime_metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'assets-version';
  END;
  CREATE TRIGGER asset_version_delete AFTER DELETE ON documents WHEN old.kind = 'asset' BEGIN
    UPDATE runtime_metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'assets-version';
  END;
  CREATE INDEX documents_project ON documents(kind, json_extract(body, '$.projectId')) WHERE kind IN ('run', 'asset');
`;

const audioReferences = (body: string) => `
  SELECT json_extract(value, '$.assetId') FROM json_each(${body}, '$.musicClips') WHERE json_type(value, '$.assetId') = 'text'
  UNION SELECT json_extract(value, '$.captionTrack.sourceAssetId') FROM json_each(${body}, '$.shots') WHERE json_type(value, '$.captionTrack.sourceAssetId') = 'text'
`;
const allReferences = (body: string) => `
  SELECT field.value FROM json_each(${body}, '$.shots') shot, json_each(shot.value) field
  WHERE field.key IN ('assetId', 'audioAssetId', 'videoAssetId') AND field.type = 'text'
  UNION ${audioReferences(body)}
`;
const AUDIO_REFERENCE_SCHEMA = `
  DROP TRIGGER project_summary_insert;
  DROP TRIGGER project_summary_update;
  CREATE TRIGGER project_summary_insert AFTER INSERT ON documents WHEN new.kind = 'project' BEGIN
    INSERT INTO documents(kind, id, body) VALUES ('project-summary', new.id, ${summaryBody('new.body')}) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body;
    INSERT OR IGNORE INTO project_asset_references(project_id, asset_id) SELECT new.id, refs.value FROM (${allReferences('new.body')}) AS refs;
  END;
  CREATE TRIGGER project_summary_update AFTER UPDATE OF body ON documents WHEN new.kind = 'project' BEGIN
    INSERT INTO documents(kind, id, body) VALUES ('project-summary', new.id, ${summaryBody('new.body')}) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body;
    DELETE FROM project_asset_references WHERE project_id = new.id;
    INSERT OR IGNORE INTO project_asset_references(project_id, asset_id) SELECT new.id, refs.value FROM (${allReferences('new.body')}) AS refs;
  END;
  INSERT OR IGNORE INTO project_asset_references(project_id, asset_id)
    SELECT documents.id, json_extract(clip.value, '$.assetId') FROM documents, json_each(documents.body, '$.musicClips') clip
    WHERE documents.kind = 'project' AND json_type(clip.value, '$.assetId') = 'text';
  INSERT OR IGNORE INTO project_asset_references(project_id, asset_id)
    SELECT documents.id, json_extract(shot.value, '$.captionTrack.sourceAssetId') FROM documents, json_each(documents.body, '$.shots') shot
    WHERE documents.kind = 'project' AND json_type(shot.value, '$.captionTrack.sourceAssetId') = 'text';
`;

// Leave the v3/v4 SQL unchanged: v5 adds the lightweight inherited thumbnail style.
const captionSummaryBody = (body: string) => `json_set(${summaryBody(body)}, '$.captionStyle', json_extract(${body}, '$.captionStyle'))`;
const CAPTION_SUMMARY_SCHEMA = `
  DROP TRIGGER project_summary_insert;
  DROP TRIGGER project_summary_update;
  CREATE TRIGGER project_summary_insert AFTER INSERT ON documents WHEN new.kind = 'project' BEGIN
    INSERT INTO documents(kind, id, body) VALUES ('project-summary', new.id, ${captionSummaryBody('new.body')}) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body;
    INSERT OR IGNORE INTO project_asset_references(project_id, asset_id) SELECT new.id, refs.value FROM (${allReferences('new.body')}) AS refs;
  END;
  CREATE TRIGGER project_summary_update AFTER UPDATE OF body ON documents WHEN new.kind = 'project' BEGIN
    INSERT INTO documents(kind, id, body) VALUES ('project-summary', new.id, ${captionSummaryBody('new.body')}) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body;
    DELETE FROM project_asset_references WHERE project_id = new.id;
    INSERT OR IGNORE INTO project_asset_references(project_id, asset_id) SELECT new.id, refs.value FROM (${allReferences('new.body')}) AS refs;
  END;
  INSERT INTO documents(kind, id, body) SELECT 'project-summary', id, ${captionSummaryBody('body')} FROM documents WHERE kind = 'project' ORDER BY rowid
    ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body;
`;

const clipReferences = (body: string) => `
  SELECT json_extract(source.value, '$.original.assetId') FROM json_each(${body}, '$.clipEditSources') source WHERE json_type(source.value, '$.original.assetId') = 'text'
  UNION SELECT json_extract(source.value, '$.original.audioAssetId') FROM json_each(${body}, '$.clipEditSources') source WHERE json_type(source.value, '$.original.audioAssetId') = 'text'
  UNION SELECT json_extract(source.value, '$.original.videoAssetId') FROM json_each(${body}, '$.clipEditSources') source WHERE json_type(source.value, '$.original.videoAssetId') = 'text'
  UNION SELECT json_extract(source.value, '$.original.captionTrack.sourceAssetId') FROM json_each(${body}, '$.clipEditSources') source WHERE json_type(source.value, '$.original.captionTrack.sourceAssetId') = 'text'
  UNION SELECT json_extract(hash.value, '$.assetId') FROM json_each(${body}, '$.clipEditSources') source, json_each(source.value, '$.assetHashes') hash WHERE json_type(hash.value, '$.assetId') = 'text'
`;
const clipSummaryBody = (body: string) => `json_set(${captionSummaryBody(body)}, '$.thumbnailShot', json(vq_thumbnail(${body})))`;
const CLIP_EDIT_SCHEMA = `
  DROP TRIGGER project_summary_insert;
  DROP TRIGGER project_summary_update;
  CREATE TRIGGER project_summary_insert AFTER INSERT ON documents WHEN new.kind = 'project' BEGIN
    INSERT INTO documents(kind, id, body) VALUES ('project-summary', new.id, ${clipSummaryBody('new.body')}) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body;
    INSERT OR IGNORE INTO project_asset_references(project_id, asset_id) SELECT new.id, refs.value FROM (${allReferences('new.body')} UNION ${clipReferences('new.body')}) AS refs;
  END;
  CREATE TRIGGER project_summary_update AFTER UPDATE OF body ON documents WHEN new.kind = 'project' BEGIN
    INSERT INTO documents(kind, id, body) VALUES ('project-summary', new.id, ${clipSummaryBody('new.body')}) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body;
    DELETE FROM project_asset_references WHERE project_id = new.id;
    INSERT OR IGNORE INTO project_asset_references(project_id, asset_id) SELECT new.id, refs.value FROM (${allReferences('new.body')} UNION ${clipReferences('new.body')}) AS refs;
  END;
  UPDATE documents SET body = body WHERE kind = 'project';
`;

/** Project writes maintain a small first-frame projection inside the same SQLite transaction. */
export function thumbnailShot(value: ProjectDocument): Shot | null {
  const shot = value.shots?.[0];
  if (!shot) return null;
  const mapped = resolveShotTime(shot, value, 0), original = clipEditSource(shot, value)?.original;
  const cue = projectCaptionCues(shot, 0, undefined, value).find(cue => cue.startUs <= 0 && cue.endUs > 0);
  return { ...shot, clipEdit: undefined, audioProcessing: undefined, sourceInUs: mapped.sourceUs, audioInUs: mapped.audioUs, videoInUs: mapped.videoUs, sceneInUs: mapped.sceneUs,
    sceneIndex: shot.sceneIndex ?? original?.sceneIndex, sceneDurationUs: shot.sceneDurationUs ?? original?.sceneDurationUs ?? original?.durationUs ?? shot.durationUs,
    captionTrack: { timeBase: 'scene', alignment: 'manual', cues: cue ? [{ ...cue, startUs: mapped.sceneUs, endUs: mapped.sceneUs + cue.endUs }] : [] } };
}

export const WORKSPACE_MIGRATIONS: readonly DatabaseMigration[] = [
  { version: 1, name: 'workspace-baseline', sql: INITIAL_SCHEMA },
  { version: 2, name: 'execution-event-index', sql: 'CREATE INDEX execution_events_run_sequence ON execution_events(run_id, sequence);' },
  { version: 3, name: 'workspace-read-models', sql: READ_MODEL_SCHEMA },
  { version: 4, name: 'audio-asset-references', sql: AUDIO_REFERENCE_SCHEMA },
  { version: 5, name: 'project-summary-caption-style', sql: CAPTION_SUMMARY_SCHEMA },
  { version: 6, name: 'clip-edit-references-and-first-frame', sql: CLIP_EDIT_SCHEMA },
  // Older clients strip unknown project fields. Advance the workspace version
  // before storing these capabilities so opening it with such a client fails.
  { version: 7, name: 'workflow-composition-and-keyframe-capabilities', sql: `INSERT INTO runtime_metadata(key, value) VALUES ('document-capabilities', '["keyframes-v1","workflow-composition-v1","media-concurrency-v1"]') ON CONFLICT(key) DO UPDATE SET value = excluded.value;` },
];

export function openDatabase(directory: string) {
  mkdirSync(directory, { recursive: true });
  const database = new Database(join(directory, 'workspace.sqlite'));
  try {
    database.pragma('busy_timeout = 5000');
    database.pragma('foreign_keys = ON');
    database.pragma('synchronous = FULL');
    database.function('vq_thumbnail', { deterministic: true }, (body: unknown) => {
      if (typeof body !== 'string') throw new TypeError('项目投影需要JSON正文。');
      return JSON.stringify(thumbnailShot(JSON.parse(body) as ProjectDocument));
    });
    migrateDatabase(database, directory, WORKSPACE_MIGRATIONS);
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
