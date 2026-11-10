import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { migrateDatabase, type DatabaseMigration } from './migrations.js';
import { clipEditSource, resolveShotTime } from '@video-quickly/video/clip-edits';
import { projectCaptionCues } from '@video-quickly/video';
import { captionsEnabled, createNativeVideoWorkflow, nodeKindSchema, productionSettingsSchema, projectSchema, resolveProductionWorkflow, workflowNodeSchema, workflowSchema, type ProjectDocument, type Shot } from '@video-quickly/contracts';

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
  -- Early v3 databases only projected summaries and had no asset reference table.
  CREATE TABLE IF NOT EXISTS project_asset_references (project_id TEXT NOT NULL, asset_id TEXT NOT NULL, PRIMARY KEY(project_id, asset_id));
  CREATE INDEX IF NOT EXISTS project_asset_references_asset ON project_asset_references(asset_id);
  DROP TRIGGER project_summary_insert;
  DROP TRIGGER project_summary_update;
  DROP TRIGGER project_summary_delete;
  CREATE TRIGGER project_summary_insert AFTER INSERT ON documents WHEN new.kind = 'project' BEGIN
    INSERT INTO documents(kind, id, body) VALUES ('project-summary', new.id, ${summaryBody('new.body')}) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body;
    INSERT OR IGNORE INTO project_asset_references(project_id, asset_id) SELECT new.id, refs.value FROM (${allReferences('new.body')}) AS refs;
  END;
  CREATE TRIGGER project_summary_update AFTER UPDATE OF body ON documents WHEN new.kind = 'project' BEGIN
    INSERT INTO documents(kind, id, body) VALUES ('project-summary', new.id, ${summaryBody('new.body')}) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body;
    DELETE FROM project_asset_references WHERE project_id = new.id;
    INSERT OR IGNORE INTO project_asset_references(project_id, asset_id) SELECT new.id, refs.value FROM (${allReferences('new.body')}) AS refs;
  END;
  CREATE TRIGGER project_summary_delete AFTER DELETE ON documents WHEN old.kind = 'project' BEGIN
    DELETE FROM documents WHERE kind = 'project-summary' AND id = old.id;
    DELETE FROM project_asset_references WHERE project_id = old.id;
  END;
  INSERT OR IGNORE INTO project_asset_references(project_id, asset_id)
    SELECT documents.id, field.value FROM documents, json_each(documents.body, '$.shots') shot, json_each(shot.value) field
    WHERE documents.kind = 'project' AND field.key IN ('assetId', 'audioAssetId', 'videoAssetId') AND field.type = 'text';
  INSERT OR IGNORE INTO project_asset_references(project_id, asset_id)
    SELECT documents.id, json_extract(clip.value, '$.assetId') FROM documents, json_each(documents.body, '$.musicClips') clip
    WHERE documents.kind = 'project' AND json_type(clip.value, '$.assetId') = 'text';
  INSERT OR IGNORE INTO project_asset_references(project_id, asset_id)
    SELECT documents.id, json_extract(shot.value, '$.captionTrack.sourceAssetId') FROM documents, json_each(documents.body, '$.shots') shot
    WHERE documents.kind = 'project' AND json_type(shot.value, '$.captionTrack.sourceAssetId') = 'text';
