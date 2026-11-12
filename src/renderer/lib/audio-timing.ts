import type { AssetRecord, PreparedAudioMix, Shot } from '@video-quickly/contracts';

const fullRecording = (shot: Shot) => Boolean(shot.audioAssetId && !shot.clipEdit && shot.sourceInUs === undefined && shot.audioInUs === undefined);
const sourceKey = (asset: AssetRecord) => JSON.stringify([asset.id, asset.sha256, asset.version, asset.path]);

/** Old untrimmed recordings retain their full length in both the editor and export. */
export function resolvedAudioShots(shots: readonly Shot[], mix?: PreparedAudioMix): Shot[] {
  if (!mix?.shotDurations) return [...shots];
  const durations = mix.shotDurations;
  if (durations.length !== shots.length || durations.some((value, index) => value.shotId !== shots[index].id)) throw new Error('混音的镜头时间映射已失效，请重新准备试听。');
  return shots.map((shot, index) => {
    const durationUs = durations[index].durationUs;
    if (durationUs === shot.durationUs) return shot;
    if (!fullRecording(shot) || durationUs < shot.durationUs) throw new Error('混音与当前镜头剪辑时长不一致，请重新准备试听。');
    return { ...shot, durationUs };
  });
}

/** A legacy extension proves the full source length; equal lengths may only be a held scene. */
export function rememberAudioDurations(cache: Map<string, number>, shots: readonly Shot[], mix: PreparedAudioMix, assets: readonly AssetRecord[]): void {
  const resolved = resolvedAudioShots(shots, mix), byId = new Map(assets.map(asset => [asset.id, asset]));
  for (const [index, shot] of shots.entries()) {
    if (!fullRecording(shot) || resolved[index].durationUs <= shot.durationUs) continue;
    const asset = byId.get(shot.audioAssetId!);
    if (asset?.active && asset.kind === 'audio') cache.set(sourceKey(asset), resolved[index].durationUs);
  }
}

/** Preserve measured prefixes across pending mixes, structure edits and undo, without saving them. */
export function measuredAudioShots(shots: readonly Shot[], assets: readonly AssetRecord[], cache: ReadonlyMap<string, number>): Shot[] {
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return shots.map(shot => {
    const asset = shot.audioAssetId ? byId.get(shot.audioAssetId) : undefined;
    const measured = fullRecording(shot) && asset?.active && asset.kind === 'audio' ? cache.get(sourceKey(asset)) : undefined;
    return measured !== undefined && measured > shot.durationUs ? { ...shot, durationUs: measured } : shot;
  });
}
