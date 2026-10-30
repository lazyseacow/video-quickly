import { expect, it } from 'vitest';
import { createHistoryWorkflow, DEFAULT_AUDIO_MIX_SETTINGS, DEFAULT_AUDIO_PROCESSING, DEFAULT_VIDEO_PROFILE, projectSchema } from '@video-quickly/contracts';
import { deleteShotRanges } from '../packages/video/src/clip-edits';
import { applyAudioProcessingEdit, type AudioProcessingValue } from '../apps/desktop/src/lib/audio-edits';
import { editContent } from '../apps/desktop/src/lib/project-edits';

const project = () => projectSchema.parse({ id: 'audio-edits', title: '原项目', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), createdAt: '', updatedAt: '', shots: [1, 2].map(index => ({ id: `shot-${index}`, title: `镜头${index}`, narration: '', visualPrompt: '', sourceInUs: 0, audioAssetId: `voice-${index}`, durationUs: 3_000_000 })) });
const processing = { ...DEFAULT_AUDIO_PROCESSING, gainDb: -6, denoise: true };
const shotEdit = (): AudioProcessingValue => ({ scope: 'shot', shot: { id: 'shot-1', processing } });
const mixEdit = (): AudioProcessingValue => ({ scope: 'project', mix: { ...DEFAULT_AUDIO_MIX_SETTINGS, ducking: { ...DEFAULT_AUDIO_MIX_SETTINGS.ducking, enabled: true } } });

it('protects the selected video source and source window while applying original audio settings', () => {
  const baseline = project(); baseline.shots[0].videoAssetId = 'video'; baseline.shots[0].videoInUs = 200_000;
  const value: AudioProcessingValue = { scope: 'shot', shot: { id: 'shot-1', processing: { ...DEFAULT_AUDIO_PROCESSING, version: 2, videoAudio: { enabled: true, gainDb: -3 } } } };
  const current = editContent(baseline);
  expect(applyAudioProcessingEdit({ ...current, title: 'Unrelated title' }, baseline, value).shots[0].audioProcessing).toEqual(value.shot.processing);
  expect(() => applyAudioProcessingEdit({ ...current, shots: current.shots.map(shot => shot.id === 'shot-1' ? { ...shot, videoAssetId: 'replacement' } : shot) }, baseline, value)).toThrow('来源或剪辑范围');
  expect(() => applyAudioProcessingEdit({ ...current, shots: current.shots.map(shot => shot.id === 'shot-1' ? { ...shot, videoInUs: 400_000 } : shot) }, baseline, value)).toThrow('来源或剪辑范围');
  expect(baseline.shots[0].audioProcessing).toBeUndefined();
});

it('applies shot and project scopes independently while preserving unrelated current edits', () => {
  const baseline = project(), before = structuredClone(baseline);
  const current = { ...editContent(baseline), title: '后改项目名', shots: baseline.shots.map(shot => ({ ...shot, title: `后改${shot.title}`, videoInUs: 1_000_000 })) };
  const shot = applyAudioProcessingEdit(current, baseline, shotEdit());
  expect(shot.shots[0]).toMatchObject({ title: '后改镜头1', videoInUs: 1_000_000, audioProcessing: processing });
  expect(shot.shots[1]).toEqual(current.shots[1]); expect(shot.audioMix).toBe(current.audioMix); expect(shot.title).toBe('后改项目名');
  const mixed = applyAudioProcessingEdit(shot, baseline, mixEdit());
  expect(mixed.shots).toBe(shot.shots); expect(mixed.shots[0].audioProcessing).toEqual(processing); expect(mixed.audioMix?.ducking.enabled).toBe(true);
  expect(baseline).toEqual(before);
});

it('permits project mixing across locked shots without letting shot edits bypass locks or removal', () => {
  const baseline = project(), current = { ...editContent(baseline), shots: baseline.shots.map(shot => ({ ...shot, locked: true })) };
  expect(() => applyAudioProcessingEdit(current, baseline, shotEdit())).toThrow('解锁');
  expect(applyAudioProcessingEdit(current, baseline, mixEdit()).shots.every(shot => shot.locked)).toBe(true);
  expect(() => applyAudioProcessingEdit({ ...current, shots: current.shots.slice(1) }, baseline, shotEdit())).toThrow('已移除');
});

