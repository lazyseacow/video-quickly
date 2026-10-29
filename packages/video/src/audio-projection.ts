import { audioMixSettingsSchema, audioProcessingSchema, DEFAULT_AUDIO_MIX_SETTINGS, DEFAULT_AUDIO_PROCESSING, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';
import { resolveShotSpans } from './clip-edits.js';
export const AUDIO_MIX_ALGORITHM = 'audio-mix-v2-fixed-us-48000-stereo';
const mixDuration = (project: Pick<ProjectDocument, 'shots'>) => project.shots.reduce((sum, shot) => sum + shot.durationUs, 0);

function audioAsset(id: string, projectId: string, assets: readonly AssetRecord[], label = '音频'): AssetRecord {
  const asset = assets.find(value => value.id === id);
  if (!asset || asset.kind !== 'audio' || !asset.active || (asset.projectId !== undefined && asset.projectId !== projectId)) throw new Error(`${label}必须引用当前项目或共享素材库中的有效音频。`);
  return asset;
}

/** Pure identity for scheduling. File bytes are independently verified before a cached result is used. */
export function audioMixProjection(project: ProjectDocument, assets: readonly AssetRecord[]): string {
  const voice = project.shots.map(shot => ({
    shotId: shot.id,
    durationUs: shot.durationUs, source: shot.audioAssetId ? audioAsset(shot.audioAssetId, project.id, assets).sha256 : undefined,
    legacyExtend: !shot.clipEdit && shot.sourceInUs === undefined && shot.audioInUs === undefined,
    processing: audioProcessingSchema.parse(shot.audioProcessing ?? DEFAULT_AUDIO_PROCESSING),
    spans: resolveShotSpans(shot, project).map(span => [span.outputStartUs, span.durationUs, span.audioInUs]),
  }));
  const music = (project.musicClips ?? []).filter(clip => clip.startUs < mixDuration(project) || voice.some(value => value.legacyExtend)).map(clip => ({ clip, sha256: audioAsset(clip.assetId, project.id, assets, '背景音乐').sha256 }));
  return JSON.stringify({ algorithm: AUDIO_MIX_ALGORITHM, projectId: project.id, voice, music, settings: audioMixSettingsSchema.parse(project.audioMix ?? DEFAULT_AUDIO_MIX_SETTINGS) });
}
