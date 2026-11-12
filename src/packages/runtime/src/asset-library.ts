import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { assetSchema, audioWaveformSchema, isJsonDocument, MAX_REFERENCE_AUDIO_BYTES, pageInputSchema, type AssetRecord, type AudioWaveform, type ProjectDocument } from '@video-quickly/contracts';
import type { DocumentStore } from './database.js';
import type { createReadModels } from './read-models.js';
import { isLegacyTimelineAsset } from './legacy-export-timeline.js';

const assetListInput = pageInputSchema.extend({
  kind: z.union([assetSchema.shape.kind, z.array(assetSchema.shape.kind).min(1).max(assetSchema.shape.kind.options.length)]).optional(),
  trashed: z.boolean().optional(), hideExportOutputs: z.boolean().optional(),
});
const assetImportInput = z.object({
  path: z.string().min(1), projectId: z.string().optional(), shotId: z.string().optional(),
  kind: assetSchema.shape.kind.optional(), purpose: z.literal('reference-audio').optional(),
});
const maxJsonPreviewBytes = 1024 * 1024;

type AssetImport = z.infer<typeof assetImportInput> & { name?: string };
type AssetLibraryMethod = 'asset.list' | 'asset.import' | 'asset.getMany' | 'asset.waveform' | 'asset.read'
  | 'asset.retain' | 'asset.delete' | 'asset.deleteMany' | 'asset.restore';

interface AssetLibraryOptions {
  directory: string;
  database: Database.Database;
  store: DocumentStore;
  reads: Pick<ReturnType<typeof createReadModels>, 'assets' | 'assetsInUse'>;
  characterAssetsInUse: (assetIds: readonly string[]) => Set<string>;
  imageToolAssetsInUse: (assetIds: readonly string[]) => Set<string>;
  project: (projectId: string) => ProjectDocument;
  bindImportedAsset: (projectId: string, shotId: string, asset: AssetRecord) => void;
  readAudioWaveform?: (asset: AssetRecord) => Promise<AudioWaveform>;
  trackWork: <T>(work: () => Promise<T>, projectId?: string) => Promise<T>;
  changed: () => void;
}

