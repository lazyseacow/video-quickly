import { expect, it } from 'vitest';
import { createHistoryWorkflow, DEFAULT_AUDIO_MIX_SETTINGS, DEFAULT_VIDEO_PROFILE, projectSchema, shotSchema, type AssetRecord } from '@video-quickly/contracts';
import { audioMixProjectionKey, readAudioLevelWindow } from '../src/audio-mix.js';
import { audioMixProjection } from '../src/audio-projection.js';

const voice: AssetRecord = { id: 'voice', projectId: 'project', name: 'voice.wav', kind: 'audio', path: '/not-read-by-projection.wav', sha256: 'a'.repeat(64), mimeType: 'audio/wav', size: 1000, version: 1, active: true, retained: false, provenance: '', createdAt: '' };
const project = () => projectSchema.parse({ id: 'project', title: 'Audio identity', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), createdAt: '', updatedAt: '', shots: [shotSchema.parse({ id: 'shot', title: 'Shot', narration: '', visualPrompt: '', durationUs: 2_000_000, sourceInUs: 0, audioAssetId: voice.id })] });

it('keys the actual sound projection independently of visual edits and target export frame rate', () => {
  const original = project(), before = structuredClone(original), assets = [voice];
  const visual = { ...original, title: 'Renamed', profile: { ...original.profile, width: 1080, height: 1920, frameRate: { numerator: 24, denominator: 1 } }, shots: original.shots.map(shot => ({ ...shot, narration: 'Only edited text', title: 'Renamed shot', videoAssetId: 'unused-video' })) };
  expect(audioMixProjectionKey(visual, assets)).toBe(audioMixProjectionKey(original, assets));
  expect(audioMixProjection(visual, assets)).toBe(audioMixProjection(original, assets));
  expect(audioMixProjectionKey({ ...original, shots: original.shots.map(shot => ({ ...shot, audioInUs: 100_000 })) }, assets)).not.toBe(audioMixProjectionKey(original, assets));
  expect(audioMixProjectionKey(original, [{ ...voice, sha256: 'b'.repeat(64) }])).not.toBe(audioMixProjectionKey(original, assets));
  expect(audioMixProjectionKey({ ...original, audioMix: { ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, enabled: false } } }, assets)).not.toBe(audioMixProjectionKey(original, assets));
  expect(original).toEqual(before);
});

it('keys enabled video source windows and gain while leaving muted video changes outside the sound dependency', () => {
  const original = project(), video: AssetRecord = { ...voice, id: 'video', kind: 'video', sha256: 'c'.repeat(64) };
  const enabled = projectSchema.parse({ ...original, shots: [{ ...original.shots[0], videoAssetId: video.id, videoInUs: 400_000, audioProcessing: { version: 2, gainDb: 0, denoise: false, noiseReductionDb: 12, videoAudio: { enabled: true, gainDb: -6 } } }] });
  const assets = [voice, video], key = audioMixProjectionKey(enabled, assets);
  expect(audioMixProjectionKey({ ...enabled, shots: [{ ...enabled.shots[0], videoInUs: 800_000 }] }, assets)).not.toBe(key);
  expect(audioMixProjectionKey(enabled, [voice, { ...video, sha256: 'd'.repeat(64) }])).not.toBe(key);
  expect(() => audioMixProjectionKey(enabled, [voice, { ...video, active: false }])).toThrow('有效视频');
  const muted = projectSchema.parse({ ...enabled, shots: [{ ...enabled.shots[0], audioProcessing: { ...enabled.shots[0].audioProcessing, videoAudio: { enabled: false, gainDb: -6 } } }] });
  expect(audioMixProjectionKey({ ...muted, shots: [{ ...muted.shots[0], videoInUs: 900_000 }] }, [voice, { ...video, active: false }])).toBe(audioMixProjectionKey(muted, assets));
});

it('scopes duration metadata to its project and shot identities across backup imports', () => {
  const original = project(), shared = [{ ...voice, projectId: undefined }];
  expect(audioMixProjectionKey({ ...original, id: 'restored-project' }, shared)).not.toBe(audioMixProjectionKey(original, shared));
  expect(audioMixProjectionKey({ ...original, shots: original.shots.map(shot => ({ ...shot, id: 'restored-shot' })) }, shared)).not.toBe(audioMixProjectionKey(original, shared));
});

it('rejects unavailable or foreign audio and bounds level reads before accessing disk', async () => {
  expect(() => audioMixProjectionKey(project(), [{ ...voice, active: false }])).toThrow('有效音频');
  expect(() => audioMixProjectionKey(project(), [{ ...voice, projectId: 'other' }])).toThrow('有效音频');
  await expect(readAudioLevelWindow({ mix: { version: 1, key: 'a'.repeat(64), sha256: 'b'.repeat(64), path: '/not-read.wav', durationUs: 1_000_000, analysis: { sampleRate: 48000, channels: 2 }, warnings: [] }, startUs: 0, durationUs: 60_000_001 })).rejects.toThrow('60 秒');
});
