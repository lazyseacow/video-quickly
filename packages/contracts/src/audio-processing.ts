import { z } from 'zod';

const voiceProcessingSchema = z.object({
  version: z.literal(1), gainDb: z.number().finite().min(-60).max(18),
  denoise: z.boolean(), noiseReductionDb: z.number().finite().min(3).max(40),
  videoAudio: z.never().optional(),
});
export const videoAudioSettingsSchema = z.object({ enabled: z.boolean(), gainDb: z.number().finite().min(-60).max(18) });
export type VideoAudioSettings = z.infer<typeof videoAudioSettingsSchema>;
export const DEFAULT_VIDEO_AUDIO: VideoAudioSettings = { enabled: false, gainDb: 0 };
// Version 2 makes the additional source explicit. Older readers reject it instead
// of silently stripping an enabled video track when they save the project.
export const audioProcessingSchema = z.discriminatedUnion('version', [
  voiceProcessingSchema,
  voiceProcessingSchema.extend({ version: z.literal(2), videoAudio: videoAudioSettingsSchema }),
]);
export type AudioProcessing = z.infer<typeof audioProcessingSchema>;
export const DEFAULT_AUDIO_PROCESSING: AudioProcessing = { version: 1, gainDb: 0, denoise: false, noiseReductionDb: 12 };

export function usesVideoAudio<T extends { videoAssetId?: string; audioProcessing?: AudioProcessing }>(shot: T): shot is T & { videoAssetId: string; audioProcessing: Extract<AudioProcessing, { version: 2 }> } {
  return Boolean(shot.videoAssetId && shot.audioProcessing?.version === 2 && shot.audioProcessing.videoAudio.enabled);
}

export const audioMixSettingsSchema = z.object({
  version: z.literal(1),
  loudness: z.object({ enabled: z.boolean(), targetLufs: z.number().finite().min(-30).max(-9), truePeakDb: z.number().finite().min(-6).max(-.1) }),
  ducking: z.object({ enabled: z.boolean(), thresholdDb: z.number().finite().min(-60).max(-6), ratio: z.number().finite().min(1).max(20), attackMs: z.number().finite().min(1).max(200), releaseMs: z.number().finite().min(20).max(2000) }),
});
export type AudioMixSettings = z.infer<typeof audioMixSettingsSchema>;
export const DEFAULT_AUDIO_MIX_SETTINGS: AudioMixSettings = {
  version: 1, loudness: { enabled: true, targetLufs: -16, truePeakDb: -1.5 },
  ducking: { enabled: false, thresholdDb: -30, ratio: 8, attackMs: 20, releaseMs: 250 },
};

export const audioMixAnalysisSchema = z.object({
  integratedLufs: z.number().finite().optional(), truePeakDb: z.number().finite().optional(),
  sampleRate: z.literal(48000), channels: z.literal(2),
});
export const preparedAudioMixSchema = z.object({
  version: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/), path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  durationUs: z.number().int().positive(), analysis: audioMixAnalysisSchema, warnings: z.array(z.string()),
  shotDurations: z.array(z.object({ shotId: z.string().min(1), durationUs: z.number().int().positive() })).optional(),
});
export type PreparedAudioMix = z.infer<typeof preparedAudioMixSchema>;
export const audioMixJobSchema = z.object({
  id: z.string().min(1), key: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  progress: z.number().min(0).max(1), result: preparedAudioMixSchema.optional(), error: z.string().optional(),
});
export type AudioMixJob = z.infer<typeof audioMixJobSchema>;
export const audioMixPrepareResultSchema = z.union([
  audioMixJobSchema,
  z.object({ status: z.literal('revision_changed'), revision: z.number().int().positive() }),
]);
export type AudioMixPrepareResult = z.infer<typeof audioMixPrepareResultSchema>;

export const audioLevelWindowSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/), startUs: z.number().int().nonnegative(), periodUs: z.literal(10000),
  samples: z.array(z.object({ peakLeft: z.number().finite().nonnegative(), peakRight: z.number().finite().nonnegative(), rmsLeft: z.number().finite().nonnegative(), rmsRight: z.number().finite().nonnegative() })).max(6000),
});
export type AudioLevelWindow = z.infer<typeof audioLevelWindowSchema>;
export const silenceDetectionSchema = z.object({
  assetId: z.string().min(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  thresholdDb: z.number().finite().min(-80).max(-10), minimumDurationUs: z.number().int().min(50000).max(10000000), paddingUs: z.number().int().min(0).max(1000000),
  ranges: z.array(z.object({ startUs: z.number().int().nonnegative(), endUs: z.number().int().positive() }).refine(value => value.endUs > value.startUs, '静音结束须晚于起点')).max(10000),
}).superRefine((value, context) => {
  value.ranges.forEach((range, index) => { if (index > 0 && range.startUs < value.ranges[index - 1].endUs) context.addIssue({ code: 'custom', message: '静音候选须按时间排序且不能重叠', path: ['ranges', index] }); });
});
export type SilenceDetection = z.infer<typeof silenceDetectionSchema>;
