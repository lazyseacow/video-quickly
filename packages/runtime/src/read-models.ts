import type Database from 'better-sqlite3';
import type { ActivityRecord, AssetListItem, AssetRecord, ProjectDetail, ProjectDocument, ProjectSummary, RecordPage, RunEvent, RunRecord, RunSummary } from '@video-quickly/contracts';
import { DocumentStore } from './database.js';

type DocumentRow = { cursor: number; body: string };
type EventRow = { sequence: number; type: string; body: string; created_at: string };
type ActivityRow = { cursor: number; activity_id: string; status: string; input_hash: string; remote_id: string | null; error: string | null; started_at: string; completed_at: string | null };

export function activityNodeId(activityId: string, nodeIds: readonly string[]) {
  return nodeIds.filter(id => activityId === id || activityId.startsWith(`${id}:`)).sort((left, right) => right.length - left.length)[0] ?? activityId.split(':')[0];
}

// Exact namespace matching keeps IDs containing ':' or SQL wildcard characters
// distinct from another step's nested model/tool activities.
const stepFilter = (column: string) => `(@nodeId IS NULL OR ((${column} = @nodeId OR substr(${column}, 1, length(@nodeId) + 1) = @nodeId || ':') AND NOT EXISTS (SELECT 1 FROM json_each(@nodes) other WHERE length(other.value) > length(@nodeId) AND (${column} = other.value OR substr(${column}, 1, length(other.value) + 1) = other.value || ':'))))`;

