interface Request { signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: unknown) => void; abort: () => void }
interface ModelQueue { active: boolean; pending: Request[] }
/** Allows one in-flight request per model across projects. */
export class MediaRequestQueue {
  private readonly models = new Map<string, ModelQueue>();
  async run<T>(modelId: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const model = this.models.get(modelId) ?? { active: false, pending: [] };
    this.models.set(modelId, model);
    const release = await new Promise<() => void>((resolve, reject) => {
      const request: Request = { signal, resolve, reject, abort: () => {
        const index = model.pending.indexOf(request); if (index !== -1) model.pending.splice(index, 1);
        reject(signal.reason); this.pump(modelId, model);
      } };
      model.pending.push(request); signal.addEventListener('abort', request.abort, { once: true }); this.pump(modelId, model);
    });
    try { signal.throwIfAborted(); return await action(); }
    finally { release(); }
  }
  private pump(id: string, model: ModelQueue) {
    if (model.active) return;
    while (model.pending.length) {
      const request = model.pending.shift()!;
      request.signal.removeEventListener('abort', request.abort);
      if (request.signal.aborted) { request.reject(request.signal.reason); continue; }
      model.active = true;
      request.resolve(() => { model.active = false; this.pump(id, model); });
      return;
    }
    this.models.delete(id);
  }
}
