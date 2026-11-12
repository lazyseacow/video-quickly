import { useRef, useState } from 'react';
import { runInspectionSchema } from '@video-quickly/contracts';
import { useChargeRpc } from '../components/ConfirmationDialog';
import { useRuntimeRead } from '../lib/use-runtime-read';

type RunOperation = 'run.resume' | 'run.cancel' | 'run.step.retry' | 'run.diagnostics';

interface InspectionOperations {
  onChanged?: () => void;
  onDiagnostic?: (result: unknown) => Promise<void>;
  refreshOnError?: boolean;
}

export function useRunInspectionOperations(runId: string, version: number, {
  onChanged, onDiagnostic, refreshOnError,
}: InspectionOperations) {
  const inspection = useRuntimeRead('run.inspect', { runId }, version, runInspectionSchema);
  const chargeRpc = useChargeRpc();
  const [pending, setPending] = useState<RunOperation>();
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  async function perform(method: RunOperation, params: { nodeId?: string } = {}) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(method);
    setError('');
    try {
      const result = await chargeRpc(method, { runId, ...params });
      if (result === null) return;
      if (method === 'run.diagnostics') {
        await onDiagnostic?.(result);
        return;
      }
      inspection.refresh();
      onChanged?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      if (refreshOnError) inspection.refresh();
    } finally {
      inFlight.current = false;
      setPending(undefined);
    }
  }

  return { inspection, pending, error, setError, perform };
}
