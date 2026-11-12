import type { JsonValue } from '@video-quickly/contracts';

export const legacyTimelineName = 'timeline.json';
export const localRenderProvenance = '本地渲染';

export function isLegacyTimelineAsset(asset: unknown): boolean {
  return Boolean(asset && typeof asset === 'object'
    && 'kind' in asset && asset.kind === 'document'
    && 'name' in asset && asset.name === legacyTimelineName
    && 'provenance' in asset && asset.provenance === localRenderProvenance);
}

export function omitLegacyExportTimeline(value: JsonValue): JsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.timelinePath !== 'string' || typeof value.videoPath !== 'string'
    || typeof value.coverPath !== 'string' || typeof value.subtitlePath !== 'string') return value;
  const { timelinePath: _timeline, ...output } = value;
  if (Array.isArray(output.assets)) output.assets = output.assets.filter(asset => !isLegacyTimelineAsset(asset));
  return output;
}
