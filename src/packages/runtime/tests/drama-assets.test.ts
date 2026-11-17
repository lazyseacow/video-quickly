import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, type AssetRecord, type CharacterProfile, type RecordPage, type VoiceProfile } from '@video-quickly/contracts';
import { createCharacterLibrary } from '../src/characters.js';
import { createVoiceLibrary } from '../src/voices.js';
import { DocumentStore, openDatabase } from '../src/database.js';

const fixtures: Array<{ directory: string; database: ReturnType<typeof openDatabase> }> = [];
afterEach(async () => {
  const saved = fixtures.splice(0); saved.forEach(({ database }) => database.close());
  await Promise.all(saved.map(({ directory }) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-drama-assets-'));
  const database = openDatabase(directory); fixtures.push({ directory, database });
  const store = new DocumentStore(database);
  const image: AssetRecord = { id: 'base-image', name: '角色基础图', kind: 'image', path: '/fixture/metadata.png', mimeType: 'image/png', size: 100, sha256: 'fixture-hash', version: 1, createdAt: '', provenance: 'fixture', retained: false, active: true };
  const alternate = { ...image, id: 'costume-image', name: '雨衣形象' };
  const audio: AssetRecord = { ...image, id: 'voice-audio', name: '角色声音参考', kind: 'audio', mimeType: 'audio/wav', path: '/fixture/metadata.wav' };
  for (const asset of [image, alternate, audio]) store.put('asset', asset.id, asset);
  let changes = 0;
  const onChanged = () => { changes++; };
  const characters = createCharacterLibrary({ database, store, onChanged });
  const voices = createVoiceLibrary({ database, store, onChanged });
  const saveVoice = (name: string) => voices.dispatch('voice.save', { voice: { name, description: '语气沉稳，吐字清楚', language: 'zh-CN', referenceAssetIds: [audio.id] } }) as VoiceProfile;
  const saveCharacter = (defaultVoiceId?: string) => characters.dispatch('character.save', { character: {
    name: '阿青', description: '固定发型和面部特征', referenceAssetIds: [image.id], defaultVoiceId,
    appearances: [{ id: 'raincoat', name: '雨衣', description: '黄色雨衣，手持折伞', referenceAssetIds: [alternate.id] }],
  } }) as CharacterProfile;
  return { database, store, image, alternate, audio, voices, characters, saveVoice, saveCharacter, changes: () => changes };
}

describe('drama appearance and voice libraries', () => {
  it('persists voice metadata with stable paging, optimistic updates, explicit clearing and archive lifecycle', async () => {
    const { voices, saveVoice, changes } = await fixture();
    const first = saveVoice('主角声音'), second = saveVoice('解说声音');
    const firstPage = voices.dispatch('voice.list', { limit: 1 }) as RecordPage<VoiceProfile>;
    expect(firstPage.items.map(voice => voice.id)).toEqual([second.id]);
    saveVoice('新插入');
    expect((voices.dispatch('voice.list', { limit: 1, before: firstPage.nextCursor }) as RecordPage<VoiceProfile>).items.map(voice => voice.id)).toEqual([first.id]);
    const updated = voices.dispatch('voice.save', { voice: { ...first, providerVoiceId: 'external-voice-label', description: '修改音色说明' } }) as VoiceProfile;
    expect(updated).toMatchObject({ revision: 2, createdAt: first.createdAt, providerVoiceId: 'external-voice-label' });
    expect(() => voices.dispatch('voice.save', { voice: first })).toThrow('其他视图修改');
    const cleared = voices.dispatch('voice.save', { voice: { ...updated, providerVoiceId: null } }) as VoiceProfile;
    expect(cleared.providerVoiceId).toBeNull();
    const archived = voices.dispatch('voice.archive', { voiceId: first.id, revision: cleared.revision }) as VoiceProfile;
    expect(archived.archived).toBe(true);
    expect(voices.dispatch('voice.getMany', { voiceIds: [first.id, 'missing', first.id] })).toEqual([archived]);
    expect(() => voices.dispatch('voice.save', { voice: archived })).toThrow('请恢复后再编辑');
    expect(voices.dispatch('voice.list', { archived: true })).toEqual({ items: [archived], nextCursor: null });
    const restored = voices.dispatch('voice.restore', { voiceId: first.id, revision: archived.revision }) as VoiceProfile;
    const archivedAgain = voices.dispatch('voice.archive', { voiceId: first.id, revision: restored.revision }) as VoiceProfile;
    expect(voices.dispatch('voice.delete', { voiceId: first.id, revision: archivedAgain.revision })).toEqual({ deleted: true });
    expect(() => voices.dispatch('voice.get', { voiceId: first.id })).toThrow('音色不存在');
    expect(changes()).toBe(9);
  });

  it('accepts only active public bounded audio and leaves rejected changes unwritten', async () => {
    const { store, audio, image, voices, saveVoice, changes } = await fixture();
    const original = saveVoice('有效音色');
    const invalidAssets = [image, { ...audio, id: 'private-audio', projectId: 'other' }, { ...audio, id: 'removed-audio', active: false },
      { ...audio, id: 'large-audio', size: 15_000_001 }, { ...audio, id: 'empty-audio', size: 0 }, { ...audio, id: 'unsupported-audio', mimeType: 'audio/flac' }];
    for (const asset of invalidAssets) {
      store.put('asset', asset.id, asset);
      expect(() => voices.dispatch('voice.save', { voice: { ...original, referenceAssetIds: [asset.id] } })).toThrow();
      expect(voices.dispatch('voice.get', { voiceId: original.id })).toEqual(original);
    }
    expect(() => voices.dispatch('voice.save', { voice: { ...original, referenceAssetIds: ['missing'] } })).toThrow('公共素材库');
    expect(changes()).toBe(1);
  });

  it('preserves appearances for legacy character edits and validates defaults and selected appearances', async () => {
    const { characters, voices, image, alternate, audio, saveVoice, saveCharacter } = await fixture();
    const voice = saveVoice('主角'), character = saveCharacter(voice.id);
    const updated = characters.dispatch('character.save', { character: { id: character.id, revision: character.revision, name: '改名', description: character.description, referenceAssetIds: character.referenceAssetIds } }) as CharacterProfile;
    expect(updated.appearances).toEqual(character.appearances); expect(updated.defaultVoiceId).toBe(voice.id);
    const project = { shots: [{ drama: { appearances: [{ characterId: character.id, appearanceId: 'raincoat' }], lines: [{ id: 'one', kind: 'dialogue' as const, speakerId: character.id, text: '下雨了。' }] } }] };
    const bundle = characters.profilesFor(project);
    expect(bundle.characters).toEqual([updated]); expect(bundle.assets).toEqual([image, alternate]);
    expect(voices.profilesFor(project, bundle.characters)).toEqual({ voices: [voice], assets: [audio] });
    expect(() => characters.profilesFor({ shots: [{ drama: { appearances: [{ characterId: character.id, appearanceId: 'missing' }], lines: [] } }] })).toThrow('角色形象不存在');
    expect(() => characters.dispatch('character.save', { character: { ...updated, defaultVoiceId: 'missing' } })).toThrow('默认音色不存在');
    const cleared = characters.dispatch('character.save', { character: { ...updated, defaultVoiceId: null } }) as CharacterProfile;
    expect(cleared.defaultVoiceId).toBeNull();
    const archived = voices.dispatch('voice.archive', { voiceId: voice.id, revision: voice.revision }) as VoiceProfile;
    expect(() => characters.dispatch('character.save', { character: { ...cleared, defaultVoiceId: archived.id } })).toThrow('默认音色已归档');
  });

  it('protects appearance bindings, work casting, dialogue voices and frozen reference assets', async () => {
    const { store, image, alternate, audio, characters, voices, saveVoice, saveCharacter } = await fixture();
    const voice = saveVoice('主角声音'), character = saveCharacter(voice.id), narrator = saveVoice('解说');
    const project = projectSchema.parse({ id: 'episode', title: '雨夜', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(), createdAt: '', updatedAt: '', shots: [{
      id: 'shot', title: '雨夜对白', narration: '', visualPrompt: '', durationUs: 4_000_000,
      drama: { appearances: [{ characterId: character.id, appearanceId: 'raincoat' }], lines: [{ id: 'narration', kind: 'narration', text: '那天下起了雨。', voiceId: narrator.id }] },
    }] });
    store.put('project', project.id, project);
    expect(() => characters.dispatch('character.save', { character: { ...character, appearances: [] } })).toThrow('仍被项目镜头使用');
    expect(() => characters.dispatch('character.archive', { characterId: character.id, revision: character.revision })).toThrow('仍有项目镜头');
    expect(() => voices.dispatch('voice.archive', { voiceId: narrator.id, revision: narrator.revision })).toThrow('项目对白使用');
    expect(() => voices.dispatch('voice.archive', { voiceId: voice.id, revision: voice.revision })).toThrow('角色或项目对白使用');
    expect(characters.assetsInUse([alternate.id, image.id, 'missing'])).toEqual(new Set([alternate.id, image.id]));
    expect(voices.assetsInUse([audio.id, image.id])).toEqual(new Set([audio.id]));
    store.delete('project', project.id);
    store.put('drama-work', 'work', { characterIds: [character.id] });
    expect(() => characters.dispatch('character.archive', { characterId: character.id, revision: character.revision })).toThrow('仍有项目镜头');
    store.delete('drama-work', 'work');
    store.put('run-snapshot', 'run', { characters: [character], voices: [voice], voiceAssets: [audio] });
    const archivedCharacter = characters.dispatch('character.archive', { characterId: character.id, revision: character.revision }) as CharacterProfile;
    characters.dispatch('character.delete', { characterId: character.id, revision: archivedCharacter.revision });
    const archivedVoice = voices.dispatch('voice.archive', { voiceId: voice.id, revision: voice.revision }) as VoiceProfile;
    voices.dispatch('voice.delete', { voiceId: voice.id, revision: archivedVoice.revision });
    expect(characters.assetInUse(alternate.id)).toBe(true); expect(voices.assetInUse(audio.id)).toBe(true);
    expect(store.get('run-snapshot', 'run')).toMatchObject({ characters: [character], voices: [voice], voiceAssets: [audio] });
  });
});
