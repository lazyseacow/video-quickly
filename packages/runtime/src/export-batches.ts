import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { assetSchema, characterProfileSchema, exportBatchSchema, exportTargetSchema, projectSchema, type AssetRecord, type CharacterProfile, type ExportBatch, type ExportBatchTarget, type ProjectDocument } from '@video-quickly/contracts';
import { DocumentStore } from './database.js';

export interface ExportBatchSnapshot { project: ProjectDocument; assets: AssetRecord[]; characters: CharacterProfile[]; characterAssets: AssetRecord[] }
export interface BatchRenderResult { videoPath: string; coverPath: string; subtitlePath: string; timelinePath: string; assets: AssetRecord[] }
export interface ExportBatchOptions {
  database: Database.Database; store: DocumentStore; dataDirectory: string; onChanged(): void;
  capture(projectId: string, revision: number): ExportBatchSnapshot;
  currentRevision(projectId: string): number;
  projectBusy(projectId: string, exceptBatchId?: string): boolean;
  createRun(batch: ExportBatch, target: ExportBatchTarget, snapshot: ExportBatchSnapshot): string;
  executeRun(runId: string, signal: AbortSignal, rebuild: boolean): Promise<BatchRenderResult>;
  abortRun(runId: string, interrupted: boolean): void;
}

const snapshotSchema = z.object({ project: projectSchema, assets: z.array(assetSchema), characters: z.array(characterProfileSchema), characterAssets: z.array(assetSchema) });
const resultSchema = z.object({ videoPath: z.string().min(1), coverPath: z.string().min(1), subtitlePath: z.string().min(1), timelinePath: z.string().min(1), assets: z.array(assetSchema) });
const outputFiles = [ ['videoPath', 'video', 'video.mp4'], ['coverPath', 'image', 'cover.png'], ['subtitlePath', 'subtitle', 'subtitles.srt'], ['timelinePath', 'document', 'timeline.json'] ] as const;
const batchIdInput = z.object({ batchId: z.string().min(1), projectId: z.string().optional() });
const timestamp = () => new Date().toISOString();

export function batchTargetDirectory(root: string, targetId: string): string {
  return join(root, `target-${createHash('sha256').update(targetId).digest('hex').slice(0, 16)}`);
}

async function verifyAssets(assets: AssetRecord[], signal?: AbortSignal) {
  for (const asset of assets) {
    signal?.throwIfAborted();
    const info = await stat(asset.path).catch(() => undefined);
    if (!asset.active || !info?.isFile() || info.size !== asset.size) throw new Error(`素材「${asset.name}」缺失或大小已变更。`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(asset.path, { signal })) hash.update(chunk);
    if (hash.digest('hex') !== asset.sha256) throw new Error(`素材「${asset.name}」校验失败，无法使用固定导出快照。`);
  }
}

export async function verifyBatchRenderResult(value: unknown, signal?: AbortSignal): Promise<BatchRenderResult> {
  const result = resultSchema.parse(value);
  if (outputFiles.some(([field, kind]) => !result.assets.some(asset => asset.path === result[field] && asset.kind === kind))) throw new Error('导出运行未返回完整的四类产物。');
  await verifyAssets(result.assets, signal);
  return result;
}

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

