import { describe, expect, it } from 'vitest';
import { applyShotCandidate, createSceneTemplate, shotCandidateSchema, shotSchema, type ShotCandidate } from '@video-quickly/contracts';

const baseline = shotSchema.parse({ id: 's1', title: '原镜头', narration: '原旁白', visualPrompt: '原画面', durationUs: 2_000_000, sourceInUs: 1_000_000, audioAssetId: 'old-audio', videoAssetId: 'old-video' });
function candidate(kind: ShotCandidate['kind'] = 'script') {
  return shotCandidateSchema.parse({ id: 'c1', projectId: 'p1', shotId: 's1', runId: 'r1', nodeId: 'regenerate', kind, createdAt: new Date().toISOString(), baseline, shot: { ...baseline, title: '新标题', narration: '新旁白', visualPrompt: '新画面', durationUs: 3_000_000, assetId: 'new-image', audioAssetId: 'new-audio', videoAssetId: 'new-video' }, assetIds: ['new-image', 'new-audio', 'new-video'] });
}

describe('shot candidate selection', () => {


  it('applies only chosen text fields and keeps unrelated manual edits and duration', () => {
    const current = { ...baseline, title: '人工标题' };
    expect(applyShotCandidate(current, candidate(), ['narration'])).toEqual({ ...current, narration: '新旁白' });
    expect(() => applyShotCandidate(current, candidate(), ['title'])).toThrow('已修改');
    expect(() => applyShotCandidate(current, candidate(), [])).toThrow('至少选择');
  });

  it('preserves audio when applying video and rejects a changed target source interval', () => {
    expect(applyShotCandidate(baseline, candidate('video'))).toEqual({ ...baseline, videoAssetId: 'new-video', videoInUs: 0 });
    expect(() => applyShotCandidate({ ...baseline, sourceInUs: 1_100_000 }, candidate('video'))).toThrow('区间');
    expect(() => applyShotCandidate({ ...baseline, locked: true }, candidate('video'))).toThrow('解锁');
  });
  it('selects an image visibly and protects an intervening video replacement', () => {
    expect(applyShotCandidate(baseline, candidate('image'))).toEqual({ ...baseline, assetId: 'new-image', videoAssetId: undefined, videoInUs: undefined });
    expect(() => applyShotCandidate({ ...baseline, videoAssetId: 'manual' }, candidate('image'))).toThrow('已修改');
  });

});
