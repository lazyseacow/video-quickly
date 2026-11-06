import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assetListItemSchema, projectDetailSchema, projectSchema, recordPageSchema, runEventSchema, runSummarySchema, workspaceSummarySchema, type AssetRecord, type ProjectDetail, type ProjectDocument, type RunRecord } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src';
import { DocumentStore, openDatabase } from '../packages/runtime/src/database';
import { editContent } from '../apps/desktop/src/lib/project-edits';
import { seedLargeWorkspace } from './fixtures/large-workspace';

const directories: string[] = [];
const runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture(shots = 200, options = { assets: 1000, runs: 105, eventsPerRun: 105 }) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-large-')); directories.push(directory);
  const database = openDatabase(directory); const store = new DocumentStore(database);
  const project = seedLargeWorkspace(store, shots, options);
  database.close();
  const runtime = createRuntime({ dataDirectory: directory, seed: false }); runtimes.push(runtime);
  return { runtime, project, directory };
}

describe('on-demand workspace reads', () => {
  // Budget for the 10,000-run/10,000-activity fixture and its index semantics checks on native CI.
  it('seeks active and latest runs without sorting or crossing project and document kinds', async () => {
    const { runtime, project, directory } = await fixture(10, { assets: 1, runs: 10_000, eventsPerRun: 0 });
    const database = openDatabase(directory), store = new DocumentStore(database);
    try {
      const other = seedLargeWorkspace(store, 11, { assets: 0, runs: 1, eventsPerRun: 0 });
      const empty = seedLargeWorkspace(store, 12, { assets: 0, runs: 0, eventsPerRun: 0 });
      const asset = store.get<AssetRecord>('asset', `${project.id}-asset-0`)!;
      store.put('asset', 'later-asset', { ...asset, id: 'later-asset' });
      const prepared = vi.spyOn(Object.getPrototypeOf(database) as Pick<typeof database, 'prepare'>, 'prepare');
      let detail: ProjectDetail;
      let latestSql: string;
      let activeSql: string;
      try {
        detail = projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id }));
        // Inspect the query actually issued by the production read model.
        const queries = prepared.mock.calls.map(([sql]) => sql).filter(sql => sql.includes('ORDER BY rowid DESC LIMIT 1'));
        expect(queries).toHaveLength(2); [activeSql, latestSql] = queries;
      } finally { prepared.mockRestore(); }
      expect(detail.latestRun?.id).toBe(`${project.id}-run-9999`);
      expect(projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: other.id })).latestRun?.id).toBe(`${other.id}-run-0`);
      expect(projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: empty.id })).latestRun).toBeUndefined();
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${latestSql}`).all(project.id) as { detail: string }[];
      expect(plan.some(row => row.detail.includes('USING INDEX documents_project'))).toBe(true);
      expect(plan.some(row => /SCAN documents|USE TEMP B-TREE/.test(row.detail))).toBe(false);
      const activePlan = database.prepare(`EXPLAIN QUERY PLAN ${activeSql}`).all(project.id) as { detail: string }[];
      expect(activePlan.some(row => row.detail.includes('USING INDEX documents_active_project_runs'))).toBe(true);
      expect(activePlan.some(row => /SCAN documents|USE TEMP B-TREE/.test(row.detail))).toBe(false);
      const previous = store.get<RunRecord>('run', `${project.id}-run-9999`)!;
      store.put('run', 'new-latest-run', { ...previous, id: 'new-latest-run' });
      const refreshed = projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id, revision: detail.revision, assetsVersion: detail.assetsVersion }));
      expect(refreshed.latestRun?.id).toBe('new-latest-run');
      expect(refreshed.project).toBeUndefined(); expect(refreshed.assets).toBeUndefined();
      const older = store.get<RunRecord>('run', `${project.id}-run-0`)!;
      const newer = store.get<RunRecord>('run', `${project.id}-run-1`)!;
      for (const status of ['queued', 'running', 'waiting_review', 'waiting_external', 'retry_scheduled'] as const) {
        store.put('run', older.id, { ...older, status, updatedAt: '2099-01-01T00:00:00.000Z' });
        store.put('run', newer.id, { ...newer, status });
        expect(projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id })).latestRun?.id).toBe(newer.id);
      }
      store.put('run', newer.id, { ...newer, status: 'succeeded' });
      expect(projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id })).latestRun?.id).toBe(older.id);
      for (const status of ['failed', 'needs_attention'] as const) {
        store.put('run', older.id, { ...older, status });
        expect(projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id })).latestRun?.id).toBe('new-latest-run');
      }
    } finally { database.close(); }
  }, 90_000);

  it.each(['failed', 'needs_attention'] as const)('follows a resumed older %s run through automatic execution, then returns to the newest completed run', async failureStatus => {
    const directory = await mkdtemp(join(tmpdir(), 'vq-current-run-')); directories.push(directory);
    let release!: () => void, releaseOther!: () => void, attempts = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const otherGate = new Promise<void>(resolve => { releaseOther = resolve; });
    const runtime = createRuntime({ dataDirectory: directory, seed: false, executeActivity: async context => {
      if (context.project.title === '另一项目的活动制作') { await otherGate; return { source: 'other isolated activity' }; }
      if (++attempts === 1) throw new Error(failureStatus === 'failed' ? 'isolated retryable failure' : '请重试隔离的本地任务');
      await gate;
      return { source: 'isolated activity' };
    } }); runtimes.push(runtime);
    try {
      const project = projectSchema.parse(await runtime.dispatch('project.create', { templateId: 'history-handdrawn', title: '恢复较早的制作' }));
      await runtime.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow: { ...project.workflow, id: 'read-custom-review', nodes: project.workflow.nodes.map(node => node.id === 'brief' ? { ...node, config: {} } : node.id === 'animation' ? { ...node, requiresReview: true } : node) } });
      const older = await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'animation' }) as RunRecord;
      await runtime.waitForIdle();
      expect(runSummarySchema.parse(await runtime.dispatch('run.get', { runId: older.id })).status).toBe(failureStatus);
      const newer = await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'brief' }) as RunRecord;
      await runtime.waitForIdle();
      expect(projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id })).latestRun).toMatchObject({ id: newer.id, status: 'succeeded' });

      const other = projectSchema.parse(await runtime.dispatch('project.create', { title: '另一项目的活动制作' }));
      await runtime.dispatch('workflow.save', { projectId: other.id, revision: other.revision, workflow: { ...other.workflow, id: 'other-custom-review', nodes: other.workflow.nodes.map(node => node.id === 'animation' ? { ...node, requiresReview: true } : node) } });
      const otherRun = await runtime.dispatch('run.start', { projectId: other.id, nodeId: 'animation' }) as RunRecord;
      await expect.poll(async () => runSummarySchema.parse(await runtime.dispatch('run.get', { runId: otherRun.id })).status).toBe('running');
      expect(projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id })).latestRun?.id).toBe(newer.id);
      await runtime.dispatch('run.resume', { runId: older.id });
      await expect.poll(() => attempts).toBe(2);
      expect(projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id })).latestRun).toMatchObject({ id: older.id, status: 'running' });
      expect(projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: other.id })).latestRun).toMatchObject({ id: otherRun.id, status: 'running' });

      release();
      await expect.poll(async () => runSummarySchema.parse(await runtime.dispatch('run.get', { runId: older.id })).status).toBe('succeeded');
      expect(runSummarySchema.parse(await runtime.dispatch('run.get', { runId: older.id })).status).toBe('succeeded');
      expect(projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id })).latestRun).toMatchObject({ id: newer.id, status: 'succeeded' });
      expect(projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: other.id })).latestRun).toMatchObject({ id: otherRun.id, status: 'running' });
      releaseOther(); await runtime.waitForIdle();
    } finally { release(); releaseOther(); }
  });

  it('reads a current project once for a full editor save without caching it across revisions', async () => {
    const { runtime, project, directory } = await fixture(1000);
    const patch = { ...editContent(project), shots: project.shots.map((shot, index) => index === 999 ? { ...shot, title: '保存最后的镜头' } : shot) };
    const reads = vi.spyOn(DocumentStore.prototype, 'get');
    let saved: ProjectDocument;
    try {
      saved = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch }));
      expect(reads.mock.calls.filter(([kind, id]) => kind === 'project' && id === project.id)).toHaveLength(1);
    } finally { reads.mockRestore(); }
    expect(saved.revision).toBe(project.revision + 1);
    expect(saved.shots[999].title).toBe('保存最后的镜头');
    expect(saved.shots.slice(0, 999)).toEqual(project.shots.slice(0, 999));
    const database = openDatabase(directory);
    const external = { ...saved, title: '独立写入的新修订', revision: saved.revision + 1 };
    try { new DocumentStore(database).put('project', project.id, external); }
    finally { database.close(); }
    await expect(runtime.dispatch('project.update', { projectId: project.id, revision: saved.revision, patch: { title: '不应覆盖外部修改' } })).rejects.toThrow('其他视图修改');
    expect(projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id })).project).toEqual(external);
  });

  it('protects background music and caption provenance references transactionally', async () => {
    const { runtime, project, directory } = await fixture(10);
    const db = openDatabase(directory); const store = new DocumentStore(db);
    const original = store.get<object>('asset', `${project.id}-asset-0`)!;
    for (const id of ['background-music', 'caption-source']) store.put('asset', id, { ...original, id, projectId: undefined, kind: 'audio' });
    db.close();
    await runtime.dispatch('project.update', { projectId: project.id, revision: 1, patch: {
      musicClips: [{ id: 'm', assetId: 'background-music', durationUs: 1_000_000 }],
      shots: [{ ...project.shots[0], captionTrack: { timeBase: 'source', alignment: 'speech', sourceAssetId: 'caption-source', sourceSha256: 'hash', cues: [] } }],
    } });
    await expect(runtime.dispatch('asset.delete', { assetId: 'background-music' })).rejects.toThrow('正在使用');
    await expect(runtime.dispatch('asset.delete', { assetId: 'caption-source' })).rejects.toThrow('正在使用');
    await runtime.dispatch('project.update', { projectId: project.id, revision: 2, patch: { title: '仅改名称' } });
    await expect(runtime.dispatch('asset.delete', { assetId: 'background-music' })).rejects.toThrow('正在使用');
    await runtime.dispatch('project.update', { projectId: project.id, revision: 3, patch: { musicClips: [], shots: [] } });
    await expect(runtime.dispatch('asset.delete', { assetId: 'background-music' })).resolves.toEqual({ deleted: true });
    await expect(runtime.dispatch('asset.delete', { assetId: 'caption-source' })).resolves.toEqual({ deleted: true });
  });
  it('projects summaries transactionally and omits unchanged documents and assets during task refresh', async () => {
    const { runtime, project } = await fixture();
    const summary = workspaceSummarySchema.parse(await runtime.dispatch('workspace.summary'));
    expect(summary.projects[0]).toMatchObject({ id: project.id, shotCount: 200, durationUs: 600_000_000, archived: false });
    expect(summary).not.toHaveProperty('events'); expect(summary).not.toHaveProperty('runs');
    expect(summary.projects[0]).not.toHaveProperty('shots');
    const first = projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id }));
    expect(first.project?.shots).toHaveLength(200); expect(first.assets).toHaveLength(1000);
    expect(first.latestRun?.completedNodeIds).toEqual(['brief']);
    const refresh = projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id, revision: first.revision, assetsVersion: first.assetsVersion }));
    expect(refresh.project).toBeUndefined(); expect(refresh.assets).toBeUndefined();
    await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.slice(0, 50) } });
    const after = workspaceSummarySchema.parse(await runtime.dispatch('workspace.summary'));
    expect(after.projects[0]).toMatchObject({ shotCount: 50, durationUs: 150_000_000, revision: 2 });
    await expect(runtime.dispatch('project.update', { projectId: project.id, revision: 1, patch: { title: '过期覆盖' } })).rejects.toThrow('其他视图修改');
    const update = projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id, revision: 1, assetsVersion: first.assetsVersion }));
    expect(update.project?.shots).toHaveLength(50); expect(update.assets).toBeUndefined();
    await runtime.dispatch('asset.retain', { assetId: `${project.id}-asset-0`, retained: true });
    const assets = projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id, revision: 2, assetsVersion: first.assetsVersion }));
    expect(assets.project).toBeUndefined(); expect(assets.assets?.[0].retained).toBe(true);
  });

  it('bounds history to 100 and uses stable cursors when new events/runs arrive between pages', async () => {
    const { runtime, project, directory } = await fixture(10);
    const schema = recordPageSchema(runSummarySchema);
    const first = schema.parse(await runtime.dispatch('run.list'));
    expect(first.items).toHaveLength(100); expect(first.nextCursor).not.toBeNull();
    const db = openDatabase(directory); const store = new DocumentStore(db);
    const latest = { ...first.items[0], id: 'new-run', events: [], activities: [] }; store.put('run', latest.id, latest);
    db.close();
    const second = schema.parse(await runtime.dispatch('run.list', { before: first.nextCursor }));
    expect(second.items).toHaveLength(5); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(run => run.id)).size).toBe(105);
    expect(first.items[0]).not.toHaveProperty('events'); expect(first.items[0]).not.toHaveProperty('activities');
    const eventSchema = recordPageSchema(runEventSchema);
    const events = eventSchema.parse(await runtime.dispatch('run.events', { runId: `${project.id}-run-0` }));
    expect(events.items).toHaveLength(100);
    const more = eventSchema.parse(await runtime.dispatch('run.events', { runId: `${project.id}-run-0`, before: events.nextCursor }));
    expect(more.items).toHaveLength(5); expect(more.nextCursor).toBeNull();
    expect(new Set([...events.items, ...more.items].map(event => event.sequence)).size).toBe(105);
    for (const method of ['run.list', 'run.events', 'run.activities', 'asset.list']) await expect(runtime.dispatch(method, { runId: latest.id, limit: 101 })).rejects.toThrow();
  });

  it('never parses historical events or generated results for workspace and run summaries', async () => {
    const { runtime, project, directory } = await fixture(50);
    const db = openDatabase(directory);
    db.prepare('UPDATE execution_events SET body = ?').run('intentionally unread historical payload');
    db.prepare('UPDATE activities SET result = ?').run('intentionally unread generated payload');
    db.close();
    expect(workspaceSummarySchema.parse(await runtime.dispatch('workspace.summary')).projects[0].shotCount).toBe(50);
    expect(projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id })).latestRun?.status).toBe('succeeded');
    expect(recordPageSchema(runSummarySchema).parse(await runtime.dispatch('run.list')).items).toHaveLength(100);
    const activities = await runtime.dispatch('run.activities', { runId: `${project.id}-run-0` }) as { items: object[] };
    expect(activities.items[0]).not.toHaveProperty('result');
    await expect(runtime.dispatch('workspace.snapshot')).rejects.toThrow();
  });

  it('updates indexed asset usage with edits and rolls its projection back with the project', async () => {
    const { runtime, project, directory } = await fixture(10);
    const assetId = `${project.id}-asset-999`;
    await runtime.dispatch('asset.select', { assetId, projectId: project.id, shotId: project.shots[0].id, revision: 1 });
    const assets = recordPageSchema(assetListItemSchema).parse(await runtime.dispatch('asset.list', { limit: 1 }));
    expect(assets.items[0]).toMatchObject({ id: assetId, inUse: true });
    await expect(runtime.dispatch('asset.delete', { assetId })).rejects.toThrow('正在使用');
    const db = openDatabase(directory); const store = new DocumentStore(db);
    expect(() => db.transaction(() => { store.put('project', project.id, { ...project, shots: [] }); throw new Error('rollback'); })()).toThrow('rollback');
    expect(store.get('project-summary', project.id)).toMatchObject({ shotCount: 10, revision: 2 });
    expect(db.prepare('SELECT asset_id FROM project_asset_references WHERE project_id = ?').all(project.id)).toEqual([{ asset_id: assetId }]);
    db.close();
    await runtime.dispatch('project.update', { projectId: project.id, revision: 2, patch: { shots: [] } });
    await expect(runtime.dispatch('asset.delete', { assetId })).resolves.toEqual({ deleted: true });
  });
});
