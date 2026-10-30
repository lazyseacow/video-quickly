import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordPage } from '@video-quickly/contracts';
import { rpc } from './client';

export function useRecordPage<T extends { id: string }>(method: string, params: Record<string, unknown>, version: number, schema: { parse: (value: unknown) => RecordPage<T> }, resetKey?: number, { keepPreviousData = false }: { keepPreviousData?: boolean } = {}) {
  const [data, setData] = useState<RecordPage<T>>({ items: [], nextCursor: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hasLoaded, setHasLoaded] = useState(false);
  const [resolvedQuery, setResolvedQuery] = useState('');
  const generation = useRef(0);
  const retained = useRef(data); retained.current = data;
  const key = JSON.stringify(params);
  const queryIdentity = JSON.stringify([method, key]);
  const currentQuery = useRef({ method, key });
  const changingQuery = currentQuery.current.method !== method || currentQuery.current.key !== key;
  const loading = useRef(false);
  const [refreshId, setRefreshId] = useState(0);
  const refresh = useCallback(() => setRefreshId(value => value + 1), []);
  const replace = useCallback((item: T) => setData(previous => ({ ...previous, items: previous.items.map(current => current.id === item.id ? item : current) })), []);
  useEffect(() => {
    const request = ++generation.current;
    const changedFilter = currentQuery.current.method !== method || currentQuery.current.key !== key;
    currentQuery.current = { method, key };
    if (changedFilter) {
      setError('');
      if (!keepPreviousData) { setData({ items: [], nextCursor: null }); setHasLoaded(false); }
    }
    loading.current = true; setBusy(true);
    const input = JSON.parse(key) as Record<string, unknown>;
    const pageSize = typeof input.limit === 'number' ? input.limit : 100;
    const target = changedFilter ? pageSize : Math.max(pageSize, retained.current.items.length);
    async function revalidate() {
      let next = schema.parse(await rpc(method, { ...input, limit: Math.min(100, target) }));
      const items = next.items;
      const ids = new Set(items.map(item => item.id));
      // Refresh the loaded range so changes in later pages do not survive indefinitely.
      while (next.nextCursor !== null && items.length < target) {
        if (request !== generation.current) return;
        next = schema.parse(await rpc(method, { ...input, before: next.nextCursor, limit: Math.min(100, target - items.length) }));
        for (const item of next.items) if (!ids.has(item.id)) { ids.add(item.id); items.push(item); }
      }
      if (request !== generation.current) return;
      setData({ items, nextCursor: next.nextCursor }); setResolvedQuery(queryIdentity); setHasLoaded(true); setError('');
    }
    void revalidate().catch(error => { if (request === generation.current) { if (changedFilter) { setData({ items: [], nextCursor: null }); setHasLoaded(false); } setError(error instanceof Error ? error.message : String(error)); } })
      .finally(() => { if (request === generation.current) { loading.current = false; setBusy(false); } });
    return () => { generation.current++; };
  }, [method, key, version, schema, refreshId, resetKey, keepPreviousData]);
  async function loadMore() {
    if (changingQuery || loading.current || data.nextCursor === null) return;
    const request = generation.current;
    loading.current = true; setBusy(true);
    try {
      const next = schema.parse(await rpc(method, { limit: 100, ...params, before: data.nextCursor }));
      if (request !== generation.current) return;
      setData(previous => { const ids = new Set(previous.items.map(item => item.id)); return { items: [...previous.items, ...next.items.filter(item => !ids.has(item.id))], nextCursor: next.nextCursor }; });
      setError('');
    } catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (request === generation.current) { loading.current = false; setBusy(false); } }
  }
  return { ...data, busy: busy || changingQuery, stale: hasLoaded && resolvedQuery !== queryIdentity, hasLoaded, error, refresh, loadMore, replace };
}
