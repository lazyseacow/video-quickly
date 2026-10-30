import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { rpc } from './client';
import { createRefreshQueue } from './refresh-queue';

/** Refreshing a query keeps completed responses usable; only changing its identity
 * or unmounting invalidates a response. Reads never retry a failed operation. */
export function useRuntimeRead<T>(method: string, params: Record<string, unknown>, version: number, schema: { parse: (value: unknown) => T }) {
  const parameters = JSON.stringify(params);
  const query = useMemo(() => {
    let state: { data?: T; error: string; busy: boolean } = { error: '', busy: true };
    let observedVersion: number | undefined;
    let failed = false;
    const listeners = new Set<() => void>();
    function publish(next: typeof state) { state = next; for (const listener of listeners) listener(); }
    const read = createRefreshQueue(async () => {
      // A notification queued before the failure must not silently retry it.
      if (failed) return;
      publish({ ...state, busy: true });
      try {
        const data = schema.parse(await rpc(method, JSON.parse(parameters)));
        publish({ data, error: '', busy: false });
      } catch (error) {
        failed = true;
        publish({ ...state, error: error instanceof Error ? error.message : String(error), busy: false });
      }
    });
    return {
      snapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      refresh: () => { failed = false; void read(); },
      observe: (version: number) => { if (version !== observedVersion) { observedVersion = version; if (!failed) void read(); } },
    };
  }, [method, parameters, schema]);
  const current = useSyncExternalStore(query.subscribe, query.snapshot);
  // Strict Mode's effect reattachment observes the same version and reuses its read.
  useEffect(() => { query.observe(version); }, [query, version]);
  return { ...current, refresh: query.refresh };
}