async function publish(batch: ExportBatch, target: ExportBatchTarget, source: BatchRenderResult, signal: AbortSignal): Promise<BatchRenderResult> {
  const root = batch.destinationDirectory;
  if (!root) throw new Error('批量导出缺少专用输出目录。');
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('批量导出目录已变更，请恢复原目录后继续。');
  const owner = z.object({ version: z.literal(1), batchId: z.string() }).parse(JSON.parse(await readFile(join(root, '.export-batch.json'), 'utf8')));
  if (owner.batchId !== batch.id) throw new Error('输出目录不属于当前批量导出。');
  const directory = batchTargetDirectory(root, target.id);
  try { await mkdir(directory); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('目标输出目录已被替换，无法写入。');
  const receiptPath = join(directory, '.outputs.json');
  const receiptSchema = z.object({ batchId: z.string(), targetId: z.string(), files: z.record(z.string(), z.string()) });
  let receipt = { batchId: batch.id, targetId: target.id, files: {} as Record<string, string> };
  try { receipt = receiptSchema.parse(JSON.parse(await readFile(receiptPath, 'utf8'))); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error('目标输出归属记录无效，请核对目录。', { cause: error }); }
  if (receipt.batchId !== batch.id || receipt.targetId !== target.id) throw new Error('目标输出目录不属于当前导出规格。');
  const result = { ...source, assets: [] as AssetRecord[] };
  for (const [field, kind, filename] of outputFiles) {
    signal.throwIfAborted();
    const asset = source.assets.find(asset => asset.path === source[field] && asset.kind === kind);
    if (!asset) throw new Error('导出运行没有返回完整的产物校验记录。');
    const destination = join(directory, filename);
    const existing = await lstat(destination).catch(error => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; });
    if (existing && receipt.files[filename] === undefined) throw new Error(`输出位置已有文件「${filename}」，请移走该文件后继续。`);
    // Reserve only this batch's own canonical path before publishing, allowing safe local rebuild after interruption.
    receipt.files[filename] = asset.sha256;
    await atomicJson(receiptPath, receipt);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try { await copyFile(asset.path, temporary, constants.COPYFILE_EXCL); signal.throwIfAborted(); await rename(temporary, destination); }
    finally { await rm(temporary, { force: true }); }
    result[field] = destination;
    result.assets.push({ ...asset, path: destination });
  }
  return result;
}

