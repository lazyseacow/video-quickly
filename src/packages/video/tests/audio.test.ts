import { describe, expect, it } from 'vitest';
import { musicClipSchema } from '@video-quickly/contracts';
import { commonSourceOutUs, mediaSourceInUs, musicPlaybackAtTime } from '../src/audio.js';

describe('independent media source clocks', () => {
  it('keeps new audio at its own start while retaining the original video position', () => {
    const shot = { sourceInUs: 5_000_000, audioInUs: 0, videoInUs: 7_000_000 };
    expect(mediaSourceInUs(shot, 'audio')).toBe(0);
    expect(mediaSourceInUs(shot, 'video')).toBe(7_000_000);
    expect(mediaSourceInUs({ sourceInUs: 5_000_000 }, 'audio')).toBe(5_000_000);
    expect(mediaSourceInUs({}, 'video')).toBe(0);
    const originalDurations = { audioDurationUs: 2_000_000, videoDurationUs: 10_000_000 };
    expect(commonSourceOutUs(shot, originalDurations)).toBe(8_000_000);
    expect(commonSourceOutUs({ ...shot, sourceInUs: 6_000_000, audioInUs: 1_000_000, videoInUs: 8_000_000 }, originalDurations)).toBe(8_000_000);
    expect(originalDurations).toEqual({ audioDurationUs: 2_000_000, videoDurationUs: 10_000_000 });
    expect(commonSourceOutUs({ sourceInUs: 5_000_000, audioInUs: 0 }, { audioDurationUs: 2_000_000 })).toBe(7_000_000);
    expect(commonSourceOutUs({}, { audioDurationUs: 2_000_000 })).toBe(2_000_000);
    expect(commonSourceOutUs({ sourceInUs: 10_000_000, audioInUs: 3_000_000 }, { audioDurationUs: 2_000_000 })).toBe(9_000_000);
    expect(commonSourceOutUs({}, {})).toBeUndefined();
  });
});

describe('project background music playback', () => {
  const clip = musicClipSchema.parse({ id: 'music', assetId: 'audio', startUs: 1_000_000, sourceInUs: 2_000_000, durationUs: 6_000_000, gainDb: -6, fadeInUs: 1_000_000, fadeOutUs: 2_000_000, loop: true });

  it('uses project time and repeats only the selected source tail', () => {
    expect(musicPlaybackAtTime(clip, 999_999, 4_000_000).active).toBe(false);
    expect(musicPlaybackAtTime(clip, 1_000_000, 4_000_000)).toEqual({ active: true, timeUs: 2_000_000, gain: 0 });
    expect(musicPlaybackAtTime(clip, 3_500_000, 4_000_000)).toMatchObject({ active: true, timeUs: 2_500_000 });
    expect(musicPlaybackAtTime(clip, 7_000_000, 4_000_000)).toMatchObject({ active: false, gain: 0 });
    expect(clip.startUs).toBe(1_000_000); expect(clip.durationUs).toBe(6_000_000);
  });

  it('multiplies decibel gain with the same linear entrance and exit fades as the exporter', () => {
    const plateau = musicPlaybackAtTime(clip, 3_000_000, 4_000_000).gain;
    expect(plateau).toBeCloseTo(.501187, 5);
    expect(musicPlaybackAtTime(clip, 1_500_000, 4_000_000).gain).toBeCloseTo(plateau / 2);
    expect(musicPlaybackAtTime(clip, 6_000_000, 4_000_000).gain).toBeCloseTo(plateau / 2);
    const overlap = { ...clip, fadeInUs: 6_000_000, fadeOutUs: 6_000_000 };
    expect(musicPlaybackAtTime(overlap, 4_000_000, 4_000_000).gain).toBeCloseTo(plateau / 4);
  });

  it('stops a nonlooping source at its real end and handles unavailable media', () => {
    const once = { ...clip, loop: false };
    expect(musicPlaybackAtTime(once, 2_999_999, 4_000_000).active).toBe(true);
    expect(musicPlaybackAtTime(once, 3_000_000, 4_000_000).active).toBe(false);
    expect(musicPlaybackAtTime(clip, 2_000_000, 2_000_000).active).toBe(false);
    expect(musicPlaybackAtTime(clip, NaN, 4_000_000).active).toBe(false);
  });
});
