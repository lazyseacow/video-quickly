import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assetListItemSchema, projectDetailSchema, recordPageSchema, runEventSchema, runSummarySchema, workspaceSummarySchema } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src';
import { DocumentStore, openDatabase } from '../packages/runtime/src/database';
import { seedLargeWorkspace } from './fixtures/large-workspace';

const directories: string[] = [];
const runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture(shots = 200) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-large-')); directories.push(directory);
  const database = openDatabase(directory); const store = new DocumentStore(database);
  const project = seedLargeWorkspace(store, shots, { assets: 1000, runs: 105, eventsPerRun: 105 });
  database.close();
  const runtime = createRuntime({ dataDirectory: directory, seed: false }); runtimes.push(runtime);
  return { runtime, project, directory };
}

describe('on-demand workspace reads', () => {
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
