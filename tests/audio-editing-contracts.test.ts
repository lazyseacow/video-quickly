import { expect, it } from 'vitest';
import { audioMixSettingsSchema, audioProcessingSchema, captionTrackSchema, clipEditPlanSchema, clipEditSourceSchema, createHistoryWorkflow, DEFAULT_AUDIO_MIX_SETTINGS, DEFAULT_AUDIO_PROCESSING, DEFAULT_VIDEO_PROFILE, firstFrameAtUs, projectSchema, silenceDetectionSchema, timeAtFrame, validateClipEditContent, validateClipEditHistory } from '@video-quickly/contracts';

function fixture() {
  const source = clipEditSourceSchema.parse({ id: 'original', original: { durationUs: 4_000_000 }, assetHashes: [] });
  const plan = clipEditPlanSchema.parse({ id: 'plan', sourceId: source.id, spans: [{ id: 'first', durationUs: 1_000_000, originInUs: 0, sourceInUs: 0, audioInUs: 0, videoInUs: 0, sceneInUs: 0 }, { id: 'second', durationUs: 2_000_000, originInUs: 2_000_000, sourceInUs: 2_000_000, audioInUs: 2_000_000, videoInUs: 2_000_000, sceneInUs: 2_000_000 }] });
  return projectSchema.parse({ id: 'audio-project', title: '声音精修', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), createdAt: '', updatedAt: '', clipEditSources: [source], clipEditPlans: [plan], shots: [{ id: 'shot', title: '原录音', narration: '', visualPrompt: '', durationUs: 3_000_000, clipEdit: { planId: plan.id, inUs: 0, restoreInUs: 0, restoreDurationUs: 4_000_000 } }] });
}

it('requires an explicit processing version for video audio and validates its independent gain', () => {
  const enabled = { ...DEFAULT_AUDIO_PROCESSING, version: 2, videoAudio: { enabled: true, gainDb: -6 } };
  expect(audioProcessingSchema.parse(enabled)).toEqual(enabled);
  expect(audioProcessingSchema.safeParse({ ...enabled, version: 1 }).success).toBe(false);
  expect(audioProcessingSchema.safeParse({ ...enabled, videoAudio: { enabled: true, gainDb: 19 } }).success).toBe(false);
  expect(audioProcessingSchema.safeParse({ ...enabled, videoAudio: { enabled: true, gainDb: NaN } }).success).toBe(false);
  const document = fixture(); document.shots[0].audioProcessing = audioProcessingSchema.parse(enabled);
  expect(projectSchema.parse(JSON.parse(JSON.stringify(document))).shots[0].audioProcessing).toEqual(enabled);
});

it('retains old projects without silently adding processing or edit plans', () => {
  const value = fixture(); const { clipEditSources, clipEditPlans, ...legacy } = value;
  const parsed = projectSchema.parse({ ...legacy, shots: value.shots.map(({ clipEdit, ...shot }) => shot) });
  expect(parsed.audioMix).toBeUndefined(); expect(parsed.clipEditPlans).toBeUndefined(); expect(parsed.shots[0].audioProcessing).toBeUndefined();
  expect(audioMixSettingsSchema.parse(DEFAULT_AUDIO_MIX_SETTINGS)).toEqual(DEFAULT_AUDIO_MIX_SETTINGS);
  expect(audioProcessingSchema.parse(DEFAULT_AUDIO_PROCESSING)).toEqual(DEFAULT_AUDIO_PROCESSING);
  expect(clipEditSources).toHaveLength(1); expect(clipEditPlans).toHaveLength(1);
});

it('validates finite processing settings and rejects invalid loudness or gain before media processing', () => {
  for (const gainDb of [-61, 19, NaN, Infinity]) expect(audioProcessingSchema.safeParse({ ...DEFAULT_AUDIO_PROCESSING, gainDb }).success).toBe(false);
  for (const targetLufs of [-31, -8, NaN]) expect(audioMixSettingsSchema.safeParse({ ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, targetLufs } }).success).toBe(false);
  expect(audioMixSettingsSchema.safeParse({ ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, truePeakDb: 0 } }).success).toBe(false);
  expect(audioMixSettingsSchema.safeParse({ ...DEFAULT_AUDIO_MIX_SETTINGS, ducking: { ...DEFAULT_AUDIO_MIX_SETTINGS.ducking, releaseMs: 0 } }).success).toBe(false);
});

