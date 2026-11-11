import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { assetSchema, imageRectangleSchema, type AssetRecord } from '@video-quickly/contracts';
import type { DocumentStore } from './database.js';
import { fingerprint } from './activities.js';

const assetInput = z.object({ assetId: z.string().min(1) });
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function verifiedToolImage(asset: AssetRecord | undefined, maximumBytes = 20 * 1024 * 1024) {
  if (!asset?.active || asset.kind !== 'image' || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType)) throw new Error('请选择有效的 PNG、JPEG 或 WebP 图片。');
  const info = await stat(asset.path).catch(() => undefined);
  if (!info?.isFile() || info.size <= 0 || info.size > maximumBytes || info.size !== asset.size) throw new Error('原图缺失、已修改或超过 20 MiB，请重新导入。');
  const bytes = await readFile(asset.path);
  if (bytes.length !== asset.size || digest(bytes) !== asset.sha256) throw new Error('原图校验失败，请重新导入。');
  return { asset, bytes };
}

export async function readAssetImageDimensions(source: AssetRecord | undefined) {
  const { asset, bytes } = await verifiedToolImage(source);
  const { imageDimensions } = await import('@video-quickly/video/image-tools');
  return { assetId: asset.id, sha256: asset.sha256, ...await imageDimensions(bytes) };
}

export function createImageTools({ store, directory, changed }: { store: DocumentStore; directory: string; changed(): void }) {
  const pending = new Map<string, Promise<AssetRecord>>();
  function assetsInUse(ids: readonly string[]): Set<string> {
    if (!ids.length) return new Set();
    // Seek each requested source through the partial index before checking frozen inputs.
    const rows = store.database.prepare<[ids: string], { id: string }>(`
      WITH requested(id) AS (SELECT value FROM json_each(?))
      SELECT requested.id FROM requested WHERE EXISTS (
        SELECT 1 FROM documents AS derived
        WHERE derived.kind = 'asset' AND json_extract(derived.body, '$.active') = 1
          AND json_type(derived.body, '$.derivation.sourceAssetId') = 'text'
          AND json_extract(derived.body, '$.derivation.sourceAssetId') = requested.id
      )
      UNION
      SELECT json_extract(asset.value, '$.id') AS id
        FROM documents AS snapshot, json_each(snapshot.body, '$.assets') AS asset
        WHERE snapshot.kind = 'run-snapshot' AND json_type(snapshot.body, '$.regeneration.imageEdit') = 'object'
          AND json_extract(asset.value, '$.id') IN (SELECT id FROM requested)
    `).all(JSON.stringify(ids));
    return new Set(rows.map(row => row.id));
  }
  async function dimensions(raw: unknown) {
    const { assetId } = assetInput.parse(raw);
    return readAssetImageDimensions(store.get<AssetRecord>('asset', assetId));
  }
  async function mask(raw: unknown) {
    const { assetId, rectangle } = assetInput.extend({ rectangle: imageRectangleSchema }).strict().parse(raw);
    const { asset: source, bytes } = await verifiedToolImage(store.get<AssetRecord>('asset', assetId));
    const tools = await import('@video-quickly/video/image-tools');
    const size = await tools.imageDimensions(bytes);
    const kind = 'edit-mask';
    const key = fingerprint({ version: 1, kind, sourceId: source.id, sha256: source.sha256, rectangles: [rectangle] });
    const operation = async () => {
      const saved = store.get<{ assetIds: string[] }>('image-operation', key);
      const id = saved?.assetIds[0];
      const previous = id ? store.get<AssetRecord>('asset', id) : undefined;
      const requireSource = () => {
        const current = store.get<AssetRecord>('asset', source.id);
        if (!current?.active || current.sha256 !== source.sha256 || current.path !== source.path) throw new Error('原图在处理期间已变更，请重新选择。');
      };
      if (previous && await verifiedToolImage(previous, previous.size).then(() => true, () => false)) {
        requireSource();
        return previous;
      }
      const output = await tools.createEditMask(bytes, rectangle);
      await tools.validateEditMask(output, size);
      const folder = join(directory, 'projects', source.projectId ?? 'library', 'assets');
      await mkdir(folder, { recursive: true });
      const sha256 = digest(output);
      const baseId = `image-${key}-0`;
      const unchanged = previous?.sha256 === sha256 ? previous : undefined;
      const maskId = unchanged?.id ?? (previous ? `${baseId}-${sha256}` : baseId);
      const path = unchanged?.path ?? join(folder, `${maskId}.png`);
      await writeFile(`${path}.part`, output);
      await rename(`${path}.part`, path);
      const asset = unchanged ? { ...unchanged, active: true } : assetSchema.parse({
        id: maskId, projectId: source.projectId, name: `${source.name} · 修改区域`, kind: 'image', mimeType: 'image/png',
        path, size: output.length, sha256, version: 1, ...size, provenance: '局部改图遮罩', createdAt: new Date().toISOString(), active: true, retained: false,
        derivation: { kind, sourceAssetId: source.id, sourceSha256: source.sha256, rectangle, sourceWidth: size.width, sourceHeight: size.height },
      });
      store.database.transaction(() => {
        requireSource();
        store.put('asset', asset.id, asset);
        store.put('image-operation', key, { assetIds: [asset.id] });
      })();
      changed();
      return asset;
    };
    const current = pending.get(key); if (current) return current;
    const next = operation(); pending.set(key, next);
    try { return await next; } finally { pending.delete(key); }
  }
  return { dimensions, assetsInUse, mask };
}
