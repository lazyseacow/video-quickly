import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { dramaVoiceIds, MAX_REFERENCE_AUDIO_BYTES, pageInputSchema, voiceProfileInputSchema, voiceProfileSchema, type AssetRecord, type CharacterProfile, type CreativeContext, type RecordPage, type Shot, type VoiceProfile } from '@video-quickly/contracts';
import { DocumentStore } from './database.js';

export interface VoiceBundle { voices: VoiceProfile[]; assets: AssetRecord[] }
interface VoiceLibraryOptions { database: Database.Database; store: DocumentStore; onChanged(): void }

const voiceIdentity = z.object({ voiceId: z.string().min(1) });
const voiceChange = voiceIdentity.extend({ revision: z.number().int().positive() });
const retainedReferenceIds = [
  "SELECT reference.value AS asset_id FROM documents profile, json_each(profile.body, '$.referenceAssetIds') reference WHERE profile.kind = 'voice'",
  "SELECT reference.value AS asset_id FROM documents snapshot, json_each(snapshot.body, '$.voices') profile, json_each(profile.value, '$.referenceAssetIds') reference WHERE snapshot.kind IN ('run-snapshot','export-batch-snapshot')",
  "SELECT json_extract(asset.value, '$.id') AS asset_id FROM documents snapshot, json_each(snapshot.body, '$.voiceAssets') asset WHERE snapshot.kind IN ('run-snapshot','export-batch-snapshot')",
].join(' UNION ALL ');

function publicAudio(asset: AssetRecord | undefined): AssetRecord {
  if (!asset?.active || asset.kind !== 'audio' || asset.projectId !== undefined) throw new Error('音色参考只能使用公共素材库中有效的音频，请先将音频导入公共素材库。');
  if (!['audio/wav', 'audio/x-wav', 'audio/mpeg'].includes(asset.mimeType) || asset.size <= 0 || asset.size > MAX_REFERENCE_AUDIO_BYTES) throw new Error('音色参考须为不超过 15 MB 的非空 WAV 或 MP3 音频。');
  return asset;
}

export function createVoiceLibrary({ database, store, onChanged }: VoiceLibraryOptions) {
  function find(id: string): VoiceProfile | undefined {
    const saved = store.get('voice', id);
    return saved ? voiceProfileSchema.parse(saved) : undefined;
  }
  function get(id: string): VoiceProfile {
    const profile = find(id);
    if (!profile) throw new Error('音色不存在。');
    return profile;
  }
  function references(profile: VoiceProfile): AssetRecord[] {
    return profile.referenceAssetIds.map(id => publicAudio(store.get<AssetRecord>('asset', id)));
  }
  function requireRevision(profile: VoiceProfile, revision: number | undefined) {
    if (profile.revision !== revision) throw new Error('音色已在其他视图修改，请刷新后重新保存。');
  }
  function isReferenced(id: string): boolean {
    return Boolean(database.prepare(`SELECT 1 FROM documents document WHERE
      (document.kind = 'character' AND json_extract(document.body, '$.defaultVoiceId') = ?) OR
      (document.kind = 'project' AND EXISTS (
        SELECT 1 FROM json_each(document.body, '$.shots') shot, json_each(shot.value, '$.drama.lines') line
        WHERE json_extract(line.value, '$.voiceId') = ?
      )) LIMIT 1`).get(id, id));
  }
  function assetInUse(id: string): boolean {
    return Boolean(database.prepare(`SELECT 1 FROM (${retainedReferenceIds}) WHERE asset_id = ? LIMIT 1`).get(id));
  }
  function assetsInUse(ids: readonly string[]): Set<string> {
    if (!ids.length) return new Set();
    const rows = database.prepare(`SELECT DISTINCT asset_id FROM (${retainedReferenceIds}) WHERE asset_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as { asset_id: string }[];
    return new Set(rows.map(row => row.asset_id));
  }
  function profilesFor(project: { creativeContext?: CreativeContext | null; shots: ReadonlyArray<Pick<Shot, 'characterIds' | 'drama'>> }, characters: readonly CharacterProfile[] = []): VoiceBundle {
    const assets = new Map<string, AssetRecord>();
    const voices = dramaVoiceIds(project, characters).map(id => {
      const profile = get(id);
      if (profile.archived) throw new Error(`音色「${profile.name}」已归档，请恢复后再使用。`);
      for (const asset of references(profile)) assets.set(asset.id, asset);
      return profile;
    });
    return { voices, assets: [...assets.values()] };
  }
  function dispatch(method: string, rawParams: unknown = {}): VoiceProfile | VoiceProfile[] | RecordPage<VoiceProfile> | AssetRecord[] | { deleted: true } {
    switch (method) {
      case 'voice.get': return get(voiceIdentity.parse(rawParams).voiceId);
      case 'voice.getMany': {
        const { voiceIds } = z.object({ voiceIds: z.array(voiceProfileSchema.shape.id).max(100) }).parse(rawParams);
        return [...new Set(voiceIds)].flatMap(id => { const profile = find(id); return profile ? [profile] : []; });
      }
      case 'voice.references': return references(get(voiceIdentity.parse(rawParams).voiceId));
      case 'voice.list': {
        const input = pageInputSchema.extend({ archived: z.boolean().default(false) }).parse(rawParams);
        const rows = database.prepare("SELECT rowid AS cursor, body FROM documents WHERE kind = 'voice' AND coalesce(json_extract(body, '$.archived'), 0) = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?").all(Number(input.archived), input.before ?? null, input.before ?? null, input.limit + 1) as { cursor: number; body: string }[];
        return { items: rows.slice(0, input.limit).map(row => voiceProfileSchema.parse(JSON.parse(row.body))), nextCursor: rows.length > input.limit ? rows[input.limit - 1].cursor : null };
      }
      case 'voice.save': {
        const { voice } = z.object({ voice: voiceProfileInputSchema }).parse(rawParams);
        const saved = database.transaction(() => {
          const previous = voice.id ? get(voice.id) : undefined;
          if (previous?.archived) throw new Error(`音色「${previous.name}」已归档，请恢复后再编辑。`);
          if (previous) requireRevision(previous, voice.revision);
          const timestamp = new Date().toISOString();
          const profile = voiceProfileSchema.parse({ ...previous, ...voice, id: previous?.id ?? randomUUID(), revision: previous ? previous.revision + 1 : 1, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, archived: false });
          references(profile);
          store.put('voice', profile.id, profile);
          return profile;
        }).immediate();
        onChanged(); return saved;
      }
      case 'voice.archive':
      case 'voice.restore':
      case 'voice.delete': {
        const input = voiceChange.parse(rawParams);
        const saved = database.transaction(() => {
          const previous = get(input.voiceId); requireRevision(previous, input.revision);
          if (method === 'voice.delete' && !previous.archived) throw new Error('请先归档音色，再彻底删除。');
          if (method === 'voice.restore') references(previous);
          else if (isReferenced(previous.id)) throw new Error('仍有角色或项目对白使用此音色，请先移除对应关联。');
          if (method === 'voice.delete') { store.delete('voice', previous.id); return { deleted: true } as const; }
          const profile = { ...previous, archived: method === 'voice.archive', revision: previous.revision + 1, updatedAt: new Date().toISOString() };
          store.put('voice', profile.id, profile);
          return profile;
        }).immediate();
        onChanged(); return saved;
      }
      default: throw new Error(`未知音色方法：${method}`);
    }
  }
  return { dispatch, profilesFor, assetInUse, assetsInUse };
}
