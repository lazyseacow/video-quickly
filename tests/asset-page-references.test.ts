import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assetListItemSchema, assetSchema, characterProfileSchema, jsonAssetPreviewSchema, recordPageSchema, type AssetRecord, type CharacterProfile } from '@video-quickly/contracts';
import { createRuntime } from '../src/packages/runtime/src';
import { DocumentStore, openDatabase } from '../src/packages/runtime/src/database';
import { legacyTimelineName, localRenderProvenance } from '../src/packages/runtime/src/legacy-export-timeline';
import { seedLargeWorkspace } from './fixtures/large-workspace';

const fixtures: Array<{ directory: string; database: ReturnType<typeof openDatabase>; runtime: ReturnType<typeof createRuntime> }> = [];
afterEach(async () => {
  for (const { directory, database, runtime } of fixtures.splice(0)) {
    await runtime.close(); database.close(); await rm(directory, { recursive: true, force: true });
  }
});
const assetsPageSchema = recordPageSchema(assetListItemSchema);
async function fixture(count: number) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-asset-page-references-'));
  const database = openDatabase(directory), store = new DocumentStore(database);
  const project = seedLargeWorkspace(store, 10, { assets: 0, runs: 0, eventsPerRun: 0 });
  const assets = Array.from({ length: count }, (_, index): AssetRecord => ({ id: `public-${index}`, name: `公共图片 ${index}`, kind: 'image', path: '/fixture/not-read-by-metadata.png', mimeType: 'image/png', size: 100, sha256: 'fixture-hash', version: 1, createdAt: '', provenance: 'fixture', retained: false, active: true }));
  database.transaction(() => { for (const asset of assets) store.put('asset', asset.id, asset); })();
  const runtime = createRuntime({ dataDirectory: directory, seed: false });
  fixtures.push({ directory, database, runtime });
  const save = async (name: string, referenceAssetIds: string[]) => characterProfileSchema.parse(await runtime.dispatch('character.save', { character: { name, description: `${name}的固定设定`, referenceAssetIds } }));
  return { directory, database, store, project, assets, runtime, save };
}

it('imports and previews JSON text without rewriting values and bounds reads by actual file length', async () => {
  const { directory, runtime, store } = await fixture(0);
  const path = join(directory, '场景.JSON');
  const original = '{"角色":"阿青","identifier":9007199254740993}';
  await writeFile(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(original, 'utf16le')]));
  const asset = assetSchema.parse(await runtime.dispatch('asset.import', { path }));
  expect(asset).toMatchObject({ name: '场景.JSON', kind: 'document', mimeType: 'application/json' });
  const preview = async (assetId = asset.id) => jsonAssetPreviewSchema.parse(await runtime.dispatch('asset.read', { assetId, format: 'text' }));
  expect(await preview()).toEqual({ text: original, truncated: false });

  const legacy = { ...asset, id: 'legacy-json', mimeType: 'application/octet-stream' };
  store.put('asset', legacy.id, legacy);
  expect(await preview(legacy.id)).toEqual({ text: original, truncated: false });

  const prefix = '{"场景":"';
  const content = prefix + 'a'.repeat(1024 * 1024 - Buffer.byteLength(prefix) - 1);
  await writeFile(asset.path, `${content}雨"}`);
  expect(await preview()).toEqual({ text: content, truncated: true });
  await writeFile(asset.path, '');
  expect(await preview()).toEqual({ text: '', truncated: false });
});

