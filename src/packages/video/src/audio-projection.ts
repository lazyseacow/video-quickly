import { audioMixSettingsSchema, audioProcessingSchema, usesVideoAudio, DEFAULT_AUDIO_MIX_SETTINGS, DEFAULT_AUDIO_PROCESSING, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';
import { resolveShotSpans } from './clip-edits.js';
import { audioAsset, usesFullAudioSource } from './audio.js';
export const AUDIO_MIX_ALGORITHM = 'audio-mix-v5-video-source-48000-stereo';
const mixDuration = (project: Pick<ProjectDocument, 'shots'>) => project.shots.reduce((sum, shot) => sum + shot.durationUs, 0);

/** Pure identity for scheduling. File bytes are independently verified before a cached result is used. */
export function audioMixProjection(project: ProjectDocument, assets: readonly AssetRecord[]): string {
  const voice = project.shots.map(shot => ({
    shotId: shot.id,
    durationUs: shot.durationUs, source: shot.audioAssetId ? audioAsset(shot.audioAssetId, project.id, assets).sha256 : undefined,
    legacyExtend: usesFullAudioSource(shot),
    processing: audioProcessingSchema.parse(shot.audioProcessing ?? DEFAULT_AUDIO_PROCESSING),
    spans: resolveShotSpans(shot, project).map(span => [span.outputStartUs, span.durationUs, span.audioInUs]),
  }));
  const music = (project.musicClips ?? []).filter(clip => clip.startUs < mixDuration(project) || voice.some(value => value.legacyExtend)).map(clip => ({ clip, sha256: audioAsset(clip.assetId, project.id, assets, '背景音乐').sha256 }));
  const video = project.shots.filter(usesVideoAudio).map(shot => ({ shotId: shot.id, source: audioAsset(shot.videoAssetId, project.id, assets, '视频原声', 'video').sha256, gainDb: shot.audioProcessing.videoAudio.gainDb, spans: resolveShotSpans(shot, project).map(span => [span.outputStartUs, span.durationUs, span.videoInUs]) }));
  return JSON.stringify({ algorithm: AUDIO_MIX_ALGORITHM, projectId: project.id, voice, video, music, settings: audioMixSettingsSchema.parse(project.audioMix ?? DEFAULT_AUDIO_MIX_SETTINGS) });
}
