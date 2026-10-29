import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHistoryWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, type AssetRecord, type CharacterProfile, type RecordPage } from '@video-quickly/contracts';
import { createCharacterLibrary } from '../src/characters.js';
import { DocumentStore, openDatabase } from '../src/database.js';

const fixtures: Array<{ directory: string; database: ReturnType<typeof openDatabase> }> = [];
afterEach(async () => {
  const saved = fixtures.splice(0); saved.forEach(({ database }) => database.close());
  await Promise.all(saved.map(({ directory }) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-characters-'));
  const database = openDatabase(directory); fixtures.push({ directory, database });
  const store = new DocumentStore(database);
  const image: AssetRecord = { id: 'public-image', name: '公共参考图', kind: 'image', path: '/fixture/not-read-by-metadata.png', mimeType: 'image/png', size: 100, sha256: 'fixture-hash', version: 1, createdAt: '', provenance: 'fixture', retained: false, active: true };
  store.put('asset', image.id, image);
  let changes = 0;
  const library = createCharacterLibrary({ database, store, onChanged: () => { changes++; } });
  const save = (name: string, referenceAssetIds: string[] = [image.id]) => library.dispatch('character.save', { character: { name, description: `角色${name}的固定外貌`, referenceAssetIds } }) as CharacterProfile;
  return { database, store, library, image, save, changes: () => changes };
}

describe('shared character library', () => {
  it('uses optimistic revisions, bounded stable cursors and exact metadata reads', async () => {
    const { library, image, save, changes } = await fixture();
    const first = save('一号'), second = save('二号');
    const page = library.dispatch('character.list', { limit: 1 }) as RecordPage<CharacterProfile>;
    expect(page.items.map(profile => profile.id)).toEqual([second.id]); expect(page.nextCursor).not.toBeNull();
    save('新插入的角色');
    const next = library.dispatch('character.list', { limit: 1, before: page.nextCursor }) as RecordPage<CharacterProfile>;
    expect(next.items.map(profile => profile.id)).toEqual([first.id]); expect(next.nextCursor).toBeNull();
    const updated = library.dispatch('character.save', { character: { ...first, name: '人工改名' } }) as CharacterProfile;
    expect(updated.revision).toBe(2); expect(updated.createdAt).toBe(first.createdAt);
    expect(() => library.dispatch('character.save', { character: first })).toThrow('其他视图修改');
    expect(() => library.dispatch('character.save', { character: { ...updated, revision: undefined } })).toThrow('其他视图修改');
    expect(library.dispatch('character.get', { characterId: first.id })).toEqual(updated);
    expect(library.dispatch('character.references', { characterId: first.id })).toEqual([image]);
    expect(() => library.dispatch('character.list', { limit: 101 })).toThrow();
    expect(changes()).toBe(4);
  });

  it('accepts only active public images and protects current and archived character references', async () => {
    const { store, library, image, save } = await fixture();
    for (const asset of [{ ...image, id: 'private', projectId: 'other-project' }, { ...image, id: 'inactive', active: false }, { ...image, id: 'audio', kind: 'audio' }]) store.put('asset', asset.id, asset);
    for (const id of ['private', 'inactive', 'audio', 'missing']) expect(() => save(id, [id])).toThrow('公共素材库');
    const profile = save('可恢复角色');
    expect(library.assetInUse(image.id)).toBe(true);
    const archived = library.dispatch('character.archive', { characterId: profile.id, revision: profile.revision }) as CharacterProfile;
    expect(archived.archived).toBe(true); expect(library.assetInUse(image.id)).toBe(true);
    expect((library.dispatch('character.list', {}) as RecordPage<CharacterProfile>).items).toEqual([]);
    expect((library.dispatch('character.list', { archived: true }) as RecordPage<CharacterProfile>).items).toEqual([archived]);
    expect(library.dispatch('character.references', { characterId: profile.id })).toEqual([image]);
    expect(() => library.profilesFor({ shots: [{ characterIds: [profile.id] }] })).toThrow('已归档');
    const restored = library.dispatch('character.restore', { characterId: profile.id, revision: archived.revision }) as CharacterProfile;
    expect(restored.archived).toBe(false); expect(restored.revision).toBe(3);
    expect(() => library.dispatch('character.archive', { characterId: profile.id, revision: 1 })).toThrow('其他视图修改');
  });

  it('reads only selected characters and refuses archiving any character referenced by a project shot', async () => {
    const { store, library, image, save } = await fixture();
    const selected = save('本镜头角色'), unused = save('未选择角色', []);
    const project = projectSchema.parse({ id: 'project', title: '角色引用', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), createdAt: '', updatedAt: '', shots: [{ id: 's', title: '镜头', narration: '', visualPrompt: '', durationUs: 1_000_000, characterIds: [selected.id] }] });
    store.put('project', project.id, project);
    expect(library.profilesFor(project)).toEqual({ characters: [selected], assets: [image] });
    expect(() => library.dispatch('character.archive', { characterId: selected.id, revision: selected.revision })).toThrow('仍有项目镜头');
    expect(library.dispatch('character.get', { characterId: selected.id })).toEqual(selected);
    library.dispatch('character.archive', { characterId: unused.id, revision: unused.revision });
    expect(library.profilesFor(project).characters).toEqual([selected]);
    store.put('project', project.id, { ...project, shots: [] });
    expect((library.dispatch('character.archive', { characterId: selected.id, revision: selected.revision }) as CharacterProfile).archived).toBe(true);
  });

  it('prepares a portable character backup with fresh identities without writing partial imports', async () => {
    const { library, save, image, store } = await fixture();
    const profile = save('原始角色');
    const bundle = { characters: [profile], assets: [image] };
    const prepared = library.prepareImport(bundle, new Map([[image.id, 'restored-public-image']]));
    expect(prepared.characters[0]).toMatchObject({ name: profile.name, description: profile.description, referenceAssetIds: ['restored-public-image'], revision: 1 });
    expect(prepared.idMap.get(profile.id)).toBe(prepared.characters[0].id); expect(prepared.characters[0].id).not.toBe(profile.id);
    expect(store.get('character', prepared.characters[0].id)).toBeUndefined();
    expect(bundle.characters[0]).toEqual(profile);
    expect(() => library.prepareImport(bundle, new Map())).toThrow('缺少参考图');
  });
});
