import { describe, expect, it } from 'vitest';
import { audioWaveformSchema, captionTrackSchema, createHistoryWorkflow, DEFAULT_VIDEO_PROFILE, frameAtTime, musicClipSchema, projectSchema, shotSchema, timeAtFrame, videoProfileSchema } from '@video-quickly/contracts';

describe('video output time and dimensions', () => {
  it('keeps fractional frame indexing aligned over a two-hour edit', () => {
    const rate = { numerator: 30000, denominator: 1001 };
    const originalUs = 2 * 60 * 60 * 1_000_000;
    const frame = frameAtTime(originalUs, rate);
    expect(Math.abs(timeAtFrame(frame, rate) - originalUs)).toBeLessThanOrEqual(1001 * 1_000_000 / 30000 / 2 + 1);
  });
  it('keeps a source timestamp independent of output frame rate', () => {
    const sourceUs = 12_345_000;
    for (const numerator of [24, 25, 30, 50, 60]) {
      const rate = { numerator, denominator: 1 };
      expect(Math.abs(timeAtFrame(frameAtTime(sourceUs, rate), rate) - sourceUs)).toBeLessThanOrEqual(1_000_000 / numerator / 2 + 1);
    }
  });
  it('rejects dimensions incompatible with 4:2:0 output and invalid rates', () => {
    expect(videoProfileSchema.safeParse({ ...DEFAULT_VIDEO_PROFILE, width: 1081 }).success).toBe(false);
    expect(videoProfileSchema.safeParse({ ...DEFAULT_VIDEO_PROFILE, frameRate: { numerator: 0, denominator: 1 } }).success).toBe(false);
    expect(videoProfileSchema.safeParse({ ...DEFAULT_VIDEO_PROFILE, width: 2160, height: 3840, frameRate: { numerator: 60000, denominator: 1001 } }).success).toBe(true);
  });
});

describe('caption and project audio contracts', () => {
  const cue = { id: 'a', startUs: 0, endUs: 1_000_000, text: '字幕文本' };
  const track = { timeBase: 'scene', alignment: 'manual', cues: [cue] };

  it('requires unique, ordered, nonoverlapping cues with nonempty text and positive intervals', () => {
    expect(captionTrackSchema.safeParse({ ...track, cues: [cue, { ...cue, id: 'b', startUs: 1_000_000, endUs: 2_000_000 }] }).success).toBe(true);
    for (const cues of [
      [{ ...cue, text: ' \n ' }], [{ ...cue, endUs: 0 }], [{ ...cue, startUs: -1 }], [{ ...cue, startUs: .5 }],
      [cue, { ...cue, startUs: 1_000_000, endUs: 2_000_000 }],
      [cue, { ...cue, id: 'b', startUs: 900_000, endUs: 2_000_000 }],
      [{ ...cue, startUs: 1_000_000, endUs: 2_000_000 }, { ...cue, id: 'b' }],
    ]) expect(captionTrackSchema.safeParse({ ...track, cues }).success).toBe(false);
    expect(captionTrackSchema.parse({ ...track, cues: [] }).cues).toEqual([]);
  });

  it('requires source audio provenance and source coordinates for real speech alignment', () => {
    const speech = { ...track, timeBase: 'source', alignment: 'speech', sourceAssetId: 'audio', sourceSha256: 'audio-hash', granularity: 'word', modelId: 'asr-model' };
    expect(captionTrackSchema.safeParse(speech).success).toBe(true);
    for (const invalid of [{ ...speech, timeBase: 'scene' }, { ...speech, sourceAssetId: undefined }, { ...speech, sourceSha256: '' }]) expect(captionTrackSchema.safeParse(invalid).success).toBe(false);
  });

  it('keeps audio fields optional in old projects and applies defaults only to new music clips', () => {
    const project = projectSchema.parse({ id: 'p', title: '项目', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), shots: [], createdAt: '', updatedAt: '' });
    expect(project.musicClips).toBeUndefined();
    const music = musicClipSchema.parse({ id: 'm', assetId: 'audio', durationUs: 2_000_000 });
    expect(music).toEqual({ id: 'm', assetId: 'audio', durationUs: 2_000_000, startUs: 0, sourceInUs: 0, gainDb: -18, fadeInUs: 0, fadeOutUs: 0, loop: false });
    expect(projectSchema.parse({ ...project, musicClips: [music] }).musicClips).toEqual([music]);
    for (const invalid of [{ durationUs: 0 }, { fadeInUs: 2_000_001 }, { fadeOutUs: 2_000_001 }, { gainDb: 1 }, { gainDb: -61 }]) expect(musicClipSchema.safeParse({ ...music, ...invalid }).success).toBe(false);
    expect(shotSchema.safeParse({ id: 's', title: '镜头', narration: '', visualPrompt: '', durationUs: 1_000_000, captionTrack: track }).success).toBe(true);
  });

  it('validates real 100Hz waveform shape including its final partial window', () => {
    const waveform = { version: 1, assetId: 'audio', sha256: 'hash', durationUs: 20_063, peaksPerSecond: 100, peaks: [0, .5, 1] };
    expect(audioWaveformSchema.safeParse(waveform).success).toBe(true);
    for (const invalid of [{ peaks: [0, .5] }, { peaks: [0, 1.1, 1] }, { peaks: [-.1, .5, 1] }, { peaksPerSecond: 50 }, { durationUs: 0 }, { version: 2 }]) expect(audioWaveformSchema.safeParse({ ...waveform, ...invalid }).success).toBe(false);
  });
});
