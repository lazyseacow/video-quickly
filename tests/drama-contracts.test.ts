import { describe, expect, it } from 'vitest';
import {
  characterProfileSchema, characterReferenceAssetIds, createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, dramaCharacterIds, dramaEpisodeSchema,
  dramaLineSchema, dramaVoiceIds, dramaWorkInputSchema, dramaWorkSchema, projectCharacterIds, projectSchema, projectSummarySchema,
  selectedCharacterReferenceAssetIds, shotDramaSchema, shotDramaText, shotSchema, shotVisualCharacterIds, validateDramaProject, voiceProfileInputSchema, voiceProfileSchema,
} from '@video-quickly/contracts';

const character = () => characterProfileSchema.parse({
  id: 'lin', name: '林夏', description: '短发', referenceAssetIds: ['main'], defaultVoiceId: 'voice-lin', revision: 1, createdAt: '', updatedAt: '',
  appearances: [{ id: 'office', name: '职场装', description: '深蓝西装', referenceAssetIds: ['office-front', 'main'] }, { id: 'home', name: '家居装', description: '浅色上衣', referenceAssetIds: [] }],
});
const voice = () => voiceProfileSchema.parse({ id: 'voice-lin', name: '林夏声音', description: '清晰、克制', language: 'zh-CN', referenceAssetIds: ['sample'], revision: 1, createdAt: '', updatedAt: '' });
const line = () => dramaLineSchema.parse({ id: 'line-1', kind: 'dialogue', speakerId: 'lin', text: ' 这份方案，我不同意。 ', emotion: '克制', pauseAfterUs: 500_000 });
const shot = () => shotSchema.parse({ id: 'shot-1', title: '推门', narration: '', visualPrompt: '会议室', durationUs: 4_000_000, drama: { sceneId: 'meeting', appearances: [{ characterId: 'lin', appearanceId: 'office' }], lines: [line()] } });
const project = () => projectSchema.parse({
  id: 'episode-1', title: '第一集', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(),
  drama: { workId: 'work', number: 1, visualStyle: 'live-action', narrativeMode: 'mixed', scenes: [{ id: 'meeting', title: '会议室', location: '公司', timeOfDay: '白天', description: '落地窗在左' }] },
  shots: [shot()], createdAt: '', updatedAt: '',
});

