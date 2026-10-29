import type { AssetRecord, ClipEditSource, ProjectDocument } from './index.js';

export type ClipEditContent = Pick<ProjectDocument, 'shots' | 'clipEditSources' | 'clipEditPlans'>;

export function clipSourceAssetIds(source: ClipEditSource): string[] {
  return [...new Set([source.original.assetId, source.original.audioAssetId, source.original.videoAssetId, source.original.captionTrack?.sourceAssetId].filter((id): id is string => Boolean(id)))];
}

/** Validate references at the project boundary; the schemas validate individual records. */
export function validateClipEditContent(content: ClipEditContent, assets?: readonly AssetRecord[]): void {
  const sources = new Map((content.clipEditSources ?? []).map(source => [source.id, source]));
  const plans = new Map((content.clipEditPlans ?? []).map(plan => [plan.id, plan]));
  if (sources.size !== (content.clipEditSources ?? []).length || plans.size !== (content.clipEditPlans ?? []).length) throw new Error('原始镜头或剪辑计划编号不能重复。');
  const assetById = assets ? new Map(assets.map(asset => [asset.id, asset])) : undefined;
  for (const source of sources.values()) {
    const expected = new Set(clipSourceAssetIds(source)), hashes = new Map(source.assetHashes.map(value => [value.assetId, value.sha256]));
    if (hashes.size !== source.assetHashes.length || hashes.size !== expected.size || [...expected].some(id => !hashes.has(id))) throw new Error('原始镜头的素材校验值不完整或包含无关素材。');
    if (assetById) for (const [id, hash] of hashes) {
      const asset = assetById.get(id);
      if (!asset || asset.sha256 !== hash) throw new Error('原始镜头素材已缺失或校验值变化，请重新核对素材。');
    }
  }
  const totals = new Map<string, number>();
  for (const plan of plans.values()) {
    if (!sources.has(plan.sourceId)) throw new Error('剪辑计划引用了不存在的原始镜头。');
    if (new Set(plan.spans.map(span => span.id)).size !== plan.spans.length) throw new Error('剪辑分段编号不能重复。');
    let total = 0;
    for (const span of plan.spans) {
      total += span.durationUs;
      const offsets = [span.originInUs, span.sourceInUs, span.audioInUs, span.videoInUs, span.sceneInUs];
      if (!Number.isSafeInteger(total) || offsets.some(offset => !Number.isSafeInteger(offset + span.durationUs))) throw new Error('剪辑分段时间超出可保存范围。');
    }
    totals.set(plan.id, total);
  }
  for (const shot of content.shots) {
    if (!shot.clipEdit) continue;
    const total = totals.get(shot.clipEdit.planId);
    if (total === undefined) throw new Error('镜头引用了不存在的剪辑计划。');
    if (!Number.isSafeInteger(shot.clipEdit.inUs + shot.durationUs) || shot.clipEdit.inUs + shot.durationUs > total) throw new Error('镜头窗口超出剪辑计划范围。');
    if (!Number.isSafeInteger(shot.clipEdit.restoreInUs + shot.clipEdit.restoreDurationUs)) throw new Error('原始镜头恢复范围超出可保存范围。');
  }
}

/** Existing sources and plans are immutable; edits allocate a new plan or source ID. */
export function validateClipEditHistory(next: ClipEditContent, previous: ClipEditContent): void {
  for (const key of ['clipEditSources', 'clipEditPlans'] as const) {
    const old = new Map((previous[key] ?? []).map(value => [value.id, value]));
    for (const value of next[key] ?? []) {
      const before = old.get(value.id);
      if (before && canonical(before) !== canonical(value)) throw new Error('已保存的原始镜头和剪辑计划不能原地改写，请创建新的剪辑版本。');
    }
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
