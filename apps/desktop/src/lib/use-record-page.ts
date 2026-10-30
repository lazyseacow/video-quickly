import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordPage } from '@video-quickly/contracts';
import { rpc } from './client';

export function useRecordPage<T extends { id: string }>(method: string, params: Record<string, unknown>, version: number, schema: { parse: (value: unknown) => RecordPage<T> }, resetKey?: number) {
  const [data, setData] = useState<RecordPage<T>>({ items: [], nextCursor: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const key = JSON.stringify(params);
  const currentKey = useRef(key);
  const currentReset = useRef(resetKey);
  const loading = useRef(false);
  const [refreshId, setRefreshId] = useState(0);
  const refresh = useCallback(() => setRefreshId(value => value + 1), []);
  const replace = useCallback((item: T) => setData(previous => ({ ...previous, items: previous.items.map(current => current.id === item.id ? item : current) })), []);
  useEffect(() => {
    const request = ++generation.current;
    const reset = currentKey.current !== key || currentReset.current !== resetKey;
    currentKey.current = key; currentReset.current = resetKey;
    if (reset) setData({ items: [], nextCursor: null });
    loading.current = true; setBusy(true);
    void rpc(method, { limit: 100, ...JSON.parse(key) }).then(value => {
      if (request !== generation.current) return;
      const next = schema.parse(value);
      setData(previous => {
        const ids = new Set(next.items.map(item => item.id));
        // New records can push the old first page into the retained history.
        const boundary = previous.items.findLastIndex(item => ids.has(item.id));
        const tail = reset || boundary < 0 || next.nextCursor === null ? [] : previous.items.slice(boundary + 1).filter(item => !ids.has(item.id));
        return { items: [...next.items, ...tail], nextCursor: tail.length ? previous.nextCursor : next.nextCursor };
      }); setError('');
    }).catch(error => { if (request === generation.current) setError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (request === generation.current) { loading.current = false; setBusy(false); } });
    return () => { generation.current++; };
  }, [method, key, version, schema, refreshId, resetKey]);
  async function loadMore() {
    if (loading.current || data.nextCursor === null) return;
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
  return { ...data, busy, error, refresh, loadMore, replace };
}
