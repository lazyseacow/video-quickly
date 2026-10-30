import { z } from 'zod';

export const motionEasingSchema = z.enum(['linear', 'hold', 'smoothstep', 'ease-in', 'ease-out', 'cubic-bezier']);
export type MotionEasing = z.infer<typeof motionEasingSchema>;
export const motionKeyframeSchema = z.object({
  id: z.string().min(1), timeUs: z.number().int().nonnegative(),
  panX: z.number().min(-2).max(2), panY: z.number().min(-2).max(2), zoom: z.number().min(.1).max(5),
  easing: motionEasingSchema.default('smoothstep'),
  curve: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
}).superRefine((value, context) => {
  if (value.easing === 'cubic-bezier' && !value.curve) context.addIssue({ code: 'custom', path: ['curve'], message: '自定义曲线需要两个控制点。' });
});
export type MotionKeyframe = z.infer<typeof motionKeyframeSchema>;
export const motionKeyframesSchema = z.array(motionKeyframeSchema).min(1).max(200).superRefine((values, context) => {
  const ids = new Set<string>();
  values.forEach((value, index) => {
    if (ids.has(value.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: '关键帧编号不能重复。' });
    if (index && values[index - 1].timeUs >= value.timeUs) context.addIssue({ code: 'custom', path: [index, 'timeUs'], message: '关键帧时间须严格递增，不能重复。' });
    ids.add(value.id);
  });
});
