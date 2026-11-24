import {
  creativeReferenceAssetIds, selectedCharacterReferenceAssetIds, shotVisualCharacterIds,
  type AssetRecord, type CharacterProfile, type ProjectDocument, type Shot,
} from '@video-quickly/contracts';
import { stat } from 'node:fs/promises';
import { fingerprint } from './activities.js';
import type { DocumentStore } from './database.js';
import { hashFileSha256 } from './file-hash.js';

function assetIdentity(asset: AssetRecord | undefined) {
  return asset && { id: asset.id, version: asset.version, sha256: asset.sha256, active: asset.active };
}

export function previewAssetHash(store: DocumentStore, id?: string): string {
  return fingerprint(id ? { id, asset: assetIdentity(store.get<AssetRecord>('asset', id)) } : null);
}

/** Only inputs affecting a still are compared. Dialogue, neighboring edits and old candidates remain independent. */
export function previewVisualInput(store: DocumentStore, project: ProjectDocument, shot: Shot) {
  const ids = creativeReferenceAssetIds(project, shot);
  const characters = shotVisualCharacterIds(shot).map(id => {
    const profile = store.get<CharacterProfile>('character', id);
    const binding = shot.drama?.appearances.find(value => value.characterId === id);
    const appearance = profile?.appearances?.find(value => value.id === binding?.appearanceId);
    if (profile && (!binding || appearance)) ids.push(...selectedCharacterReferenceAssetIds(profile, binding?.appearanceId));
    return { id, name: profile?.name, description: profile?.description, appearance };
  });
  const scene = project.drama?.scenes.find(scene => scene.id === shot.drama?.sceneId);
  const references = [...new Set(ids)].map(id => ({ id, asset: store.get<AssetRecord>('asset', id) }));
  const visualHash = fingerprint({
    style: project.style, width: project.profile.width, height: project.profile.height, scene,
    visualStyle: project.drama?.visualStyle, narrativeMode: project.drama?.narrativeMode,
    visualPrompt: shot.visualPrompt, sceneTemplate: shot.sceneTemplate,
    continuity: project.creativeContext?.continuity,
    entities: shot.creativeEntityKeys?.map(key => project.creativeContext?.entities.find(entity => entity.key === key)),
    appearances: shot.drama?.appearances, characters,
    references: references.map(({ id, asset }) => ({ id, identity: assetIdentity(asset) })),
  });
  return { visualHash, references };
}

export function previewStoryboardRevision(project: ProjectDocument, visuals: ReadonlyMap<string, { visualHash: string }>): string {
  return fingerprint(project.shots.map(({ id, title, narration, durationUs, soundPrompt, locked, drama }) => ({
    id, title, narration, durationUs, soundPrompt, locked, dialogue: drama?.lines, visualHash: visuals.get(id)?.visualHash,
  })));
}

export async function verifyPreviewImage(asset: AssetRecord): Promise<void> {
  const info = await stat(asset.path).catch(() => undefined);
  if (!info?.isFile() || info.size !== asset.size || await hashFileSha256(asset.path) !== asset.sha256) {
    throw new Error('预演候选素材缺失或损坏，请重新生成。');
  }
}
