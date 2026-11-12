import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordPage } from '@video-quickly/contracts';
import { rpc } from './client';

export function useRecordPage<T extends { id: string }>(method: string, params: Record<string, unknown>, version: number, schema: { parse: (value: unknown) => RecordPage<T> }, resetKey?: number, { keepPreviousData = false }: { keepPreviousData?: boolean } = {}) {
  const [data, setData] = useState<RecordPage<T>>({ items: [], nextCursor: null });
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [hasLoaded, setHasLoaded] = useState(false);
  const [resolvedQuery, setResolvedQuery] = useState('');
  const generation = useRef(0);
  // The current query owns its range even while previous-filter rows remain visible.
  // Cursor and IDs advance with that range before React commits the new page.
  const range = useRef<{ loaded: number; requested: number; query: string; nextCursor: number | null; ids: Set<string> }>({ loaded: 0, requested: 0, query: '', nextCursor: null, ids: new Set() });
  const key = JSON.stringify(params);
  const queryIdentity = JSON.stringify([method, key]);
  const currentQuery = useRef({ method, key });
  const changingQuery = currentQuery.current.method !== method || currentQuery.current.key !== key;
  const loading = useRef(false);
  const paging = useRef(false);
  const [refreshId, setRefreshId] = useState(0);
  const refresh = useCallback(() => setRefreshId(value => value + 1), []);
  const replace = useCallback((item: T) => setData(previous => ({ ...previous, items: previous.items.map(current => current.id === item.id ? item : current) })), []);
  useEffect(() => {
    const request = ++generation.current;
    const changedFilter = currentQuery.current.method !== method || currentQuery.current.key !== key;
    currentQuery.current = { method, key };
    if (changedFilter) {
      range.current = { loaded: 0, requested: 0, query: '', nextCursor: null, ids: new Set() };
      paging.current = false; setLoadingMore(false);
      setError('');
      if (!keepPreviousData) { setData({ items: [], nextCursor: null }); setHasLoaded(false); }
    }
    loading.current = true; setBusy(true);
    const input = JSON.parse(key) as Record<string, unknown>;
    const pageSize = typeof input.limit === 'number' ? input.limit : 100;
    const target = () => Math.max(pageSize, range.current.loaded, range.current.requested);
    async function revalidate() {
      let next = schema.parse(await rpc(method, { ...input, limit: Math.min(100, target()) }));
      const items = next.items;
      const ids = new Set(items.map(item => item.id));
      // Refresh the loaded range so changes in later pages do not survive indefinitely.
      // A load-more click can extend this read while its first page is pending.
      while (next.nextCursor !== null && items.length < target()) {
        if (request !== generation.current) return;
        next = schema.parse(await rpc(method, { ...input, before: next.nextCursor, limit: Math.min(100, target() - items.length) }));
        for (const item of next.items) if (!ids.has(item.id)) { ids.add(item.id); items.push(item); }
      }
      if (request !== generation.current) return;
      range.current = { loaded: items.length, requested: items.length, query: queryIdentity, nextCursor: next.nextCursor, ids };
      setData({ items, nextCursor: next.nextCursor }); setResolvedQuery(queryIdentity); setHasLoaded(true); setError('');
    }
    void revalidate().catch(error => { if (request === generation.current) { range.current.requested = range.current.loaded; if (changedFilter) { setData({ items: [], nextCursor: null }); setHasLoaded(false); } setError(error instanceof Error ? error.message : String(error)); } })
      .finally(() => { if (request === generation.current) { loading.current = false; paging.current = false; setBusy(false); setLoadingMore(false); } });
    return () => { generation.current++; };
  }, [method, key, version, schema, refreshId, resetKey, keepPreviousData]);
  async function loadMore() {
    if (changingQuery || resolvedQuery !== queryIdentity || range.current.query !== queryIdentity || currentQuery.current.method !== method || currentQuery.current.key !== key || paging.current || range.current.nextCursor === null) return;
    range.current.requested = range.current.loaded + (typeof params.limit === 'number' ? params.limit : 100);
    paging.current = true; setLoadingMore(true);
    // The active validation owns the current cursor and consumes this intent.
    if (loading.current) return;
    const request = generation.current;
    loading.current = true; setBusy(true);
    try {
      const next = schema.parse(await rpc(method, { limit: 100, ...params, before: range.current.nextCursor }));
      if (request !== generation.current) return;
      const ids = new Set(range.current.ids);
      for (const item of next.items) ids.add(item.id);
      const loaded = ids.size;
      range.current = { loaded, requested: loaded, query: queryIdentity, nextCursor: next.nextCursor, ids };
      setData(previous => { const ids = new Set(previous.items.map(item => item.id)); return { items: [...previous.items, ...next.items.filter(item => !ids.has(item.id))], nextCursor: next.nextCursor }; });
      setError('');
    } catch (error) { if (request === generation.current) { range.current.requested = range.current.loaded; setError(error instanceof Error ? error.message : String(error)); } }
    finally { if (request === generation.current) { loading.current = false; paging.current = false; setBusy(false); setLoadingMore(false); } }
  }
  return { ...data, busy: busy || changingQuery, loadingMore, canLoadMore: !changingQuery && resolvedQuery === queryIdentity && range.current.query === queryIdentity && range.current.nextCursor !== null && !loadingMore, stale: hasLoaded && resolvedQuery !== queryIdentity, hasLoaded, error, refresh, loadMore, replace };
}
