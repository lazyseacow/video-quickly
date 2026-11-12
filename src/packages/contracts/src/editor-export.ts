import { z } from 'zod';

const editorExportTargetSchema = z.enum(['jianying', 'capcut']);

export const editorExportInputSchema = z.object({
  projectId: z.string().min(1),
  revision: z.number().int().positive(),
  target: editorExportTargetSchema,
  destinationDirectory: z.string().trim().min(1).optional(),
  templatePath: z.string().trim().min(1).optional(),
}).strict();
export type EditorExportInput = z.infer<typeof editorExportInputSchema>;

export const editorExportResultSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectRevision: z.number(),
  target: editorExportTargetSchema,
  format: z.enum(['handoff', 'draft']),
  directory: z.string(),
  manifestPath: z.string(),
  specPath: z.string(),
  draftPath: z.string().optional(),
  editorVersion: z.string().optional(),
  warnings: z.array(z.string()),
});
export type EditorExportResult = z.infer<typeof editorExportResultSchema>;
