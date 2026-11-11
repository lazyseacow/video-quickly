import { type ChargeEstimate, type ModelProfile, type ProjectDocument, type WorkflowNode } from '@video-quickly/contracts';
import { requestCostMetrics } from './costs.js';

type ChargeLine = ChargeEstimate['items'][number];
export interface PlannedCharge {
  model?: ModelProfile;
  kind: ChargeLine['kind'];
  count?: number;
  videoSeconds?: number;
}

export function plannedNodeCharge(node: WorkflowNode, model: ModelProfile | undefined, project?: ProjectDocument): PlannedCharge {
  const kind = node.kind === 'assets' ? 'image' : node.kind === 'animation' ? 'video' : 'text';
  if (kind === 'text') return { model, kind, count: 1 };
  const metrics = project && model ? requestCostMetrics(project, node, model) : undefined;
  return { model, kind, count: metrics?.requestCount, videoSeconds: metrics?.videoSeconds };
}

function estimate(work: PlannedCharge): ChargeLine['estimated'] {
  const { model, count, kind, videoSeconds } = work;
  const pricing = model?.pricing;
  if (!model || !pricing || count === undefined) return;
  let amount: number | undefined;
  if (kind === 'image' && pricing.perImage !== undefined && ['openai-compatible', 'seedream'].includes(model.provider)) {
    const grouping = model.parameters.sequential_image_generation;
    if (grouping === undefined || grouping === 'disabled') amount = count * pricing.perImage;
  }
  if (kind === 'video' && pricing.perVideoSecond !== undefined && videoSeconds !== undefined) amount = videoSeconds * pricing.perVideoSecond;
  return amount !== undefined && Number.isFinite(amount) ? { currency: pricing.currency, amount } : undefined;
}

export function summarizeCharge(work: PlannedCharge[], batch = false, incomplete = false): ChargeEstimate {
  const rows = new Map<string, ChargeLine>();
  for (const { model, ...quantity } of work) {
    const estimated = estimate({ model, ...quantity });
    const key = JSON.stringify([model?.id, model?.name, model?.model, quantity.kind, model?.pricing?.currency]);
    const previous = rows.get(key);
    if (!previous) {
      rows.set(key, { ...quantity, modelName: model?.name, model: model?.model, estimated });
      continue;
    }
    previous.count = previous.count === undefined || quantity.count === undefined ? undefined : previous.count + quantity.count;
    previous.videoSeconds = previous.videoSeconds === undefined || quantity.videoSeconds === undefined ? undefined : previous.videoSeconds + quantity.videoSeconds;
    previous.estimated = previous.estimated && estimated ? { currency: estimated.currency, amount: previous.estimated.amount + estimated.amount } : undefined;
  }
  const items = [...rows.values()];
  const byCurrency = new Map<NonNullable<ChargeLine['estimated']>['currency'], number>();
  for (const item of items) {
    if (!item.estimated || !Number.isFinite(item.estimated.amount)) return { batch, items: items.map(line => Number.isFinite(line.estimated?.amount) ? line : { ...line, estimated: undefined }) };
    const { currency, amount } = item.estimated;
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + amount);
  }
  const totals = !incomplete && items.length && [...byCurrency.values()].every(Number.isFinite)
    ? [...byCurrency].map(([currency, amount]) => ({ currency, amount })) : undefined;
  return { batch, items, totals };
}
