import { z } from 'zod';

export const assetRecoveryExpectedSchema = z.object({
  id: z.string(), path: z.string(), sha256: z.string(), size: z.number().nonnegative(), version: z.number().int().positive(),
  kind: z.enum(['image', 'video', 'audio', 'subtitle', 'document']), projectId: z.string().optional(), shotId: z.string().optional(),
});
export const assetRecoverySourceSchema = z.object({
  kind: z.enum(['asset', 'project', 'character', 'run-snapshot', 'export-batch-snapshot', 'node-result']),
  id: z.string(), active: z.boolean().optional(),
});
export const assetRecoveryCandidateSchema = z.object({ id: z.string(), path: z.string(), size: z.number().nonnegative(), sha256: z.string() });
export const assetRecoveryItemSchema = z.object({
  id: z.string(), assetId: z.string(), name: z.string(), expected: assetRecoveryExpectedSchema.nullable(),
  sources: z.array(assetRecoverySourceSchema),
  status: z.enum(['pending', 'available', 'missing', 'content_mismatch', 'unreadable', 'unsafe_path', 'invalid_metadata', 'conflict', 'restored']),
  detail: z.string().optional(), candidates: z.array(assetRecoveryCandidateSchema), additionalCandidates: z.number().int().nonnegative().default(0),
});
export const assetRecoveryJobSchema = z.object({
  id: z.string(), generation: z.number().int().positive().default(1), projectId: z.string().optional(), directory: z.string().optional(),
  phase: z.enum(['checking', 'awaiting_directory', 'scanning', 'awaiting_confirmation', 'repairing', 'succeeded', 'failed', 'canceled', 'interrupted']),
  createdAt: z.string(), updatedAt: z.string(), error: z.string().optional(),
  progress: z.object({ checked: z.number().int().nonnegative(), total: z.number().int().nonnegative(), scanned: z.number().int().nonnegative(), hashed: z.number().int().nonnegative(), restored: z.number().int().nonnegative() }),
  warningCount: z.number().int().nonnegative(), warnings: z.array(z.object({ path: z.string(), message: z.string() })),
});
export const assetRecoveryPageSchema = z.object({ job: assetRecoveryJobSchema, items: z.array(assetRecoveryItemSchema), nextOffset: z.number().int().nonnegative().nullable() });
export const assetRecoveryStartSchema = z.object({ projectId: z.string().min(1).optional() });
export const assetRecoveryGetSchema = z.object({ jobId: z.string().min(1), generation: z.number().int().positive().optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(100) });
export const assetRecoveryScanSchema = z.object({ jobId: z.string().min(1), directory: z.string().min(1) });
export const assetRecoveryConfirmSchema = z.object({ jobId: z.string().min(1), selections: z.array(z.object({ itemId: z.string().min(1), candidateId: z.string().min(1) })).min(1).max(2000) });
export const assetRecoveryCancelSchema = z.object({ jobId: z.string().min(1) });
export type AssetRecoveryExpected = z.infer<typeof assetRecoveryExpectedSchema>;
export type AssetRecoverySource = z.infer<typeof assetRecoverySourceSchema>;
export type AssetRecoveryItem = z.infer<typeof assetRecoveryItemSchema>;
export type AssetRecoveryJob = z.infer<typeof assetRecoveryJobSchema>;
export type AssetRecoveryPage = z.infer<typeof assetRecoveryPageSchema>;