`;

// v5 adds the lightweight inherited thumbnail style.
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
  const cue = captionsEnabled(value) ? projectCaptionCues(shot, 0, undefined, value).find(cue => cue.startUs <= 0 && cue.endUs > 0) : undefined;
  return { ...shot, clipEdit: undefined, audioProcessing: undefined, sourceInUs: mapped.sourceUs, audioInUs: mapped.audioUs, videoInUs: mapped.videoUs, sceneInUs: mapped.sceneUs,
    sceneIndex: shot.sceneIndex ?? original?.sceneIndex, sceneDurationUs: shot.sceneDurationUs ?? original?.sceneDurationUs ?? original?.durationUs ?? shot.durationUs,
    captionTrack: { timeBase: 'scene', alignment: 'manual', cues: cue ? [{ ...cue, startUs: mapped.sceneUs, endUs: mapped.sceneUs + cue.endUs }] : [] } };
}

const PRODUCTION_AUDIO_REFERENCE_SCHEMA = `
  DROP TRIGGER project_summary_insert;
  DROP TRIGGER project_summary_update;
  CREATE TRIGGER project_summary_insert AFTER INSERT ON documents WHEN new.kind = 'project' BEGIN
    INSERT INTO documents(kind, id, body) VALUES ('project-summary', new.id, ${clipSummaryBody('new.body')}) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body;
    INSERT OR IGNORE INTO project_asset_references(project_id, asset_id)
      SELECT new.id, refs.value FROM (${allReferences('new.body')} UNION ${clipReferences('new.body')}
        UNION SELECT value FROM json_each(new.body, '$.workflow.production.referenceAudioAssetIds') WHERE type = 'text') AS refs;
  END;
  CREATE TRIGGER project_summary_update AFTER UPDATE OF body ON documents WHEN new.kind = 'project' BEGIN
    INSERT INTO documents(kind, id, body) VALUES ('project-summary', new.id, ${clipSummaryBody('new.body')}) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body;
    DELETE FROM project_asset_references WHERE project_id = new.id;
    INSERT OR IGNORE INTO project_asset_references(project_id, asset_id)
      SELECT new.id, refs.value FROM (${allReferences('new.body')} UNION ${clipReferences('new.body')}
        UNION SELECT value FROM json_each(new.body, '$.workflow.production.referenceAudioAssetIds') WHERE type = 'text') AS refs;
  END;
  UPDATE documents SET body = body WHERE kind = 'project';
`;

const episodeSummaryBody = (body: string) => `json_patch(${clipSummaryBody(body)}, json_object('episode', json_extract(${body}, '$.episode'), 'episodeSource', json_extract(${body}, '$.episodeSource')))`;
const WORK_PRODUCTION_SCHEMA = PRODUCTION_AUDIO_REFERENCE_SCHEMA.replaceAll(clipSummaryBody('new.body'), episodeSummaryBody('new.body')) + `
  CREATE UNIQUE INDEX projects_work_episode ON documents(json_extract(body, '$.episode.workId'), json_extract(body, '$.episode.number')) WHERE kind = 'project' AND json_type(body, '$.episode') = 'object';
  CREATE UNIQUE INDEX queue_active_project ON documents(json_extract(body, '$.projectId')) WHERE kind = 'production-queue-item' AND json_extract(body, '$.status') IN ('queued','running','needs_attention','failed');
  CREATE UNIQUE INDEX queue_running_item ON documents((1)) WHERE kind = 'production-queue-item' AND json_extract(body, '$.status') = 'running';
  CREATE INDEX queue_order ON documents(json_extract(body, '$.queueId'), json_extract(body, '$.position')) WHERE kind = 'production-queue-item';
  CREATE UNIQUE INDEX queue_item_run ON documents(json_extract(body, '$.productionQueueItemId')) WHERE kind = 'run' AND json_type(body, '$.productionQueueItemId') = 'text';
  INSERT INTO runtime_metadata(key, value) VALUES ('work-production', '1');
