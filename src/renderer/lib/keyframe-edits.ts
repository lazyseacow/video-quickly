import { shotSchema, type AssetRecord, type Shot } from '@video-quickly/contracts';
import { resolveShotSpans, type ClipEditContext } from '@video-quickly/video/clip-edits';
import { usesFullAudioSource } from '@video-quickly/video/audio';
export { keyframePreviewWindow } from '@video-quickly/video';

function keyframeEditScope(shot: Shot, context: ClipEditContext) {
  const recordingId = shot.audioAssetId && usesFullAudioSource(shot) ? shot.audioAssetId : undefined;
  return JSON.stringify([shot.animation, shot.durationUs, shot.sceneInUs, shot.sceneDurationUs, shot.assetId, shot.videoAssetId, shot.sceneTemplate, shot.clipEdit, recordingId, resolveShotSpans(shot, context)]);
}

export function keyframeAssetIds(shot: Shot) {
  return [shot.sceneTemplate ? undefined : shot.videoAssetId ?? shot.assetId, usesFullAudioSource(shot) ? shot.audioAssetId : undefined].filter((value): value is string => Boolean(value));
}

export function assertKeyframeAssets(shot: Shot, baseline: readonly AssetRecord[], current: readonly AssetRecord[]) {
  for (const id of keyframeAssetIds(shot)) {
    const signature = (assets: readonly AssetRecord[]) => { const asset = assets.find(value => value.id === id); return asset ? JSON.stringify([asset.id, asset.projectId, asset.kind, asset.path, asset.sha256, asset.version, asset.active]) : undefined; };
    if (signature(baseline) !== signature(current)) throw new Error('画面或决定窗口时长的旁白素材版本已更新，关键帧输入仍保留，请重新核对。');
  }
}

export function assertKeyframePreviewWindow(baseline: Shot, current?: Shot) {
  if (!current || baseline.durationUs !== current.durationUs) throw new Error('镜头实际预览时长已更新，关键帧输入仍保留，请重新打开后核对完整窗口。');
}

export function applyKeyframeEdit<T extends ClipEditContext & { shots: Shot[] }>(content: T, baseline: Shot, baselineContext: ClipEditContext, animation: Shot['animation']): T {
  const current = content.shots.find(shot => shot.id === baseline.id);
  if (!current) throw new Error('镜头已移除，关键帧输入仍保留。');
  if (current.locked) throw new Error('镜头已锁定，请先解锁后重新打开关键帧。');
  if (keyframeEditScope(current, content) !== keyframeEditScope(baseline, baselineContext)) throw new Error('镜头运镜、素材或剪辑区间已更新，请保留输入并重新核对。');
  const next = shotSchema.parse({ ...current, animation });
  return { ...content, shots: content.shots.map(shot => shot.id === baseline.id ? next : shot) };
}
