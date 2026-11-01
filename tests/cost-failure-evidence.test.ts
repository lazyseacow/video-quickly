import { expect, test } from 'vitest';
import { runInspectionSchema, runSchema, usageRecordSchema } from '@video-quickly/contracts';
import { costFailureEvidence } from './fixtures/cost-failure-evidence';

test('projects only cost fixture counts, activity stages and receipt state into failure evidence', () => {
  const run = runSchema.parse({ id: '5d25239a-3d34-4f29-bcb1-b27dc88b3447', projectId: 'project-sensitive-fixture', projectRevision: 1, workflowVersion: 1, snapshotDigest: 'digest-sensitive-fixture', status: 'failed', createdAt: '2026-11-01T06:59:41.532Z', updatedAt: '2026-11-01T06:59:47.640Z', error: 'error-sensitive-fixture' });
  const inspection = runInspectionSchema.parse({ run: { ...run, completedNodeIds: [] }, projectTitle: 'title-sensitive-fixture', snapshotAvailable: true, checkpointAvailable: true,
    steps: [{ id: 'node-sensitive-fixture', label: 'label-sensitive-fixture', kind: 'brief', description: 'description-sensitive-fixture', requiresReview: false, status: 'failed', reason: 'reason-sensitive-fixture', inputAvailable: true, outputAvailable: false, activityCount: 1, unknownSubmission: true, error: 'error-sensitive-fixture', startedAt: run.createdAt }],
    recovery: { review: false, resume: false, cancel: false, restart: false, reason: 'reason-sensitive-fixture' } });
  const record = usageRecordSchema.parse({ id: 'usage-sensitive-fixture', revision: 1, operationId: 'operation-sensitive-fixture', runId: run.id, nodeId: 'node-sensitive-fixture', projectId: run.projectId, modelId: 'model-sensitive-fixture', modelName: 'model-sensitive-fixture', provider: 'openai-compatible', model: 'model-sensitive-fixture', capability: 'text', status: 'unknown', requestMetrics: { source: 'request', requestCount: 1 }, note: 'note-sensitive-fixture', createdAt: run.createdAt, updatedAt: run.updatedAt });
  const evidence = costFailureEvidence({ received: 24, finished: 24, closed: 0 }, { received: 0, finished: 0, closed: 0 }, run, inspection, [record]);
  expect(JSON.stringify(evidence)).not.toContain('sensitive-fixture');
  expect(evidence).toEqual({ provider: { received: 24, finished: 24, closed: 0 }, runProvider: { received: 0, finished: 0, closed: 0 },
    run: { id: run.id, status: 'failed', createdAt: run.createdAt, updatedAt: run.updatedAt },
    inspection: { snapshotAvailable: true, checkpointAvailable: true, steps: [{ status: 'failed', inputAvailable: true, outputAvailable: false, activityCount: 1, unknownSubmission: true, startedAt: run.createdAt, completedAt: undefined }] },
    inspectionUnavailable: false, receipts: [{ status: 'unknown', providerUsageRecorded: false }], receiptsUnavailable: false });
  record.providerUsage = { inputTokens: 100 };
  expect(costFailureEvidence({ received: 1, finished: 1, closed: 0 }, undefined, run, inspection, [record]).receipts).toEqual([{ status: 'unknown', providerUsageRecorded: true }]);
});

test('retains local provider counts when read-only failure evidence is unavailable', () => {
  expect(costFailureEvidence({ received: 25, finished: 24, closed: 1 }, undefined, undefined, undefined, undefined)).toMatchObject({ provider: { received: 25, finished: 24, closed: 1 }, inspectionUnavailable: true, receiptsUnavailable: true });
});
