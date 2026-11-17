import { expect, it } from 'vitest';
import { dramaStylePresets, dramaTopicInputSchema, dramaTopicSchema } from '../src/packages/contracts/src/drama-catalog';

it('offers distinct production styles with explicit rendering categories and reusable skill references', () => {
  expect(dramaStylePresets.length).toBeGreaterThanOrEqual(8);
  expect(new Set(dramaStylePresets.map(style => style.id)).size).toBe(dramaStylePresets.length);
  expect(new Set(dramaStylePresets.map(style => style.category))).toEqual(new Set(['live-action', '2d', '3d', 'illustration']));
  for (const style of dramaStylePresets) {
    expect(style.name.trim()).not.toBe('');
    expect(style.description.trim()).not.toBe('');
    expect(style.prompt.trim()).not.toBe('');
    expect(style.skillIds.length).toBeGreaterThan(0);
    expect(new Set(style.skillIds).size).toBe(style.skillIds.length);
    expect(style.skillIds).toContain('builtin-drama-continuity');
  }
});

it('requires an actionable topic and bounds tags without accepting duplicate normalized labels', () => {
  const input = dramaTopicInputSchema.parse({ title: '  旧钟表铺  ', logline: '一张旧维修单让即将关门的店主改变决定。' });
  expect(input).toEqual({ title: '旧钟表铺', logline: '一张旧维修单让即将关门的店主改变决定。', description: '', tags: [] });
  for (const invalid of [
    { ...input, title: '  ' }, { ...input, logline: ' ' },
    { ...input, tags: ['生活', ' 生活 '] }, { ...input, tags: [''] },
    { ...input, tags: Array.from({ length: 21 }, (_, index) => `题材${index}`) },
    { ...input, revision: 0 }, { ...input, description: '文'.repeat(20001) },
  ]) expect(dramaTopicInputSchema.safeParse(invalid).success).toBe(false);
  expect(dramaTopicSchema.safeParse(input).success).toBe(false);
  expect(dramaTopicSchema.parse({ ...input, id: 'topic', revision: 1, createdAt: '', updatedAt: '' }).archived).toBe(false);
});