`;

const legacyProjectSchema = z.looseObject({
  revision: projectSchema.shape.revision,
  workflow: z.looseObject({ version: workflowSchema.shape.version, production: z.undefined().optional() }),
});
const legacyBuiltinWorkflowSchema = workflowSchema.omit({ production: true }).extend({
  id: z.enum(['history-handdrawn', 'general-video']),
  nodes: workflowNodeSchema.extend({ kind: nodeKindSchema.or(z.literal('voice')) }).array().min(7).max(9),
});

function upgradeLegacyProject(body: string): string {
  const parsed = legacyProjectSchema.safeParse(JSON.parse(body));
  if (!parsed.success) return body;
  const project = parsed.data;
  const version = project.workflow.version + 1;
  // The old production pipeline always rendered subtitles.
  const production = productionSettingsSchema.parse({ mode: 'native-video', subtitleMode: 'script' });
  let workflow = { ...project.workflow, version, production };
  const builtin = legacyBuiltinWorkflowSchema.safeParse(project.workflow);
  if (builtin.success) {
    const { nodes, edges, subflows, execution } = builtin.data;
    const roles = nodes.filter(node => node.kind !== 'research' && node.kind !== 'review').map(node => node.kind);
    const isBuiltinChain = !subflows?.length
      && nodes.every(node => node.id === node.kind)
      && new Set(nodes.map(node => node.id)).size === nodes.length
      && roles.join(' ') === 'brief style script assets voice animation export'
      && edges.length === nodes.length - 1
      && nodes.slice(1).every((node, index) => edges.some(edge => edge.source === nodes[index].id && edge.target === node.id && edge.condition === undefined));
    if (isBuiltinChain) {
      const native = createNativeVideoWorkflow();
      const previous = new Map(nodes.map(node => [node.id, node]));
      workflow = resolveProductionWorkflow({
        ...native, version, execution,
        production: { ...production, referenceMode: previous.get('assets')?.modelId ? 'generate' : 'none' },
        nodes: native.nodes.map(node => {
          if (node.id === 'animation') return node;
          const saved = previous.get(node.id === 'video' ? 'animation' : node.id);
          if (!saved) return node;
          return {
            ...node, prompt: saved.prompt || node.prompt, skillIds: saved.skillIds, modelId: saved.modelId,
            config: saved.modelId && node.config.modelBinding === 'default' ? { ...node.config, modelOverride: true } : node.config,
          };
        }),
      });
    }
  }
  if (!workflowSchema.safeParse(workflow).success) return body;
  return JSON.stringify({ ...project, revision: project.revision + 1, workflow });
}

const COST_AND_RUN_READ_SCHEMA = `
  CREATE INDEX documents_run_history ON documents(kind) WHERE kind = 'run';
  CREATE INDEX documents_usage_run ON documents(CAST(json_extract(body, '$.runId') AS TEXT)) WHERE kind = 'usage-record';
  CREATE INDEX documents_usage_project_run ON documents(json_extract(body, '$.projectId'), CAST(json_extract(body, '$.runId') AS TEXT)) WHERE kind = 'usage-record';

  CREATE TABLE cost_task_order (
    scope TEXT NOT NULL, cursor INTEGER NOT NULL, run_id TEXT NOT NULL,
    PRIMARY KEY(scope, cursor), UNIQUE(scope, run_id)
  ) WITHOUT ROWID;
  -- Preserve existing cursors independently for the complete ledger and each project.
  WITH ledger AS MATERIALIZED (
    SELECT rowid AS cursor, json_extract(body, '$.runId') AS run_id, json_extract(body, '$.projectId') AS project_id
    FROM documents WHERE kind = 'usage-record'
      AND json_type(body, '$.runId') = 'text' AND json_type(body, '$.projectId') = 'text'
  )
  INSERT INTO cost_task_order(scope, cursor, run_id)
    SELECT 'all', min(cursor), run_id FROM ledger GROUP BY run_id
    UNION ALL
    SELECT 'project:' || project_id, min(cursor), run_id FROM ledger GROUP BY project_id, run_id;

  -- Ledger identities are append-only. Updates to status, usage and actual charges keep their task cursor.
  CREATE TRIGGER cost_task_order_insert AFTER INSERT ON documents
    WHEN new.kind = 'usage-record' AND json_type(new.body, '$.runId') = 'text' AND json_type(new.body, '$.projectId') = 'text'
  BEGIN
    INSERT INTO cost_task_order(scope, cursor, run_id)
      SELECT candidate.scope, coalesce((SELECT max(cursor) FROM cost_task_order WHERE scope = candidate.scope), 0) + 1,
        json_extract(new.body, '$.runId')
      FROM (SELECT 'all' AS scope UNION ALL SELECT 'project:' || json_extract(new.body, '$.projectId')) candidate
      WHERE NOT EXISTS (
        SELECT 1 FROM cost_task_order WHERE scope = candidate.scope AND run_id = json_extract(new.body, '$.runId')
      );
  END;
`;

const invalidateCostOverview = (...rows: ('new' | 'old')[]) => `
  UPDATE cost_task_order SET overview_metrics = NULL
  WHERE scope = 'all' AND overview_metrics IS NOT NULL
    AND run_id IN (${rows.map(row => `CAST(json_extract(${row}.body, '$.runId') AS TEXT)`).join(', ')});
`;

const COST_OVERVIEW_SCHEMA = `
  -- Only the global scope owns a subtotal. NULL marks a task for recomputation.
  ALTER TABLE cost_task_order ADD COLUMN overview_metrics TEXT;
  CREATE INDEX cost_task_overview_pending ON cost_task_order(scope, overview_metrics, run_id)
    WHERE scope = 'all' AND overview_metrics IS NULL;

  CREATE TRIGGER cost_overview_insert AFTER INSERT ON documents WHEN new.kind = 'usage-record' BEGIN
    ${invalidateCostOverview('new')}
  END;
  CREATE TRIGGER cost_overview_update AFTER UPDATE OF body ON documents WHEN new.kind = 'usage-record' BEGIN
    ${invalidateCostOverview('old', 'new')}
  END;
  CREATE TRIGGER cost_overview_delete AFTER DELETE ON documents WHEN old.kind = 'usage-record' BEGIN
    ${invalidateCostOverview('old')}
  END;