it.each(['audioAssetId', 'audioInUs', 'sourceInUs', 'durationUs'] as const)('blocks an audio %s change while preserving the entered processing draft', field => {
  const baseline = project(), draft = shotEdit(), before = structuredClone(draft);
  const changed = field === 'audioAssetId' ? 'replacement' : field === 'durationUs' ? 4_000_000 : 100_000;
  const current = { ...editContent(baseline), shots: baseline.shots.map((shot, index) => index ? shot : { ...shot, [field]: changed }) };
  expect(() => applyAudioProcessingEdit(current, baseline, draft)).toThrow('音频来源或剪辑范围'); expect(draft).toEqual(before);
});

it('allows a video-only plan fork but rejects a changed audio mapping inside the same visible window', () => {
  const baseline = project(); let nextId = 0;
  const edited = deleteShotRanges(baseline, 'shot-1', [{ startUs: 1_000_000, endUs: 1_500_000 }], baseline.profile.frameRate, [{ id: 'voice-1', sha256: 'a'.repeat(64) }], kind => `${kind}-${++nextId}`);
  const plan = edited.clipEditPlans![0], videoOnly = { ...plan, id: 'video-plan', spans: plan.spans.map(span => ({ ...span, videoInUs: span.videoInUs + 50_000 })) };
  const current = { ...editContent(edited), clipEditPlans: [...edited.clipEditPlans!, videoOnly], shots: edited.shots.map((shot, index) => index ? shot : { ...shot, clipEdit: { ...shot.clipEdit!, planId: videoOnly.id } }) };
  expect(applyAudioProcessingEdit(current, edited, shotEdit()).shots[0].audioProcessing).toEqual(processing);
  const audioChanged = { ...current, clipEditPlans: current.clipEditPlans.map(value => value.id === videoOnly.id ? { ...value, spans: value.spans.map(span => ({ ...span, audioInUs: span.audioInUs + 50_000 })) } : value) };
  expect(() => applyAudioProcessingEdit(audioChanged, edited, shotEdit())).toThrow('剪辑范围');
});

it('retries its own failed shot submission and still refuses a later external processing edit', () => {
  const baseline = project(), first = shotEdit(), current = applyAudioProcessingEdit(editContent(baseline), baseline, first);
  expect(() => applyAudioProcessingEdit(current, baseline, first)).toThrow('其他视图');
  const second: AudioProcessingValue = { scope: 'shot', shot: { id: 'shot-1', processing: { ...processing, gainDb: -9 } } };
  const retried = applyAudioProcessingEdit({ ...current, title: '保存失败后的新标题' }, baseline, second, first);
  expect(retried.shots[0].audioProcessing?.gainDb).toBe(-9); expect(retried.title).toBe('保存失败后的新标题');
  const external = { ...retried, shots: retried.shots.map((shot, index) => index ? shot : { ...shot, audioProcessing: { ...processing, gainDb: -12 } }) };
  expect(() => applyAudioProcessingEdit(external, baseline, first, second)).toThrow('其他视图');
  expect(() => applyAudioProcessingEdit(current, baseline, first, { scope: 'shot', shot: { id: 'shot-2', processing } })).toThrow('其他视图');
});

it('retries its own mix submission without overwriting an external mix or touching newer source edits', () => {
  const baseline = project(), submitted = mixEdit(), first = applyAudioProcessingEdit(editContent(baseline), baseline, submitted);
  expect(() => applyAudioProcessingEdit(first, baseline, submitted)).toThrow('其他视图');
  const sourcesChanged = { ...first, shots: first.shots.map((shot, index) => index ? shot : { ...shot, audioAssetId: 'new-voice', durationUs: 4_000_000 }) };
  const second: AudioProcessingValue = { scope: 'project', mix: { ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, targetLufs: -20 } } };
  expect(applyAudioProcessingEdit(sourcesChanged, baseline, second, submitted).shots).toBe(sourcesChanged.shots);
  const external = { ...first, audioMix: { ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, targetLufs: -24 } } };
  expect(() => applyAudioProcessingEdit(external, baseline, second, submitted)).toThrow('其他视图');
});

it('rejects invalid DSP input before mutating the current content', () => {
  const baseline = project(), current = editContent(baseline);
  expect(() => applyAudioProcessingEdit(current, baseline, { scope: 'shot', shot: { id: 'shot-1', processing: { ...processing, gainDb: NaN } } })).toThrow();
  expect(() => applyAudioProcessingEdit(current, baseline, { scope: 'project', mix: { ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, targetLufs: -90 } } })).toThrow();
  expect(current).toEqual(editContent(baseline));
});
