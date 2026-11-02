import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AssetRecord } from '@video-quickly/contracts';
import { assetAvailabilityUrl, assetAvailabilityVersion, refreshAssetAvailability } from '../apps/desktop/src/lib/asset-availability';
import { previewAssetKey } from '../apps/desktop/src/components/preview-media';
import { ThumbnailCache } from '../apps/desktop/src/components/preview-thumbnails';

describe('transient asset availability', () => {
  it('invalidates only repaired content requests without changing the frozen asset identity', async () => {
    const id = randomUUID(), other = randomUUID();
    const asset: AssetRecord = { id, path: '/workspace/projects/p/assets/movie.mp4', kind: 'video', name: 'movie', sha256: 'a'.repeat(64), size: 10, version: 3, mimeType: 'video/mp4', createdAt: '', provenance: '', active: true, retained: false };
    const original = structuredClone(asset), before = previewAssetKey(asset);
    let decoded = 0; const cache = new ThumbnailCache(async () => ({ width: 1, height: 1, decoded: ++decoded }));
    const input = { asset, width: 1, height: 1, timeUs: 123_000 }, signal = new AbortController().signal;
    expect((await cache.read(input, signal)).decoded).toBe(1); expect((await cache.read(input, signal)).decoded).toBe(1);
    refreshAssetAvailability([id, id]);
    expect(assetAvailabilityVersion(id)).toBeGreaterThan(0); expect(assetAvailabilityVersion(other)).toBe(0);
    expect(previewAssetKey(asset)).not.toBe(before); expect(asset).toEqual(original);
    expect((await cache.read(input, signal)).decoded).toBe(2);
  });

  it.each(['C:\\视频素材\\原始 #1&2.mp4', '/Users/you/视频素材/原始 #1&2.mp4'])('preserves the original native and HTTP path query for %s', path => {
    const id = randomUUID(), native = `video-quickly://app/__asset?path=${encodeURIComponent(path)}#frame`, http = `/__desktop_asset?path=${encodeURIComponent(path)}`;
    expect(assetAvailabilityUrl(native, id)).toBe(native); refreshAssetAvailability([id]);
    for (const original of [native, http]) {
      const url = new URL(assetAvailabilityUrl(original, id), 'http://127.0.0.1:1421');
      expect(url.searchParams.get('path')).toBe(path); expect(url.searchParams.get('availability')).toBe(String(assetAvailabilityVersion(id)));
      expect(url.hash).toBe(original.includes('#frame') ? '#frame' : '');
    }
    for (const url of ['data:image/svg+xml,%3Csvg/%3E', 'blob:http://127.0.0.1:1421/saved']) expect(assetAvailabilityUrl(url, id)).toBe(url);
  });
});
