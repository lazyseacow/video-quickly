import { z } from 'zod';

export const imageRectangleSchema = z.object({
  x: z.number().int().nonnegative(), y: z.number().int().nonnegative(),
  width: z.number().int().positive(), height: z.number().int().positive(),
}).strict();
export type ImageRectangle = z.infer<typeof imageRectangleSchema>;
export const imageDerivationSchema = z.object({
  kind: z.enum(['grid-crop', 'edit-mask']), sourceAssetId: z.string().min(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), rectangle: imageRectangleSchema,
  sourceWidth: z.number().int().positive(), sourceHeight: z.number().int().positive(),
  grid: z.object({ rows: z.number().int().min(1).max(8), columns: z.number().int().min(1).max(8), index: z.number().int().nonnegative().max(63) }).optional(),
}).strict().superRefine((value, context) => {
  const { rectangle, grid, sourceWidth, sourceHeight } = value;
  if (rectangle.x + rectangle.width > sourceWidth || rectangle.y + rectangle.height > sourceHeight) context.addIssue({ code: 'custom', message: '图片来源的裁切区域超出原图范围。', path: ['rectangle'] });
  if (!grid) return;
  if (value.kind !== 'grid-crop') {
    context.addIssue({ code: 'custom', message: '修改区域遮罩不能包含切图网格信息。', path: ['grid'] }); return;
  }
  if (grid.rows > sourceHeight || grid.columns > sourceWidth || grid.index >= grid.rows * grid.columns) {
    context.addIssue({ code: 'custom', message: '切图网格或编号超出原图范围。', path: ['grid'] }); return;
  }
  const expected = imageGridRectangles(sourceWidth, sourceHeight, grid.rows, grid.columns)[grid.index];
  if ((['x', 'y', 'width', 'height'] as const).some(key => rectangle[key] !== expected[key])) context.addIssue({ code: 'custom', message: '切图区域与网格编号不一致。', path: ['rectangle'] });
});
export const imageEditInputSchema = z.object({ sourceAssetId: z.string().min(1), maskAssetId: z.string().min(1).optional() }).strict();
export type ImageEditInput = z.infer<typeof imageEditInputSchema>;

/** Integer boundaries preserve all source pixels even when dimensions do not divide evenly. */
export function imageGridRectangles(width: number, height: number, rows: number, columns: number): ImageRectangle[] {
  if (![width, height, rows, columns].every(Number.isSafeInteger) || width < 1 || height < 1 || rows < 1 || columns < 1 || rows > 8 || columns > 8 || rows > height || columns > width) throw new Error('网格行列须为 1–8，且不能超过图片像素尺寸。');
  return Array.from({ length: rows * columns }, (_, index) => {
    const column = index % columns, row = Math.floor(index / columns);
    const x = Math.floor(column * width / columns), y = Math.floor(row * height / rows);
    return { x, y, width: Math.floor((column + 1) * width / columns) - x, height: Math.floor((row + 1) * height / rows) - y };
  });
}
