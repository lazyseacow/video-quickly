import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assetSchema, imageGridRectangles, type AssetRecord } from '@video-quickly/contracts';
import { DocumentStore, openDatabase } from '../../src/packages/runtime/src/database';
import { cropToolImage, imageDimensions } from '../../src/packages/video/src/image-tools';

export async function seedLegacyGridAsset(directory: string, source: AssetRecord, columns = 2) {
  const bytes = await readFile(source.path);
  const { width, height } = await imageDimensions(bytes);
  const [rectangle] = imageGridRectangles(width, height, 1, columns);
  const [crop] = await cropToolImage(bytes, [rectangle]);
  const id = randomUUID();
  const path = join(dirname(source.path), `${id}.png`);
  const asset = assetSchema.parse({
    ...source, id, path, name: '旧版裁切参考图.png', size: crop.length, sha256: createHash('sha256').update(crop).digest('hex'),
    width: rectangle.width, height: rectangle.height,
    derivation: { kind: 'grid-crop', sourceAssetId: source.id, sourceSha256: source.sha256, rectangle,
      sourceWidth: width, sourceHeight: height, grid: { rows: 1, columns, index: 0 } },
  });
  await writeFile(path, crop);
  const database = openDatabase(directory);
  try { new DocumentStore(database).put('asset', id, asset); }
  finally { database.close(); }
  return asset;
}
