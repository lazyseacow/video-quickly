import type { RunInspection, RunRecord, UsageRecord } from '@video-quickly/contracts';

export interface ProviderCounts { received: number; finished: number; closed: number }

// These projections deliberately omit labels, model configuration, errors,
// prompts, activity results and remote task identities from failure attachments.
export function costFailureEvidence(counts: ProviderCounts, runCounts: ProviderCounts | undefined, run: RunRecord | undefined, inspection: RunInspection | undefined, records: UsageRecord[] | undefined) {
  return {
    provider: { received: counts.received, finished: counts.finished, closed: counts.closed },
    runProvider: runCounts ? { received: runCounts.received, finished: runCounts.finished, closed: runCounts.closed } : undefined,
    run: run ? { id: run.id, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt } : undefined,
    inspection: inspection ? {
      snapshotAvailable: inspection.snapshotAvailable, checkpointAvailable: inspection.checkpointAvailable,
      steps: inspection.steps.map(step => ({ status: step.status, inputAvailable: step.inputAvailable, outputAvailable: step.outputAvailable,
        activityCount: step.activityCount, unknownSubmission: step.unknownSubmission, startedAt: step.startedAt, completedAt: step.completedAt })),
    } : undefined,
    inspectionUnavailable: inspection === undefined,
    receipts: records?.map(record => ({ status: record.status, providerUsageRecorded: record.providerUsage !== undefined })),
    receiptsUnavailable: records === undefined,
  };
}
