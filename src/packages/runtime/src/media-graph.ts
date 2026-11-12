import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { Annotation, END, Send, START, StateGraph } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { JsonValue } from '@video-quickly/contracts';
import type Database from 'better-sqlite3';

const MediaState = Annotation.Root({
  shotIds: Annotation<string[]>({ reducer: (_, value) => value, default: () => [] }),
  concurrency: Annotation<number>({ reducer: (_, value) => value, default: () => 0 }),
  outputs: Annotation<Record<string, JsonValue>>({ reducer: (previous, next) => ({ ...previous, ...next }), default: () => ({}) }),
});

export interface MediaGraphOptions {
  database: Database.Database;
  runId: string;
  nodeId: string;
  shotIds: string[];
  concurrency: number;
  signal: AbortSignal;
  execute(shotId: string): Promise<JsonValue>;
}

/** Native Send tasks retain successful siblings through SQLite pending writes. */
export async function executeMediaGraph({ database, runId, nodeId, shotIds, concurrency, signal, execute }: MediaGraphOptions): Promise<Record<string, JsonValue>> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('镜头并发数必须为正整数。');
  if (new Set(shotIds).size !== shotIds.length) throw new Error('并行镜头身份不能重复。');
  signal.throwIfAborted();
  const inFlight = new Set<Promise<JsonValue>>();
  const checkpointer = new SqliteSaver(database);
  const graph = new StateGraph(MediaState)
    .addNode('dispatch', () => ({}))
    .addNode('shot', async ({ shotId }: { shotId: string }) => {
      signal.throwIfAborted();
      // Track the underlying operation: Runnable cancellation can reject its
      // wrapper before a provider has finished releasing its own resources.
      const operation = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return execute(shotId);
      });
      inFlight.add(operation);
      try { return { outputs: { [shotId]: await operation } }; }
      finally { inFlight.delete(operation); }
    })
    .addNode('join', () => ({}))
    .addEdge(START, 'dispatch')
    .addConditionalEdges('dispatch', state => {
      // Keep each native superstep within the concurrency budget. LangGraph
      // 1.5's runner can otherwise finish a step with Send tasks still queued
      // (notably at concurrency one), leaving invoke with partial results.
      const pending = state.shotIds.filter(id => !Object.hasOwn(state.outputs, id)).slice(0, concurrency);
      return pending.length ? pending.map(shotId => new Send('shot', { shotId })) : END;
    })
    .addEdge('shot', 'join')
    // A failed superstep may mark not-yet-started tasks as NO_WRITES. On
    // recovery, dispatch those missing results again after native task replay;
    // successful sibling outputs stay in the reducer and are never resent.
    .addConditionalEdges('join', state => state.shotIds.every(id => Object.hasOwn(state.outputs, id)) ? END : 'dispatch')
    .compile({ checkpointer });
  const config = {
    configurable: { thread_id: `${runId}:media:${nodeId}`, checkpoint_ns: '' },
    durability: 'sync' as const,
    maxConcurrency: concurrency,
    recursionLimit: Math.max(25, shotIds.length * 3 + 4),
    signal,
  };
  // A media graph owns a separate durable thread. Parent checkpoint maps and
  // scratchpads must not leak through LangChain's ambient runnable config.
  return AsyncLocalStorageProviderSingleton.runWithConfig(config, async () => {
    try {
      const state = await graph.getState(config);
      signal.throwIfAborted();
      let savedShotIds: string[] = state.values.shotIds ?? [];
      let savedConcurrency: number = state.values.concurrency ?? 0;
      if (state.next.includes(START)) {
        // The first durable checkpoint still holds the input on START; the
        // shotIds state channel only receives it when that task has run.
        const initial = (await checkpointer.getTuple(config))?.checkpoint.channel_values[START];
        if (initial && typeof initial === 'object' && 'shotIds' in initial && Array.isArray(initial.shotIds) && initial.shotIds.every((id): id is string => typeof id === 'string')) savedShotIds = initial.shotIds;
        if (initial && typeof initial === 'object' && 'concurrency' in initial && typeof initial.concurrency === 'number') savedConcurrency = initial.concurrency;
      }
      const outputs: Record<string, JsonValue> = state.values.outputs ?? {};
      if (state.createdAt && (savedShotIds.length !== shotIds.length || savedShotIds.some((id, index) => id !== shotIds[index]))) {
        throw new Error('并行镜头列表已变化，不能复用原运行的检查点。');
      }
      if (state.createdAt && state.next.length && savedConcurrency !== concurrency) throw new Error('镜头并发配置已变化，不能复用原运行的检查点。');
      let resultOutputs = outputs;
      if (!state.createdAt || state.next.length) resultOutputs = (await graph.invoke(state.createdAt ? null : { shotIds: [...shotIds], concurrency }, config)).outputs;
      signal.throwIfAborted();
      if (shotIds.some(id => !Object.hasOwn(resultOutputs, id))) throw new Error('并行镜头结果尚未完整汇合，请恢复原运行继续处理。');
      return resultOutputs;
    } finally {
      // Never let runtime shutdown close SQLite or release operation ownership
      // while a cancelled provider callback is still running.
      await Promise.allSettled(inFlight);
    }
  });
}
