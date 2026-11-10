import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { characterProfileSchema, characterReferencePrompt, creativeReferenceAssetIds, isCreativeReferenceAsset, type AssetRecord, type CharacterProfile, type CreativeContext, type Shot } from '@video-quickly/contracts';

export const MAX_CHARACTER_REFERENCE_BYTES = 20 * 1024 * 1024;
const MAX_CHARACTER_REFERENCE_TOTAL_BYTES = 64 * 1024 * 1024;
interface CharacterReferenceImage { assetId: string; mimeType: string; dataUrl: string }
export interface ResolvedCharacterReferences { characters: CharacterProfile[]; prompt: string; images: CharacterReferenceImage[] }
export interface CharacterReferenceInput { shot: Pick<Shot, 'characterIds' | 'creativeEntityKeys'>; project?: { id?: string; creativeContext?: CreativeContext | null }; characters?: CharacterProfile[]; assets: AssetRecord[]; includeImages?: boolean }

/** Resolve only the frozen profiles selected by this shot, before any provider request is made. */
export async function resolveCharacterReferences({ shot, project, characters = [], assets, includeImages = true }: CharacterReferenceInput): Promise<ResolvedCharacterReferences> {
  const selectedIds = [...new Set(shot.characterIds ?? [])];
  const profiles = new Map(characters.map(profile => [profile.id, profile]));
  const availableAssets = new Map(assets.map(asset => [asset.id, asset]));
  const selected = selectedIds.map(id => {
    const profile = profiles.get(id);
    if (!profile) throw new Error('运行快照缺少镜头所选角色，请基于当前角色重新生成。');
    const parsed = characterProfileSchema.parse(profile);
    if (parsed.archived) throw new Error(`角色「${parsed.name}」已归档，请恢复后重新生成。`);
    return parsed;
  });
  const libraryIds = new Set(selected.flatMap(profile => profile.referenceAssetIds));
  const referenceIds = includeImages ? [...new Set([...libraryIds, ...creativeReferenceAssetIds(project ?? {}, shot)])] : [];
  const references: AssetRecord[] = [];
  let totalBytes = 0;
  for (const id of referenceIds) {
    const asset = availableAssets.get(id);
    if (!isCreativeReferenceAsset(project ?? {}, asset) || libraryIds.has(id) && asset.projectId !== undefined) throw new Error('请使用运行快照中有效的公共图片或当前项目的人物定妆图。');
    const info = await stat(asset.path).catch(() => undefined);
    if (!info?.isFile() || info.size <= 0 || info.size !== asset.size) throw new Error(`参考图「${asset.name}」缺失、为空或已更改，请重新导入。`);
    if (info.size > MAX_CHARACTER_REFERENCE_BYTES) throw new Error(`参考图「${asset.name}」超过 20 MiB，请压缩后重新导入。`);
    totalBytes += info.size;
    if (totalBytes > MAX_CHARACTER_REFERENCE_TOTAL_BYTES) throw new Error('本次参考图总量超过 64 MiB，请压缩图片或减少参考图。');
    references.push(asset);
  }
  const images: CharacterReferenceImage[] = [];
  for (const asset of references) {
    const bytes = await readFile(asset.path);
    if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`参考图「${asset.name}」校验失败，请重新导入。`);
    images.push({ assetId: asset.id, mimeType: asset.mimeType, dataUrl: `data:${asset.mimeType};base64,${bytes.toString('base64')}` });
  }
  const prompt = characterReferencePrompt(selected, referenceIds);
  return { characters: selected, prompt, images };
}
