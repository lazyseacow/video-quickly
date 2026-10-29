import { expect, it } from 'vitest';
import { assetSchema, preparedAudioMixSchema, shotSchema } from '@video-quickly/contracts';
import { buildTimeline } from '../packages/video/src/index';
import { splitShot } from '../packages/video/src/editing';
import { measuredAudioShots, rememberAudioDurations, resolvedAudioShots } from '../apps/desktop/src/lib/audio-timing';

const shot = shotSchema.parse({ id: 'voice', title: '旧旁白', narration: '', visualPrompt: '', durationUs: 2_000_000, audioAssetId: 'audio' });
const next = shotSchema.parse({ ...shot, id: 'next', audioAssetId: undefined, durationUs: 1_000_000 });
const mix = preparedAudioMixSchema.parse({ version: 1, key: 'a'.repeat(64), sha256: 'b'.repeat(64), path: '/tmp/mix.wav', durationUs: 5_000_000, shotDurations: [{ shotId: shot.id, durationUs: 4_000_000 }, { shotId: next.id, durationUs: 1_000_000 }], analysis: { sampleRate: 48000, channels: 2 }, warnings: [] });

it('uses the full legacy recording for preview positions and split without silently changing authored content', () => {
  const raw = [shot, next], resolved = resolvedAudioShots(raw, mix);
  expect(raw[0].durationUs).toBe(2_000_000);
  expect(buildTimeline(resolved)[1].startUs).toBe(4_000_000);
  const [left, right] = splitShot(resolved[0], 3_000_000, { numerator: 30, denominator: 1 }, 'right');
  expect(left.durationUs).toBe(3_000_000); expect(right.durationUs).toBe(1_000_000); expect(right.sourceInUs).toBe(3_000_000);
  expect(resolved[1]).toBe(next);
});

it('rejects stale identity mappings and never extends an explicitly trimmed recording', () => {
  expect(() => resolvedAudioShots([next, shot], mix)).toThrow('时间映射');
  expect(() => resolvedAudioShots([{ ...shot, sourceInUs: 0 }, next], mix)).toThrow('剪辑时长');
  expect(() => resolvedAudioShots([{ ...shot, audioInUs: 0 }, next], mix)).toThrow('剪辑时长');
  expect(resolvedAudioShots([shot, next])).toEqual([shot, next]);
});

const asset = assetSchema.parse({ id: 'audio', kind: 'audio', name: '录音', path: '/tmp/source.wav', sha256: 'a'.repeat(64), size: 1000, version: 1, mimeType: 'audio/wav', createdAt: '', provenance: 'fixture' });

it('retains measured prefixes through structure edits and undo without persisting unrelated legacy data', () => {
  const cache = new Map<string, number>(); rememberAudioDurations(cache, [shot, next], mix, [asset]);
  const raw = [shot, { ...next, durationUs: 500000 }, { ...next, id: 'right', durationUs: 500000 }];
  const resolved = measuredAudioShots(raw, [asset], cache);
  expect(buildTimeline(resolved)[2].startUs).toBe(4500000);
  expect(raw[0]).toBe(shot); expect(raw[0].durationUs).toBe(2000000);
  expect(measuredAudioShots([shot, { ...shot, id: 'copy' }, next], [asset], cache).map(value => value.durationUs)).toEqual([4000000, 4000000, 1000000]);
  const fixed = { ...shot, sourceInUs: 0 };
  rememberAudioDurations(cache, [fixed, next], { ...mix, durationUs: 3000000, shotDurations: [{ shotId: shot.id, durationUs: 2000000 }, { shotId: next.id, durationUs: 1000000 }] }, [asset]);
  expect(measuredAudioShots([shot, next], [asset], cache)[0].durationUs).toBe(4000000);
  expect(measuredAudioShots([fixed, { ...shot, audioInUs: 0 }, { ...shot, durationUs: 5000000 }], [asset], cache).map(value => value.durationUs)).toEqual([2000000, 2000000, 5000000]);
});

it('invalidates measured timing when source hash, file identity or availability changes', () => {
  const cache = new Map<string, number>(); rememberAudioDurations(cache, [shot, next], mix, [asset]);
  for (const changed of [{ ...asset, sha256: 'b'.repeat(64) }, { ...asset, version: 2 }, { ...asset, path: '/tmp/replaced.wav' }, { ...asset, active: false }]) expect(measuredAudioShots([shot, next], [changed], cache)[0].durationUs).toBe(2000000);
  const unknown = new Map<string, number>(); rememberAudioDurations(unknown, [{ ...shot, durationUs: 4000000 }, next], mix, [asset]);
  expect(measuredAudioShots([shot], [asset], unknown)[0].durationUs).toBe(2000000);
});
