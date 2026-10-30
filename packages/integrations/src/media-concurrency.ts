interface Request { limit: number; signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: unknown) => void; abort: () => void }
interface ModelQueue { limits: Set<Request>; pending: Request[] }
/** Limits physical in-flight requests across projects using the same model. */
export class MediaRequestQueue {
  private readonly models = new Map<string, ModelQueue>();
  async run<T>(modelId: string, limit: number, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const model = this.models.get(modelId) ?? { limits: new Set<Request>(), pending: [] };
    this.models.set(modelId, model);
    const release = await new Promise<() => void>((resolve, reject) => {
      const request: Request = { limit, signal, resolve, reject, abort: () => {
        const index = model.pending.indexOf(request); if (index !== -1) model.pending.splice(index, 1);
        reject(signal.reason); this.pump(modelId, model);
      } };
      model.pending.push(request); signal.addEventListener('abort', request.abort, { once: true }); this.pump(modelId, model);
    });
    try { signal.throwIfAborted(); return await action(); }
    finally { release(); }
  }
  private pump(id: string, model: ModelQueue) {
    while (model.pending.length) {
      const request = model.pending[0];
      const limit = Math.min(request.limit, ...[...model.limits].map(active => active.limit));
      if (model.limits.size >= limit) break;
      model.pending.shift(); request.signal.removeEventListener('abort', request.abort);
      if (request.signal.aborted) { request.reject(request.signal.reason); continue; }
      model.limits.add(request);
      request.resolve(() => { model.limits.delete(request); this.pump(id, model); });
    }
    if (!model.limits.size && !model.pending.length) this.models.delete(id);
  }
}

/** Workers stop taking new shots after a failure, then drain in-flight receipts. */
export async function mapMediaShots<T, R>(items: readonly T[], concurrency: number, signal: AbortSignal, execute: (item: T, index: number, queueSignal: AbortSignal, fail: (error: unknown) => void) => Promise<R>): Promise<R[]> {
  const scheduling = new AbortController(), queueSignal = AbortSignal.any([signal, scheduling.signal]);
  const results = new Array<R>(items.length); let next = 0, failure: unknown;
  let failed = false;
  const fail = (error: unknown) => { if (!failed) { failed = true; failure = error; scheduling.abort(error); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { signal.throwIfAborted(); results[index] = await execute(items[index], index, queueSignal, fail); }
      catch (error) { fail(error); }
    }
  }));
  if (failed) throw failure;
  return results;
}
