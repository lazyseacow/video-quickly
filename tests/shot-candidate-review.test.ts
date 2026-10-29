import { describe, expect, it } from 'vitest';
import { applyShotCandidate, shotCandidateSchema, shotSchema } from '@video-quickly/contracts';

describe('candidate input dependency protection', () => {
  const baseline = shotSchema.parse({ id: 'shot', title: '目标镜头', narration: '旁白输入', visualPrompt: '视频提示', durationUs: 2_000_000, assetId: 'reference-before', videoAssetId: 'old-video', audioAssetId: 'old-voice' });
  const candidate = (kind: 'audio' | 'video') => shotCandidateSchema.parse({
    id: `candidate-${kind}`, kind, projectId: 'project', shotId: baseline.id, runId: 'run', nodeId: 'regenerate', createdAt: '2026-10-30', baseline,
    shot: { ...baseline, [kind === 'video' ? 'videoAssetId' : 'audioAssetId']: 'generated' }, assetIds: ['generated'],
  });

  it('rejects a video made from a reference image changed during generation', () => {
    expect(() => applyShotCandidate({ ...baseline, assetId: 'reference-after' }, candidate('video'))).toThrow('已修改');
  });

  it('keeps an unrelated reference image edit when applying a voice candidate', () => {
    const current = { ...baseline, assetId: 'reference-after' };
    expect(applyShotCandidate(current, candidate('audio'))).toEqual({ ...current, audioAssetId: 'generated', audioInUs: 0 });
  });
});
