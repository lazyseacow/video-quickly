import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { executeMediaGraph } from '../src/media-graph.js';

const directories: string[] = [];
const databases: Database.Database[] = [];
async function storage() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-media-graph-'));
  directories.push(directory);
  const path = join(directory, 'state.sqlite');
  return { path, database: open(path) };
}
function open(path: string) { const database = new Database(path); databases.push(database); return database; }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(async () => {
  for (const database of databases.splice(0)) if (database.open) database.close();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('native durable media fan-out', () => {
  it('fans out Send tasks with a native concurrency cap and joins every result', async () => {
    const { database } = await storage();
    const shotIds = ['one', 'two', 'three', 'four', 'five'];
    const releases = new Map(shotIds.map(id => [id, deferred()]));
    const firstWave = deferred(), thirdStarted = deferred();
    const started: string[] = [];
    let active = 0, maximum = 0;
    const execution = executeMediaGraph({ database, runId: 'run', nodeId: 'images', shotIds, concurrency: 2, signal: new AbortController().signal, async execute(shotId) {
      started.push(shotId);
      active++;
      maximum = Math.max(maximum, active);
      if (started.length === 2) firstWave.resolve();
      if (started.length === 3) thirdStarted.resolve();
      await releases.get(shotId)!.promise;
      active--;
      return { assetId: `asset-${shotId}` };
    } });
    await firstWave.promise;
    expect(started).toEqual(['one', 'two']);
    releases.get('one')!.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(started).toEqual(['one', 'two']);
    releases.get('two')!.resolve();
    await thirdStarted.promise;
    expect(started.slice(0, 3)).toEqual(['one', 'two', 'three']);
    for (const release of releases.values()) release.resolve();
    expect(await execution).toEqual(Object.fromEntries(shotIds.map(id => [id, { assetId: `asset-${id}` }])));
    expect(maximum).toBe(2);
    expect(active).toBe(0);
    const saved = await new SqliteSaver(database).getTuple({ configurable: { thread_id: 'run:media:images', checkpoint_ns: '' } });
    expect(saved?.checkpoint.channel_values.shotIds).toEqual(shotIds);
    expect(saved?.checkpoint.channel_values.outputs).toEqual(await execution);
    expect(JSON.stringify(saved)).not.toContain('execute(');
  });

  it('reopens SQLite and resumes only failed tasks while preserving successful pending writes', async () => {
    const { database, path } = await storage();
    const failure = deferred();
    const attempts: string[] = [];
    const options = { database, runId: 'run', nodeId: 'images', shotIds: ['one', 'two', 'three'], concurrency: 3, signal: new AbortController().signal };
    const first = executeMediaGraph({ ...options, async execute(shotId) {
      attempts.push(shotId);
      if (shotId === 'two') { await failure.promise; throw new Error('temporary provider failure'); }
      return { assetId: `asset-${shotId}` };
    } });
    // Observe the real SQLite saver, rather than substituting a graph or saver.
    await expect.poll(async () => {
      const saved = await new SqliteSaver(database).getTuple({ configurable: { thread_id: 'run:media:images', checkpoint_ns: '' } });
      return saved?.pendingWrites?.filter(([, channel]) => channel === 'outputs').length;
    }).toBe(2);
    failure.resolve();
    await expect(first).rejects.toThrow('temporary provider failure');
    expect(attempts).toEqual(['one', 'two', 'three']);
    database.close();
    const reopened = open(path);
    await expect(executeMediaGraph({ ...options, database: reopened, concurrency: 1, async execute() { throw new Error('changed scheduling must not execute'); } })).rejects.toThrow('并发配置已变化');
    const resumed = await executeMediaGraph({ ...options, database: reopened, async execute(shotId) { attempts.push(shotId); return { assetId: `asset-${shotId}` }; } });
    expect(resumed).toEqual({ one: { assetId: 'asset-one' }, two: { assetId: 'asset-two' }, three: { assetId: 'asset-three' } });
    expect(attempts).toEqual(['one', 'two', 'three', 'two']);
    expect(await executeMediaGraph({ ...options, database: reopened, async execute() { throw new Error('completed graph must stay read-only'); } })).toEqual(resumed);
    await expect(executeMediaGraph({ ...options, database: reopened, shotIds: ['one', 'three', 'two'], async execute() { throw new Error('changed identity must not execute'); } })).rejects.toThrow('镜头列表已变化');
  });

  it('drains underlying callbacks on cancellation and does not launch queued shots', async () => {
    const { database } = await storage();
    const controller = new AbortController();
    const started = deferred(), release = deferred(), callbackFinished = deferred();
    const attempts: string[] = [];
    let settled = false;
    const execution = executeMediaGraph({ database, runId: 'run', nodeId: 'images', shotIds: ['one', 'two'], concurrency: 1, signal: controller.signal, async execute(shotId) {
      attempts.push(shotId);
      started.resolve();
      await release.promise;
      callbackFinished.resolve();
      return { assetId: `asset-${shotId}` };
    } });
    const observed = execution.then(() => { settled = true; }, () => { settled = true; });
    await started.promise;
    controller.abort();
    // A macrotask permits the graph's cancellation race to settle; the actual
    // provider remains blocked until explicitly released by this fixture.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    release.resolve();
    await expect(execution).rejects.toThrow();
    await callbackFinished.promise;
    await observed;
    expect(attempts).toEqual(['one']);
  });

  it('resumes the initial persisted input before the start task has applied it', async () => {
    const { database } = await storage();
    const options = { database, runId: 'run', nodeId: 'images', shotIds: ['one'], concurrency: 1, signal: new AbortController().signal, async execute(id: string) { return { assetId: id }; } };
    await executeMediaGraph(options);
    // Keep the actual initial checkpoint but remove all later task writes,
    // reproducing a process exit immediately after input became durable.
    const earliest = database.prepare('SELECT min(checkpoint_id) AS id FROM checkpoints WHERE thread_id = ?').get('run:media:images') as { id: string };
    database.prepare('DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_id != ?').run('run:media:images', earliest.id);
    database.prepare('DELETE FROM writes WHERE thread_id = ?').run('run:media:images');
    expect(await executeMediaGraph(options)).toEqual({ one: { assetId: 'one' } });
  });

  it('drains a failed wave and resumes queued shots that never started', async () => {
    const { database } = await storage();
    const bothStarted = deferred(), failure = deferred(), release = deferred();
    const attempts: string[] = [];
    let settled = false;
    const options = { database, runId: 'run', nodeId: 'images', shotIds: ['fails', 'blocked', 'queued'], concurrency: 2, signal: new AbortController().signal };
    const first = executeMediaGraph({ ...options, async execute(id) {
      attempts.push(id);
      if (attempts.length === 2) bothStarted.resolve();
      if (id === 'fails') { await failure.promise; throw new Error('provider failed'); }
      await release.promise;
      return { assetId: id };
    } });
    const observed = first.then(() => { settled = true; }, () => { settled = true; });
    await bothStarted.promise;
    failure.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    release.resolve();
    await expect(first).rejects.toThrow('provider failed');
    await observed;
    expect(attempts).toEqual(['fails', 'blocked']);
    const result = await executeMediaGraph({ ...options, async execute(id) { attempts.push(id); return { assetId: id }; } });
    expect(result).toEqual({ fails: { assetId: 'fails' }, blocked: { assetId: 'blocked' }, queued: { assetId: 'queued' } });
    expect(attempts.filter(id => id === 'queued')).toHaveLength(1);
  });

  it('isolates its thread when invoked inside a checkpointed parent graph', async () => {
    const { database } = await storage();
    const Parent = Annotation.Root({ done: Annotation<boolean>({ default: () => false, reducer: (_, value) => value }) });
    const attempts: string[] = [];
    const graph = new StateGraph(Parent)
      .addNode('media', async () => {
        const execute = () => executeMediaGraph({ database, runId: 'parent', nodeId: 'images', shotIds: ['one', 'two'], concurrency: 2, signal: new AbortController().signal, async execute(id) { attempts.push(id); return { assetId: id }; } });
        expect(await execute()).toEqual({ one: { assetId: 'one' }, two: { assetId: 'two' } });
        expect(await execute()).toEqual({ one: { assetId: 'one' }, two: { assetId: 'two' } });
        return { done: true };
      })
      .addEdge(START, 'media').addEdge('media', END)
      .compile({ checkpointer: new SqliteSaver(database) });
    const config = { configurable: { thread_id: 'parent', checkpoint_ns: '' }, durability: 'sync' as const };
    expect(await AsyncLocalStorageProviderSingleton.runWithConfig(config, () => graph.invoke({ done: false }, config))).toEqual({ done: true });
    expect(attempts).toEqual(['one', 'two']);
    const threads = database.prepare('SELECT DISTINCT thread_id, checkpoint_ns FROM checkpoints ORDER BY thread_id').all();
    expect(threads).toEqual([{ thread_id: 'parent', checkpoint_ns: '' }, { thread_id: 'parent:media:images', checkpoint_ns: '' }]);
  });

  it('handles an empty graph and rejects invalid scheduling inputs before executing', async () => {
    const { database } = await storage();
    const options = { database, runId: 'run', nodeId: 'images', concurrency: 2, signal: new AbortController().signal, async execute() { throw new Error('no task should run'); } };
    expect(await executeMediaGraph({ ...options, shotIds: [] })).toEqual({});
    await expect(executeMediaGraph({ ...options, nodeId: 'invalid', shotIds: ['one', 'one'] })).rejects.toThrow('身份不能重复');
    await expect(executeMediaGraph({ ...options, nodeId: 'invalid', shotIds: ['one'], concurrency: 0 })).rejects.toThrow('正整数');
  });

  it('joins more than twenty shots at concurrency one without a recursion overflow', async () => {
    const { database } = await storage();
    const shotIds = Array.from({ length: 64 }, (_, index) => `shot-${index}`);
    const attempts: string[] = [];
    const credential = 'fixture-closure-credential';
    const outputs = await executeMediaGraph({ database, runId: 'large', nodeId: 'images', shotIds, concurrency: 1, signal: new AbortController().signal, async execute(id) {
      expect(credential).toHaveLength(26);
      attempts.push(id);
      return { assetId: id };
    } });
    expect(attempts).toEqual(shotIds);
    expect(Object.keys(outputs)).toEqual(shotIds);
    let persisted = '';
    for await (const tuple of new SqliteSaver(database).list({ configurable: { thread_id: 'large:media:images', checkpoint_ns: '' } })) persisted += JSON.stringify(tuple);
    expect(persisted).not.toContain(credential);
  });
});
