import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync, readFileSync, unlinkSync, type BigIntStats } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import type { AssetRecord, AudioMixJob, ProjectDocument } from '@video-quickly/contracts';
import { audioStemCacheKey } from '@video-quickly/video/audio-mix';
import { z } from 'zod';
import type { DocumentStore } from './database.js';
import { logError, type DiagnosticLogger } from './logging.js';

const cleanupKind = 'project-file-cleanup';
export const projectFilesPurgedKind = 'project-files-purged';
const cleanupSchema = z.object({ id: z.string().uuid(), files: z.array(z.object({ path: z.string(), identity: z.string(), audioSource: z.string().optional() })) });
type Cleanup = z.infer<typeof cleanupSchema>;
type AssetReference = Pick<AssetRecord, 'id' | 'path' | 'kind' | 'sha256'>;
const directoryId = /^[a-z\d_-]+$/i;
const finalRenderFiles = new Set(['video.mp4', 'cover.png', 'subtitles.srt', 'timeline.json']);
// The renderer writes deliverables beside segments and partial files, and media tasks reuse the same activity layout.
const activityCache = /^(?:[a-f0-9]{24}\.(?:(?:png|mp4)(?:\.tmp|\.[a-f0-9-]{36}\.mp4)?|receipt\.json(?:\.[a-f0-9-]{36}\.tmp)?)|segment-[a-f0-9]{24}\.(?:mp4(?:\.json)?|partial\.mp4(?:\.part-\d+\.mp4|\.parts\.txt)?)|segments\.txt|video\.partial\.mp4|subtitles\.ass)$/i;
const audioCache = /^(?:mix|source)-[a-f0-9]{64}\.wav(?:\.json|\.levels)?$/i;
const sourceKey = (asset: AssetReference) => `${asset.sha256}-${asset.kind}`;
const pathKey = (path: string) => process.platform === 'linux' ? path : path.toLowerCase();
const identity = (file: BigIntStats) => `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;

/** Discover owned files before committing project removal and retry only those file identities. */
export function createProjectFileCleanup(directory: string, store: DocumentStore, logger: DiagnosticLogger) {
  const root = realpathSync(directory), database = store.database;
  function workspacePath(path: string) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return undefined;
    return [directory, root].map(base => relative(base, path)).find(part => part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
  }
  function entry(part: string) {
    const names = part.split(sep);
    if (isAbsolute(part) || names.some(name => !name || name === '.' || name === '..' || /[:\\/\0]/.test(name)
      || process.platform === 'win32' && /[. ]$/.test(name))) return undefined;
    let path = root, info: BigIntStats | undefined;
    for (const [index, name] of names.entries()) {
      path = join(path, name);
      info = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (!info || info.isSymbolicLink() || (index < names.length - 1 && !info.isDirectory())) return undefined;
    }
    return pathKey(relative(root, realpathSync(path))) === pathKey(part) ? info : undefined;
  }
  function children(part: string) {
    return entry(part)?.isDirectory() ? readdirSync(join(root, part)) : [];
  }
  function referencePaths(references: readonly Pick<AssetReference, 'path'>[]) {
    const paths = new Set<string>();
    for (const { path } of references) {
      const part = workspacePath(path);
      if (!part || paths.has(pathKey(part))) continue;
      paths.add(pathKey(part));
      try {
        const canonical = workspacePath(realpathSync(path));
        if (canonical) paths.add(pathKey(canonical));
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(String(error.code)))) throw error;
      }
    }
    return paths;
  }
  function exportsInWorkspace() {
    const paths = database.prepare<[], { path: string }>(`
      SELECT field.value AS path FROM documents d, json_each(d.body) field
      WHERE d.kind IN ('node-result', 'export-batch-result') AND field.key IN ('videoPath', 'coverPath', 'subtitlePath', 'timelinePath') AND field.type = 'text'
      UNION SELECT json_extract(body, '$.config.destination') FROM documents
      WHERE kind = 'node-definition' AND json_extract(body, '$.kind') = 'export' AND json_type(body, '$.config.destination') = 'text'
    `).all();
    return referencePaths(paths);
  }
  function frozenReferences() {
    const rows = database.prepare<[], { body: string }>(`
      SELECT asset.value AS body FROM documents d, json_each('["assets","characterAssets"]') field, json_each(d.body, '$.' || field.value) asset
      WHERE d.kind IN ('run-snapshot', 'export-batch-snapshot', 'prompt-session-snapshot')
        AND EXISTS (SELECT 1 FROM documents p WHERE p.kind = 'project' AND p.id = json_extract(d.body, '$.project.id'))
        AND asset.type = 'object'
    `).all();
    return rows.map(row => JSON.parse(row.body) as AssetReference);
  }
  function stage(projects: readonly ProjectDocument[], assets: readonly AssetRecord[], audioJobs: readonly AudioMixJob[]): Cleanup | undefined {
    // Project documents have already been removed in the enclosing transaction, so the index contains surviving references.
    const projectIds = new Set(projects.map(project => project.id));
    const exports = exportsInWorkspace();
    const owned = assets.filter(asset => {
      const part = workspacePath(asset.path), [area, owner, folder, ...rest] = part?.split(sep) ?? [];
      return part && asset.projectId && projectIds.has(asset.projectId) && area === 'projects' && owner === asset.projectId && owner.toLowerCase() !== 'library'
        && ['assets', 'activities'].includes(folder) && !asset.retained && !exports.has(pathKey(part))
        && !rest.some(name => ['backups', 'exports'].includes(name.toLowerCase()))
        && !(folder === 'activities' && finalRenderFiles.has(basename(part).toLowerCase()));
    });
    const ownedIds = new Set(owned.map(asset => asset.id)), frozen = frozenReferences();
    const ids = JSON.stringify([...ownedIds]);
    const shared = new Set(database.prepare<[string, string], { id: string }>(`
      SELECT DISTINCT asset_id AS id FROM project_asset_references WHERE asset_id IN (SELECT value FROM json_each(?))
      UNION SELECT field.atom AS id FROM documents d, json_tree(d.body) field
      WHERE d.kind IN ('character', 'series-template') AND field.type = 'text' AND field.atom IN (SELECT value FROM json_each(?))
    `).all(ids, ids).map(row => row.id));
    for (const reference of frozen) shared.add(reference.id);
    const assetsById = new Map(assets.map(asset => [asset.id, asset]));
    for (const asset of assets) {
      if (ownedIds.has(asset.id) && !shared.has(asset.id)) continue;
      for (let source = asset.derivation?.sourceAssetId; source && !shared.has(source); source = assetsById.get(source)?.derivation?.sourceAssetId) shared.add(source);
    }
    const removed = owned.filter(asset => !shared.has(asset.id)), removedIds = new Set(removed.map(asset => asset.id));
    const kept = [...assets.filter(asset => !removedIds.has(asset.id)), ...frozen];
    const protectedPaths = referencePaths(kept), keptSources = new Set(kept.map(sourceKey));
    const exclusiveSources = new Set(removed.filter(asset => ['audio', 'video'].includes(asset.kind) && !keptSources.has(sourceKey(asset))).map(sourceKey));
    const files = new Map<string, Cleanup['files'][number]>();
    function add(path: string, audioSource?: string) {
      const key = pathKey(path);
      if (exports.has(key) || protectedPaths.has(key) || files.has(key)) return;
      const info = entry(path);
      if (info?.isFile()) files.set(key, { path, identity: identity(info), audioSource });
    }
    function matching(folder: string, pattern: RegExp) {
      for (const name of children(folder)) if (pattern.test(name)) add(join(folder, name));
    }
    function scratch(folder: string) {
      const stack = [folder];
      while (stack.length) {
        const current = stack.pop()!, entries = children(current);
        if (entries.some(name => ['project.json', '.export-batch.json'].includes(name.toLowerCase()))) continue;
        for (const name of entries) {
          const path = join(current, name);
          if (entry(path)?.isDirectory()) {
            if (!['exports', 'backups'].includes(name.toLowerCase()) && !name.toLowerCase().startsWith('vq-edit-')) stack.push(path);
          } else add(path);
        }
      }
    }
    for (const asset of removed) add(workspacePath(asset.path)!);
    for (const id of projectIds) {
      if (!directoryId.test(id) || id.toLowerCase() === 'library') continue;
      const folder = join('projects', id);
      matching(join(folder, 'assets'), /^(?:[a-f0-9-]{36}|image-[a-f0-9]{64}-\d+(?:-[a-f0-9]{64})?)\.[a-z\d]+\.part$/i);
      matching(join(folder, 'research'), /^[a-f0-9]{64}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/i);
      matching(join(folder, 'tool-artifacts'), /^[a-f0-9-]{36}\.[a-z\d]+(?:\.part)?$/i);
      const activities = join(folder, 'activities');
      for (const name of children(activities)) {
        if (!/^[a-f0-9]{24}$/i.test(name)) continue;
        const activity = join(activities, name), audio = join(activity, 'audio');
        matching(activity, activityCache);
        matching(audio, audioCache);
        for (const temporary of children(audio)) if (/^\.mix-[a-z\d]{6}$/i.test(temporary)) scratch(join(audio, temporary));
      }
    }
    const runs = database.prepare<[string], { id: string }>("SELECT id FROM documents WHERE kind = 'run' AND json_extract(body, '$.projectId') IN (SELECT value FROM json_each(?))").all(JSON.stringify([...projectIds]));
    for (const { id } of runs) if (directoryId.test(id)) scratch(join('tool-artifacts', id));

    const mixes = join('derived', 'audio-mixes');
    for (const job of audioJobs) {
      const path = job.result && workspacePath(job.result.path);
      const paths = [join(mixes, `mix-${job.key}.wav`)];
      if (path?.startsWith(`${mixes}${sep}`)) paths.push(path);
      for (const mix of paths) for (const suffix of ['', '.json', '.levels']) add(`${mix}${suffix}`);
    }
    if (exclusiveSources.size) {
      const waveforms = join('derived', 'waveforms');
      for (const algorithm of children(waveforms)) for (const key of exclusiveSources) if (/^[a-f0-9]{64}-(audio|video)$/.test(key)) add(join(waveforms, algorithm, `${key}.json`), key);
      const legacyStems = new Map(removed.filter(asset => exclusiveSources.has(sourceKey(asset))).map(asset => [audioStemCacheKey(asset, false, 0), sourceKey(asset)]));
      for (const project of projects) for (const shot of project.shots) {
        const voice = shot.audioAssetId && assetsById.get(shot.audioAssetId);
        if (voice && exclusiveSources.has(sourceKey(voice)) && shot.audioProcessing?.denoise) legacyStems.set(audioStemCacheKey(voice, true, shot.audioProcessing.noiseReductionDb), sourceKey(voice));
      }
      for (const name of children(mixes)) {
        const match = /^source-([a-f0-9]{64})\.wav\.json$/.exec(name);
        if (!match) continue;
        const metadata = join(mixes, name), info = entry(metadata);
        if (!info?.isFile() || info.size > 4096n) continue;
        let source: { sourceSha256?: string; sourceKind?: string } | null;
        try { source = JSON.parse(readFileSync(join(root, metadata), 'utf8')); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; continue; }
        const key = legacyStems.get(match[1]) ?? `${source?.sourceSha256}-${source?.sourceKind}`;
        if (exclusiveSources.has(key)) {
          add(metadata.slice(0, -'.json'.length), key); add(metadata, key);
        }
      }
    }
    for (const asset of removed) store.delete('asset', asset.id);
    for (const id of projectIds) store.put(projectFilesPurgedKind, id, {});
    if (!files.size) return undefined;
    const job = { id: randomUUID(), files: [...files.values()] };
    store.put(cleanupKind, job.id, job);
    return job;
  }
  function finish(job: Cleanup) {
    const report = (error: unknown) => logger.warn('project.file_cleanup_pending', { requestId: job.id, error: logError(error) });
    try {
      const references = [...store.list<AssetRecord>('asset'), ...frozenReferences()];
      const protectedPaths = referencePaths(references), exports = exportsInWorkspace(), protectedAudio = new Set(references.map(sourceKey));
      for (const job of store.list<AudioMixJob>('audio-mix-job')) {
        const path = job.result && workspacePath(job.result.path);
        if (path) for (const suffix of ['', '.json', '.levels']) protectedPaths.add(pathKey(`${path}${suffix}`));
      }
      const files = job.files.filter(file => {
        const parts = file.path.split(sep), [area, owner, folder] = parts;
        if (!(parts.length > 3 && area === 'projects' && owner.toLowerCase() !== 'library' && ['assets', 'activities', 'research', 'tool-artifacts'].includes(folder)
          || parts.length > 2 && (area === 'tool-artifacts' && directoryId.test(owner) || area === 'derived' && ['audio-mixes', 'waveforms'].includes(owner)))) return false;
        try {
          const key = pathKey(file.path);
          if (protectedPaths.has(key) || exports.has(key) || file.audioSource && protectedAudio.has(file.audioSource)) return false;
          const info = entry(file.path);
          if (info?.isFile() && identity(info) === file.identity) unlinkSync(join(root, file.path));
          return false;
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
          report(error);
          return true;
        }
      });
      if (files.length) store.put(cleanupKind, job.id, { ...job, files });
      else store.delete(cleanupKind, job.id);
      return files.length;
    } catch (error) {
      report(error);
      return job.files.length;
    }
  }
  return { stage, finish, resume() {
    for (const value of store.list<unknown>(cleanupKind)) {
      const job = cleanupSchema.safeParse(value);
      if (job.success) finish(job.data);
    }
  } };
}
