import { z } from 'zod';

const identity = z.string().trim().min(1).max(128);
const uniqueIds = (maximum: number) => z.array(identity).max(maximum).refine(ids => new Set(ids).size === ids.length, '引用编号不能重复。');
const revisionFields = {
  id: identity, revision: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string(), archived: z.boolean().default(false),
};

export const dramaVisualStyleSchema = z.enum(['live-action', 'animation', 'mixed']);
export const dramaNarrativeModeSchema = z.enum(['dialogue', 'narration', 'mixed']);
export type DramaVisualStyle = z.infer<typeof dramaVisualStyleSchema>;
export type DramaNarrativeMode = z.infer<typeof dramaNarrativeModeSchema>;
export const dramaVisualStyleLabels = { 'live-action': '真人写实', animation: '动漫与风格化', mixed: '混合画风' } as const;
export const dramaNarrativeModeLabels = { dialogue: '角色对白', narration: '旁白解说', mixed: '对白与解说混合' } as const;
export const dramaLineKindLabels = { dialogue: '对白', narration: '旁白' } as const;

const editableWork = z.object({
  title: z.string().trim().min(1).max(160), description: z.string().max(30000).default(''),
  visualStyle: dramaVisualStyleSchema, narrativeMode: dramaNarrativeModeSchema,
  characterIds: uniqueIds(50).default([]),
  topicIds: uniqueIds(20).default([]), stylePresetId: identity.optional(), skillIds: uniqueIds(500).default([]),
});
export const dramaWorkSchema = editableWork.extend(revisionFields);
export const dramaWorkInputSchema = editableWork.extend({ id: identity.optional(), revision: z.number().int().positive().optional() });
export type DramaWork = z.infer<typeof dramaWorkSchema>;
export const dramaStudioCreateInputSchema = z.object({
  work: dramaWorkInputSchema.omit({ id: true, revision: true }).extend({ skillIds: uniqueIds(500).optional() }),
  originalText: z.string().max(30000).default(''), mode: z.enum(['upload', 'write']),
  seriesTemplateId: identity.optional(), seriesTemplateRevision: z.number().int().positive().optional(),
}).superRefine((value, context) => {
  if (value.mode === 'upload' && !value.originalText.trim()) context.addIssue({ code: 'custom', path: ['originalText'], message: '请先上传或填写剧本正文。' });
  if (Boolean(value.seriesTemplateId) !== (value.seriesTemplateRevision !== undefined)) context.addIssue({ code: 'custom', path: ['seriesTemplateId'], message: '请选择系列模板及其当前修订。' });
});
export const dramaScriptReadResultSchema = z.object({ fileName: z.string().min(1), text: z.string().trim().min(1).max(30000, '剧本正文最多 30000 个字符，请按分集拆分后导入。') });

export const dramaSceneSchema = z.object({
  id: identity, title: z.string().trim().min(1).max(160), description: z.string().max(10000).default(''),
  location: z.string().max(1000).default(''), timeOfDay: z.string().max(120).default(''),
});
export type DramaScene = z.infer<typeof dramaSceneSchema>;
export const dramaEpisodeSchema = z.object({
  workId: identity, number: z.number().int().min(1).max(100000), visualStyle: dramaVisualStyleSchema,
  narrativeMode: dramaNarrativeModeSchema,
  scenes: z.array(dramaSceneSchema).max(500).default([]).refine(scenes => new Set(scenes.map(scene => scene.id)).size === scenes.length, '场次编号不能重复。'),
});
export type DramaEpisode = z.infer<typeof dramaEpisodeSchema>;
export const dramaEpisodeSummarySchema = dramaEpisodeSchema.omit({ scenes: true });

export const characterAppearanceSchema = z.object({
  id: identity, name: z.string().trim().min(1).max(120), description: z.string().max(10000).default(''),
  referenceAssetIds: uniqueIds(4).default([]),
});
export type CharacterAppearance = z.infer<typeof characterAppearanceSchema>;
export const characterAppearancesSchema = z.array(characterAppearanceSchema).max(50)
  .refine(appearances => new Set(appearances.map(appearance => appearance.id)).size === appearances.length, '角色形象编号不能重复。');

const editableVoice = z.object({
  name: z.string().trim().min(1).max(120), description: z.string().max(10000).default(''), language: z.string().trim().min(1).max(80).default('zh-CN'),
  referenceAssetIds: uniqueIds(3).default([]), providerVoiceId: z.string().trim().min(1).max(500).nullable().optional(),
});
export const voiceProfileSchema = editableVoice.extend(revisionFields);
export const voiceProfileInputSchema = editableVoice.extend({ id: identity.optional(), revision: z.number().int().positive().optional() });
export type VoiceProfile = z.infer<typeof voiceProfileSchema>;