export function createAssetLibrary({ directory, database, store, reads, characterAssetsInUse, imageToolAssetsInUse,
  project, bindImportedAsset, readAudioWaveform, trackWork, changed }: AssetLibraryOptions) {
  function requireAsset(assetId: string) {
    const asset = store.get<AssetRecord>('asset', assetId);
    if (!asset || isLegacyTimelineAsset(asset)) throw new Error('素材不存在。');
    return asset;
  }

  async function importAsset(input: AssetImport, origin: 'user' | 'tool'): Promise<AssetRecord> {
    const sourcePath = resolve(input.path);
    const sourceFile = await stat(sourcePath);
    if (!sourceFile.isFile() || sourceFile.size > 2_000_000_000) throw new Error('请选择不超过 2 GB 的文件。');
    const projectForBinding = input.projectId && origin === 'user' ? project(input.projectId) : undefined;
    if (origin === 'user' && input.shotId && !projectForBinding?.shots.some(shot => shot.id === input.shotId)) throw new Error('镜头不存在。');

    const assetId = randomUUID();
    const extension = extname(sourcePath).toLowerCase();
    if (input.purpose === 'reference-audio' && (sourceFile.size <= 0 || sourceFile.size > MAX_REFERENCE_AUDIO_BYTES || !['.wav', '.mp3'].includes(extension))) {
      throw new Error('请选择不超过 15 MB 的非空 WAV 或 MP3 参考音频。');
    }
    const format = assetFormat(extension);
    if (input.kind && input.kind !== format.kind) throw new Error('文件格式与所选素材类型不一致。');
    const destinationDirectory = join(directory, 'projects', input.projectId ?? 'library', 'assets');
    const destinationPath = join(destinationDirectory, `${assetId}${extension}`);
    const stagedPath = `${destinationPath}.part`;
    await mkdir(destinationDirectory, { recursive: true });
    await copyFile(sourcePath, stagedPath);
    const fileBytes = await readFile(stagedPath);
    await rename(stagedPath, destinationPath);
    const asset = assetSchema.parse({
      id: assetId, projectId: input.projectId, shotId: input.shotId, name: input.name ?? basename(sourcePath),
      kind: input.kind ?? format.kind, path: destinationPath, mimeType: format.mimeType, size: sourceFile.size,
      sha256: createHash('sha256').update(fileBytes).digest('hex'), version: 1, createdAt: new Date().toISOString(),
      provenance: origin === 'user' ? '用户导入' : '工具导入', retained: false, active: true,
    });
    if (origin === 'tool') return asset;

    database.transaction(() => {
      store.put('asset', asset.id, asset);
      if (projectForBinding && input.shotId && ['image', 'audio', 'video'].includes(asset.kind)) {
        bindImportedAsset(projectForBinding.id, input.shotId, asset);
      }
    })();
    changed();
    return asset;
  }

  async function readAsset(rawParams: unknown) {
    const { assetId, format } = z.object({ assetId: z.string(), format: z.literal('text').optional() }).parse(rawParams);
    const asset = requireAsset(assetId);
    if (format === 'text') return readJsonAssetPreview(asset);
    if (asset.size > 50_000_000) throw new Error('该素材较大，请通过桌面文件预览打开。');
    return { dataUrl: `data:${asset.mimeType};base64,${(await readFile(asset.path)).toString('base64')}`, mimeType: asset.mimeType };
  }

  async function readWaveform(rawParams: unknown) {
    const { assetId } = z.object({ assetId: z.string().min(1) }).parse(rawParams);
    const asset = requireAsset(assetId);
    if (asset.kind !== 'audio' && asset.kind !== 'video') throw new Error('请选择音频或视频素材读取波形。');
    if (!readAudioWaveform) throw new Error('音频波形读取器尚未连接。');
    const waveform = audioWaveformSchema.parse(await trackWork(() => readAudioWaveform(asset), asset.projectId));
    if (waveform.assetId !== asset.id || waveform.sha256 !== asset.sha256) throw new Error('波形与当前素材不匹配，请重新读取。');
    return waveform;
  }

  function moveToTrash(assetIds: string[], isBatch: boolean) {
    const removedCount = database.transaction(() => {
      const assets = assetIds.map(requireAsset);
      const referenceSets = [reads.assetsInUse(assetIds), characterAssetsInUse(assetIds), imageToolAssetsInUse(assetIds)];
      const blockedAsset = assets.find(asset => asset.retained || referenceSets.some(ids => ids.has(asset.id)));
      if (blockedAsset) throw new Error(isBatch
        ? `“${blockedAsset.name}”正在使用或已保留，请重新选择后重试。`
        : '正在使用或已保留的素材不能移除。');
      const activeAssets = assets.filter(asset => asset.active !== false);
      for (const asset of activeAssets) store.put('asset', asset.id, { ...asset, active: false });
      return activeAssets.length;
    }).immediate();
    if (removedCount) changed();
    return { deleted: true };
  }

  function dispatch(method: AssetLibraryMethod, rawParams: unknown) {
    switch (method) {
      case 'asset.list': {
        const page = reads.assets(assetListInput.parse(rawParams));
        const uncheckedIds = page.items.filter(asset => !asset.inUse).map(asset => asset.id);
        if (uncheckedIds.length === 0) return page;
        const characterReferences = characterAssetsInUse(uncheckedIds);
        const imageReferences = imageToolAssetsInUse(uncheckedIds);
        return { ...page, items: page.items.map(asset => !asset.inUse && (characterReferences.has(asset.id) || imageReferences.has(asset.id))
          ? { ...asset, inUse: true } : asset) };
      }
      case 'asset.import': {
        const input = assetImportInput.parse(rawParams);
        return trackWork(() => importAsset(input, 'user'), input.projectId);
      }
      case 'asset.getMany': {
        const { assetIds } = z.object({ assetIds: z.array(z.string().min(1)).max(100) }).parse(rawParams);
        return [...new Set(assetIds)].flatMap(assetId => {
          const asset = store.get<AssetRecord>('asset', assetId);
          return asset && !isLegacyTimelineAsset(asset) ? [asset] : [];
        });
      }
      case 'asset.waveform': return readWaveform(rawParams);
      case 'asset.read': return readAsset(rawParams);
      case 'asset.retain': {
        const { assetId, retained } = z.object({ assetId: z.string(), retained: z.boolean() }).parse(rawParams);
        const updatedAsset = { ...requireAsset(assetId), retained };
        store.put('asset', assetId, updatedAsset);
        changed();
        return updatedAsset;
      }
      case 'asset.delete': {
        const { assetId } = z.object({ assetId: z.string() }).parse(rawParams);
        return moveToTrash([assetId], false);
      }
      case 'asset.deleteMany': {
        const { assetIds } = z.object({ assetIds: z.array(z.string().min(1)).min(1) }).parse(rawParams);
        return moveToTrash([...new Set(assetIds)], true);
      }
      case 'asset.restore': {
        const { assetId } = z.object({ assetId: z.string().min(1) }).parse(rawParams);
        const restored = database.transaction(() => {
          const asset = requireAsset(assetId);
          if (asset.active !== false) return false;
          store.put('asset', assetId, { ...asset, active: true });
          return true;
        }).immediate();
        if (restored) changed();
        return { restored: true };
      }
    }
  }

  return { dispatch, importToolAsset: (input: AssetImport) => importAsset(input, 'tool') };
}