describe('drama structures', () => {
  it('supports visual and narrative choices independently, with editable defaults', () => {
    for (const visualStyle of ['live-action', 'animation', 'mixed'] as const) for (const narrativeMode of ['dialogue', 'narration', 'mixed'] as const) {
      const input = dramaWorkInputSchema.parse({ title: '同一个故事', visualStyle, narrativeMode });
      const work = dramaWorkSchema.parse({ ...input, id: 'work', revision: 1, createdAt: '', updatedAt: '' });
      expect(work).toMatchObject({ visualStyle, narrativeMode, description: '', characterIds: [], archived: false });
      expect(dramaEpisodeSchema.parse({ workId: work.id, number: 2, visualStyle, narrativeMode }).scenes).toEqual([]);
    }
    expect(voiceProfileInputSchema.parse({ name: '解说' })).toEqual({ name: '解说', description: '', language: 'zh-CN', referenceAssetIds: [] });
  });

  it('preserves legacy projects, shots and characters without introducing authored drama fields', () => {
    const value = project(); delete value.drama; delete value.shots[0].drama;
    const oldCharacter = character(); delete oldCharacter.appearances; delete oldCharacter.defaultVoiceId;
    expect(projectSchema.parse(value)).not.toHaveProperty('drama');
    expect(shotSchema.parse(value.shots[0])).not.toHaveProperty('drama');
    expect(characterProfileSchema.parse(oldCharacter)).not.toHaveProperty('appearances');
    expect(characterProfileSchema.parse({ ...oldCharacter, defaultVoiceId: null }).defaultVoiceId).toBeNull();
    expect(() => validateDramaProject(value)).not.toThrow();
  });

  it('bounds authored inputs and rejects duplicate scene, appearance and line identities', () => {
    const current = project(), profile = character();
    const roleIds = Array.from({ length: 50 }, (_, index) => `role-${index}`);
    expect(dramaWorkInputSchema.safeParse({ title: '作品', visualStyle: 'animation', narrativeMode: 'mixed', characterIds: roleIds }).success).toBe(true);
    expect(dramaWorkInputSchema.safeParse({ title: '作品', visualStyle: 'animation', narrativeMode: 'mixed', characterIds: [...roleIds, 'one-too-many'] }).success).toBe(false);
    for (const scenes of [[current.drama!.scenes[0], current.drama!.scenes[0]], [{ id: 'empty', title: ' ' }]]) expect(dramaEpisodeSchema.safeParse({ ...current.drama, scenes }).success).toBe(false);
    expect(characterProfileSchema.safeParse({ ...profile, appearances: [profile.appearances![0], profile.appearances![0]] }).success).toBe(false);
    expect(characterProfileSchema.safeParse({ ...profile, appearances: [{ ...profile.appearances![0], referenceAssetIds: ['a', 'a'] }] }).success).toBe(false);
    expect(shotDramaSchema.safeParse({ lines: [line(), line()] }).success).toBe(false);
    expect(shotDramaSchema.safeParse({ appearances: [{ characterId: 'lin', appearanceId: 'office' }, { characterId: 'lin', appearanceId: 'home' }] }).success).toBe(false);
    expect(dramaLineSchema.safeParse({ ...line(), speakerId: undefined }).success).toBe(false);
    expect(dramaLineSchema.safeParse({ ...line(), text: ' \n ' }).success).toBe(false);
    expect(dramaLineSchema.safeParse({ ...line(), pauseAfterUs: -1 }).success).toBe(false);
    expect(voiceProfileInputSchema.safeParse({ name: '旁白', referenceAssetIds: ['1', '2', '3', '4'] }).success).toBe(false);
  });

  it('allows narration without a cast member and gathers voice-only speakers and appearance references', () => {
    const current = project();
    current.shots.push(shotSchema.parse({ id: 'shot-2', title: '空镜', narration: '', visualPrompt: '', durationUs: 4_000_000, drama: { lines: [{ id: 'line-2', kind: 'narration', text: '那天以后，一切都变了。', voiceId: 'voice-narrator' }] } }));
    expect(dramaCharacterIds(current)).toEqual(['lin']);
    expect(projectCharacterIds(current)).toEqual(['lin']);
    expect(shotVisualCharacterIds(current.shots[0])).toEqual(['lin']);
    expect(shotVisualCharacterIds({ drama: { appearances: [], lines: [line()] } })).toEqual([]);
    expect(dramaVoiceIds(current, [character()])).toEqual(['voice-narrator', 'voice-lin']);
    expect(characterReferenceAssetIds(character())).toEqual(['main', 'office-front']);
    expect(selectedCharacterReferenceAssetIds(character(), 'office')).toEqual(['office-front', 'main']);
    expect(selectedCharacterReferenceAssetIds(character(), 'home')).toEqual(['main']);
    expect(() => selectedCharacterReferenceAssetIds(character(), 'missing')).toThrow('不存在');
    const narrator = { ...voice(), id: 'voice-narrator' };
    expect(() => validateDramaProject(current, [character()], [voice(), narrator])).not.toThrow();
  });

  it('rejects dangling scene, character, appearance and voice bindings at the runtime boundary', () => {
    const current = project();
    expect(() => validateDramaProject(current, [character()], [voice()])).not.toThrow();
    expect(() => validateDramaProject({ ...current, drama: undefined }, [character()], [voice()])).toThrow('场次不存在');
    expect(() => validateDramaProject(current, [], [voice()])).toThrow('角色不存在');
    expect(() => validateDramaProject(current, [{ ...character(), appearances: [] }], [voice()])).toThrow('形象不存在');
    expect(() => validateDramaProject(current, [character()], [])).toThrow('音色不存在');
    const wrongSpeaker = { ...shot(), drama: { ...shot().drama!, appearances: [], lines: [{ ...line(), speakerId: 'missing' }] } };
    expect(() => validateDramaProject({ ...current, shots: [wrongSpeaker] }, [character()], [voice()])).toThrow('说话角色不存在');
    const wrongVoice = { ...shot(), drama: { ...shot().drama!, lines: [{ ...line(), voiceId: 'missing' }] } };
    expect(() => validateDramaProject({ ...current, shots: [wrongVoice] }, [character()], [voice()])).toThrow('台词引用的音色不存在');
    expect(() => validateDramaProject({ ...current, shots: [shot(), shot()] })).toThrow('镜头编号不能重复');
    expect(() => validateDramaProject({ ...current, shots: [shot(), { ...shot(), id: 'shot-2' }] })).toThrow('台词编号不能重复');
    const noScene = { ...shot(), drama: { ...shot().drama!, sceneId: undefined } };
    expect(() => validateDramaProject({ ...current, drama: undefined, shots: [noScene] }, [character()], [voice()])).not.toThrow();
  });

  it('compiles selected scene, appearance, speaker, emotion and voice without mutating legacy fields', () => {
    const current = project(), original = JSON.stringify(current), text = shotDramaText(current, current.shots[0], [character()], [voice()]);
    expect(text).toContain('真人写实'); expect(text).toContain('对白与解说混合'); expect(text).toContain('会议室'); expect(text).toContain('落地窗在左');
    expect(text).toContain('深蓝西装'); expect(text).not.toContain('浅色上衣'); expect(text).toContain('林夏'); expect(text).toContain('这份方案，我不同意。');
    expect(text).toContain('林夏声音'); expect(text).toContain('清晰、克制'); expect(text).toContain('0.5 秒'); expect(JSON.stringify(current)).toBe(original);
    expect(shotDramaText({}, {})).toBe('');
  });

  it('keeps project summaries small while preserving episode identity and independent choices', () => {
    const current = project();
    const summary = projectSummarySchema.parse({ ...current, drama: current.drama, shotCount: 1, durationUs: 4_000_000, workflowNodeCount: 4, thumbnailShot: null });
    expect(summary.drama).toEqual({ workId: 'work', number: 1, visualStyle: 'live-action', narrativeMode: 'mixed' });
    expect(summary.drama).not.toHaveProperty('scenes');
  });
});