it('assigns exact rounded microsecond frame boundaries to the same half-open frame as preview', () => {
  const rate = { numerator: 30_000, denominator: 1001 };
  expect(timeAtFrame(1, rate)).toBe(33367); expect(firstFrameAtUs(33367, rate)).toBe(1); expect(firstFrameAtUs(33368, rate)).toBe(2); expect(firstFrameAtUs(100100, rate)).toBe(3);
  for (const numerator of [24, 25, 30, 30_000, 60_000]) {
    const frameRate = { numerator, denominator: numerator > 100 ? 1001 : 1 };
    for (const frame of [1, 2, 15, 100, 1001]) for (const shift of [-1, 0, 1]) {
      const boundary = timeAtFrame(frame, frameRate) + shift, first = firstFrameAtUs(boundary, frameRate);
      expect(timeAtFrame(first, frameRate)).toBeGreaterThanOrEqual(boundary);
      expect(timeAtFrame(first - 1, frameRate)).toBeLessThan(boundary);
    }
  }
  expect(() => firstFrameAtUs(Infinity, rate)).toThrow('有限');
});

it('rejects unknown, duplicate or out-of-range edit references without changing the saved source', () => {
  const original = fixture(); expect(() => validateClipEditContent(original)).not.toThrow();
  expect(() => validateClipEditContent({ ...original, clipEditSources: [...original.clipEditSources!, ...original.clipEditSources!] })).toThrow('编号不能重复');
  expect(() => validateClipEditContent({ ...original, clipEditSources: [] })).toThrow('不存在的原始');
  expect(() => validateClipEditContent({ ...original, clipEditPlans: [] })).toThrow('不存在的剪辑计划');
  expect(() => validateClipEditContent({ ...original, shots: original.shots.map(shot => ({ ...shot, durationUs: 3_000_001 })) })).toThrow('超出剪辑计划');
  const source = { ...original.clipEditSources![0], original: { ...original.clipEditSources![0].original, audioAssetId: 'voice' } };
  expect(() => validateClipEditContent({ ...original, clipEditSources: [source] })).toThrow('校验值不完整');
  expect(original.clipEditPlans![0].spans[1].originInUs).toBe(2_000_000);
});

it('keeps saved sources and plans immutable while allowing a new plan and persisted undo', () => {
  const original = fixture(), source = original.clipEditSources![0], plan = original.clipEditPlans![0];
  const reorderedSource = clipEditSourceSchema.parse(Object.fromEntries(Object.entries(source).reverse()));
  expect(() => validateClipEditHistory({ ...original, clipEditSources: [reorderedSource] }, original)).not.toThrow();
  expect(() => validateClipEditHistory({ ...original, clipEditPlans: [{ ...plan, spans: plan.spans.slice(1) }] }, original)).toThrow('不能原地改写');
  const next = { ...original, clipEditPlans: [...original.clipEditPlans!, { ...plan, id: 'new-plan', spans: plan.spans.slice(1) }] };
  expect(() => validateClipEditHistory(next, original)).not.toThrow(); expect(() => validateClipEditHistory(original, next)).not.toThrow();
});

it('keeps output-clock manual captions distinct from speech provenance and requires ordered silence candidates', () => {
  const project = fixture(), track = { timeBase: 'clip' as const, alignment: 'manual' as const, cues: [{ id: 'cue', startUs: 0, endUs: 1_000_000, text: '手动校正' }] };
  const withTrack = { ...project, shots: project.shots.map(shot => ({ ...shot, captionTrack: track })) };
  expect(() => validateClipEditContent(withTrack)).not.toThrow();
  expect(() => validateClipEditContent({ ...withTrack, shots: withTrack.shots.map(({ clipEdit, ...shot }) => shot) })).not.toThrow();
  expect(captionTrackSchema.safeParse({ ...track, alignment: 'speech', sourceAssetId: 'voice', sourceSha256: 'a'.repeat(64) }).success).toBe(false);
  const base = { assetId: 'voice', sourceSha256: 'a'.repeat(64), thresholdDb: -40, minimumDurationUs: 200000, paddingUs: 50000 };
  expect(silenceDetectionSchema.parse({ ...base, ranges: [] }).ranges).toEqual([]);
  expect(silenceDetectionSchema.safeParse({ ...base, ranges: [{ startUs: 100000, endUs: 300000 }, { startUs: 200000, endUs: 400000 }] }).success).toBe(false);
});