`;

const queueCostOverview = (...rows: ('new' | 'old')[]) => `
  UPDATE cost_task_order SET overview_pending = 1
  WHERE scope = 'all' AND overview_pending = 0
    AND run_id IN (${rows.map(row => `CAST(json_extract(${row}.body, '$.runId') AS TEXT)`).join(', ')});
`;

const COST_OVERVIEW_DELTAS_SCHEMA = `
  ALTER TABLE cost_task_order ADD COLUMN overview_pending INTEGER NOT NULL DEFAULT 1;
  DROP INDEX cost_task_overview_pending;
  DROP TRIGGER cost_overview_insert;
  DROP TRIGGER cost_overview_update;
  DROP TRIGGER cost_overview_delete;

  -- Older subtotals store rounded numbers. Rebuild from the ledger once for exact deltas.
  UPDATE cost_task_order SET overview_metrics = NULL WHERE scope = 'all' AND overview_metrics IS NOT NULL;
  DELETE FROM runtime_metadata WHERE key = 'cost-overview-summary';
  CREATE INDEX cost_task_overview_pending ON cost_task_order(scope, overview_pending, run_id)
    WHERE scope = 'all' AND overview_pending = 1;

  CREATE TRIGGER cost_overview_insert AFTER INSERT ON documents WHEN new.kind = 'usage-record' BEGIN
    ${queueCostOverview('new')}
  END;
  CREATE TRIGGER cost_overview_update AFTER UPDATE OF body ON documents WHEN new.kind = 'usage-record' BEGIN
    ${queueCostOverview('old', 'new')}
  END;
  CREATE TRIGGER cost_overview_delete AFTER DELETE ON documents WHEN old.kind = 'usage-record' BEGIN
    ${queueCostOverview('old')}
  END;
