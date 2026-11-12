import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { characterProfileSchema, creativeReferenceAssetIds, isCreativeReferenceAsset, pageInputSchema, projectCharacterIds, type AssetRecord, type CharacterProfile, type CreativeContext, type RecordPage, type Shot } from '@video-quickly/contracts';
import { DocumentStore } from './database.js';

export interface CharacterBundle { characters: CharacterProfile[]; assets: AssetRecord[] }
export interface CharacterLibraryOptions { database: Database.Database; store: DocumentStore; onChanged: () => void }

const editableCharacter = characterProfileSchema.pick({ name: true, description: true, referenceAssetIds: true });
const saveInput = z.object({ character: editableCharacter.extend({ id: z.string().min(1).optional(), revision: z.number().int().positive().optional() }) });
const characterIdInput = z.object({ characterId: z.string().min(1) });
const characterChangeInput = characterIdInput.extend({ revision: z.number().int().positive() });
const characterIdsInput = z.object({ characterIds: z.array(characterProfileSchema.shape.id).max(50) });

function publicReference(asset: AssetRecord | undefined, label = '角色'): AssetRecord {
  if (!asset?.active || asset.kind !== 'image' || asset.projectId !== undefined) throw new Error(`${label}参考图只能使用公共素材库中有效的图片，请先将图片导入公共素材库。`);
  return asset;
}

const retainedReferenceIds = [
  "SELECT reference.value AS asset_id FROM documents profile, json_each(profile.body, '$.referenceAssetIds') reference WHERE profile.kind = 'character'",
  "SELECT reference.value AS asset_id FROM documents snapshot, json_each(snapshot.body, '$.characters') profile, json_each(profile.value, '$.referenceAssetIds') reference WHERE snapshot.kind IN ('run-snapshot','export-batch-snapshot')",
  ...[['project', '$.creativeContext.entities'], ['run-snapshot', '$.project.creativeContext.entities'], ['run-snapshot', '$.trial.inputProject.creativeContext.entities'], ['run-snapshot', '$.sourceGeneration.inputProject.creativeContext.entities'], ['node-project', '$.creativeContext.entities'], ['export-batch-snapshot', '$.project.creativeContext.entities']].map(([kind, path]) => `SELECT reference.value AS asset_id FROM documents profile, json_each(profile.body, '${path}') entity, json_each(entity.value, '$.referenceAssetIds') reference WHERE profile.kind = '${kind}'`),
].join(' UNION ALL ');

