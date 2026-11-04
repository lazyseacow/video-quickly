import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { assetSchema, imageGridRectangles, imageRectangleSchema, type AssetRecord } from '@video-quickly/contracts';
import type { DocumentStore } from './database.js';
import { fingerprint } from './activities.js';

const assetInput = z.object({ assetId: z.string().min(1) });
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function verifiedToolImage(asset: AssetRecord | undefined): Promise<Buffer> {
  if (!asset?.active || asset.kind !== 'image' || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType)) throw new Error('请选择有效的 PNG、JPEG 或 WebP 图片。');
  const info = await stat(asset.path).catch(() => undefined);
  if (!info?.isFile() || info.size <= 0 || info.size > 20 * 1024 * 1024 || info.size !== asset.size) throw new Error('原图缺失、已修改或超过 20 MiB，请重新导入。');
  const bytes = await readFile(asset.path);
  if (bytes.length !== asset.size || digest(bytes) !== asset.sha256) throw new Error('原图校验失败，请重新导入。');
  return bytes;
}

export function createImageTools({ store, directory, changed }: { store: DocumentStore; directory: string; changed(): void }) {
  const pending = new Map<string, Promise<AssetRecord[]>>();
  function assetsInUse(ids: readonly string[]): Set<string> {
    if (!ids.length) return new Set();
    const rows = store.database.prepare(`SELECT DISTINCT id FROM (
      SELECT json_extract(body, '$.derivation.sourceAssetId') AS id FROM documents WHERE kind = 'asset' AND json_extract(body, '$.active') = 1
      UNION SELECT json_extract(a.value, '$.id') AS id FROM documents s, json_each(s.body, '$.assets') a WHERE s.kind = 'run-snapshot' AND json_type(s.body, '$.regeneration.imageEdit') = 'object'
    ) WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as { id: string }[];
    return new Set(rows.map(row => row.id));
  }
  async function dimensions(raw: unknown) {
    const { assetId } = assetInput.parse(raw), asset = store.get<AssetRecord>('asset', assetId);
    const bytes = await verifiedToolImage(asset);
    const { imageDimensions } = await import('@video-quickly/video/image-tools');
    return { assetId, sha256: asset!.sha256, ...await imageDimensions(bytes) };
  }
  async function create(raw: unknown, kind: 'grid-crop' | 'edit-mask') {
    const input = kind === 'grid-crop'
      ? assetInput.extend({ rows: z.number().int().min(1).max(8), columns: z.number().int().min(1).max(8) }).strict().parse(raw)
      : assetInput.extend({ rectangle: imageRectangleSchema }).strict().parse(raw);
    const source = store.get<AssetRecord>('asset', input.assetId), bytes = await verifiedToolImage(source);
    const tools = await import('@video-quickly/video/image-tools');
    const size = await tools.imageDimensions(bytes);
    const rectangles = 'rows' in input ? imageGridRectangles(size.width, size.height, input.rows, input.columns) : [input.rectangle];
    const key = fingerprint({ version: 1, kind, sourceId: source!.id, sha256: source!.sha256, rectangles });
    const operation = async () => {
      const saved = store.get<{ assetIds: string[] }>('image-operation', key);
      if (saved) {
        const assets = saved.assetIds.map(id => store.get<AssetRecord>('asset', id));
        for (const asset of assets) await verifiedToolImage(asset);
        return assets as AssetRecord[];
      }
      const outputs = kind === 'grid-crop' ? await tools.cropToolImage(bytes, rectangles) : [await tools.createEditMask(bytes, rectangles[0])];
      if (kind === 'edit-mask') await tools.validateEditMask(outputs[0], size);
      const folder = join(directory, 'projects', source!.projectId ?? 'library', 'assets'); await mkdir(folder, { recursive: true });
      const assets: AssetRecord[] = [];
      for (let index = 0; index < outputs.length; index++) {
        const output = outputs[index], id = `image-${key}-${index}`, path = join(folder, `${id}.png`);
        await writeFile(`${path}.part`, output); await rename(`${path}.part`, path);
        assets.push(assetSchema.parse({ id, projectId: source!.projectId, name: kind === 'grid-crop' ? `${source!.name} · 切图 ${index + 1}` : `${source!.name} · 修改区域`, kind: 'image', mimeType: 'image/png', path, size: output.length, sha256: digest(output), version: 1,
          width: kind === 'grid-crop' ? rectangles[index].width : size.width, height: kind === 'grid-crop' ? rectangles[index].height : size.height,
          provenance: kind === 'grid-crop' ? '网格切图' : '局部改图遮罩', createdAt: new Date().toISOString(), active: true, retained: false,
          derivation: { kind, sourceAssetId: source!.id, sourceSha256: source!.sha256, rectangle: rectangles[index], sourceWidth: size.width, sourceHeight: size.height, ...('rows' in input ? { grid: { rows: input.rows, columns: input.columns, index } } : {}) } }));
      }
      store.database.transaction(() => {
        for (const asset of assets) store.put('asset', asset.id, asset);
        store.put('image-operation', key, { assetIds: assets.map(asset => asset.id) });
      })(); changed(); return assets;
    };
    const current = pending.get(key); if (current) return current;
    const next = operation(); pending.set(key, next);
    try { return await next; } finally { pending.delete(key); }
  }
  return { dimensions, assetsInUse, cutGrid: (input: unknown) => create(input, 'grid-crop'), async mask(input: unknown) { return (await create(input, 'edit-mask'))[0]; } };
}