export const dramaLineSchema = z.object({
  id: identity, kind: z.enum(['dialogue', 'narration']), text: z.string().trim().min(1).max(10000),
  speakerId: identity.optional(), voiceId: identity.optional(), emotion: z.string().max(1000).optional(),
  pauseAfterUs: z.number().int().min(0).max(60_000_000).optional(),
}).superRefine((line, context) => {
  if (line.kind === 'dialogue' && !line.speakerId) context.addIssue({ code: 'custom', message: '对白需要选择说话角色。', path: ['speakerId'] });
});
export type DramaLine = z.infer<typeof dramaLineSchema>;
export type DramaLineKind = DramaLine['kind'];
export const shotDramaSchema = z.object({
  sceneId: identity.optional(),
  appearances: z.array(z.object({ characterId: identity, appearanceId: identity })).max(8).default([])
    .refine(bindings => new Set(bindings.map(binding => binding.characterId)).size === bindings.length, '同一镜头的角色只能选择一个形象。'),
  lines: z.array(dramaLineSchema).max(200).default([])
    .refine(lines => new Set(lines.map(line => line.id)).size === lines.length, '台词编号不能重复。'),
});
export type ShotDrama = z.infer<typeof shotDramaSchema>;

/** A copied or split shot owns new dialogue identities while retaining its authored bindings. */
export function cloneShotDrama(drama: ShotDrama, createId: () => string = () => globalThis.crypto.randomUUID()): ShotDrama {
  return { ...drama, appearances: drama.appearances.map(binding => ({ ...binding })), lines: drama.lines.map(line => ({ ...line, id: createId() })) };
}

type DramaShot = { id?: string; characterIds?: readonly string[]; drama?: ShotDrama };
type DramaProject = { drama?: DramaEpisode | null; creativeContext?: { characterIds: readonly string[] } | null; shots: readonly DramaShot[] };
type DramaCharacter = { id: string; name: string; description?: string; referenceAssetIds: readonly string[]; appearances?: readonly CharacterAppearance[]; defaultVoiceId?: string | null };
type DramaVoice = Pick<VoiceProfile, 'id' | 'name' | 'description' | 'language'>;

/** Includes voice-only speakers, even when they do not appear in the visual cast. */
export function dramaCharacterIds(project: Pick<DramaProject, 'shots'>): string[] {
  return [...new Set(project.shots.flatMap(shot => [
    ...(shot.drama?.appearances.map(binding => binding.characterId) ?? []),
    ...(shot.drama?.lines.flatMap(line => line.speakerId ? [line.speakerId] : []) ?? []),
  ]))];
}

/** Spoken dialogue can be off screen; only explicit visual bindings select images. */
export function shotVisualCharacterIds(shot: Pick<DramaShot, 'characterIds' | 'drama'>): string[] {
  return [...new Set([...(shot.characterIds ?? []), ...(shot.drama?.appearances.map(binding => binding.characterId) ?? [])])];
}

export function dramaVoiceIds(project: DramaProject, characters: readonly DramaCharacter[] = []): string[] {
  const selected = new Set([...(project.creativeContext?.characterIds ?? []), ...project.shots.flatMap(shot => shot.characterIds ?? []), ...dramaCharacterIds(project)]);
  return [...new Set([
    ...project.shots.flatMap(shot => shot.drama?.lines.flatMap(line => line.voiceId ? [line.voiceId] : []) ?? []),
    ...characters.flatMap(character => selected.has(character.id) && character.defaultVoiceId ? [character.defaultVoiceId] : []),
  ])];
}

/** All appearances remain retained for editing, backup and frozen runs. */
export function characterReferenceAssetIds(character: Pick<DramaCharacter, 'referenceAssetIds' | 'appearances'>): string[] {
  return [...new Set([...character.referenceAssetIds, ...(character.appearances?.flatMap(appearance => appearance.referenceAssetIds) ?? [])])];
}

export function selectedCharacterReferenceAssetIds(character: Pick<DramaCharacter, 'referenceAssetIds' | 'appearances'>, appearanceId?: string): string[] {
  if (!appearanceId) return [...character.referenceAssetIds];
  const appearance = character.appearances?.find(value => value.id === appearanceId);
  if (!appearance) throw new Error('镜头选择的角色形象不存在，请重新选择。');
  return [...(appearance.referenceAssetIds.length ? appearance.referenceAssetIds : character.referenceAssetIds)];
}

