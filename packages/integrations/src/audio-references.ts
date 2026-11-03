import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { MAX_REFERENCE_AUDIO_BYTES, type AssetRecord } from '@video-quickly/contracts';

export interface ReferenceAudio { assetId: string; dataUrl: string }

export async function resolveReferenceAudio({ assetIds, assets, projectId, signal }: {
  assetIds: readonly string[]; assets: AssetRecord[]; projectId: string; signal?: AbortSignal;
}): Promise<ReferenceAudio[]> {
  const available = new Map(assets.map(asset => [asset.id, asset]));
  const result: ReferenceAudio[] = [];
  let encodedBytes = 0;
  for (const id of assetIds) {
    signal?.throwIfAborted();
    const asset = available.get(id);
    if (!asset?.active || asset.kind !== 'audio' || asset.projectId && asset.projectId !== projectId) throw new Error('参考音频已移除或不属于当前项目，请重新添加。');
    if (!['audio/wav', 'audio/mpeg'].includes(asset.mimeType)) throw new Error(`参考音频「${asset.name}」须使用 WAV 或 MP3 格式。`);
    const info = await stat(asset.path).catch(() => undefined);
    if (!info?.isFile() || info.size <= 0 || info.size !== asset.size) throw new Error(`参考音频「${asset.name}」缺失、为空或已更改，请重新导入。`);
    if (info.size > MAX_REFERENCE_AUDIO_BYTES) throw new Error(`参考音频「${asset.name}」超过 15 MB，请压缩后重新导入。`);
    const prefix = `data:audio/${asset.mimeType === 'audio/mpeg' ? 'mp3' : 'wav'};base64,`;
    encodedBytes += prefix.length + 4 * Math.ceil(info.size / 3);
    if (encodedBytes > 64_000_000) throw new Error('参考音频编码后超过 64 MB 请求限制，请压缩或减少文件。');
    const bytes = await readFile(asset.path, { signal });
    if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`参考音频「${asset.name}」校验失败，请重新导入。`);
    result.push({ assetId: asset.id, dataUrl: prefix + bytes.toString('base64') });
  }
  return result;
}
