import { expect, it } from 'vitest';
import { assetSchema, createSceneTemplate, DEFAULT_AUDIO_PROCESSING, shotSchema } from '@video-quickly/contracts';
import { sourceDurationsKey } from '../apps/desktop/src/lib/source-duration';

it('probes template video only while its original sound is enabled and invalidates changed source metadata', () => {
  const shot = shotSchema.parse({ id: 'diagram', title: '图解原声', narration: '', visualPrompt: '', durationUs: 1_000_000, sceneTemplate: createSceneTemplate('process'), videoAssetId: 'video' });
  const asset = assetSchema.parse({ id: 'video', kind: 'video', name: 'source.mp4', path: '/fixture/source.mp4', version: 1, sha256: 'a'.repeat(64), size: 100, mimeType: 'video/mp4', provenance: 'test', active: true, retained: false, createdAt: '' });
  expect(sourceDurationsKey([shot], [asset])).toBe(sourceDurationsKey([shot], []));
  const audible = { ...shot, audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, version: 2 as const, videoAudio: { enabled: true, gainDb: 0 } } };
  const key = sourceDurationsKey([audible], [asset]);
  expect(key).not.toBe(sourceDurationsKey([audible], []));
  expect(key).not.toBe(sourceDurationsKey([audible], [{ ...asset, version: 2, sha256: 'b'.repeat(64) }]));
  expect(key).not.toBe(sourceDurationsKey([audible], [{ ...asset, active: false }]));
  expect(key).toBe(sourceDurationsKey([{ ...audible, audioProcessing: { ...audible.audioProcessing, videoAudio: { enabled: true, gainDb: -6 } } }], [asset]));
});
