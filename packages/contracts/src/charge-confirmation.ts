import { z } from 'zod';

export const chargeActionSchema = z.enum([
  'run.start', 'run.resume', 'run.step.retry', 'shot.regenerate',
  'character.generateViews', 'planning.prefill.start', 'promptTrial.start', 'workflowAssistant.start',
  'productionQueue.start', 'productionQueue.resumeItem', 'cost.update',
]);
export type ChargeAction = z.infer<typeof chargeActionSchema>;

const chargeActions = new Set<string>(chargeActionSchema.options);
export function isChargeAction(method: string): method is ChargeAction {
  return chargeActions.has(method);
}

export const chargeActionRequestSchema = z.object({ method: chargeActionSchema, params: z.record(z.string(), z.unknown()) }).strict();
