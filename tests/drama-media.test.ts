import { describe, expect, it } from 'vitest';
import { buildMediaPrompt, characterProfileSchema, createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, modelSchema, planReferenceImageSequences, projectSchema, resolveProductionWorkflow, shotSchema, videoReferenceImages, voiceProfileSchema, type DramaEpisode, type Shot } from '@video-quickly/contracts';

const character = characterProfileSchema.parse({ id: 'lead', name: '阿青', description: '固定面部特征', referenceAssetIds: ['base'], revision: 1, createdAt: '', updatedAt: '', defaultVoiceId: 'calm', appearances: [
  { id: 'coat', name: '雨衣形象', description: '黄色雨衣，手持折伞', referenceAssetIds: ['coat-image'] },
  { id: 'uniform', name: '制服形象', description: '深蓝制服', referenceAssetIds: ['uniform-image'] },
] });
const voice = voiceProfileSchema.parse({ id: 'calm', name: '沉稳青年', description: '声音低沉，语速平稳', language: 'zh-CN', referenceAssetIds: [], revision: 1, createdAt: '', updatedAt: '' });
function scene(visualStyle: DramaEpisode['visualStyle'], narrativeMode: DramaEpisode['narrativeMode']) {
  const shot = shotSchema.parse({ id: 'first', title: '雨夜', visualPrompt: '路灯下的人物停步', narration: '旧版台词不再朗读', durationUs: 4_000_000,
    drama: { sceneId: 'alley', appearances: [{ characterId: character.id, appearanceId: 'coat' }], lines: [
      { id: 'line', kind: 'dialogue', speakerId: character.id, text: '你终于来了。', emotion: '克制惊讶', pauseAfterUs: 500_000 },
      { id: 'narration', kind: 'narration', text: '那一夜，雨一直没有停。', voiceId: voice.id },
    ] },
  });
  const project = projectSchema.parse({ id: 'episode', title: '第一集', brief: '', revision: 1, createdAt: '', updatedAt: '', profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(), shots: [shot],
    drama: { workId: 'work', number: 1, visualStyle, narrativeMode, scenes: [{ id: 'alley', title: '巷口相遇', location: '石板巷口', timeOfDay: '深夜', description: '路灯照亮一把折伞' }] },
  });
  return { project, shot, video: project.workflow.nodes.find(node => node.id === 'video')! };
}

describe('drama media compilation', () => {
  it.each([
    ['live-action', 'dialogue', '真人写实', '角色对白'],
    ['animation', 'mixed', '动漫与风格化', '对白与解说混合'],
    ['live-action', 'narration', '真人写实', '旁白解说'],
  ] as const)('compiles %s and %s with explicit speakers, voice metadata and scene context', (style, mode, styleLabel, modeLabel) => {
    const { project, shot, video } = scene(style, mode);
    const prompt = buildMediaPrompt(project, video, shot, [character], undefined, false, {}, undefined, [voice]);
    for (const expected of [styleLabel, modeLabel, '石板巷口', '雨衣形象', '黄色雨衣', '对白（阿青）：你终于来了。', '旁白：那一夜，雨一直没有停。', voice.name, voice.description, '句后停顿：0.5 秒', '仅朗读台词正文']) expect(prompt).toContain(expected);
    expect(prompt).not.toContain('旧版台词不再朗读');
    expect(prompt).toContain('参考图：图片 1');
  });

  it('uses the selected appearance as the video reference without attaching an offscreen speaker', () => {
    const { project, shot, video } = scene('animation', 'mixed');
    const offscreen = { ...character, id: 'offscreen', name: '画外角色', referenceAssetIds: ['offscreen-image'] };
    const selected = { ...shot, drama: { ...shot.drama!, lines: [{ id: 'offscreen-line', kind: 'dialogue' as const, text: '我在门外。', speakerId: offscreen.id }] } };
    const model = modelSchema.parse({ id: 'model', name: '参考视频连接', provider: 'seedance', connectionType: 'video', capabilities: ['video'], model: 'doubao-seedance-2-5-260628', baseUrl: 'http://127.0.0.1:1', parameters: { characterReferenceMode: 'reference_image' }, createdAt: '', updatedAt: '' });
    expect(videoReferenceImages(project, video, model, selected, [character, offscreen], [])).toEqual({ mode: 'multiple', referenceIds: ['coat-image'] });
    const prompt = buildMediaPrompt(project, video, selected, [character, offscreen], model);
    expect(prompt).toContain('对白（画外角色）：我在门外。');
    expect(prompt).not.toContain('角色「画外角色」：固定面部特征');
  });

  it('starts a new image sequence when a character changes appearance', () => {
    const { project, shot } = scene('animation', 'dialogue');
    const workflow = resolveProductionWorkflow({ ...project.workflow, id: 'custom-drama', production: { ...project.workflow.production, continueFromLastFrame: false, referenceMode: 'generate', imageModelId: 'image', groupReferenceImages: true } });
    const another = (id: string, appearanceId: string): Shot => ({ ...shot, id, drama: { appearances: [{ characterId: character.id, appearanceId }], lines: [] } });
    const grouped = { ...project, workflow, shots: [another('coat-a', 'coat'), another('coat-b', 'coat'), another('uniform-a', 'uniform'), another('uniform-b', 'uniform')] };
    const model = modelSchema.parse({ id: 'image', name: '图片', provider: 'seedream', connectionType: 'image', capabilities: ['image'], model: 'doubao-seedream-4-5-251128', baseUrl: 'http://127.0.0.1:1', createdAt: '', updatedAt: '' });
    const node = workflow.nodes.find(node => node.id === 'assets')!;
    const sequences = planReferenceImageSequences({ project: grouped, node, model, characters: [character] });
    expect(sequences.map(sequence => sequence.batches.flat().map(shot => shot.id))).toEqual([['coat-a', 'coat-b'], ['uniform-a', 'uniform-b']]);
  });
});
