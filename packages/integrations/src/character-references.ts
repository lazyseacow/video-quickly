import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { characterProfileSchema, type AssetRecord, type CharacterProfile, type Shot } from '@video-quickly/contracts';

export const MAX_CHARACTER_REFERENCE_BYTES = 20 * 1024 * 1024;
export const MAX_CHARACTER_REFERENCE_TOTAL_BYTES = 64 * 1024 * 1024;
export interface CharacterReferenceImage { assetId: string; mimeType: string; dataUrl: string }
export interface ResolvedCharacterReferences { characters: CharacterProfile[]; prompt: string; images: CharacterReferenceImage[] }
export interface CharacterReferenceInput { shot: Pick<Shot, 'characterIds'>; characters?: CharacterProfile[]; assets: AssetRecord[] }

/** Resolve only the frozen profiles selected by this shot, before any provider request is made. */
export async function resolveCharacterReferences({ shot, characters = [], assets }: CharacterReferenceInput): Promise<ResolvedCharacterReferences> {
  const selectedIds = [...new Set(shot.characterIds ?? [])];
  if (!selectedIds.length) return { characters: [], prompt: '', images: [] };
  const profiles = new Map(characters.map(profile => [profile.id, profile]));
  const availableAssets = new Map(assets.map(asset => [asset.id, asset]));
  const selected = selectedIds.map(id => {
    const profile = profiles.get(id);
    if (!profile) throw new Error('运行快照缺少镜头所选角色，请基于当前角色重新生成。');
    const parsed = characterProfileSchema.parse(profile);
    if (parsed.archived) throw new Error(`角色「${parsed.name}」已归档，请恢复后重新生成。`);
    return parsed;
  });
  const referenceIds = [...new Set(selected.flatMap(profile => profile.referenceAssetIds))];
  const references: AssetRecord[] = [];
  let totalBytes = 0;
  for (const id of referenceIds) {
    const asset = availableAssets.get(id);
    if (!asset?.active || asset.kind !== 'image' || asset.projectId !== undefined) throw new Error('角色参考图必须是运行快照中有效的公共图片，请重新选择角色。');
    const info = await stat(asset.path).catch(() => undefined);
    if (!info?.isFile() || info.size <= 0 || info.size !== asset.size) throw new Error(`角色参考图「${asset.name}」缺失、为空或已更改，请重新导入。`);
    if (info.size > MAX_CHARACTER_REFERENCE_BYTES) throw new Error(`角色参考图「${asset.name}」超过 20 MiB，请压缩后重新导入。`);
    totalBytes += info.size;
    if (totalBytes > MAX_CHARACTER_REFERENCE_TOTAL_BYTES) throw new Error('本次角色参考图总量超过 64 MiB，请压缩图片或减少参考图。');
    references.push(asset);
  }
  const images: CharacterReferenceImage[] = [];
  for (const asset of references) {
    const bytes = await readFile(asset.path);
    if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`角色参考图「${asset.name}」校验失败，请重新导入。`);
    images.push({ assetId: asset.id, mimeType: asset.mimeType, dataUrl: `data:${asset.mimeType};base64,${bytes.toString('base64')}` });
  }
  const prompt = ['角色一致性要求：', ...selected.map(profile => `角色「${profile.name}」：${profile.description || '保持同一角色身份。'}${profile.referenceAssetIds.length ? `\n参考图：${profile.referenceAssetIds.map(id => `图片 ${referenceIds.indexOf(id) + 1}`).join('、')}。保留参考图中的人物外观、服装和辨识特征。` : ''}`)].join('\n');
  return { characters: selected, prompt, images };
}
