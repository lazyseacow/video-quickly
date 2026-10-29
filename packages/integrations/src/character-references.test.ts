import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { characterProfileSchema, type AssetRecord } from '@video-quickly/contracts';
import { MAX_CHARACTER_REFERENCE_BYTES, resolveCharacterReferences } from './character-references.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-character-images-')); directories.push(directory);
  const path = join(directory, 'reference.png');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  await writeFile(path, bytes);
  const asset: AssetRecord = { id: 'reference', name: '公共角色图', kind: 'image', path, mimeType: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: '', provenance: 'isolated fixture', active: true, retained: false };
  const profile = characterProfileSchema.parse({ id: 'character', name: '小青', description: '蓝色外衣和固定发型。', referenceAssetIds: [asset.id], revision: 1, createdAt: '', updatedAt: '' });
  return { directory, asset, profile, bytes };
}

describe('character image request preflight', () => {
  it('resolves selected frozen profiles, adds their descriptions and deduplicates real image data', async () => {
    const { asset, profile, bytes } = await fixture();
    const second = { ...profile, id: 'second', name: '小白', description: '白色外衣。' };
    const unused = { ...profile, id: 'unused', referenceAssetIds: ['missing-unused-reference'] };
    const resolved = await resolveCharacterReferences({ shot: { characterIds: [profile.id, second.id] }, characters: [unused, profile, second], assets: [asset] });
    expect(resolved.characters).toEqual([profile, second]);
    expect(resolved.prompt).toContain('小青'); expect(resolved.prompt).toContain(profile.description); expect(resolved.prompt).toContain('小白');
    expect(resolved.images).toEqual([{ assetId: asset.id, mimeType: asset.mimeType, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }]);
    const textOnly = await resolveCharacterReferences({ shot: { characterIds: [profile.id] }, characters: [{ ...profile, referenceAssetIds: [] }], assets: [] });
    expect(textOnly.images).toEqual([]); expect(textOnly.prompt).toContain(profile.description);
    expect(await resolveCharacterReferences({ shot: {}, assets: [] })).toEqual({ characters: [], prompt: '', images: [] });
  });

  it('rejects missing or archived snapshots and private, inactive or changed images', async () => {
    const { asset, profile, bytes } = await fixture();
    await expect(resolveCharacterReferences({ shot: { characterIds: [profile.id] }, assets: [asset] })).rejects.toThrow('快照缺少');
    await expect(resolveCharacterReferences({ shot: { characterIds: [profile.id] }, characters: [{ ...profile, archived: true }], assets: [asset] })).rejects.toThrow('已归档');
    for (const invalid of [{ ...asset, projectId: 'private-project' }, { ...asset, active: false }, { ...asset, kind: 'audio' as const }]) await expect(resolveCharacterReferences({ shot: { characterIds: [profile.id] }, characters: [profile], assets: [invalid] })).rejects.toThrow('公共图片');
    await writeFile(asset.path, Buffer.alloc(bytes.length, 1));
    await expect(resolveCharacterReferences({ shot: { characterIds: [profile.id] }, characters: [profile], assets: [asset] })).rejects.toThrow('校验失败');
  });

  it('rejects oversized files from metadata before buffering their contents', async () => {
    const { asset, profile } = await fixture();
    const handle = await open(asset.path, 'r+');
    try { await handle.truncate(MAX_CHARACTER_REFERENCE_BYTES + 1); } finally { await handle.close(); }
    await expect(resolveCharacterReferences({ shot: { characterIds: [profile.id] }, characters: [profile], assets: [{ ...asset, size: MAX_CHARACTER_REFERENCE_BYTES + 1 }] })).rejects.toThrow('20 MiB');
  });

  it('bounds the combined image payload before reading any of its large source files', async () => {
    const { directory, asset, profile } = await fixture();
    const assets: AssetRecord[] = [];
    for (let index = 0; index < 4; index++) {
      const path = join(directory, `large-${index}.png`);
      const handle = await open(path, 'w');
      try { await handle.truncate(17 * 1024 * 1024); } finally { await handle.close(); }
      assets.push({ ...asset, id: `large-${index}`, path, size: 17 * 1024 * 1024 });
    }
    await expect(resolveCharacterReferences({ shot: { characterIds: [profile.id] }, characters: [{ ...profile, referenceAssetIds: assets.map(value => value.id) }], assets })).rejects.toThrow('总量超过 64 MiB');
  });
});
