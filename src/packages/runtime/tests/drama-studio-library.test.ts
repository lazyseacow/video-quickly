import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { dramaStylePresets, dramaTopicSchema, type DramaTopic, type RecordPage, type SkillGroup, type SkillPackage } from '@video-quickly/contracts';
import { builtInDramaSkills, builtInDramaStudioVersion, builtInDramaTopics, seedBuiltInDramaStudio } from '../src/builtin-drama-studio.js';
import { DocumentStore, openDatabase } from '../src/database.js';
import { createDramaTopicLibrary } from '../src/drama-topics.js';
import { createLogger } from '../src/logging.js';
import { createSkillLibrary } from '../src/skill-library.js';

const fixtures: Array<{ directory: string; database: ReturnType<typeof openDatabase> }> = [];
afterEach(async () => {
  const saved = fixtures.splice(0); saved.forEach(({ database }) => database.close());
  await Promise.all(saved.map(({ directory }) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-drama-studio-library-'));
  const database = openDatabase(directory); fixtures.push({ directory, database });
  const store = new DocumentStore(database);
  let changes = 0;
  const library = createDramaTopicLibrary({ database, store, changed: () => { changes++; } });
  const save = (title: string, extra: { logline?: string; description?: string; tags?: string[] } = {}) => dramaTopicSchema.parse(library.dispatch('dramaTopic.save', {
    topic: { title, logline: `${title}的一句话故事`, ...extra },
  }));
  return { directory, database, store, library, save, changes: () => changes };
}

it('searches before stable cursor pagination and treats search punctuation literally', async () => {
  const { library, save, changes } = await fixture();
  const first = save('旧表', { tags: ['亲情'], description: '找回一段旧时记忆。' });
  save('深空值班室', { tags: ['科幻'] });
  const second = save('维修单', { tags: ['亲情'], logline: '店主收到一只没有指针的表。' });
  const page = library.dispatch('dramaTopic.list', { search: '亲情', limit: 1 }) as RecordPage<DramaTopic>;
  expect(page.items).toEqual([second]); expect(page.nextCursor).not.toBeNull();
  save('后来新增', { tags: ['亲情'] });
  expect(library.dispatch('dramaTopic.list', { search: '亲情', limit: 1, before: page.nextCursor })).toEqual({ items: [first], nextCursor: null });
  expect((library.dispatch('dramaTopic.list', { search: '旧时记忆' }) as RecordPage<DramaTopic>).items).toEqual([first]);
  expect((library.dispatch('dramaTopic.list', { search: '没有指针' }) as RecordPage<DramaTopic>).items).toEqual([second]);
  const literal = save('100% 的约定', { tags: ['slice_of_life'] });
  expect((library.dispatch('dramaTopic.list', { search: '%' }) as RecordPage<DramaTopic>).items).toEqual([literal]);
  expect((library.dispatch('dramaTopic.list', { search: 'SLICE_OF_LIFE' }) as RecordPage<DramaTopic>).items).toEqual([literal]);
  expect(library.dispatch('dramaTopic.list', { search: "' OR 1=1 --" })).toEqual({ items: [], nextCursor: null });
  expect(() => library.dispatch('dramaTopic.list', { limit: 101 })).toThrow();
  expect(changes()).toBe(5);
});

it('guards stale topic changes and retains existing work and generation references through archival', async () => {
  const { store, library, save, changes } = await fixture();
  const topic = save('山门', { tags: ['武侠'] });
  const updated = dramaTopicSchema.parse(library.dispatch('dramaTopic.save', { topic: { ...topic, title: '雨夜山门' } }));
  expect(updated.revision).toBe(2); expect(updated.createdAt).toBe(topic.createdAt);
  expect(() => library.dispatch('dramaTopic.save', { topic })).toThrow('其他视图修改');
  expect(() => library.dispatch('dramaTopic.save', { topic: { ...updated, revision: undefined } })).toThrow('其他视图修改');
  const work = { id: 'work', topicIds: [topic.id], title: '原作品', topicContext: { title: topic.title, description: topic.description } };
  const snapshot = { project: { drama: { workId: work.id } }, topics: [topic] };
  store.put('drama-work', work.id, work); store.put('run-snapshot', 'original-run', snapshot);
  const archived = dramaTopicSchema.parse(library.dispatch('dramaTopic.archive', { topicId: topic.id, revision: updated.revision }));
  expect(archived.archived).toBe(true);
  expect(library.dispatch('dramaTopic.list')).toEqual({ items: [], nextCursor: null });
  expect(library.dispatch('dramaTopic.list', { archived: true })).toEqual({ items: [archived], nextCursor: null });
  expect(library.dispatch('dramaTopic.get', { topicId: topic.id })).toEqual(archived);
  expect(store.get('drama-work', work.id)).toEqual(work); expect(store.get('run-snapshot', 'original-run')).toEqual(snapshot);
  expect(() => library.dispatch('dramaTopic.save', { topic: archived })).toThrow('恢复后再编辑');
  expect(() => library.dispatch('dramaTopic.restore', { topicId: topic.id, revision: updated.revision })).toThrow('其他视图修改');
  const restored = dramaTopicSchema.parse(library.dispatch('dramaTopic.restore', { topicId: topic.id, revision: archived.revision }));
  expect(restored).toMatchObject({ archived: false, revision: 4, title: updated.title });
  expect(() => library.dispatch('dramaTopic.delete', { topicId: topic.id })).toThrow('未知短剧选题');
  expect(() => library.dispatch('dramaTopic.get', { topicId: 'missing' })).toThrow('选题不存在');
  expect(changes()).toBe(4);
});

it('seeds original topics and usable creative skills with resources expanded by the production skill library', async () => {
  const { directory, store, library } = await fixture();
  seedBuiltInDramaStudio(directory, store);
  const topics = (library.dispatch('dramaTopic.list') as RecordPage<DramaTopic>).items;
  expect(topics.length).toBeGreaterThanOrEqual(12);
  expect(new Set(topics.map(topic => topic.id)).size).toBe(topics.length);
  const skills = store.list<SkillPackage>('skill');
  expect(skills.length).toBeGreaterThanOrEqual(8);
  const skillLibrary = createSkillLibrary({ directory, store, changed() {}, logger: createLogger({ dataDirectory: directory, component: 'runtime' }) });
  const selectedIds = [...new Set(dramaStylePresets.flatMap(style => style.skillIds))];
  const prepared = await skillLibrary.prepare(selectedIds);
  expect(prepared.length).toBe(selectedIds.length);
  for (const skill of prepared) {
    expect(skill.enabled).toBe(true); expect(skill.autoDiscover).toBe(false);
    expect(skill.referenceContents?.[skill.resources[0]]).toContain('原创练习');
    expect(skill.instructions).toContain(skill.resources[0]);
    expect(skill.tools).toEqual([]);
  }
  for (const definition of builtInDramaSkills) {
    const skill = skills.find(item => item.id === `builtin-drama-${definition.key}`)!;
    expect((await skillLibrary.readResource(skill.id, skill.resources[0])).content).toContain('制作卡');
  }
  const group = store.get<SkillGroup>('skill-group', 'builtin-drama-studio-skills')!;
  expect(group.skillIds).toEqual(skills.map(skill => skill.id));
  const before = JSON.stringify({ topics, skills, group });
  seedBuiltInDramaStudio(directory, store);
  expect(JSON.stringify({ topics: (library.dispatch('dramaTopic.list') as RecordPage<DramaTopic>).items, skills: store.list('skill'), group: store.get('skill-group', group.id) })).toBe(before);
  await skillLibrary.close();
});

it('adds missing built-ins on a version upgrade without replacing edited topics, disabled skills or user groups', async () => {
  const { directory, store, library } = await fixture();
  seedBuiltInDramaStudio(directory, store);
  const topic = dramaTopicSchema.parse(library.dispatch('dramaTopic.get', { topicId: builtInDramaTopics[0].id }));
  const modified = dramaTopicSchema.parse(library.dispatch('dramaTopic.save', { topic: { ...topic, title: '工作室自己的故事', description: '人工重写的故事。' } }));
  const archived = library.dispatch('dramaTopic.archive', { topicId: modified.id, revision: modified.revision });
  const skillId = `builtin-drama-${builtInDramaSkills[0].key}`, savedSkill = store.get<SkillPackage>('skill', skillId)!;
  const customSkill = { ...savedSkill, enabled: false, instructions: '工作室自己的编剧方法。' };
  store.put('skill', skillId, customSkill);
  const guidePath = join(directory, 'skills', skillId, savedSkill.resources[0]);
  await writeFile(guidePath, '人工保留的制作卡。', 'utf8');
  const group = store.get<SkillGroup>('skill-group', 'builtin-drama-studio-skills')!;
  const customGroup = { ...group, name: '我的创作方法', skillIds: [skillId] };
  store.put('skill-group', group.id, customGroup);
  store.delete('drama-topic', builtInDramaTopics[1].id);
  const missingSkillId = `builtin-drama-${builtInDramaSkills[1].key}`;
  store.delete('skill', missingSkillId);
  store.put('metadata', 'builtin-drama-studio', { version: 0 });
  seedBuiltInDramaStudio(directory, store);
  expect(library.dispatch('dramaTopic.get', { topicId: topic.id })).toEqual(archived);
  expect(store.get('drama-topic', builtInDramaTopics[1].id)).toBeDefined();
  expect(store.get('skill', skillId)).toEqual(customSkill);
  expect(await readFile(guidePath, 'utf8')).toBe('人工保留的制作卡。');
  expect(store.get<SkillPackage>('skill', missingSkillId)?.enabled).toBe(true);
  expect(store.get<SkillGroup>('skill-group', group.id)).toMatchObject({ name: customGroup.name, skillIds: [skillId, missingSkillId] });
  expect(store.get('metadata', 'builtin-drama-studio')).toEqual({ version: builtInDramaStudioVersion });
});
