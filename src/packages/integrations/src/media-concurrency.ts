interface Request { signal: AbortSignal; limit: number; resolve: (release: () => void) => void; reject: (error: unknown) => void; abort: () => void }
interface ModelQueue { active: number; limit: number; pending: Request[] }
/** Applies one shared limit per model, with serial requests taking an exclusive slot. */
export class MediaRequestQueue {
  private readonly models = new Map<string, ModelQueue>();
  async run<T>(modelId: string, signal: AbortSignal, action: () => Promise<T>, limit = 1): Promise<T> {
    signal.throwIfAborted();
    const model = this.models.get(modelId) ?? { active: 0, limit, pending: [] };
    this.models.set(modelId, model);
    const release = await new Promise<() => void>((resolve, reject) => {
      const request: Request = { signal, limit, resolve, reject, abort: () => {
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
      if (model.active && model.active >= Math.min(model.limit, model.pending[0].limit)) return;
      const request = model.pending.shift()!;
      request.signal.removeEventListener('abort', request.abort);
      if (request.signal.aborted) { request.reject(request.signal.reason); continue; }
      if (!model.active) model.limit = request.limit;
      model.active++;
      request.resolve(() => { model.active--; this.pump(id, model); });
    }
    if (!model.active) this.models.delete(id);
  }
}
