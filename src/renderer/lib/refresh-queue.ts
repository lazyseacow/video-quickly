interface ReadBatch<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }

function batch<T>(): ReadBatch<T> {
  let resolve!: ReadBatch<T>['resolve'], reject!: ReadBatch<T>['reject'];
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

/** Each caller observes a read started after its request. Overlapping callers
 * share one next pass, while the current complete response remains usable. */
export function createRefreshQueue<T>(read: () => Promise<T>, onIdle?: () => void) {
  let active = false, next: ReadBatch<T> | undefined;
  async function execute(current: ReadBatch<T>) {
    try { current.resolve(await read()); }
    catch (error) { current.reject(error); }
    finally {
      const queued = next; next = undefined;
      if (queued) void execute(queued);
      else { active = false; onIdle?.(); }
    }
  }
  return () => {
    if (active) { next ??= batch<T>(); return next.promise; }
    active = true;
    const current = batch<T>(); void execute(current); return current.promise;
  };
}
