import { z } from 'zod';

export const frameRateSchema = z.object({ numerator: z.number().int().positive().max(120000), denominator: z.number().int().positive().max(1001) })
  .refine(value => value.numerator / value.denominator >= 1 && value.numerator / value.denominator <= 120, '帧率须介于 1 和 120 fps');
export const videoProfileSchema = z.object({
  width: z.number().int().min(64).max(7680).refine(value => value % 2 === 0, '宽度须为偶数'),
  height: z.number().int().min(64).max(7680).refine(value => value % 2 === 0, '高度须为偶数'),
  frameRate: frameRateSchema,
  fitMode: z.enum(['contain', 'cover', 'blur']).default('contain'),
  previewScale: z.number().min(0.1).max(1).default(0.5),
});
export type FrameRate = z.infer<typeof frameRateSchema>;
export type VideoProfile = z.infer<typeof videoProfileSchema>;

export const DEFAULT_VIDEO_PROFILE: VideoProfile = { width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: 0.5 };
export const FRAME_RATE_PRESETS = [
  { label: '23.976', numerator: 24000, denominator: 1001 },
  { label: '24', numerator: 24, denominator: 1 },
  { label: '25', numerator: 25, denominator: 1 },
  { label: '29.97', numerator: 30000, denominator: 1001 },
  { label: '30', numerator: 30, denominator: 1 },
  { label: '50', numerator: 50, denominator: 1 },
  { label: '59.94', numerator: 60000, denominator: 1001 },
  { label: '60', numerator: 60, denominator: 1 },
] as const;
export const ASPECT_RATIO_PRESETS = [
  { label: '16:9', width: 16, height: 9 }, { label: '9:16', width: 9, height: 16 },
  { label: '1:1', width: 1, height: 1 }, { label: '4:3', width: 4, height: 3 },
  { label: '3:4', width: 3, height: 4 }, { label: '4:5', width: 4, height: 5 },
  { label: '21:9', width: 21, height: 9 },
] as const;
export const VIDEO_FIT_MODE_LABELS = {
  contain: '完整显示 · 等比留边', cover: '裁剪填满', blur: '模糊背景填充',
} satisfies Record<VideoProfile['fitMode'], string>;
export function videoAspectRatioPreset(width: number, height: number) {
  const ratio = width / height;
  return ASPECT_RATIO_PRESETS.find(item => Math.abs(item.width / item.height - ratio) < .005);
}
export function formatFrameRate(rate: FrameRate): string {
  return FRAME_RATE_PRESETS.find(value => value.numerator === rate.numerator && value.denominator === rate.denominator)?.label ?? (rate.numerator / rate.denominator).toFixed(3).replace(/\.?0+$/, '');
}
export function frameAtTime(timeUs: number, rate: FrameRate): number {
  return Math.round(timeUs * rate.numerator / (1_000_000 * rate.denominator));
}
export function timeAtFrame(frame: number, rate: FrameRate): number {
  return Math.round(frame * 1_000_000 * rate.denominator / rate.numerator);
}
/** Use the persisted microsecond frame grid at half-open caption and edit boundaries. */
export function firstFrameAtUs(timeUs: number, rate: FrameRate): number {
  if (!Number.isFinite(timeUs)) throw new RangeError('时间须为有限数值。');
  let frame = Math.max(0, frameAtTime(timeUs, rate));
  while (timeAtFrame(frame, rate) < timeUs) frame++;
  while (frame > 0 && timeAtFrame(frame - 1, rate) >= timeUs) frame--;
  return frame;
}