`;

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
  { version: 8, name: 'active-project-runs-index', sql: `CREATE INDEX documents_active_project_runs ON documents(json_extract(body, '$.projectId')) WHERE kind = 'run' AND json_extract(body, '$.status') IN ('queued','running','waiting_review','waiting_external','retry_scheduled');` },
  { version: 9, name: 'workflow-layout', sql: 'SELECT 1;' },
  { version: 10, name: 'native-video-production', sql: `INSERT INTO runtime_metadata(key, value) VALUES ('native-video-production', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;` },
  { version: 11, name: 'production-reference-audio', sql: PRODUCTION_AUDIO_REFERENCE_SCHEMA },
  { version: 12, name: 'project-creative-context', sql: "INSERT INTO runtime_metadata(key, value) VALUES ('creative-context', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;" },
  { version: 13, name: 'prompt-workbench', sql: "INSERT INTO runtime_metadata(key, value) VALUES ('prompt-workbench', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;" },
  { version: 14, name: 'work-episodes-production-queue', sql: WORK_PRODUCTION_SCHEMA },
  { version: 15, name: 'creative-reference-images-and-media-derivations', sql: PRODUCTION_AUDIO_REFERENCE_SCHEMA
    .replaceAll(clipSummaryBody('new.body'), episodeSummaryBody('new.body'))
    .replaceAll("UNION SELECT value FROM json_each(new.body, '$.workflow.production.referenceAudioAssetIds') WHERE type = 'text'", "UNION SELECT value FROM json_each(new.body, '$.workflow.production.referenceAudioAssetIds') WHERE type = 'text' UNION SELECT image.value FROM json_each(new.body, '$.creativeContext.entities') entity JOIN json_each(entity.value, '$.referenceAssetIds') image WHERE image.type = 'text'")
    + "INSERT INTO runtime_metadata(key, value) VALUES ('media-extensions', '1');" },
  // Older schedulers treat a completed single-node graph as a completed run.
  { version: 16, name: 'single-step-retry-checkpoints', sql: "INSERT INTO runtime_metadata(key, value) VALUES ('single-step-retry', '1');" },
  // A local text receipt must never be interpreted as a resumable provider task.
  { version: 17, name: 'script-response-receipts', sql: "INSERT INTO runtime_metadata(key, value) VALUES ('script-response-receipts', '1');" },
  { version: 18, name: 'text-request-rejection-receipts', sql: "INSERT INTO runtime_metadata(key, value) VALUES ('text-request-rejections', '1');" },
  { version: 19, name: 'media-request-rejection-receipts', sql: "INSERT INTO runtime_metadata(key, value) VALUES ('media-request-rejections', '1');" },
  { version: 20, name: 'legacy-project-production-workflows', sql: `
    WITH upgrades AS MATERIALIZED (
      SELECT id, vq_upgrade_legacy_project(body) AS body FROM documents
      WHERE kind = 'project' AND json_type(body, '$.workflow.production') IS NULL
    )
    UPDATE documents SET body = upgrades.body FROM upgrades
    WHERE documents.kind = 'project' AND documents.id = upgrades.id AND documents.body != upgrades.body;
  ` },
  { version: 21, name: 'asset-read-indexes', sql: `
    CREATE INDEX documents_active_assets ON documents(kind)
      WHERE kind = 'asset' AND coalesce(json_extract(body, '$.active'), 1) = 1;
    CREATE INDEX documents_active_asset_derivations ON documents(json_extract(body, '$.derivation.sourceAssetId'))
      WHERE kind = 'asset' AND json_extract(body, '$.active') = 1
        AND json_type(body, '$.derivation.sourceAssetId') = 'text';
  ` },
  // Older clients would otherwise interpret a manual planning step as an AI task.
  { version: 22, name: 'manual-planning-inputs', sql: "INSERT INTO runtime_metadata(key, value) VALUES ('manual-planning-inputs', '1');" },
  { version: 23, name: 'structured-planning-prefill', sql: "INSERT INTO runtime_metadata(key, value) VALUES ('structured-planning-prefill', '1');" },
  { version: 24, name: 'cost-and-run-read-indexes', sql: COST_AND_RUN_READ_SCHEMA },
  { version: 25, name: 'incremental-cost-overview', sql: COST_OVERVIEW_SCHEMA },
  { version: 26, name: 'exact-cost-overview-deltas', sql: COST_OVERVIEW_DELTAS_SCHEMA },
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
    database.function('vq_upgrade_legacy_project', { deterministic: true }, (body: unknown) => {
      if (typeof body !== 'string') throw new TypeError('流程升级需要项目JSON正文。');
      return upgradeLegacyProject(body);
    });
    migrateDatabase(database, directory, WORKSPACE_MIGRATIONS);
    database.pragma('journal_mode = WAL');
    return database;
  } catch (error) { database.close(); throw error; }
}

type DocumentBody = { body: string };

export class DocumentStore {
  private getDocument?: Database.Statement<[kind: string, id: string], DocumentBody>;
  private listDocuments?: Database.Statement<[kind: string], DocumentBody>;
  private putDocument?: Database.Statement<[kind: string, id: string, body: string]>;
  private deleteDocument?: Database.Statement<[kind: string, id: string]>;
  private insertEvent?: Database.Statement<[runId: string, type: string, body: string, createdAt: string]>;

  constructor(readonly database: Database.Database) {}

  get<T>(kind: string, id: string): T | undefined {
    const statement = this.getDocument ??= this.database.prepare('SELECT body FROM documents WHERE kind = ? AND id = ?');
    const value = statement.get(kind, id);
    return value ? JSON.parse(value.body) as T : undefined;
  }

  list<T>(kind: string): T[] {
    const statement = this.listDocuments ??= this.database.prepare('SELECT body FROM documents WHERE kind = ? ORDER BY rowid');
    const rows = statement.all(kind);
    return rows.map(row => JSON.parse(row.body) as T);
  }

  put(kind: string, id: string, value: unknown) {
    const statement = this.putDocument ??= this.database.prepare('INSERT INTO documents(kind, id, body) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body');
    statement.run(kind, id, JSON.stringify(value));
  }

  delete(kind: string, id: string) {
    const statement = this.deleteDocument ??= this.database.prepare('DELETE FROM documents WHERE kind = ? AND id = ?');
    statement.run(kind, id);
  }

  event(runId: string, type: string, body: unknown) {
    const createdAt = new Date().toISOString();
    const statement = this.insertEvent ??= this.database.prepare('INSERT INTO execution_events(run_id, type, body, created_at) VALUES (?, ?, ?, ?)');
    const result = statement.run(runId, type, JSON.stringify(body), createdAt);
    return { sequence: Number(result.lastInsertRowid), runId, type, body, createdAt };
  }
}
