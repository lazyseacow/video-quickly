import { describe, expect, it } from 'vitest';
import { characterProfileSchema, shotSchema } from '@video-quickly/contracts';

describe('character reference contracts', () => {
  const profile = { id: 'character', name: '小青', description: '蓝色外衣，固定发型。', referenceAssetIds: ['public-image'], revision: 1, createdAt: '', updatedAt: '' };
  it('keeps old shots unchanged and bounds selected roles and reference images', () => {
    const shot = { id: 'shot', title: '镜头', narration: '', visualPrompt: '', durationUs: 1_000_000 };
    expect(shotSchema.parse(shot).characterIds).toBeUndefined();
    expect(characterProfileSchema.parse(profile).archived).toBe(false);
    expect(shotSchema.parse({ ...shot, characterIds: ['character'] }).characterIds).toEqual(['character']);
    for (const invalid of [{ name: '' }, { name: '名'.repeat(121) }, { description: '字'.repeat(10001) }, { revision: 0 }, { referenceAssetIds: ['a', 'a'] }, { referenceAssetIds: ['1', '2', '3', '4', '5'] }]) expect(characterProfileSchema.safeParse({ ...profile, ...invalid }).success).toBe(false);
    expect(shotSchema.safeParse({ ...shot, characterIds: Array.from({ length: 9 }, (_, index) => String(index)) }).success).toBe(false);
    expect(shotSchema.safeParse({ ...shot, characterIds: ['a', 'a'] }).success).toBe(false);
  });
});
