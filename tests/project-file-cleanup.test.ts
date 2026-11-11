import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assetRecoveryJobSchema, assetRecoveryPageSchema, projectSchema, type AssetRecord, type RunRecord } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src';
import { openDatabase, DocumentStore } from '../packages/runtime/src/database';
import { createLogger } from '../packages/runtime/src/logging';
import { createProjectFileCleanup } from '../packages/runtime/src/project-file-cleanup';
import { audioStemCacheKey } from '../packages/video/src/audio-mix';

const directories: string[] = [], runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => { await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-project-purge-')); directories.push(directory);
  const dataDirectory = join(directory, 'workspace with spaces');
  const open = () => { const runtime = createRuntime({ dataDirectory }); runtimes.add(runtime); return runtime; };
  const runtime = open();
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '待删除项目' }));
  async function file(path: string, content = 'isolated file') { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); return path; }
  async function asset(name: string, content: string, projectId?: string) {
    const source = await file(join(directory, name), content);
    const value = await runtime.dispatch('asset.import', { projectId, path: source }) as AssetRecord;
    return { source, value };
  }
  return { dataDirectory, directory, project, runtime, open, file, asset };
}

it('purges only owned files and derived caches and keeps shared references, exports and portable backups readable', async () => {
  const { runtime, project, dataDirectory, directory, asset, file } = await fixture();
  const live = projectSchema.parse(await runtime.dispatch('project.create', { title: '继续保留的项目' }));
  const own = await asset('private.wav', 'private voice', project.id);
  const duplicate = await asset('duplicate.wav', 'shared voice', project.id);
  const publicAsset = await asset('public.wav', 'shared voice');
  const alias = await asset('same-path.png', 'shared path', project.id);
  const sharedByReference = await asset('referenced.png', 'surviving project reference', project.id);
  const retained = await asset('retained.png', 'retained version', project.id);
  await runtime.dispatch('asset.retain', { assetId: retained.value.id, retained: true });
  const runId = randomUUID(), folder = join(dataDirectory, 'projects', project.id), scratch = join(dataDirectory, 'tool-artifacts', runId);
  const activity = join(folder, 'activities', 'a'.repeat(24)), waveform = join(dataDirectory, 'derived', 'waveforms', 'test-algorithm'), mixes = join(dataDirectory, 'derived', 'audio-mixes');
  const segment = await file(join(activity, `segment-${'b'.repeat(24)}.mp4`), 'render intermediate');
  const render = await file(join(activity, 'video.mp4'), 'built-in export');
  const custom = await file(join(activity, `${'c'.repeat(24)}.mp4`), 'custom export');
  const research = await file(join(folder, 'research', `${'d'.repeat(64)}.json`));
  const toolCache = await file(join(scratch, 'tool', 'scratch.txt'));
  const ownWaveform = await file(join(waveform, `${own.value.sha256}-audio.json`));
  const sharedWaveform = await file(join(waveform, `${duplicate.value.sha256}-audio.json`), 'shared cache');
  const stem = await file(join(mixes, `source-${audioStemCacheKey(own.value, false, 0)}.wav`));
  const stemMetadata = await file(`${stem}.json`, '{}');
  const external = await file(join(directory, 'outside', `${'e'.repeat(24)}.png`), 'external file behind a junction');
  await symlink(dirname(external), join(folder, 'activities', 'f'.repeat(24)), process.platform === 'win32' ? 'junction' : 'dir');

  const database = openDatabase(dataDirectory), store = new DocumentStore(database);
  const publicAlias = { ...alias.value, id: 'public-alias', projectId: undefined };
  try {
    store.put('asset', publicAlias.id, publicAlias);
    store.put('project', live.id, projectSchema.parse({ ...live, shots: [{ id: 'uses-shared', title: '共用素材', narration: '', visualPrompt: '', durationUs: 1_000_000, assetId: sharedByReference.value.id }] }));
    const completed: RunRecord = { id: runId, projectId: project.id, projectRevision: 1, status: 'succeeded', workflowVersion: 1, snapshotDigest: 'fixture', createdAt: project.createdAt, updatedAt: project.updatedAt, events: [], activities: [] };
    store.put('run', runId, completed);
    store.put('run-snapshot', runId, { project, assets: [own.value] });
    const exportAsset = { ...own.value, id: 'rendered-video', path: render, kind: 'video', mimeType: 'video/mp4', size: Buffer.byteLength('built-in export'), sha256: createHash('sha256').update('built-in export').digest('hex') };
    store.put('asset', exportAsset.id, exportAsset);
    store.put('node-result', `${runId}:export`, { videoPath: custom, assets: [exportAsset] });
  } finally { database.close(); }
  const backup = await runtime.dispatch('project.backup', { projectId: project.id, destination: join(scratch, 'backup-copy') }) as { path: string };

  await runtime.dispatch('project.archive', { projectId: project.id });
  await expect(runtime.dispatch('project.deleteMany', { projectIds: [project.id, live.id] })).rejects.toThrow('回收站');
  expect(await readFile(own.value.path, 'utf8')).toBe('private voice');
  expect(await runtime.dispatch('project.deleteMany', { projectIds: [project.id] })).toEqual({ deleted: 1 });
  for (const path of [own.value.path, duplicate.value.path, ownWaveform, stem, stemMetadata, segment, research, toolCache]) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const [path, content] of [
    [own.source, 'private voice'], [publicAsset.value.path, 'shared voice'], [alias.value.path, 'shared path'], [sharedByReference.value.path, 'surviving project reference'],
    [retained.value.path, 'retained version'], [sharedWaveform, 'shared cache'], [render, 'built-in export'], [custom, 'custom export'], [external, 'external file behind a junction'],
  ]) expect(await readFile(path, 'utf8')).toBe(content);
  const existing = await runtime.dispatch('asset.getMany', { assetIds: [own.value.id, duplicate.value.id, alias.value.id, publicAlias.id, sharedByReference.value.id, retained.value.id, 'rendered-video'] }) as AssetRecord[];
  expect(existing.map(value => value.id)).toEqual([publicAlias.id, sharedByReference.value.id, retained.value.id, 'rendered-video']);
  const recovery = assetRecoveryJobSchema.parse(await runtime.dispatch('asset.recovery.start'));
  await runtime.waitForIdle();
  expect(assetRecoveryPageSchema.parse(await runtime.dispatch('asset.recovery.get', { jobId: recovery.id })).items.some(item => item.assetId === own.value.id)).toBe(false);
  expect(projectSchema.parse(JSON.parse(await readFile(join(backup.path, 'project.json'), 'utf8')).project).title).toBe(project.title);
});