describe('asset-page character references', () => {
  it('checks project and character references for a full page with one query per source', async () => {
    const { database, runtime, assets, save } = await fixture(100);
    await save('当前角色', [assets[0].id]);
    const archived = await save('已归档角色', [assets[99].id]);
    await runtime.dispatch('character.archive', { characterId: archived.id, revision: archived.revision });
    const prepared = vi.spyOn(Object.getPrototypeOf(database) as Pick<typeof database, 'prepare'>, 'prepare');
    try {
      const page = assetsPageSchema.parse(await runtime.dispatch('asset.list', {}));
      expect(page.items).toHaveLength(100); expect(page.nextCursor).toBeNull();
      expect(page.items.filter(asset => asset.inUse).map(asset => asset.id)).toEqual([assets[99].id, assets[0].id]);
      const queries = prepared.mock.calls.map(([sql]) => sql);
      const projectQueries = queries.filter(sql => sql.includes('project_asset_references'));
      expect(projectQueries).toHaveLength(1);
      expect(queries.filter(sql => sql.includes("json_each(profile.body, '$.referenceAssetIds')"))).toHaveLength(1);
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${projectQueries[0]}`).all({ limit: 101, legacyTimelineName, localRenderProvenance }) as { detail: string }[];
      expect(plan.some(row => row.detail.includes('USING INDEX documents_active_assets'))).toBe(true);
      expect(plan.some(row => row.detail.includes('USE TEMP B-TREE'))).toBe(false);
      const derivationQueries = queries.filter(sql => sql.includes('$.derivation.sourceAssetId'));
      expect(derivationQueries).toHaveLength(1);
      const derivationPlan = database.prepare(`EXPLAIN QUERY PLAN ${derivationQueries[0]}`).all(JSON.stringify(assets.map(asset => asset.id))) as { detail: string }[];
      expect(derivationPlan.some(row => row.detail.includes('USING INDEX documents_active_asset_derivations'))).toBe(true);
    } finally { prepared.mockRestore(); }
  });

  it('keeps references exact across pages and external changes while preserving deletion protection', async () => {
    const { database, store, project, assets, runtime, save } = await fixture(105);
    const local = { ...assets[0], id: 'project-image', projectId: project.id };
    store.put('asset', local.id, local);
    await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ ...project.shots[0], assetId: local.id }, ...project.shots.slice(1)] } });
    store.put('asset', assets[102].id, { ...assets[102], active: false });
    store.put('asset', assets[103].id, { ...assets[103], retained: true });
    const current = await save('当前参考', [assets[104].id]);
    const archived = await save('页外归档参考', [assets[0].id]);
    await runtime.dispatch('character.archive', { characterId: archived.id, revision: archived.revision });

    const first = assetsPageSchema.parse(await runtime.dispatch('asset.list', { kind: 'image' }));
    expect(first.items).toHaveLength(100); expect(first.nextCursor).not.toBeNull();
    expect(first.items.filter(asset => asset.inUse).map(asset => asset.id)).toEqual([local.id, assets[104].id]);
    expect(first.items.some(asset => asset.id === assets[102].id)).toBe(false);
    const next = assetsPageSchema.parse(await runtime.dispatch('asset.list', { kind: 'image', before: first.nextCursor }));
    expect(next.items.map(asset => asset.id)).toEqual(assets.slice(0, 5).reverse().map(asset => asset.id));
    expect(next.items.filter(asset => asset.inUse).map(asset => asset.id)).toEqual([assets[0].id]);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...first.items, ...next.items].map(asset => asset.id)).size).toBe(105);
    const prepared = vi.spyOn(Object.getPrototypeOf(database) as Pick<typeof database, 'prepare'>, 'prepare');
    try {
      for (const params of [{ kind: 'video' }, { before: 1 }]) expect(assetsPageSchema.parse(await runtime.dispatch('asset.list', params))).toEqual({ items: [], nextCursor: null });
      expect(prepared.mock.calls.some(([sql]) => sql.includes("json_each(profile.body, '$.referenceAssetIds')"))).toBe(false);
    } finally { prepared.mockRestore(); }

    for (const assetId of [local.id, assets[104].id, assets[0].id, assets[103].id]) await expect(runtime.dispatch('asset.delete', { assetId })).rejects.toThrow('正在使用或已保留');
    const external: CharacterProfile = { ...current, revision: current.revision + 1, referenceAssetIds: [assets[4].id] };
    store.put('character', external.id, external);
    const changed = assetsPageSchema.parse(await runtime.dispatch('asset.list', { kind: 'image' }));
    expect(changed.items.find(asset => asset.id === assets[104].id)?.inUse).toBe(false);
    const changedNext = assetsPageSchema.parse(await runtime.dispatch('asset.list', { kind: 'image', before: changed.nextCursor }));
    expect(changedNext.items.filter(asset => asset.inUse).map(asset => asset.id)).toEqual([assets[4].id, assets[0].id]);
    await expect(runtime.dispatch('asset.delete', { assetId: assets[4].id })).rejects.toThrow('正在使用');
    await expect(runtime.dispatch('asset.delete', { assetId: assets[104].id })).resolves.toEqual({ deleted: true });
    await expect(runtime.dispatch('asset.delete', { assetId: assets[3].id })).resolves.toEqual({ deleted: true });
    expect(store.get<AssetRecord>('asset', assets[3].id)?.active).toBe(false);
  });

  it('continues to accept only active public images as character references', async () => {
    const { assets, project, store, save } = await fixture(1);
    const invalid = [
      { ...assets[0], id: 'private-image', projectId: project.id },
      { ...assets[0], id: 'inactive-image', active: false },
      { ...assets[0], id: 'public-audio', kind: 'audio' as const },
    ];
    for (const asset of invalid) store.put('asset', asset.id, asset);
    for (const id of [...invalid.map(asset => asset.id), 'missing-image']) await expect(save(id, [id])).rejects.toThrow('公共素材库');
    await expect(save('有效参考', [assets[0].id])).resolves.toMatchObject({ referenceAssetIds: [assets[0].id] });
  });

  it('moves a batch to the recycle bin atomically and restores the original records', async () => {
    const { assets: [first, legacy, inUse, retained], store, runtime, save } = await fixture(4);
    store.put('asset', legacy.id, { ...legacy, active: undefined });
    await save('使用中的参考', [inUse.id]);
    await runtime.dispatch('asset.retain', { assetId: retained.id, retained: true });
    const before = await runtime.dispatch('workspace.summary') as { version: number; assetsVersion: number };
    const remove = (...assetIds: string[]) => runtime.dispatch('asset.deleteMany', { assetIds });

    for (const blocked of [inUse, retained]) await expect(remove(first.id, blocked.id)).rejects.toThrow(blocked.name);
    await expect(remove(first.id, 'missing-asset')).rejects.toThrow('素材不存在');
    expect(store.get<AssetRecord>('asset', first.id)?.active).toBe(true);
    expect(await runtime.dispatch('workspace.summary')).toMatchObject({ version: before.version, assetsVersion: before.assetsVersion });

    await expect(remove(first.id, legacy.id, first.id)).resolves.toEqual({ deleted: true });
    const page = assetsPageSchema.parse(await runtime.dispatch('asset.list', {}));
    expect(page.items.map(asset => asset.id)).toEqual([retained.id, inUse.id]);
    expect(store.get<AssetRecord>('asset', first.id)?.active).toBe(false);
    expect(store.get<AssetRecord>('asset', legacy.id)?.active).toBe(false);
    const after = await runtime.dispatch('workspace.summary') as { version: number; assetsVersion: number };
    expect(after.version).toBe(before.version + 1);
    await expect(remove(first.id, legacy.id)).resolves.toEqual({ deleted: true });
    expect(await runtime.dispatch('workspace.summary')).toMatchObject({ version: after.version, assetsVersion: after.assetsVersion });

    const trash = assetsPageSchema.parse(await runtime.dispatch('asset.list', { trashed: true }));
    expect(trash.items.map(asset => asset.id)).toEqual([legacy.id, first.id]);
    const restore = (assetId: string) => runtime.dispatch('asset.restore', { assetId });
    await expect(restore('missing-asset')).rejects.toThrow('素材不存在');
    await expect(restore(legacy.id)).resolves.toEqual({ restored: true });
    expect(store.get<AssetRecord>('asset', legacy.id)).toEqual(legacy);
    expect(await runtime.dispatch('workspace.summary')).toMatchObject({ version: after.version + 1, assetsVersion: after.assetsVersion + 1 });
    await expect(restore(legacy.id)).resolves.toEqual({ restored: true });
    expect(await runtime.dispatch('workspace.summary')).toMatchObject({ version: after.version + 1, assetsVersion: after.assetsVersion + 1 });
    const remaining = assetsPageSchema.parse(await runtime.dispatch('asset.list', { trashed: true }));
    expect(remaining.items.map(asset => asset.id)).toEqual([first.id]);
  });
});
