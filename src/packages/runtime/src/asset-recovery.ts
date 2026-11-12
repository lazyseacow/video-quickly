import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { assetSchema, type AssetRecord } from '@video-quickly/contracts';
import {
  assetRecoveryCancelSchema, assetRecoveryConfirmSchema, assetRecoveryGetSchema, assetRecoveryJobSchema, assetRecoveryScanSchema,
  assetRecoveryStartSchema, assetRecoveryItemSchema,
  type AssetRecoveryExpected, type AssetRecoveryItem, type AssetRecoveryJob, type AssetRecoverySource,
} from '@video-quickly/contracts';
import { hashFileSha256 } from './file-hash.js';
import type { DocumentStore } from './database.js';
import { projectFilesPurgedKind } from './project-file-cleanup.js';

export interface AssetRecoveryOptions {
  directory: string;
  store: DocumentStore;
  onRestored?: (assetIds: string[]) => void;
  failpoint?: (point: 'scan:file' | 'repair:opened' | 'repair:staged' | 'repair:before-publish' | 'repair:published', context: { jobId: string; itemId?: string; path: string }) => void | Promise<void>;
}
const stagedSchema = z.object({ itemId: z.string(), itemIds: z.array(z.string()).optional(), attempt: z.string().uuid().optional(), temporary: z.string(), destination: z.string(), dev: z.string().optional(), ino: z.string().optional(), published: z.boolean() });
const savedSchema = z.object({ version: z.literal(1), job: assetRecoveryJobSchema, items: z.array(assetRecoveryItemSchema), staged: z.array(stagedSchema), abandoned: z.array(stagedSchema).default([]), selection: z.string().optional() });
type SavedJob = z.infer<typeof savedSchema>;
type StagedFile = z.infer<typeof stagedSchema>;
const timestamp = () => new Date().toISOString();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const code = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
function inside(root: string, path: string) { const part = relative(root, path); return part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part); }
function expected(asset: AssetRecord): AssetRecoveryExpected {
  const { id, path, sha256, size, version, kind, projectId, shotId } = asset;
  return { id, path, sha256, size, version, kind, ...(projectId === undefined ? {} : { projectId }), ...(shotId === undefined ? {} : { shotId }) };
}
const identity = (asset: AssetRecoveryExpected) => JSON.stringify(asset);
const itemId = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const values = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Restores identical bytes to recorded managed paths. It never rewrites asset or frozen document identities. */
export function createAssetRecovery(options: AssetRecoveryOptions) {
  const logicalRoot = resolve(options.directory), jobs = new Map<string, SavedJob>();
  const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  let root = '', closing = false;
  function save(record: SavedJob) { record.job.updatedAt = timestamp(); options.store.put('asset-recovery-job', record.job.id, record); }
  function warning(record: SavedJob, path: string, text: string) { record.job.warningCount++; if (record.job.warnings.length < 100) record.job.warnings.push({ path, message: text }); }
  function get(id: string) { const record = jobs.get(id); if (!record) throw new Error('素材恢复任务不存在。'); return record; }
  async function pathFor(path: string, create = false, created?: string[]): Promise<string> {
    if (!isAbsolute(path) || path.includes('\0') || path.length > 32_768) throw new Error('素材路径无效。');
    const absolute = resolve(path), base = inside(logicalRoot, absolute) ? logicalRoot : root;
    if (!inside(base, absolute)) throw new Error('素材路径位于当前工作区之外。');
    const parts = relative(base, absolute).split(sep);
    if (parts.length < 4 || parts[0] !== 'projects' || !['assets', 'activities'].includes(parts[2])) throw new Error('素材不在受管的项目素材或执行产物目录内。');
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      directory = join(directory, part);
      let info = await lstat(directory).catch(error => { if (code(error) === 'ENOENT') return undefined; throw error; });
      if (!info && create) {
        try { await mkdir(directory); created?.push(directory); } catch (error) { if (code(error) !== 'EEXIST') throw error; }
        info = await lstat(directory);
      }
      if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error('素材父路径包含链接或非目录，无法安全恢复。');
      if (info && !inside(root, await realpath(directory))) throw new Error('素材父路径越过当前工作区。');
    }
    return join(directory, parts.at(-1)!);
  }
  async function health(item: AssetRecoveryItem, signal: AbortSignal) {
    const value = item.expected; if (!value) return;
    if (!/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.size)) { item.status = 'invalid_metadata'; item.detail = '素材缺少有效的完整 SHA-256 或字节长度，无法自动匹配。'; return; }
    let destination: string;
    try { destination = await pathFor(value.path); }
    catch (error) { item.status = ['EACCES', 'EPERM'].includes(code(error) ?? '') ? 'unreadable' : 'unsafe_path'; item.detail = message(error); return; }
    try {
      const info = await lstat(destination);
      if (!info.isFile() || info.isSymbolicLink()) { item.status = 'unsafe_path'; item.detail = '素材位置是链接或非普通文件，未自动替换。'; return; }
      signal.throwIfAborted();
      const hash = await hashFileSha256(destination, signal);
      item.status = info.size === value.size && hash === value.sha256 ? 'available' : 'content_mismatch';
      item.detail = item.status === 'available' ? undefined : '原位置已有异内容文件；自动恢复不会覆盖它。';
    } catch (error) {
      signal.throwIfAborted(); item.status = code(error) === 'ENOENT' ? 'missing' : 'unreadable'; item.detail = item.status === 'missing' ? '原受管文件缺失，可扫描目录查找相同内容。' : `无法读取素材：${message(error)}`;
    }
  }
  function collect(projectId?: string): AssetRecoveryItem[] {
    const result = new Map<string, AssetRecoveryItem>(), current = options.store.list<unknown>('asset');
    const currentIds = new Set(current.map(value => object(value).id));
    const purgedProjects = new Set(options.store.database.prepare('SELECT id FROM documents WHERE kind = ?').pluck().all(projectFilesPurgedKind));
    if (projectId && !options.store.database.prepare("SELECT 1 FROM documents WHERE kind = 'project' AND id = ?").get(projectId)) throw new Error('项目不存在，无法检查其素材。');
    const projectReferences = options.store.database.prepare('SELECT project_id, asset_id FROM project_asset_references WHERE (? IS NULL OR project_id = ?)').all(projectId ?? null, projectId ?? null) as { project_id: string; asset_id: string }[];
    const needed = new Set(projectReferences.map(row => row.asset_id));
    const characterRows = projectId ? options.store.database.prepare("SELECT character.value AS id FROM documents project, json_each(project.body, '$.shots') shot, json_each(shot.value, '$.characterIds') character WHERE project.kind = 'project' AND project.id = ? UNION SELECT character.value AS id FROM documents project, json_each(project.body, '$.creativeContext.characterIds') character WHERE project.kind = 'project' AND project.id = ?").all(projectId, projectId) as { id: string }[] : [];
    const characterIds = new Set(characterRows.map(row => row.id));
    const profiles = options.store.list<unknown>('character').filter(value => !projectId || characterIds.has(String(object(value).id)));
    for (const profile of profiles) for (const id of values(object(profile).referenceAssetIds)) if (typeof id === 'string') needed.add(id);
    function add(raw: unknown, source: AssetRecoverySource) {
      const parsed = assetSchema.safeParse(raw), metadata = object(raw), id = typeof metadata.id === 'string' ? metadata.id : `invalid:${source.kind}:${source.id}`;
      if (parsed.success && purgedProjects.has(parsed.data.projectId) && !currentIds.has(id)) return;
      const value = parsed.success ? expected(parsed.data) : null, key = value ? identity(value) : `invalid:${id}`;
      let item = result.get(key);
      if (!item) { item = { id: itemId(key), assetId: id, name: typeof metadata.name === 'string' ? metadata.name : id, expected: value, sources: [], status: value ? 'pending' : 'invalid_metadata', detail: value ? undefined : '素材记录缺少恢复所需的路径、摘要或版本信息。', candidates: [], additionalCandidates: 0 }; result.set(key, item); }
      if (!item.sources.some(previous => JSON.stringify(previous) === JSON.stringify(source))) item.sources.push(source);
    }
    for (const raw of current) { const asset = object(raw); if (!projectId || asset.projectId === projectId || needed.has(String(asset.id))) add(raw, { kind: 'asset', id: String(asset.id), ...(typeof asset.active === 'boolean' ? { active: asset.active } : {}) }); }
    const rows = options.store.database.prepare("SELECT snapshot.kind, snapshot.id, asset.value AS body FROM documents snapshot, json_each(snapshot.body, '$.assets') asset WHERE snapshot.kind IN ('run-snapshot','export-batch-snapshot','node-result') AND (? IS NULL OR json_extract(snapshot.body, '$.project.id') = ? OR (snapshot.kind = 'node-result' AND json_extract(asset.value, '$.projectId') = ?)) UNION ALL SELECT snapshot.kind, snapshot.id, asset.value AS body FROM documents snapshot, json_each(snapshot.body, '$.characterAssets') asset WHERE snapshot.kind IN ('run-snapshot','export-batch-snapshot') AND (? IS NULL OR json_extract(snapshot.body, '$.project.id') = ?)").all(projectId ?? null, projectId ?? null, projectId ?? null, projectId ?? null, projectId ?? null) as { kind: 'run-snapshot' | 'export-batch-snapshot' | 'node-result'; id: string; body: string }[];
    for (const row of rows) add(JSON.parse(row.body), { kind: row.kind, id: row.id });
    for (const id of needed) {
      const matches = [...result.values()].filter(item => item.assetId === id);
      const sources: AssetRecoverySource[] = projectReferences.filter(row => row.asset_id === id).map(row => ({ kind: 'project', id: row.project_id }));
      if (!sources.length) sources.push({ kind: 'character', id: 'reference-library' });
      for (const source of sources) { if (!matches.length) add({ id, name: id }, source); else for (const item of matches) item.sources.push(source); }
    }
    for (const profile of profiles) for (const id of values(object(profile).referenceAssetIds)) for (const item of result.values()) if (item.assetId === id) item.sources.push({ kind: 'character', id: String(object(profile).id) });
    return [...result.values()];
  }
  async function inspect(record: SavedJob, signal: AbortSignal) {
    record.items = collect(record.job.projectId); record.job.progress = { checked: 0, total: record.items.length, scanned: 0, hashed: 0, restored: 0 };
    // Polling reads live progress; phase boundaries persist the full list without quadratic rewrites.
    for (const item of record.items) { signal.throwIfAborted(); await health(item, signal); record.job.progress.checked++; }
    const byPath = new Map<string, AssetRecoveryItem[]>();
    for (const item of record.items) if (item.expected && !['unsafe_path', 'unreadable', 'invalid_metadata'].includes(item.status)) { const path = resolve(item.expected.path), key = process.platform === 'win32' ? path.toLowerCase() : path; const list = byPath.get(key) ?? []; list.push(item); byPath.set(key, list); }
    for (const list of byPath.values()) if (new Set(list.map(item => `${item.expected!.sha256}:${item.expected!.size}`)).size > 1) for (const item of list) { item.status = 'conflict'; item.detail = '当前记录与历史快照要求同一路径包含不同内容，不能自动替换任一版本。'; }
  }
  async function sourceFile(path: string, sourceRoot: string) {
    if (!inside(sourceRoot, path)) throw new Error('候选文件越过已选择的扫描目录。');
    let part = sourceRoot;
    for (const name of relative(sourceRoot, path).split(sep).filter(Boolean)) { part = join(part, name); if ((await lstat(part)).isSymbolicLink()) throw new Error('候选路径包含符号链接或 junction。'); }
    const canonical = await realpath(path); if (!inside(sourceRoot, canonical) || !(await stat(canonical)).isFile()) throw new Error('候选不是扫描目录内的普通文件。'); return canonical;
  }
  async function scan(record: SavedJob, directory: string, signal: AbortSignal) {
    await cleanupStaging(record);
    if (record.staged.length) throw new Error('上次恢复暂存文件尚未清理，请检查目标目录权限后重试。');
    await inspect(record, signal);
    const selectedRoot = await realpath(resolve(directory)); if (!(await stat(selectedRoot)).isDirectory()) throw new Error('请选择可读取的扫描目录。');
    record.job.directory = selectedRoot; record.job.phase = 'scanning'; save(record);
    const sizes = new Set(record.items.filter(item => item.status === 'missing').map(item => item.expected!.size));
    const stack = [selectedRoot];
    while (stack.length) {
      signal.throwIfAborted(); const folder = stack.pop()!;
      try {
        if (folder !== selectedRoot && (await lstat(folder)).isSymbolicLink()) throw new Error('扫描跳过符号链接或 junction。');
        const canonical = await realpath(folder); if (!inside(selectedRoot, canonical)) throw new Error('扫描目录已越界。');
        const entries = await opendir(canonical);
        for await (const entry of entries) {
          signal.throwIfAborted(); const path = join(canonical, entry.name);
          if (entry.isSymbolicLink()) { warning(record, path, '扫描跳过符号链接或 junction。'); continue; }
          if (entry.isDirectory()) { stack.push(path); continue; }
          if (!entry.isFile()) continue;
          record.job.progress.scanned++;
          try {
            const info = await stat(path); if (!sizes.has(info.size)) continue;
            await options.failpoint?.('scan:file', { jobId: record.job.id, path }); signal.throwIfAborted();
            const source = await sourceFile(path, selectedRoot), hash = await hashFileSha256(source, signal); record.job.progress.hashed++;
            const candidate = { id: randomUUID(), path: source, size: info.size, sha256: hash };
            for (const item of record.items) if (item.status === 'missing' && item.expected?.sha256 === hash && item.expected.size === info.size) {
              if (item.candidates.length < 8) item.candidates.push(candidate); else item.additionalCandidates++;
            }
          } catch (error) { signal.throwIfAborted(); warning(record, path, message(error)); }
        }
      } catch (error) { signal.throwIfAborted(); warning(record, folder, message(error)); }
    }
    record.job.phase = 'awaiting_confirmation';
  }
  function assertIdentity(item: AssetRecoveryItem, history?: Map<string, Set<string>>) {
    if (!item.expected) throw new Error('素材缺少恢复身份。');
    if (item.expected.projectId && options.store.get(projectFilesPurgedKind, item.expected.projectId) && !options.store.get('asset', item.expected.id)) throw new Error('该项目的本地素材已彻底删除。');
    for (const source of item.sources) {
      if (source.kind === 'asset') {
        const value = options.store.get<AssetRecord>('asset', source.id);
        if (!value || identity(expected(value)) !== identity(item.expected) || source.active !== undefined && value.active !== source.active) throw new Error('确认期间素材身份已变化，请重新检查。');
      } else if (history && ['run-snapshot', 'export-batch-snapshot', 'node-result'].includes(source.kind)) {
        const key = JSON.stringify([source.kind, source.id]);
        let identities = history.get(key);
        if (!identities) {
          const rows = options.store.database.prepare("SELECT asset.value AS body FROM documents snapshot, json_each(snapshot.body, '$.assets') asset WHERE snapshot.kind = ? AND snapshot.id = ? UNION ALL SELECT asset.value AS body FROM documents snapshot, json_each(snapshot.body, '$.characterAssets') asset WHERE snapshot.kind = ? AND snapshot.id = ?").all(source.kind, source.id, source.kind, source.id) as { body: string }[];
          identities = new Set(rows.flatMap(row => { const parsed = assetSchema.safeParse(JSON.parse(row.body)); return parsed.success ? [identity(expected(parsed.data))] : []; })); history.set(key, identities);
        }
        if (!identities.has(identity(item.expected))) throw new Error('确认期间历史素材身份已变化，请重新检查。');
      }
    }
  }
  function assertIdentities(items: AssetRecoveryItem[]) {
    // Frozen documents are checked once per batch boundary, without a cross-request cache.
    const history = new Map<string, Set<string>>(); for (const item of items) assertIdentity(item, history);
  }
  async function temporaryPath(record: SavedJob, staged: StagedFile) {
    const destination = await pathFor(staged.destination);
    const required = join(dirname(destination), `.recovery-${record.job.id}-${staged.itemId}${staged.attempt ? `-${staged.attempt}` : ''}.part`);
    if (required !== staged.temporary) throw new Error('恢复暂存文件归属无效。');
    return required;
  }
  async function removeTemporary(record: SavedJob, staged: StagedFile) {
    const required = await temporaryPath(record, staged);
    const info = await lstat(required, { bigint: true }).catch(error => { if (code(error) === 'ENOENT') return undefined; throw error; });
    if (!info) return;
    if (info.isSymbolicLink() || String(info.dev) !== staged.dev || String(info.ino) !== staged.ino) throw new Error('恢复暂存文件已被其他操作替换，未自动删除。');
    await unlink(required);
  }
  async function cleanupStaging(record: SavedJob) {
    const remaining: StagedFile[] = [], abandoned: StagedFile[] = [];
    for (const staged of [...record.abandoned, ...record.staged]) {
      try {
        if (staged.dev === undefined || staged.ino === undefined) {
          const path = await temporaryPath(record, staged), info = await lstat(path).catch(error => { if (code(error) === 'ENOENT') return undefined; throw error; });
          if (info) { abandoned.push(staged); warning(record, path, '上次创建的暂存文件未完成归属记录，已保留供核对；继续恢复使用新的暂存文件。'); }
        } else await removeTemporary(record, staged);
      } catch (error) { if (staged.dev === undefined || staged.ino === undefined) abandoned.push(staged); else remaining.push(staged); warning(record, staged.temporary, `恢复暂存清理未完成：${message(error)}`); }
    }
    record.staged = remaining; record.abandoned = abandoned;
  }
  function stagedItems(record: SavedJob, staged: StagedFile) {
    return (staged.itemIds ?? [staged.itemId]).map(id => record.items.find(item => item.id === id)!);
  }
  async function verifiedOwnedFile(record: SavedJob, staged: StagedFile, path: string, signal?: AbortSignal) {
    const info = await lstat(path, { bigint: true }).catch(error => { if (code(error) === 'ENOENT') return undefined; throw error; });
    const value = stagedItems(record, staged)[0].expected!;
    return Boolean(info?.isFile() && !info.isSymbolicLink() && String(info.dev) === staged.dev && String(info.ino) === staged.ino && info.size === BigInt(value.size) && await hashFileSha256(path, signal) === value.sha256);
  }
  async function rollback(record: SavedJob) {
    const remaining: StagedFile[] = [];
    for (const staged of [...record.staged].reverse()) {
      try {
        if (staged.published) {
          const target = await pathFor(record.items.find(item => item.id === staged.itemId)!.expected!.path);
          const info = await lstat(target).catch(error => { if (code(error) === 'ENOENT') return undefined; throw error; });
          if (info && await verifiedOwnedFile(record, staged, target)) await unlink(target);
          else if (info) warning(record, target, '目标的归属或内容已被其他操作改变，回滚未删除它。');
        }
        await removeTemporary(record, staged);
      } catch (error) { if (staged.dev === undefined || staged.ino === undefined) record.abandoned.push(staged); else remaining.push(staged); warning(record, staged.destination, `恢复回滚未完成：${message(error)}`); }
      const item = stagedItems(record, staged)[0];
      try {
        const target = await pathFor(item.expected!.path), info = await lstat(target, { bigint: true }).catch(error => { if (code(error) === 'ENOENT') return undefined; throw error; });
        if (!info) { item.status = 'missing'; item.detail = '本次恢复已回滚，原文件仍缺失。'; }
        else if (await verifiedOwnedFile(record, staged, target)) { item.status = 'restored'; item.detail = '已验证文件尚未完成回滚，请重新检查恢复状态。'; }
        else { item.status = 'conflict'; item.detail = '目标在恢复期间被其他操作写入，未覆盖或删除它。'; }
      } catch (error) { item.status = 'unreadable'; item.detail = `回滚后无法检查目标：${message(error)}`; }
      for (const alias of stagedItems(record, staged).slice(1)) { alias.status = item.status; alias.detail = item.detail; }
    }
    record.staged = remaining; record.job.progress.restored = 0;
  }
  async function repair(record: SavedJob, selections: Array<{ itemId: string; candidateId: string }>, signal: AbortSignal) {
    const selected = selections.map(selection => {
      const item = record.items.find(item => item.id === selection.itemId), candidate = item?.candidates.find(candidate => candidate.id === selection.candidateId);
      if (!item?.expected || !candidate || candidate.sha256 !== item.expected.sha256 || candidate.size !== item.expected.size) throw new Error('候选不属于当前素材恢复任务。');
      return { item, candidate };
    });
    if (new Set(selected.map(({ item }) => item.id)).size !== selected.length) throw new Error('不能重复确认同一素材。');
    await cleanupStaging(record);
    if (record.staged.length) throw new Error('上次恢复暂存文件尚未清理，请检查目标目录权限后重试。');
    const created: string[] = [];
    try {
      assertIdentities(selected.map(({ item }) => item));
      for (const { item } of selected) { await health(item, signal); if (!['missing', 'available'].includes(item.status)) throw new Error(item.detail ?? '原素材位置不可恢复。'); }
      const physical = new Map<string, { destination: string; entries: typeof selected }>();
      for (const entry of selected) {
        if (entry.item.status === 'available') continue;
        const destination = await pathFor(entry.item.expected!.path, true, created), path = process.platform === 'win32' ? destination.toLowerCase() : destination;
        const key = JSON.stringify([path, entry.item.expected!.sha256, entry.item.expected!.size]), group = physical.get(key);
        if (group) group.entries.push(entry); else physical.set(key, { destination, entries: [entry] });
      }
      for (const { destination, entries } of physical.values()) {
        signal.throwIfAborted(); const { item, candidate } = entries[0];
        // Every chosen candidate is rechecked, even when several identities share one destination.
        for (const alias of entries.slice(1)) {
          const source = await sourceFile(alias.candidate.path, record.job.directory!), info = await stat(source);
          if (info.size !== alias.item.expected!.size || await hashFileSha256(source, signal) !== alias.item.expected!.sha256) throw new Error('候选内容已变化或校验失败，请重新扫描。');
          await sourceFile(alias.candidate.path, record.job.directory!);
        }
        const attempt = randomUUID(), temporary = join(dirname(destination), `.recovery-${record.job.id}-${item.id}-${attempt}.part`);
        const source = await sourceFile(candidate.path, record.job.directory!);
        // Persist intent before exclusive creation. An interruption cannot make its filename block a later attempt.
        const staged: StagedFile = { itemId: item.id, itemIds: entries.map(entry => entry.item.id), attempt, destination, temporary, published: false };
        record.staged.push(staged); save(record);
        const handle = await open(temporary, 'wx');
        const hash = createHash('sha256'); let size = 0;
        try {
          await options.failpoint?.('repair:opened', { jobId: record.job.id, itemId: item.id, path: temporary });
          const info = await handle.stat({ bigint: true }); staged.dev = String(info.dev); staged.ino = String(info.ino); save(record);
          for await (const chunk of createReadStream(source, { signal })) {
            signal.throwIfAborted(); hash.update(chunk); size += chunk.length;
            let offset = 0; while (offset < chunk.length) { const result = await handle.write(chunk, offset, chunk.length - offset); if (!result.bytesWritten) throw new Error('恢复暂存写入未取得进展。'); offset += result.bytesWritten; }
          }
          await handle.sync();
        } finally { await handle.close(); }
        if (size !== item.expected!.size || hash.digest('hex') !== item.expected!.sha256) throw new Error('候选内容已变化或校验失败，请重新扫描。');
        await sourceFile(candidate.path, record.job.directory!);
        await options.failpoint?.('repair:staged', { jobId: record.job.id, itemId: item.id, path: temporary }); signal.throwIfAborted();
      }
      for (const staged of record.staged) {
        signal.throwIfAborted(); const item = record.items.find(item => item.id === staged.itemId)!;
        await options.failpoint?.('repair:before-publish', { jobId: record.job.id, itemId: item.id, path: staged.destination }); signal.throwIfAborted();
        for (const alias of stagedItems(record, staged)) assertIdentity(alias);
        const destination = await pathFor(item.expected!.path);
        const temporary = await temporaryPath(record, staged), info = await lstat(temporary, { bigint: true });
        if (!info.isFile() || info.isSymbolicLink() || String(info.dev) !== staged.dev || String(info.ino) !== staged.ino || info.size !== BigInt(item.expected!.size) || await hashFileSha256(temporary, signal) !== item.expected!.sha256) throw new Error('恢复暂存文件校验失败或已被替换，请重新扫描。');
        // A same-directory hard link publishes verified bytes without replacing an existing destination.
        await link(temporary, destination); staged.published = true;
        for (const alias of stagedItems(record, staged)) { alias.status = 'restored'; alias.detail = undefined; record.job.progress.restored++; }
        save(record);
        await options.failpoint?.('repair:published', { jobId: record.job.id, itemId: item.id, path: destination });
      }
      signal.throwIfAborted();
      for (const staged of record.staged) await removeTemporary(record, staged);
      for (const staged of record.staged) if (!await verifiedOwnedFile(record, staged, await pathFor(stagedItems(record, staged)[0].expected!.path), signal)) throw new Error('恢复目标在提交前发生变化，未确认恢复成功。');
      assertIdentities(selected.map(({ item }) => item)); signal.throwIfAborted();
      const committed = record.staged; record.staged = []; record.job.phase = 'succeeded';
      try { save(record); } catch (error) { record.staged = committed; throw error; }
      options.onRestored?.([...new Set(selected.map(({ item }) => item.assetId))]);
    } catch (error) { await rollback(record); throw error; }
    finally { for (const directory of [...created].reverse()) await rmdir(directory).catch(() => { /* Only empty directories created by this task may be removed. */ }); }
  }
  function schedule(record: SavedJob, work: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => work(controller.signal)).catch(error => { record.job.phase = controller.signal.aborted ? 'canceled' : 'failed'; record.job.error = message(error); }).finally(() => {
      try { save(record); }
      catch (error) { record.job.phase = 'failed'; record.job.error = `${record.job.error ? `${record.job.error}；` : ''}任务状态写入失败：${message(error)}。请检查工作区存储后重新检查。`; }
      finally { active.delete(record.job.id); }
    });
    active.set(record.job.id, { controller, promise });
  }
  const ready = (async () => {
    root = await realpath(logicalRoot);
    for (const raw of options.store.list<unknown>('asset-recovery-job')) {
      const parsed = savedSchema.safeParse(raw); if (!parsed.success) continue;
      const record = parsed.data; jobs.set(record.job.id, record);
      if (record.staged.length || record.abandoned.length) { await cleanupStaging(record); save(record); }
      if (['checking', 'scanning', 'repairing'].includes(record.job.phase)) {
        // Published files already contain verified expected bytes. Keep them; a new explicit scan is repeatable.
        record.job.phase = 'interrupted'; record.job.error = '上次素材恢复已中断，请重新检查并扫描后继续。'; save(record);
      }
    }
  })();
  void ready.catch(() => { /* dispatch/close report initialization failures to their caller. */ });
  async function dispatch(method: string, params: unknown = {}) {
    await ready; if (closing) throw new Error('素材恢复已关闭。');
    if (method === 'asset.recovery.start') {
      const input = assetRecoveryStartSchema.parse(params), now = timestamp();
      const job: AssetRecoveryJob = { id: randomUUID(), generation: 1, ...input, phase: 'checking', createdAt: now, updatedAt: now, progress: { checked: 0, total: 0, scanned: 0, hashed: 0, restored: 0 }, warningCount: 0, warnings: [] };
      const record: SavedJob = { version: 1, job, items: [], staged: [], abandoned: [] }; jobs.set(job.id, record); save(record);
      schedule(record, async signal => { await inspect(record, signal); record.job.phase = 'awaiting_directory'; }); return structuredClone(job);
    }
    if (method === 'asset.recovery.get') {
      const { jobId, generation, offset, limit } = assetRecoveryGetSchema.parse(params), record = get(jobId);
      if (generation !== undefined && generation !== record.job.generation) throw new Error('素材清单已重新扫描，请重新读取第一页。');
      return structuredClone({ job: record.job, items: record.items.slice(offset, offset + limit), nextOffset: offset + limit < record.items.length ? offset + limit : null });
    }
    if (method === 'asset.recovery.cancel') { const record = get(assetRecoveryCancelSchema.parse(params).jobId); active.get(record.job.id)?.controller.abort(new Error('素材恢复已取消。')); return structuredClone(record.job); }
    if (method === 'asset.recovery.scan') {
      const input = assetRecoveryScanSchema.parse(params), record = get(input.jobId); if (active.has(record.job.id)) throw new Error('当前恢复操作尚未结束。');
      record.job.generation++; record.job.phase = 'checking'; record.job.error = undefined; record.job.warningCount = 0; record.job.warnings = []; record.selection = undefined; save(record);
      schedule(record, signal => scan(record, input.directory, signal)); return structuredClone(record.job);
    }
    if (method === 'asset.recovery.confirm') {
      const input = assetRecoveryConfirmSchema.parse(params), record = get(input.jobId), selection = JSON.stringify([...input.selections].sort((left, right) => left.itemId.localeCompare(right.itemId)));
      if (record.job.phase === 'succeeded' && record.selection === selection) return structuredClone(record.job);
      if (active.has(record.job.id)) { if (record.selection === selection) return structuredClone(record.job); throw new Error('当前恢复操作尚未结束。'); }
      if (!record.job.directory || !['awaiting_confirmation', 'failed', 'canceled'].includes(record.job.phase)) throw new Error('请先完成目录扫描并确认候选。');
      for (const { itemId, candidateId } of input.selections) { const item = record.items.find(item => item.id === itemId); if (!item?.candidates.some(candidate => candidate.id === candidateId)) throw new Error('候选不属于当前素材恢复任务。'); }
      record.selection = selection; record.job.phase = 'repairing'; record.job.error = undefined; record.job.progress.restored = 0; save(record);
      schedule(record, signal => repair(record, input.selections, signal)); return structuredClone(record.job);
    }
    throw new Error(`未知素材恢复操作：${method}`);
  }
  return {
    dispatch,
    repairing(projectId: string) {
      return [...active.keys()].some(id => {
        const record = get(id);
        if (record.job.phase !== 'repairing' || !record.selection) return false;
        const selected = new Set((JSON.parse(record.selection) as Array<{ itemId: string }>).map(value => value.itemId));
        return record.items.some(item => selected.has(item.id) && item.expected?.projectId === projectId);
      });
    },
    async waitForIdle() { await ready; while (active.size) await Promise.allSettled([...active.values()].map(value => value.promise)); },
    async close() { closing = true; await ready; for (const job of active.values()) job.controller.abort(new Error('素材恢复已关闭。')); while (active.size) await Promise.allSettled([...active.values()].map(value => value.promise)); },
  };
}
