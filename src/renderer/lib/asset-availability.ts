import { useSyncExternalStore } from 'react';
import { subscribe } from './client';

// Availability is transient filesystem state, independent of frozen content identity.
const versions = new Map<string, number>();
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;
let version = 0;

export function refreshAssetAvailability(assetIds: readonly string[]) {
  const ids = [...new Set(assetIds)].filter(Boolean);
  if (!ids.length) return;
  version++;
  for (const id of ids) versions.set(id, version);
  for (const listener of listeners) listener();
}

function observe(listener: () => void) {
  listeners.add(listener);
  if (!stop) stop = subscribe(event => {
    if (event.type !== 'workspace.changed' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
    const ids = event.data.repairedAssetIds;
    if (Array.isArray(ids)) refreshAssetAvailability(ids.filter((id): id is string => typeof id === 'string'));
  });
  return () => { listeners.delete(listener); if (!listeners.size) { stop?.(); stop = undefined; } };
}

export const assetAvailabilityVersion = (id?: string) => id ? versions.get(id) ?? 0 : 0;
export function useAssetAvailability(id?: string): number {
  return useSyncExternalStore(observe, () => assetAvailabilityVersion(id), () => 0);
}
export function useAssetAvailabilityKey(ids: readonly (string | undefined)[]): string {
  return useSyncExternalStore(observe, () => JSON.stringify(ids.map(assetAvailabilityVersion)), () => '[]');
}

/** A new request URL also invalidates a browser's cached failure for the same path. */
export function assetAvailabilityUrl(url: string, assetId: string): string {
  const current = assetAvailabilityVersion(assetId);
  if (!current || /^(?:blob|data):/.test(url)) return url;
  const hash = url.indexOf('#'), path = hash < 0 ? url : url.slice(0, hash), suffix = hash < 0 ? '' : url.slice(hash);
  return `${path}${path.includes('?') ? '&' : '?'}availability=${current}${suffix}`;
}