it('resumes persisted cleanup and preserves files replaced or shared after the delete transaction', async () => {
  const { runtime, project, dataDirectory, open, asset, file } = await fixture();
  const first = await asset('first.wav', 'old file', project.id), second = await asset('second.txt', 'original second file', project.id);
  const waveform = await file(join(dataDirectory, 'derived', 'waveforms', 'test-algorithm', `${first.value.sha256}-audio.json`), 'becomes shared');
  await runtime.dispatch('project.archive', { projectId: project.id });
  await runtime.close(); runtimes.delete(runtime);

  const database = openDatabase(dataDirectory), store = new DocumentStore(database);
  try {
    const cleanup = createProjectFileCleanup(dataDirectory, store, createLogger({ dataDirectory, component: 'runtime' }));
    database.transaction(() => {
      store.delete('project', project.id);
      expect(cleanup.stage([project], store.list<AssetRecord>('asset'), [])?.files).toHaveLength(3);
    }).immediate();
    const shared = await file(join(dataDirectory, 'projects', 'library', 'assets', 'newly-shared.wav'), 'old file');
    store.put('asset', 'newly-shared', { ...first.value, id: 'newly-shared', projectId: undefined, path: shared });
  } finally { database.close(); }
  await writeFile(second.value.path, 'replacement must survive');
  const restarted = open();
  await expect(stat(first.value.path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(second.value.path, 'utf8')).toBe('replacement must survive');
  expect(await readFile(waveform, 'utf8')).toBe('becomes shared');
  await expect(restarted.dispatch('project.restore', { projectId: project.id })).rejects.toThrow('项目不存在');
});
