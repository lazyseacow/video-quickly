import { z } from 'zod';
import type { AssetRecord, CharacterProfile, Shot } from './index.js';

const uniqueKeys = (maximum: number) => z.array(z.string().min(1)).max(maximum).refine(values => new Set(values).size === values.length, '创作引用不能重复。');
export const creativeEntitySchema = z.object({
  key: z.string().regex(/^(?!role-)[a-z][a-z0-9-]{0,63}$/, '设定编号须为小写字母、数字或连字符，且不能以 role- 开头。'),
  kind: z.enum(['character', 'scene', 'prop']), name: z.string().trim().min(1).max(120), description: z.string().max(4000),
  referenceAssetIds: uniqueKeys(4).optional(),
});
export const creativeContextSchema = z.object({
  characterIds: uniqueKeys(50).default([]),
  entities: z.array(creativeEntitySchema).max(100).refine(values => new Set(values.map(value => value.key)).size === values.length, '创作设定编号不能重复。').default([]),
  continuity: z.string().max(10000).default(''),
});
export const creativeEntityKeysSchema = uniqueKeys(12);
export type CreativeEntity = z.infer<typeof creativeEntitySchema>;
export type CreativeContext = z.infer<typeof creativeContextSchema>;
type CreativeProject = { creativeContext?: CreativeContext | null; shots: ReadonlyArray<Pick<Shot, 'characterIds' | 'creativeEntityKeys'>> };

/** Omitting a shot collects all authored references for validation, backup and retention. */
export function creativeReferenceAssetIds(project: Pick<CreativeProject, 'creativeContext'>, shot?: Pick<Shot, 'creativeEntityKeys'>): string[] {
  const selected = shot ? new Set(shot.creativeEntityKeys ?? []) : undefined;
  return [...new Set((project.creativeContext?.entities ?? []).filter(entity => !selected || selected.has(entity.key)).flatMap(entity => entity.referenceAssetIds ?? []))];
}

export function hasCharacterAppearance(project: Pick<CreativeProject, 'creativeContext'>, shot: Pick<Shot, 'creativeEntityKeys'>): boolean {
  return Boolean(project.creativeContext?.entities.some(entity => entity.kind === 'character' && entity.referenceAssetIds?.length && shot.creativeEntityKeys?.includes(entity.key)));
}

export function isCreativeReferenceAsset(project: Pick<CreativeProject, 'creativeContext'> & { id?: string }, asset: AssetRecord | undefined): asset is AssetRecord {
  if (!asset?.active || asset.kind !== 'image') return false;
  if (asset.projectId === undefined) return true;
  if (asset.projectId !== project.id || asset.shotId) return false;
  const entities = project.creativeContext?.entities.filter(entity => entity.referenceAssetIds?.includes(asset.id)) ?? [];
  return entities.length > 0 && entities.every(entity => entity.kind === 'character');
}

/** Pool order is frozen with the project; models use these keys rather than authoring library IDs. */
export function projectCharacterIds(project: Pick<CreativeProject, 'creativeContext'> & { shots: ReadonlyArray<Pick<Shot, 'characterIds'>> }): string[] {
  return [...new Set([...(project.creativeContext?.characterIds ?? []), ...project.shots.flatMap(shot => shot.characterIds ?? [])])];
}

export function creativeCharacterBindings(project: CreativeProject, characters: readonly CharacterProfile[]) {
  const profiles = new Map(characters.map(profile => [profile.id, profile]));
  return projectCharacterIds(project).map((id, index) => {
    const profile = profiles.get(id);
    if (!profile) throw new Error('运行快照缺少项目所选角色，请基于当前角色新建运行。');
    return { key: `role-${index + 1}`, profile };
  });
}

export function validateCreativeReferences(project: CreativeProject): void {
  const available = new Set(project.creativeContext?.entities.map(entity => entity.key) ?? []);
  for (const shot of project.shots) for (const key of shot.creativeEntityKeys ?? []) {
    if (!available.has(key)) throw new Error(`镜头引用的创作设定「${key}」不存在，请先调整镜头引用。`);
  }
}

export const creativeEntityLabels = { character: '人物', scene: '场景', prop: '道具' } as const;

export function shotCreativePrompt(project: Pick<CreativeProject, 'creativeContext'>, shot: Pick<Shot, 'creativeEntityKeys'>): string {
  const context = project.creativeContext;
  if (!context) return '';
  const entities = new Map(context.entities.map(entity => [entity.key, entity]));
  return [context.continuity.trim() ? `全片连续性要求：${context.continuity}` : '', ...(shot.creativeEntityKeys ?? []).map(key => {
    const entity = entities.get(key);
    if (!entity) throw new Error(`镜头引用的创作设定「${key}」不存在。`);
    return `${creativeEntityLabels[entity.kind]}「${entity.name}」：${entity.description}`;
  })].filter(Boolean).join('\n');
}
