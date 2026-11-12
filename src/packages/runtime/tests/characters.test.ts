import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, type AssetRecord, type CharacterProfile, type RecordPage } from '@video-quickly/contracts';
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
    expect(() => library.dispatch('character.save', { character: { ...archived, description: '归档后的修改' } })).toThrow('请恢复后再编辑');
    expect(library.dispatch('character.get', { characterId: profile.id })).toEqual(archived);
    const restored = library.dispatch('character.restore', { characterId: profile.id, revision: archived.revision }) as CharacterProfile;
    expect(restored.archived).toBe(false); expect(restored.revision).toBe(3);
    expect(library.dispatch('character.save', { character: { ...restored, description: '恢复后修改' } })).toMatchObject({ description: '恢复后修改', revision: 4 });
    expect(() => library.dispatch('character.archive', { characterId: profile.id, revision: 1 })).toThrow('其他视图修改');
  });

  it('deletes only an unreferenced archived revision and preserves shared reference assets and snapshots', async () => {
    const { store, library, image, save, changes } = await fixture();
    const profile = save('待删除角色');
    const shared = save('共享同一参考图的角色');
    const remove = (revision: number) => library.dispatch('character.delete', { characterId: profile.id, revision });
    expect(() => remove(profile.revision)).toThrow('请先归档');
    const archived = library.dispatch('character.archive', { characterId: profile.id, revision: profile.revision }) as CharacterProfile;
    expect(() => remove(profile.revision)).toThrow('其他视图修改');
    const project = projectSchema.parse({ id: 'legacy', title: '旧归档项目', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(), createdAt: '', updatedAt: '', shots: [], archived: true, creativeContext: { characterIds: [profile.id] } });
    store.put('project', project.id, project);
    expect(() => remove(archived.revision)).toThrow('项目角色池');
    expect(library.dispatch('character.get', { characterId: profile.id })).toEqual(archived);
    expect(changes()).toBe(3);
    store.delete('project', project.id);
    const snapshot = { characters: [profile], characterAssets: [image] };
    store.put('run-snapshot', 'historical-run', snapshot);

    expect(remove(archived.revision)).toEqual({ deleted: true });
    expect(() => library.dispatch('character.get', { characterId: profile.id })).toThrow('角色不存在');
    expect(library.dispatch('character.getMany', { characterIds: [profile.id, shared.id] })).toEqual([shared]);
    expect(library.dispatch('character.list', { archived: true })).toEqual({ items: [], nextCursor: null });
    expect(store.get('run-snapshot', 'historical-run')).toEqual(snapshot);
    expect(library.dispatch('character.references', { characterId: shared.id })).toEqual([image]);
    expect(library.assetInUse(image.id)).toBe(true);
    expect(() => remove(archived.revision)).toThrow('角色不存在');
    expect(changes()).toBe(4);
  });

  it('returns only requested reference IDs in one query, including archived characters and opaque IDs', async () => {
    const { database, store, library, image, save } = await fixture();
    const quoted = { ...image, id: "reference'_%:" }, outside = { ...image, id: 'outside-page' };
    for (const asset of [quoted, outside]) store.put('asset', asset.id, asset);
    save('当前引用', [image.id, outside.id]);
    const archived = save('归档引用', [quoted.id]);
    library.dispatch('character.archive', { characterId: archived.id, revision: archived.revision });
    const prepared = vi.spyOn(database, 'prepare');
    try {
      expect(library.assetsInUse([])).toEqual(new Set()); expect(prepared).not.toHaveBeenCalled();
      expect(library.assetsInUse([image.id, quoted.id, 'missing', image.id])).toEqual(new Set([image.id, quoted.id]));
      expect(prepared).toHaveBeenCalledTimes(1);
    } finally { prepared.mockRestore(); }
  });

  it('reads only selected characters and refuses archiving any character referenced by a project shot', async () => {
    const { store, library, image, save } = await fixture();
    const selected = save('本镜头角色'), unused = save('未选择角色', []);
    const project = projectSchema.parse({ id: 'project', title: '角色引用', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(), createdAt: '', updatedAt: '', shots: [{ id: 's', title: '镜头', narration: '', visualPrompt: '', durationUs: 1_000_000, characterIds: [selected.id] }] });
    store.put('project', project.id, project);
    expect(library.profilesFor(project)).toEqual({ characters: [selected], assets: [image] });
    expect(() => library.dispatch('character.archive', { characterId: selected.id, revision: selected.revision })).toThrow('仍有项目镜头');
    expect(library.dispatch('character.get', { characterId: selected.id })).toEqual(selected);
    library.dispatch('character.archive', { characterId: unused.id, revision: unused.revision });
    expect(library.profilesFor(project).characters).toEqual([selected]);
    store.put('project', project.id, { ...project, shots: [] });
    expect((library.dispatch('character.archive', { characterId: selected.id, revision: selected.revision }) as CharacterProfile).archived).toBe(true);
  });

});