async function readJsonAssetPreview(asset: AssetRecord) {
  if (!isJsonDocument(asset)) throw new Error('请选择 JSON 文件预览。');
  const chunks: Buffer[] = [];
  try {
    // The inclusive end reads one extra byte to detect truncation even after a file change.
    for await (const chunk of createReadStream(asset.path, { start: 0, end: maxJsonPreviewBytes })) chunks.push(chunk);
  } catch (error) {
    throw new Error('无法读取 JSON 文件，请检查素材文件。', { cause: error });
  }
  const bytes = Buffer.concat(chunks);
  const truncated = bytes.length > maxJsonPreviewBytes;
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(encoding).decode(bytes.subarray(0, maxJsonPreviewBytes), { stream: truncated });
  return { text, truncated };
}

function assetFormat(extension: string): { kind: AssetRecord['kind']; mimeType: string } {
  const formats: Record<string, { kind: AssetRecord['kind']; mimeType: string }> = {
    '.svg': { kind: 'image', mimeType: 'image/svg+xml' }, '.png': { kind: 'image', mimeType: 'image/png' }, '.jpg': { kind: 'image', mimeType: 'image/jpeg' }, '.jpeg': { kind: 'image', mimeType: 'image/jpeg' }, '.webp': { kind: 'image', mimeType: 'image/webp' },
    '.mp4': { kind: 'video', mimeType: 'video/mp4' }, '.webm': { kind: 'video', mimeType: 'video/webm' }, '.mov': { kind: 'video', mimeType: 'video/quicktime' },
    '.mp3': { kind: 'audio', mimeType: 'audio/mpeg' }, '.wav': { kind: 'audio', mimeType: 'audio/wav' }, '.m4a': { kind: 'audio', mimeType: 'audio/mp4' }, '.ogg': { kind: 'audio', mimeType: 'audio/ogg' },
    '.srt': { kind: 'subtitle', mimeType: 'text/plain' }, '.ass': { kind: 'subtitle', mimeType: 'text/plain' }, '.pdf': { kind: 'document', mimeType: 'application/pdf' }, '.txt': { kind: 'document', mimeType: 'text/plain' }, '.md': { kind: 'document', mimeType: 'text/markdown' },
    '.json': { kind: 'document', mimeType: 'application/json' },
  };
  const format = formats[extension];
  if (!format) throw new Error('暂不支持该文件格式。');
  return format;
}
