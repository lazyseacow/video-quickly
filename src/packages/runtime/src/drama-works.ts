import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { characterProfileSchema, dramaEpisodeSchema, dramaStylePresets, dramaTopicSchema, dramaWorkInputSchema, dramaWorkSchema, pageInputSchema, projectSummarySchema, type DramaEpisode, type DramaWork, type ProjectDocument, type ProjectSummary, type RecordPage, type SkillPackage } from '@video-quickly/contracts';
import type { DocumentStore } from './database.js';

const identity = z.object({ workId: z.string().min(1) });
export const createDramaEpisodeInput = dramaEpisodeSchema.partial({ visualStyle: true, narrativeMode: true, scenes: true });

export function createDramaWorkLibrary({ database, store, changed }: { database: Database.Database; store: DocumentStore; changed(): void }) {
  function get(id: string): DramaWork {
    const value = store.get('drama-work', id);
    if (!value) throw new Error('短剧作品不存在。');
    return dramaWorkSchema.parse(value);
  }
  function requireCharacters(work: DramaWork) {
    for (const id of work.characterIds) {
      const profile = characterProfileSchema.safeParse(store.get('character', id));
      if (!profile.success || profile.data.archived) throw new Error('作品角色须来自有效的公共角色库。');
    }
    for (const id of work.topicIds) {
      const topic = dramaTopicSchema.safeParse(store.get('drama-topic', id));
      if (!topic.success || topic.data.archived) throw new Error('作品选题不存在或已归档，请重新选择。');
    }
    const style = dramaStylePresets.find(style => style.id === work.stylePresetId);
    if (work.stylePresetId && !style) throw new Error('作品画风不存在，请重新选择。');
    if (style && work.visualStyle !== 'mixed' && style.visualStyle !== work.visualStyle) throw new Error('作品视觉类型与所选画风不一致，请重新选择画风。');
    for (const id of selectedSkillIds(work)) {
      if (!store.get<SkillPackage>('skill', id)?.enabled) throw new Error('作品选用的 Skill 不存在或已停用，请重新选择。');
    }
  }
  function selectedSkillIds(work: DramaWork) {
    return work.skillIds;
  }
  function validateProject(value: ProjectDocument, previous?: ProjectDocument) {
    if (previous?.drama && previous.drama.workId !== value.drama?.workId) throw new Error('分集的作品归属不能通过项目编辑更改。');
    if (!value.drama) return;
    const work = get(value.drama.workId);
    if (work.archived && previous?.drama?.workId !== work.id) throw new Error('作品已归档，请恢复后再添加分集。');
    const duplicate = database.prepare("SELECT id FROM documents WHERE kind = 'project' AND json_extract(body, '$.drama.workId') = ? AND json_extract(body, '$.drama.number') = ? AND id != ? LIMIT 1").get(work.id, value.drama.number, value.id);
    if (duplicate) throw new Error(`作品已存在第 ${value.drama.number} 集，请选择其他集数。`);
  }
  return {
    get,
    create(raw: z.input<typeof dramaWorkInputSchema>): DramaWork {
      const input = dramaWorkInputSchema.omit({ id: true, revision: true }).parse(raw), time = new Date().toISOString();
      const work = dramaWorkSchema.parse({ ...input, id: randomUUID(), revision: 1, createdAt: time, updatedAt: time, archived: false });
      requireCharacters(work); store.put('drama-work', work.id, work); return work;
    },
    forCreation(raw: z.input<typeof createDramaEpisodeInput>): { drama: DramaEpisode; characterIds: string[]; brief: string; style: string; skillIds: string[] } {
      const input = createDramaEpisodeInput.parse(raw), work = get(input.workId);
      if (work.archived) throw new Error('作品已归档，请恢复后再添加分集。');
      requireCharacters(work);
      const topics = work.topicIds.map(id => dramaTopicSchema.parse(store.get('drama-topic', id)));
      const visualStyle = input.visualStyle ?? work.visualStyle;
      const preset = dramaStylePresets.find(style => style.id === work.stylePresetId);
      const brief = [`作品：${work.title}`, work.description, ...topics.map(topic => `选题：${topic.title}\n故事梗概：${topic.logline}\n${topic.description}\n题材：${topic.tags.join('、')}`)].filter(Boolean).join('\n\n');
      if (brief.length > 30000) throw new Error('作品和选题的创作要求合计超过 30000 个字符，请精简后再新建分集。');
      return { drama: dramaEpisodeSchema.parse({ ...input, visualStyle, narrativeMode: input.narrativeMode ?? work.narrativeMode, scenes: input.scenes ?? [] }), characterIds: work.characterIds,
        brief, style: preset && (visualStyle === 'mixed' || preset.visualStyle === visualStyle) ? preset.prompt : '', skillIds: selectedSkillIds(work) };
    },
    validateProject,
    dispatch(method: string, raw: unknown = {}): DramaWork | RecordPage<DramaWork> | ProjectSummary[] {
      switch (method) {
        case 'dramaWork.get': return get(identity.parse(raw).workId);
        case 'dramaWork.list': {
          const input = pageInputSchema.extend({ archived: z.boolean().default(false), search: z.string().trim().max(200).default('') }).parse(raw);
          const rows = database.prepare("SELECT rowid AS cursor, body FROM documents WHERE kind = 'drama-work' AND coalesce(json_extract(body, '$.archived'), 0) = ? AND (? IS NULL OR rowid < ?) AND (? = '' OR instr(lower(json_extract(body, '$.title')), lower(?)) > 0 OR instr(lower(json_extract(body, '$.description')), lower(?)) > 0) ORDER BY rowid DESC LIMIT ?").all(Number(input.archived), input.before ?? null, input.before ?? null, input.search, input.search, input.search, input.limit + 1) as { cursor: number; body: string }[];
          return { items: rows.slice(0, input.limit).map(row => dramaWorkSchema.parse(JSON.parse(row.body))), nextCursor: rows.length > input.limit ? rows[input.limit - 1].cursor : null };
        }
        case 'dramaWork.episodes': {
          const { workId } = identity.parse(raw); get(workId);
          const rows = database.prepare("SELECT summary.body FROM documents project JOIN documents summary ON summary.kind = 'project-summary' AND summary.id = project.id WHERE project.kind = 'project' AND json_extract(project.body, '$.drama.workId') = ? ORDER BY json_extract(project.body, '$.drama.number'), project.rowid").all(workId) as { body: string }[];
          return rows.map(row => projectSummarySchema.parse(JSON.parse(row.body)));
        }
        case 'dramaWork.save': {
          const { work } = z.object({ work: dramaWorkInputSchema }).parse(raw);
          const value = database.transaction(() => {
            const previous = work.id ? get(work.id) : undefined;
            if (previous && previous.revision !== work.revision) throw new Error('作品已在其他视图修改，请刷新后重新保存。');
            if (previous?.archived) throw new Error('作品已归档，请恢复后再编辑。');
            const time = new Date().toISOString();
            const next = dramaWorkSchema.parse({ ...previous, ...work, stylePresetId: work.stylePresetId, id: previous?.id ?? randomUUID(), revision: previous ? previous.revision + 1 : 1, createdAt: previous?.createdAt ?? time, updatedAt: time, archived: false });
            requireCharacters(next); store.put('drama-work', next.id, next); return next;
          }).immediate();
          changed(); return value;
        }
        case 'dramaWork.archive':
        case 'dramaWork.restore': {
          const input = identity.extend({ revision: z.number().int().positive() }).parse(raw);
          const value = database.transaction(() => {
            const previous = get(input.workId);
            if (previous.revision !== input.revision) throw new Error('作品已在其他视图修改，请刷新后重新保存。');
            const next = { ...previous, archived: method === 'dramaWork.archive', revision: previous.revision + 1, updatedAt: new Date().toISOString() };
            if (!next.archived) requireCharacters(next);
            store.put('drama-work', next.id, next); return next;
          }).immediate();
          changed(); return value;
        }
        default: throw new Error(`未知短剧作品方法：${method}`);
      }
    },
  };
}