export function createCharacterLibrary({ database, store, onChanged }: CharacterLibraryOptions) {
  function find(id: string): CharacterProfile | undefined {
    const value = store.get('character', id);
    return value ? characterProfileSchema.parse(value) : undefined;
  }
  function get(id: string): CharacterProfile {
    const value = find(id);
    if (!value) throw new Error('角色不存在。');
    return value;
  }
  function references(profile: CharacterProfile): AssetRecord[] {
    return profile.referenceAssetIds.map(id => publicReference(store.get<AssetRecord>('asset', id)));
  }
  function requireRevision(profile: CharacterProfile, revision: number | undefined) {
    if (revision !== profile.revision) throw new Error('角色已在其他视图修改，请刷新后重新保存。');
  }
  function isReferenced(id: string): boolean {
    return Boolean(database.prepare("SELECT 1 FROM documents project WHERE project.kind = 'project' AND (EXISTS (SELECT 1 FROM json_each(project.body, '$.creativeContext.characterIds') WHERE value = ?) OR EXISTS (SELECT 1 FROM json_each(project.body, '$.shots') shot, json_each(shot.value, '$.characterIds') character WHERE character.value = ?)) LIMIT 1").get(id, id));
  }
  function assetInUse(id: string): boolean {
    // Archived settings and frozen generation inputs remain restorable.
    return Boolean(database.prepare(`SELECT 1 FROM (${retainedReferenceIds}) WHERE asset_id = ? LIMIT 1`).get(id));
  }
  function assetsInUse(ids: readonly string[]): Set<string> {
    if (!ids.length) return new Set();
    // Scan current and archived references once for this page, without retaining a cross-request cache.
    const rows = database.prepare(`SELECT DISTINCT asset_id FROM (${retainedReferenceIds}) WHERE asset_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as { asset_id: string }[];
    return new Set(rows.map(row => row.asset_id));
  }
  function profilesFor(project: { id?: string; creativeContext?: CreativeContext | null; shots: ReadonlyArray<Pick<Shot, 'characterIds'>> }): CharacterBundle {
    const ids = projectCharacterIds(project);
    const assets = new Map<string, AssetRecord>();
    const characters = [...ids].map(id => {
      const profile = get(id);
      if (profile.archived) throw new Error(`角色「${profile.name}」已归档，请恢复后再使用。`);
      for (const asset of references(profile)) assets.set(asset.id, asset);
      return profile;
    });
    for (const id of creativeReferenceAssetIds(project)) {
      const asset = store.get<AssetRecord>('asset', id);
      if (!isCreativeReferenceAsset(project, asset)) throw new Error('创作参考图须使用公共素材库中的有效图片或当前项目的人物定妆图。');
      assets.set(asset.id, asset);
    }
    return { characters, assets: [...assets.values()] };
  }
  function dispatch(method: string, rawParams: unknown = {}): CharacterProfile | CharacterProfile[] | RecordPage<CharacterProfile> | AssetRecord[] | { deleted: true } {
    switch (method) {
      case 'character.get': return get(characterIdInput.parse(rawParams).characterId);
      case 'character.getMany': {
        const { characterIds } = characterIdsInput.parse(rawParams);
        return [...new Set(characterIds)].flatMap(id => {
          const profile = find(id);
          return profile ? [profile] : [];
        });
      }
      case 'character.references': return references(get(characterIdInput.parse(rawParams).characterId));
      case 'character.list': {
        const input = pageInputSchema.extend({ archived: z.boolean().default(false) }).parse(rawParams);
        const rows = database.prepare("SELECT rowid AS cursor, body FROM documents WHERE kind = 'character' AND coalesce(json_extract(body, '$.archived'), 0) = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?").all(Number(input.archived), input.before ?? null, input.before ?? null, input.limit + 1) as { cursor: number; body: string }[];
        return { items: rows.slice(0, input.limit).map(row => characterProfileSchema.parse(JSON.parse(row.body))), nextCursor: rows.length > input.limit ? rows[input.limit - 1].cursor : null };
      }
      case 'character.save': {
        const { character } = saveInput.parse(rawParams);
        const profile = database.transaction(() => {
          const previous = character.id ? get(character.id) : undefined;
          if (previous?.archived) throw new Error(`角色「${previous.name}」已归档，请恢复后再编辑。`);
          if (previous) requireRevision(previous, character.revision);
          const timestamp = new Date().toISOString();
          const value = characterProfileSchema.parse({ ...character, id: previous?.id ?? randomUUID(), revision: previous ? previous.revision + 1 : 1, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, archived: false });
          references(value);
          store.put('character', value.id, value);
          return value;
        })();
        onChanged(); return profile;
      }
      case 'character.archive':
      case 'character.restore':
      case 'character.delete': {
        const input = characterChangeInput.parse(rawParams);
        const result = database.transaction(() => {
          const previous = get(input.characterId); requireRevision(previous, input.revision);
          const deleting = method === 'character.delete';
          if (deleting && !previous.archived) throw new Error('请先归档角色，再彻底删除。');
          if (method === 'character.restore') references(previous);
          else if (isReferenced(previous.id)) throw new Error('仍有项目镜头使用此角色，或项目角色池包含此角色，请先移除对应关联。');
          if (deleting) {
            store.delete('character', previous.id);
            return { deleted: true } as const;
          }
          const value = { ...previous, archived: method === 'character.archive', revision: previous.revision + 1, updatedAt: new Date().toISOString() };
          store.put('character', value.id, value); return value;
        }).immediate();
        onChanged(); return result;
      }
      default: throw new Error(`未知角色方法：${method}`);
    }
  }
  return { dispatch, assetInUse, assetsInUse, profilesFor };
}
