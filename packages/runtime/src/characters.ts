import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { assetSchema, characterProfileSchema, pageInputSchema, type AssetRecord, type CharacterProfile, type RecordPage, type Shot } from '@video-quickly/contracts';
import { DocumentStore } from './database.js';

export interface CharacterBundle { characters: CharacterProfile[]; assets: AssetRecord[] }
export interface ImportedCharacters { characters: CharacterProfile[]; idMap: Map<string, string> }
export interface CharacterLibraryOptions { database: Database.Database; store: DocumentStore; onChanged: () => void }

const editableCharacter = characterProfileSchema.pick({ name: true, description: true, referenceAssetIds: true });
const saveInput = z.object({ character: editableCharacter.extend({ id: z.string().min(1).optional(), revision: z.number().int().positive().optional() }) });
const characterIdInput = z.object({ characterId: z.string().min(1) });

function publicReference(asset: AssetRecord | undefined): AssetRecord {
  if (!asset?.active || asset.kind !== 'image' || asset.projectId !== undefined) throw new Error('角色参考图只能使用公共素材库中有效的图片，请先将图片导入公共素材库。');
  return asset;
}

export function createCharacterLibrary({ database, store, onChanged }: CharacterLibraryOptions) {
  function get(id: string): CharacterProfile {
    const value = store.get('character', id);
    if (!value) throw new Error('角色不存在。');
    return characterProfileSchema.parse(value);
  }
  function references(profile: CharacterProfile): AssetRecord[] {
    return profile.referenceAssetIds.map(id => publicReference(store.get<AssetRecord>('asset', id)));
  }
  function requireRevision(profile: CharacterProfile, revision: number | undefined) {
    if (revision !== profile.revision) throw new Error('角色已在其他视图修改，请刷新后重新保存。');
  }
  function isReferenced(id: string): boolean {
    return Boolean(database.prepare("SELECT 1 FROM documents project, json_each(project.body, '$.shots') shot, json_each(shot.value, '$.characterIds') character WHERE project.kind = 'project' AND character.value = ? LIMIT 1").get(id));
  }
  function assetInUse(id: string): boolean {
    // Archived characters remain restorable, so their reference images are retained too.
    return Boolean(database.prepare("SELECT 1 FROM documents profile, json_each(profile.body, '$.referenceAssetIds') reference WHERE profile.kind = 'character' AND reference.value = ? LIMIT 1").get(id));
  }
  function profilesFor(project: { shots: ReadonlyArray<Pick<Shot, 'characterIds'>> }): CharacterBundle {
    const ids = new Set(project.shots.flatMap(shot => shot.characterIds ?? []));
    const assets = new Map<string, AssetRecord>();
    const characters = [...ids].map(id => {
      const profile = get(id);
      if (profile.archived) throw new Error(`角色「${profile.name}」已归档，请恢复后再使用。`);
      for (const asset of references(profile)) assets.set(asset.id, asset);
      return profile;
    });
    return { characters, assets: [...assets.values()] };
  }
  function prepareImport(bundle: CharacterBundle, assetIdMap: ReadonlyMap<string, string>): ImportedCharacters {
    const input = z.object({ characters: z.array(characterProfileSchema), assets: z.array(assetSchema) }).parse(bundle);
    const sourceAssets = new Map(input.assets.map(asset => [asset.id, asset]));
    const idMap = new Map<string, string>();
    const timestamp = new Date().toISOString();
    const characters = input.characters.map(profile => {
      if (idMap.has(profile.id)) throw new Error('备份包含重复的角色编号。');
      const id = randomUUID(); idMap.set(profile.id, id);
      const referenceAssetIds = profile.referenceAssetIds.map(assetId => {
        publicReference(sourceAssets.get(assetId));
        const mapped = assetIdMap.get(assetId);
        if (!mapped) throw new Error('角色备份缺少参考图，请重新备份完整项目。');
        return mapped;
      });
      return characterProfileSchema.parse({ ...profile, id, referenceAssetIds, revision: 1, createdAt: timestamp, updatedAt: timestamp });
    });
    return { characters, idMap };
  }
  function dispatch(method: string, rawParams: unknown = {}): CharacterProfile | RecordPage<CharacterProfile> | AssetRecord[] {
    switch (method) {
      case 'character.get': return get(characterIdInput.parse(rawParams).characterId);
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
          if (previous) requireRevision(previous, character.revision);
          const timestamp = new Date().toISOString();
          const value = characterProfileSchema.parse({ ...character, id: previous?.id ?? randomUUID(), revision: previous ? previous.revision + 1 : 1, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, archived: previous?.archived ?? false });
          references(value);
          store.put('character', value.id, value);
          return value;
        })();
        onChanged(); return profile;
      }
      case 'character.archive':
      case 'character.restore': {
        const input = characterIdInput.extend({ revision: z.number().int().positive() }).parse(rawParams);
        const profile = database.transaction(() => {
          const previous = get(input.characterId); requireRevision(previous, input.revision);
          const archived = method === 'character.archive';
          if (archived && isReferenced(previous.id)) throw new Error('仍有项目镜头使用此角色，请先移除镜头中的角色关联。');
          if (!archived) references(previous);
          const value = { ...previous, archived, revision: previous.revision + 1, updatedAt: new Date().toISOString() };
          store.put('character', value.id, value); return value;
        })();
        onChanged(); return profile;
      }
      default: throw new Error(`未知角色方法：${method}`);
    }
  }
  return { dispatch, assetInUse, profilesFor, prepareImport };
}