export function createExportBatchManager(options: ExportBatchOptions) {
  const { database, store } = options;
  type Job = { controller: AbortController; promise: Promise<void>; interrupted: boolean };
  const active = new Map<string, Job>();
  const starting = new Set<string>();
  let closed = false;
  const resultId = (batchId: string, targetId: string) => `${batchId}:${targetId}`;
  function get(id: string) { const value = store.get('export-batch', id); if (!value) throw new Error('批量导出不存在。'); return exportBatchSchema.parse(value); }
  function save(value: ExportBatch) { const next = exportBatchSchema.parse({ ...value, revision: value.revision + 1, updatedAt: timestamp() }); store.put('export-batch', next.id, next); options.onChanged(); return next; }
  function targetUpdate(id: string, targetId: string, patch: Partial<ExportBatchTarget>) { const batch = get(id); return save({ ...batch, targets: batch.targets.map(target => target.id === targetId ? { ...target, ...patch } : target) }); }
  function blocked(projectId: string, exceptId?: string) {
    return starting.has(projectId) || Boolean(database.prepare("SELECT 1 FROM documents WHERE kind = 'export-batch' AND json_extract(body, '$.projectId') = ? AND id <> ? AND json_extract(body, '$.status') IN ('queued','running','interrupted') LIMIT 1").get(projectId, exceptId ?? ''));
  }
  function snapshot(id: string) { return snapshotSchema.parse(store.get('export-batch-snapshot', id)); }
  async function completedResult(batchId: string, targetId: string, signal: AbortSignal): Promise<boolean> {
    const value = store.get('export-batch-result', resultId(batchId, targetId));
    if (!value) return false;
    try { await verifyBatchRenderResult(value, signal); return true; }
    catch (error) { if (signal.aborted) throw error; return false; }
  }
  function schedule(id: string) {
    if (active.has(id)) return;
    if (closed) throw new Error('批量导出服务正在关闭。');
    const controller = new AbortController();
    const job: Job = { controller, interrupted: false, promise: Promise.resolve().then(async () => {
      const frozen = snapshot(id);
      save({ ...get(id), status: 'running', error: undefined });
      for (const original of get(id).targets) {
        if (controller.signal.aborted) break;
        let batch = get(id), target = batch.targets.find(item => item.id === original.id)!;
        if (target.status === 'succeeded' && await completedResult(id, target.id, controller.signal)) continue;
        const rebuild = target.status === 'succeeded';
        try {
          await verifyAssets(frozen.assets, controller.signal);
          controller.signal.throwIfAborted();
          const runId = target.runId ?? options.createRun(batch, target, frozen);
          targetUpdate(id, target.id, { runId, status: 'running', progress: 0, error: undefined });
          target = get(id).targets.find(item => item.id === target.id)!;
          const rendered = await verifyBatchRenderResult(await options.executeRun(runId, controller.signal, rebuild), controller.signal);
          const output = await publish(get(id), target, rendered, controller.signal);
          await verifyAssets(output.assets, controller.signal);
          store.put('export-batch-result', resultId(id, target.id), output);
          targetUpdate(id, target.id, { status: 'succeeded', progress: 1, error: undefined, videoPath: output.videoPath, coverPath: output.coverPath, subtitlePath: output.subtitlePath, timelinePath: output.timelinePath });
        } catch (error) {
          targetUpdate(id, target.id, { status: controller.signal.aborted ? job.interrupted ? 'interrupted' : 'canceled' : 'failed', error: controller.signal.aborted ? job.interrupted ? '导出已中断，请继续。' : '已取消当前导出。' : error instanceof Error ? error.message : String(error) });
        }
      }
      const latest = get(id);
      if (controller.signal.aborted) {
        save({ ...latest, status: job.interrupted ? 'interrupted' : 'canceled', targets: latest.targets.map(target => target.status === 'queued' ? { ...target, status: job.interrupted ? 'queued' : 'canceled' } : target), error: job.interrupted ? '上次批量导出已中断，请继续。' : undefined });
      } else {
        const succeeded = latest.targets.filter(target => target.status === 'succeeded').length;
        save({ ...latest, status: succeeded === latest.targets.length ? 'succeeded' : succeeded ? 'partial' : 'failed', error: undefined });
      }
    }).catch(error => { if (store.get('export-batch', id)) save({ ...get(id), status: controller.signal.aborted ? job.interrupted ? 'interrupted' : 'canceled' : 'failed', error: error instanceof Error ? error.message : String(error) }); }).finally(() => { if (active.get(id) === job) active.delete(id); }) };
    active.set(id, job);
  }

  // Restart never starts FFmpeg by itself. The user can inspect and explicitly resume the frozen batch.
  const pending = database.prepare("SELECT body FROM documents WHERE kind = 'export-batch' AND json_extract(body, '$.status') IN ('queued','running')").all() as { body: string }[];
  for (const row of pending) {
    const batch = exportBatchSchema.parse(JSON.parse(row.body));
    save({ ...batch, status: 'interrupted', error: '上次批量导出已中断，请继续。', targets: batch.targets.map(target => target.status === 'running' ? { ...target, status: 'interrupted', error: '上次导出已中断。' } : target) });
  }

  return {
    blocked,
    progress(batchId: string, targetId: string, value: number) {
      if (!Number.isFinite(value) || !active.has(batchId)) return;
      const target = get(batchId).targets.find(target => target.id === targetId);
      const progress = Math.max(0, Math.min(.97, value));
      if (target?.status === 'running' && Math.floor(progress * 100) > Math.floor(target.progress * 100)) targetUpdate(batchId, targetId, { progress });
    },
    async dispatch(method: string, rawParams: unknown = {}) {
      if (method === 'render.batch.start') {
        const input = z.object({ projectId: z.string().min(1), revision: z.number().int().positive(), targets: z.array(exportTargetSchema).min(1).max(8), destinationDirectory: z.string().min(1).optional() }).parse(rawParams);
        if (new Set(input.targets.map(target => target.id)).size !== input.targets.length) throw new Error('批量导出规格编号不能重复。');
        if (closed || blocked(input.projectId) || options.projectBusy(input.projectId)) throw new Error('该项目已有未完成的运行或批量导出，请先继续或取消。');
        starting.add(input.projectId);
        let ownedDirectory: string | undefined, stored = false;
        try {
          const frozen = options.capture(input.projectId, input.revision), id = randomUUID();
          const parent = resolve(input.destinationDirectory ?? join(options.dataDirectory, 'projects', input.projectId, 'exports'));
          await mkdir(parent, { recursive: true });
          const destinationDirectory = join(parent, `batch-${id}`); await mkdir(destinationDirectory); ownedDirectory = destinationDirectory;
          await writeFile(join(destinationDirectory, '.export-batch.json'), JSON.stringify({ version: 1, batchId: id }), { flag: 'wx' });
          if (options.currentRevision(input.projectId) !== input.revision) throw new Error('项目已在其他视图修改，请重新打开批量导出。');
          const createdAt = timestamp();
          const batch = exportBatchSchema.parse({ id, revision: 1, projectId: input.projectId, projectRevision: input.revision, status: 'queued', targets: input.targets.map(target => ({ ...target, status: 'queued', progress: 0 })), destinationDirectory, createdAt, updatedAt: createdAt });
          database.transaction(() => { store.put('export-batch-snapshot', id, frozen); store.put('export-batch', id, batch); })(); stored = true; options.onChanged(); schedule(id); return batch;
        } finally {
          starting.delete(input.projectId);
          if (ownedDirectory && !stored) {
            await rm(join(ownedDirectory, '.export-batch.json'), { force: true });
            await rmdir(ownedDirectory).catch(error => { if (!(error instanceof Error && 'code' in error && (error.code === 'ENOTEMPTY' || error.code === 'EEXIST'))) throw error; });
          }
        }
      }
      if (method === 'render.batch.list') {
        const input = z.object({ projectId: z.string().optional(), before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(20) }).parse(rawParams);
        const rows = database.prepare("SELECT rowid AS cursor, body FROM documents WHERE kind = 'export-batch' AND (? IS NULL OR rowid < ?) AND (? IS NULL OR json_extract(body, '$.projectId') = ?) ORDER BY rowid DESC LIMIT ?").all(input.before ?? null, input.before ?? null, input.projectId ?? null, input.projectId ?? null, input.limit + 1) as { cursor: number; body: string }[];
        return { items: rows.slice(0, input.limit).map(row => exportBatchSchema.parse(JSON.parse(row.body))), nextCursor: rows.length > input.limit ? rows[input.limit - 1].cursor : null };
      }
      const input = batchIdInput.parse(rawParams);
      let batch = get(input.batchId);
      if (input.projectId && batch.projectId !== input.projectId) throw new Error('批量导出不属于当前项目。');
      if (method === 'render.batch.get') return batch;
      if (method === 'render.batch.cancel') {
        if (batch.status === 'succeeded' && !active.has(batch.id)) return batch;
        const job = active.get(batch.id);
        job?.controller.abort(new Error('用户取消批量导出'));
        for (const target of batch.targets) if (target.status === 'running' || target.status === 'interrupted' || target.status === 'queued') if (target.runId) options.abortRun(target.runId, false);
        save({ ...get(batch.id), status: 'canceled', error: undefined, targets: get(batch.id).targets.map(target => target.status === 'queued' || target.status === 'interrupted' ? { ...target, status: 'canceled' } : target) });
        await job?.promise;
        return get(batch.id);
      }
      if (method === 'render.batch.resume') {
        const job = active.get(batch.id);
        if (job && !job.controller.signal.aborted) return get(batch.id);
        if (job) { await job.promise; batch = get(batch.id); }
        if (closed || blocked(batch.projectId, batch.id) || options.projectBusy(batch.projectId, batch.id)) throw new Error('该项目已有其他运行，请完成或取消后继续批量导出。');
        const resumed = save({ ...batch, status: 'queued', error: undefined, targets: batch.targets.map(target => target.status === 'succeeded' ? target : { ...target, status: 'queued', error: undefined, progress: 0 }) });
        schedule(batch.id); return resumed;
      }
      throw new Error(`未知批量导出操作：${method}`);
    },
    async waitForIdle() { await Promise.allSettled([...active.values()].map(job => job.promise)); },
    async close() {
      closed = true;
      for (const [id, job] of active) {
        if (!job.controller.signal.aborted) { job.interrupted = true; job.controller.abort(new Error('运行环境关闭，批量导出中断')); }
        for (const target of get(id).targets) if (target.status === 'running' && target.runId) options.abortRun(target.runId, true);
      }
      await Promise.allSettled([...active.values()].map(job => job.promise));
    },
  };
}
