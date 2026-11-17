import { expect, it } from 'vitest';
import {
  applyShotCandidate, characterProfileSchema, createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, shotCandidateSchema, shotSchema,
  type ShotCandidateKind,
} from '@video-quickly/contracts';
import { buildWorkflowPrompt, parseWorkflowScript } from '../src/packages/runtime/src/workflow-prompts';

const profile = characterProfileSchema.parse({
  id: 'private-character-id', name: '林夏', description: '短发', referenceAssetIds: [], revision: 1, createdAt: '', updatedAt: '',
  appearances: [{ id: 'private-appearance-id', name: '职场装', description: '深蓝西装', referenceAssetIds: [] }], defaultVoiceId: 'private-voice-id',
});
const shot = () => shotSchema.parse({
  id: 'shot', title: '推门', narration: '', visualPrompt: '会议室木门', durationUs: 4_000_000,
  drama: { sceneId: 'meeting', appearances: [{ characterId: profile.id, appearanceId: 'private-appearance-id' }], lines: [
    { id: 'dialogue', kind: 'dialogue', speakerId: profile.id, text: '这份方案，我不同意。', emotion: '克制', pauseAfterUs: 300_000 },
    { id: 'narration', kind: 'narration', text: '她终于说出了这句话。' },
  ] },
});
const project = () => projectSchema.parse({
  id: 'project', title: '第一集', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(),
  drama: { workId: 'private-work-id', number: 2, visualStyle: 'animation', narrativeMode: 'mixed', scenes: [{ id: 'meeting', title: '公司会议', location: '会议室', timeOfDay: '白天', description: '落地窗在左' }] },
  shots: [shot()], createdAt: '', updatedAt: '',
});
const candidate = (kind: ShotCandidateKind) => shotCandidateSchema.parse({
  id: 'candidate', projectId: 'project', shotId: 'shot', kind, runId: 'run', nodeId: 'regenerate', createdAt: '',
  baseline: shot(), shot: { ...shot(), title: '新标题', assetId: 'new-image', videoAssetId: 'new-video' }, assetIds: ['new-image', 'new-video'],
});

it('rejects old image, video and script candidates after scene, appearance, dialogue or voice changes', () => {
  const initial = shot();
  const changedContexts = [
    { ...initial.drama!, sceneId: 'another-scene' },
    { ...initial.drama!, appearances: [{ characterId: profile.id, appearanceId: 'another-look' }] },
    { ...initial.drama!, lines: [{ ...initial.drama!.lines[0], text: '这份方案，我同意。' }] },
    { ...initial.drama!, lines: [{ ...initial.drama!.lines[0], voiceId: 'another-voice' }] },
    { ...initial.drama!, lines: [{ ...initial.drama!.lines[0], emotion: '愤怒' }] },
  ];
  for (const kind of ['script', 'image', 'video'] as const) {
    expect(applyShotCandidate(initial, candidate(kind)).drama).toEqual(initial.drama);
    for (const drama of changedContexts) expect(() => applyShotCandidate({ ...initial, drama }, candidate(kind))).toThrow('已修改');
  }
});

it('includes frozen episode, scene, appearance and authored lines in planning input without introducing output bindings', () => {
  const current = project(), before = JSON.stringify(current), node = current.workflow.nodes.find(node => node.kind === 'script')!;
  const prompt = buildWorkflowPrompt(current, node, [], false, [profile]);
  for (const expected of ['第 2 集', '动漫与风格化', '对白与解说混合', '公司会议', '落地窗在左', '深蓝西装', '林夏', '这份方案，我不同意。', '她终于说出了这句话。', '克制', '0.3 秒']) expect(prompt).toContain(expected);
  expect(prompt).not.toContain('private-character-id'); expect(prompt).not.toContain('private-appearance-id'); expect(prompt).not.toContain('private-voice-id');
  expect(prompt).toContain('不返回 drama 或 dramaContext 字段');
  expect(JSON.stringify(current)).toBe(before);
});

it('retains authored drama context when a storyboard batch supplies only its legacy shot fields', () => {
  const current = project(), original = current.shots[0], { drama: _drama, ...batchShot } = original;
  const prompt = buildWorkflowPrompt(current, current.workflow.nodes.find(node => node.kind === 'script')!, [], false, [profile], [], undefined, { shots: [batchShot], contract: '本批仍使用既有分镜输出结构' });
  expect(prompt).toContain('深蓝西装'); expect(prompt).toContain('这份方案，我不同意。'); expect(prompt).toContain('本批仍使用既有分镜输出结构');
});

it('preserves scene, dialogue and appearance bindings when legacy whole-project and single-shot results are applied', () => {
  const current = project(), output = JSON.stringify({ shots: [{ id: 'shot', title: '新标题', narration: '模型提供的旧字段', visualPrompt: '会议室门口近景', durationUs: 5_000_000 }] });
  for (const singleShot of [false, true]) {
    const result = parseWorkflowScript(output, current, singleShot, [profile]);
    expect(result.shots[0].drama).toEqual(current.shots[0].drama);
    expect(result.shots[0].title).toBe('新标题'); expect(result.shots[0].visualPrompt).toBe('会议室门口近景');
  }
  expect(current.shots[0].title).toBe('推门');
});
