import type { Shot, ShotCandidate, ShotCandidateField } from './index.js';

const defaultFields: ShotCandidateField[] = ['title', 'narration', 'visualPrompt'];

function sameInput(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameInput(value, right[index]));
  if (Array.isArray(left) || Array.isArray(right)) return false;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const keys = Object.keys(left).filter(key => Reflect.get(left, key) !== undefined);
  return keys.length === Object.keys(right).filter(key => Reflect.get(right, key) !== undefined).length && keys.every(key => Object.hasOwn(right, key) && sameInput(Reflect.get(left, key), Reflect.get(right, key)));
}

/** Merge only the chosen output. Each affected field must still match the generation snapshot. */
export function applyShotCandidate(current: Shot, candidate: ShotCandidate, fields: ShotCandidateField[] = defaultFields): Shot {
  if (current.id !== candidate.shotId) throw new Error('候选与当前镜头不匹配。');
  if (current.locked) throw new Error('请先解锁镜头，再应用候选。');
  const baseline = candidate.baseline;
  const output = candidate.shot;
  const selectedCharacters = current.characterIds ?? [], originalCharacters = baseline.characterIds ?? [];
  if (selectedCharacters.length !== originalCharacters.length || selectedCharacters.some((id, index) => id !== originalCharacters[index])) throw new Error('镜头角色已在生成后修改，请重新生成候选。');
  function unchanged(keys: (keyof Shot)[]) {
    if (keys.some(key => !sameInput(current[key], baseline[key]))) throw new Error('候选涉及的内容或镜头区间已修改，请重新生成或核对后再应用。');
  }
  unchanged(['claimIds', 'clipEdit']);
  if (candidate.kind === 'script') {
    if (!fields.length) throw new Error('请至少选择一项要应用的内容。');
    unchanged(fields);
    unchanged(['sceneTemplate']);
    if (fields.includes('durationUs')) unchanged(['sourceInUs', 'sceneInUs', 'audioInUs', 'videoInUs']);
    const next = { ...current };
    for (const field of fields) {
      if (field === 'durationUs') next.durationUs = output.durationUs;
      else next[field] = output[field];
    }
    return next;
  }
  unchanged(['sourceInUs', 'durationUs']);
  if (candidate.kind === 'audio') {
    unchanged(['audioAssetId', 'audioInUs', 'narration']);
    if (!output.audioAssetId || !candidate.assetIds.includes(output.audioAssetId)) throw new Error('候选缺少生成的旁白音频。');
    return { ...current, audioAssetId: output.audioAssetId, audioInUs: 0 };
  }
  if (candidate.kind === 'video') {
    unchanged(['assetId', 'videoAssetId', 'videoInUs', 'visualPrompt', 'sceneTemplate']);
    if (!output.videoAssetId || !candidate.assetIds.includes(output.videoAssetId)) throw new Error('候选缺少生成的视频。');
    return { ...current, videoAssetId: output.videoAssetId, videoInUs: 0, sceneTemplate: undefined };
  }
  unchanged(['assetId', 'videoAssetId', 'videoInUs', 'visualPrompt', 'sceneTemplate']);
  if (!output.assetId || !candidate.assetIds.includes(output.assetId)) throw new Error('候选缺少生成的画面。');
  // A video takes precedence in the preview; remove that association to make the selected image visible.
  return { ...current, assetId: output.assetId, videoAssetId: undefined, videoInUs: undefined, sceneTemplate: undefined };
}