/** Library existence is checked when records are supplied at the owning runtime boundary. */
export function validateDramaProject(project: DramaProject, characters?: readonly DramaCharacter[], voices?: readonly DramaVoice[]): void {
  if (!project.drama && !project.shots.some(shot => shot.drama)) return;
  const sceneIds = new Set(project.drama?.scenes.map(scene => scene.id) ?? []);
  if (sceneIds.size !== (project.drama?.scenes.length ?? 0)) throw new Error('场次编号不能重复。');
  const shotIds = new Set<string>(), lineIds = new Set<string>();
  const profiles = characters ? new Map(characters.map(character => [character.id, character])) : undefined;
  const voiceIds = voices ? new Set(voices.map(voice => voice.id)) : undefined;
  for (const shot of project.shots) {
    if (shot.id) {
      if (shotIds.has(shot.id)) throw new Error('镜头编号不能重复。');
      shotIds.add(shot.id);
    }
    if (shot.drama?.sceneId && !sceneIds.has(shot.drama.sceneId)) throw new Error('镜头引用的场次不存在，请先调整场次关联。');
    for (const binding of shot.drama?.appearances ?? []) {
      const profile = profiles?.get(binding.characterId);
      if (profiles && !profile) throw new Error('镜头引用的角色不存在。');
      if (profile && !profile.appearances?.some(appearance => appearance.id === binding.appearanceId)) throw new Error(`角色「${profile.name}」的镜头形象不存在。`);
    }
    for (const line of shot.drama?.lines ?? []) {
      if (lineIds.has(line.id)) throw new Error('不同镜头的台词编号不能重复。');
      lineIds.add(line.id);
      if (line.kind === 'dialogue' && !line.speakerId) throw new Error('对白需要选择说话角色。');
      if (line.speakerId && profiles && !profiles.has(line.speakerId)) throw new Error('台词引用的说话角色不存在。');
      if (line.voiceId && voiceIds && !voiceIds.has(line.voiceId)) throw new Error('台词引用的音色不存在。');
    }
  }
  if (voiceIds) for (const id of dramaVoiceIds(project, characters)) if (!voiceIds.has(id)) throw new Error('角色引用的默认音色不存在。');
}

/** Compiles authored structure without changing the legacy narration or sound fields. */
export function shotDramaText(project: Pick<DramaProject, 'drama'>, shot: Pick<DramaShot, 'drama'>, characters: readonly DramaCharacter[] = [], voices: readonly DramaVoice[] = []): string {
  if (!project.drama && !shot.drama) return '';
  const profiles = new Map(characters.map(character => [character.id, character]));
  const voiceProfiles = new Map(voices.map(voice => [voice.id, voice]));
  const scene = project.drama?.scenes.find(value => value.id === shot.drama?.sceneId);
  const voiceText = (id?: string | null) => {
    const voice = id ? voiceProfiles.get(id) : undefined;
    return voice ? `音色「${voice.name}」：${voice.description}；语言：${voice.language}` : '';
  };
  return [
    project.drama ? `短剧画风：${dramaVisualStyleLabels[project.drama.visualStyle]}；讲述方式：${dramaNarrativeModeLabels[project.drama.narrativeMode]}` : '',
    scene ? `场次「${scene.title}」：${[scene.location, scene.timeOfDay, scene.description].filter(Boolean).join('；')}` : '',
    ...(shot.drama?.appearances.map(binding => {
      const profile = profiles.get(binding.characterId), appearance = profile?.appearances?.find(value => value.id === binding.appearanceId);
      return profile && appearance ? `角色「${profile.name}」使用形象「${appearance.name}」：${appearance.description}` : '';
    }) ?? []),
    ...(shot.drama?.lines.map(line => {
      const profile = line.speakerId ? profiles.get(line.speakerId) : undefined;
      const details = [voiceText(line.voiceId ?? profile?.defaultVoiceId), line.emotion ? `表演：${line.emotion}` : '', line.pauseAfterUs ? `句后停顿：${line.pauseAfterUs / 1_000_000} 秒` : ''].filter(Boolean);
      return `${dramaLineKindLabels[line.kind]}${profile ? `（${profile.name}）` : ''}：${line.text}${details.length ? `\n${details.join('；')}` : ''}`;
    }) ?? []),
  ].filter(Boolean).join('\n');
}
