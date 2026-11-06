import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  skillGroupSchema, skillImportJobSchema, skillImportSourceSchema,
  type SkillGroup, type SkillImportJob, type SkillImportSource, type SkillPackage,
} from '@video-quickly/contracts';
import type { DocumentStore } from './database.js';
import { importSkills } from './skills.js';
import { logError, type DiagnosticLogger } from './logging.js';

const timestamp = () => new Date().toISOString();
const readableExtensions = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.toml', '.py', '.js', '.mjs', '.cjs', '.ts', '.sh']);
function sourceGroup(source: SkillImportSource) {
  if (source.url) {
    const url = new URL(source.url), parts = url.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean);
    const identity = `https://github.com/${parts[0]}/${parts[1]}`;
    return { identity, name: parts[1], partial: Boolean(source.skillPath || parts[2] === 'tree' && parts.length > 4) };
  }
  const identity = resolve(source.path!);
  return { identity, name: basename(identity).replace(/\.zip$/i, ''), partial: Boolean(source.skillPath) };
}

export function createSkillLibrary({ store, directory, changed, logger }: { store: DocumentStore; directory: string; changed(): void; logger: DiagnosticLogger }) {
  const active = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  const importing = new Map<string, number>();
  let closing = false;
  function groups() { return store.list<SkillGroup>('skill-group'); }
  function jobs() { return store.list<SkillImportJob>('skill-import-job').reverse(); }
  function getJob(id: string) {
    const value = store.get<SkillImportJob>('skill-import-job', id);
    if (!value) throw new Error('Skill 导入记录不存在。');
    return value;
  }
  function saveJob(job: SkillImportJob) {
    const value = skillImportJobSchema.parse({ ...job, updatedAt: timestamp() });
    store.put('skill-import-job', value.id, value); changed(); return value;
  }
  for (const job of jobs()) if (job.status === 'queued' || job.status === 'running') {
    saveJob({ ...job, status: 'interrupted', error: '上次导入已中断，可重试。' });
  }

  async function importSource(source: SkillImportSource, name?: string, signal?: AbortSignal, onProgress?: (completed: number, total: number) => void) {
    const origin = sourceGroup(source);
    importing.set(origin.identity, (importing.get(origin.identity) ?? 0) + 1);
    try {
      const skills = await importSkills(source, directory, { signal, onProgress });
      signal?.throwIfAborted();
      if (new Set(skills.map(skill => skill.name)).size !== skills.length) throw new Error('导入来源包含同名 Skill，请分别提供对应目录。');
      const id = `skill-group-${createHash('sha256').update(origin.identity).digest('hex').slice(0, 20)}`;
      return store.database.transaction(() => {
        const previous = store.get<SkillGroup>('skill-group', id), importedNames = new Set(skills.map(skill => skill.name));
        const retained = origin.partial ? previous?.skillIds.filter(id => {
          const skill = store.get<SkillPackage>('skill', id); return skill && !importedNames.has(skill.name);
        }) ?? [] : [];
        const stored = skills.map(skill => {
          const existing = store.get<SkillPackage>('skill', skill.id);
          const value = existing ? { ...skill, enabled: existing.enabled, tools: skill.tools.map(tool => ({ ...tool, enabled: existing.tools.find(item => item.id === tool.id)?.enabled ?? false })) } : skill;
          store.put('skill', value.id, value); return value;
        });
        const time = timestamp();
        const group = skillGroupSchema.parse({ id, name: name ?? previous?.name ?? origin.name, source: origin.identity, skillIds: [...retained, ...stored.map(skill => skill.id)], createdAt: previous?.createdAt ?? time, updatedAt: time });
        store.put('skill-group', group.id, group);
        return { skills: stored, group };
      })();
    } finally {
      const count = (importing.get(origin.identity) ?? 1) - 1;
      if (count) importing.set(origin.identity, count); else importing.delete(origin.identity);
    }
  }

  function uninstall(skillId?: string, groupId?: string) {
    const currentGroups = groups(), group = currentGroups.find(item => item.id === groupId);
    const requested = new Set(groupId ? group?.skillIds ?? [] : skillId ? [skillId] : []);
    const shared = new Set(groupId ? currentGroups.filter(item => item.id !== groupId).flatMap(item => item.skillIds) : []);
    const removed = [...requested].filter(id => !shared.has(id) && store.get<SkillPackage>('skill', id));
    const affected = currentGroups.filter(item => item.id === groupId || item.skillIds.some(id => removed.includes(id)));
    if (affected.some(item => importing.has(item.source))) throw new Error('相关分组正在导入，请等待完成后再卸载。');
    const groupIds: string[] = [];
    store.database.transaction(() => {
      for (const id of removed) store.delete('skill', id);
      for (const item of affected) {
        const skillIds = item.skillIds.filter(id => !removed.includes(id));
        if (item.id === groupId || !skillIds.length) { store.delete('skill-group', item.id); groupIds.push(item.id); }
        else store.put('skill-group', item.id, { ...item, skillIds, updatedAt: timestamp() });
      }
      // Content-addressed resources remain available to saved and in-flight snapshots.
    })();
    if (removed.length || groupIds.length) changed();
    return { skillIds: removed, groupIds, retainedSkillIds: [...requested].filter(id => shared.has(id)) };
  }

  function schedule(job: SkillImportJob) {
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      const started = performance.now();
      logger.info('skill.import.started', { requestId: job.id });
      saveJob({ ...job, status: 'running', completed: 0, total: undefined, error: undefined });
      try {
        const result = await importSource(job.source, job.groupName, controller.signal, (completed, total) => {
          saveJob({ ...getJob(job.id), completed, total });
        });
        saveJob({ ...getJob(job.id), status: 'succeeded', groupId: result.group.id, skillIds: result.skills.map(skill => skill.id), completed: result.skills.length, total: result.skills.length, error: undefined });
        logger.info('skill.import.completed', { requestId: job.id, durationMs: Math.round(performance.now() - started) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        saveJob({ ...getJob(job.id), status: closing ? 'interrupted' : 'failed', error: closing ? '应用已退出，可重试导入。' : message });
        logger[closing ? 'info' : 'error']('skill.import.failed', { requestId: job.id, durationMs: Math.round(performance.now() - started), error: logError(error) });
      }
    }).finally(() => { active.delete(job.id); });
    active.set(job.id, { controller, promise });
  }

  function resolveSkills(ids: string[]) {
    const skills = [...new Set(ids)].map(id => {
      const skill = store.get<SkillPackage>('skill', id);
      if (!skill?.enabled) throw new Error('选用的 Skill 不存在或已停用，请重新选择。');
      return skill;
    });
    if (new Set(skills.map(skill => skill.name)).size !== skills.length) throw new Error('选用了同名 Skill 的多个版本，请保留需要的版本。');
    return skills;
  }
  async function readResource(skillId: string, path: string, limit?: number) {
    const skill = store.get<SkillPackage>('skill', skillId);
    if (!skill || !skill.resources.includes(path)) throw new Error('Skill 资源不存在。');
    if (!readableExtensions.has(extname(path).toLowerCase())) throw new Error('该资源不支持文本预览。');
    const root = resolve(directory, 'skills', skill.id), file = resolve(root, path), part = relative(root, file);
    if (isAbsolute(part) || part === '..' || part.startsWith('../') || part.startsWith('..\\')) throw new Error('Skill 资源路径越界。');
    const info = await lstat(file);
    const canonicalPart = relative(await realpath(root), await realpath(file));
    if (!info.isFile() || info.isSymbolicLink() || isAbsolute(canonicalPart) || canonicalPart === '..' || canonicalPart.startsWith('../') || canonicalPart.startsWith('..\\')) throw new Error('Skill 资源不是有效的本地文件。');
    if (limit === undefined && info.size > 500_000) throw new Error('该资源超过 500 KB，请查看本地文件。');
    const handle = await open(file, 'r');
    try {
      const bytes = new Uint8Array(Math.min(info.size, limit ?? 500_000));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0), truncated = info.size > bytesRead;
      return { path, content: new TextDecoder().decode(bytes.subarray(0, bytesRead), { stream: truncated }), truncated };
    } finally { await handle.close(); }
  }

  return {
    groups, jobs, resolveSkills,
    async prepare(ids: string[], options: { allowUnavailable?: boolean } = {}) {
      let remaining = 64_000;
      const result: SkillPackage[] = [];
      const selected = options.allowUnavailable ? [...new Set(ids)].flatMap(id => { const skill = store.get<SkillPackage>('skill', id); return skill ? [skill] : []; }) : resolveSkills(ids);
      for (const skill of selected) {
        if (!skill.enabled) { result.push(skill); continue; }
        const contents: Record<string, string> = {};
        for (const path of skill.resources.filter(path => !path.startsWith('scripts/') && readableExtensions.has(extname(path).toLowerCase()) && skill.instructions.includes(path))) {
          if (remaining <= 0) { contents[path] = '本资源未展开，可在 Skill 工作室查看。'; continue; }
          const { content, truncated } = await readResource(skill.id, path, Math.min(remaining, 8_000) * 4);
          const limit = Math.min(remaining, 8_000), excerpt = content.slice(0, limit);
          contents[path] = excerpt + (truncated || excerpt.length < content.length ? '\n[本资源后续内容未展开，可在 Skill 工作室查看。]' : '');
          remaining -= excerpt.length;
        }
        result.push(Object.keys(contents).length ? { ...skill, referenceContents: contents } : skill);
      }
      return result;
    },
    async import(source: SkillImportSource) {
      const result = await importSource(source); changed();
      return result.skills.length === 1 ? result.skills[0] : result;
    },
    readResource,
    dispatch(method: string, params: unknown) {
      if (closing) throw new Error('Skill 导入服务正在关闭。');
      if (method === 'skill.import.start') {
        const input = z.object({ source: skillImportSourceSchema, groupName: z.string().trim().min(1).max(120).optional(), requestId: z.string().uuid() }).parse(params);
        const existing = store.get<SkillImportJob>('skill-import-job', input.requestId);
        if (existing) {
          if (JSON.stringify(existing.source) !== JSON.stringify(input.source) || existing.groupName !== input.groupName) throw new Error('该导入标识已用于其他来源。');
          return existing;
        }
        const pending = jobs().find(job => ['queued', 'running'].includes(job.status) && JSON.stringify(job.source) === JSON.stringify(input.source) && job.groupName === input.groupName);
        if (pending) return pending;
        const time = timestamp(), job = saveJob({ id: input.requestId, source: input.source, groupName: input.groupName, status: 'queued', completed: 0, skillIds: [], createdAt: time, updatedAt: time });
        schedule(job); return job;
      }
      if (method === 'skill.import.get') return getJob(z.object({ id: z.string().uuid() }).parse(params).id);
      if (method === 'skill.import.list') return jobs();
      if (method === 'skill.import.retry') {
        const job = getJob(z.object({ id: z.string().uuid() }).parse(params).id);
        if (active.has(job.id)) return job;
        if (job.status === 'succeeded') throw new Error('该导入已经完成。');
        const next = saveJob({ ...job, status: 'queued', error: undefined }); schedule(next); return next;
      }
      if (method === 'skill.group.update') {
        const input = z.object({ id: z.string().min(1), name: z.string().trim().min(1).max(120) }).parse(params);
        const group = store.get<SkillGroup>('skill-group', input.id);
        if (!group) throw new Error('Skill 分组不存在。');
        const value = { ...group, name: input.name, updatedAt: timestamp() };
        store.put('skill-group', value.id, value); changed(); return value;
      }
      if (method === 'skill.group.toggle') {
        const input = z.object({ id: z.string().min(1), enabled: z.boolean() }).parse(params);
        const group = store.get<SkillGroup>('skill-group', input.id);
        if (!group) throw new Error('Skill 分组不存在。');
        const skills = store.database.transaction(() => group.skillIds.flatMap(id => {
          const skill = store.get<SkillPackage>('skill', id);
          if (!skill) return [];
          const value = { ...skill, enabled: input.enabled }; store.put('skill', id, value); return [value];
        }))();
        changed(); return { group, skills };
      }
      if (method === 'skill.uninstall') return uninstall(z.object({ skillId: z.string().min(1) }).parse(params).skillId);
      if (method === 'skill.group.uninstall') return uninstall(undefined, z.object({ id: z.string().min(1) }).parse(params).id);
      if (method === 'skill.resource.read') {
        const input = z.object({ skillId: z.string().min(1), path: z.string().min(1) }).parse(params); return readResource(input.skillId, input.path);
      }
      throw new Error('未知 Skill 操作。');
    },
    async waitForIdle() { while (active.size) await Promise.all([...active.values()].map(item => item.promise)); },
    async close() {
      closing = true;
      for (const item of active.values()) item.controller.abort();
      await Promise.all([...active.values()].map(item => item.promise));
    },
  };
}