export function createReadModels(database: Database.Database, store: DocumentStore) {
  function assetsVersion() {
    return Number((database.prepare("SELECT value FROM runtime_metadata WHERE key = 'assets-version'").get() as { value: string }).value);
  }
  function projects(): ProjectSummary[] {
    return store.list<ProjectSummary>('project-summary').map(value => {
      const id = value.thumbnailShot?.videoAssetId ?? value.thumbnailShot?.assetId;
      return id ? { ...value, thumbnailAsset: store.get<AssetRecord>('asset', id) } : value;
    });
  }
  function runSummary(value: RunRecord): RunSummary {
    const { events: _events, activities: _activities, ...record } = value;
    const completed = database.prepare("SELECT activity_id FROM activities WHERE run_id = ? AND status = 'completed'").all(value.id) as { activity_id: string }[];
    return { ...record, completedNodeIds: [...new Set(completed.map(row => row.activity_id.split(':')[0]))] };
  }
  function projectDetail(id: string, revision?: number, knownAssetsVersion?: number): ProjectDetail {
    const summary = store.get<ProjectSummary>('project-summary', id);
    if (!summary) throw new Error('项目不存在或已被移除。');
    const version = assetsVersion();
    const latest = database.prepare("SELECT body FROM documents WHERE kind = 'run' AND json_extract(body, '$.projectId') = ? ORDER BY rowid DESC LIMIT 1").get(id) as { body: string } | undefined;
    const assets = knownAssetsVersion === version ? undefined : (database.prepare("SELECT body FROM documents WHERE kind = 'asset' AND (json_extract(body, '$.projectId') = ? OR json_extract(body, '$.projectId') IS NULL) ORDER BY rowid").all(id) as { body: string }[]).map(row => JSON.parse(row.body) as AssetRecord);
    return { id, revision: summary.revision, assetsVersion: version, project: revision === summary.revision ? undefined : store.get<ProjectDocument>('project', id), assets, latestRun: latest ? runSummary(JSON.parse(latest.body)) : undefined };
  }
  function runs(before: number | undefined, limit: number, projectId?: string): RecordPage<RunSummary> {
    const rows = database.prepare("SELECT rowid AS cursor, body FROM documents WHERE kind = 'run' AND (? IS NULL OR rowid < ?) AND (? IS NULL OR json_extract(body, '$.projectId') = ?) ORDER BY rowid DESC LIMIT ?").all(before ?? null, before ?? null, projectId ?? null, projectId ?? null, limit + 1) as DocumentRow[];
    return page(rows, limit, row => runSummary(JSON.parse(row.body)));
  }
  function nodeIds(runId: string) {
    const row = database.prepare("SELECT json_extract(body, '$.nodes') AS nodes FROM documents WHERE kind = 'run-snapshot' AND id = ?").get(runId) as { nodes: string | null } | undefined;
    return row?.nodes ? (JSON.parse(row.nodes) as { id: string }[]).map(node => node.id) : [];
  }
  function events(run: RunRecord, before: number | undefined, limit: number, nodeId?: string): RecordPage<RunEvent> {
    const ids = nodeIds(run.id);
    const rows = database.prepare(`WITH entries AS (SELECT sequence, type, body, created_at, coalesce(json_extract(body, '$.nodeId'), json_extract(body, '$.activityId')) AS step_id FROM execution_events WHERE run_id = @runId AND (@before IS NULL OR sequence < @before)) SELECT sequence, type, body, created_at FROM entries WHERE ${stepFilter('step_id')} ORDER BY sequence DESC LIMIT @limit`).all({ runId: run.id, before: before ?? null, nodeId: nodeId ?? null, nodes: JSON.stringify(ids), limit: limit + 1 }) as EventRow[];
    return page(rows.map(row => ({ ...row, cursor: row.sequence })), limit, row => {
      const body = JSON.parse(row.body) as { message?: string; nodeId?: string; activityId?: string };
      const sourceId = body.nodeId ?? body.activityId;
      return { id: `event-${row.sequence}`, runId: run.id, projectId: run.projectId, sequence: row.sequence, type: row.type, message: body.message ?? '步骤结果已保存', nodeId: sourceId ? activityNodeId(sourceId, ids) : undefined, createdAt: row.created_at };
    });
  }
  function activities(runId: string, before: number | undefined, limit: number, nodeId?: string): RecordPage<ActivityRecord> {
    // Results are fetched through node.result; opening a log never transfers generated media payloads.
    const ids = nodeIds(runId);
    const rows = database.prepare(`SELECT rowid AS cursor, activity_id, status, input_hash, remote_id, error, started_at, completed_at FROM activities WHERE run_id = @runId AND (@before IS NULL OR rowid < @before) AND ${stepFilter('activity_id')} ORDER BY rowid DESC LIMIT @limit`).all({ runId, before: before ?? null, nodeId: nodeId ?? null, nodes: JSON.stringify(ids), limit: limit + 1 }) as ActivityRow[];
    return page(rows, limit, row => ({ id: row.activity_id, runId, nodeId: activityNodeId(row.activity_id, ids), status: (row.status === 'dispatched' ? 'submitted' : row.status) as ActivityRecord['status'], inputHash: row.input_hash, remoteTaskId: row.remote_id ?? undefined, attempt: 1, createdAt: row.started_at, updatedAt: row.completed_at ?? row.started_at, error: row.error ?? undefined }));
  }
  function assets(before: number | undefined, limit: number, kind?: AssetRecord['kind']): RecordPage<AssetListItem> {
    const rows = database.prepare(`SELECT rowid AS cursor, body FROM documents WHERE kind = 'asset' AND coalesce(json_extract(body, '$.active'), 1) = 1 AND (? IS NULL OR rowid < ?) AND (? IS NULL OR json_extract(body, '$.kind') = ?) ORDER BY rowid DESC LIMIT ?`).all(before ?? null, before ?? null, kind ?? null, kind ?? null, limit + 1) as DocumentRow[];
    return page(rows, limit, row => {
      const asset = JSON.parse(row.body) as AssetRecord;
      return { ...asset, inUse: assetInUse(asset.id) };
    });
  }
  function assetInUse(id: string) { return !!database.prepare('SELECT 1 FROM project_asset_references WHERE asset_id = ? LIMIT 1').get(id); }
  return { assetsVersion, projects, projectDetail, runSummary, runs, events, activities, assets, assetInUse };
}

function page<T extends { cursor: number }, R>(rows: T[], limit: number, map: (row: T) => R): RecordPage<R> {
  return { items: rows.slice(0, limit).map(map), nextCursor: rows.length > limit ? rows[limit - 1].cursor : null };
}
