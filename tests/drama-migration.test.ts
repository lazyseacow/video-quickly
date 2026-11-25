import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema } from '@video-quickly/contracts';
import { DocumentStore, openDatabase, thumbnailShot, WORKSPACE_MIGRATIONS } from '../src/packages/runtime/src/database';
import { migrateDatabase } from '../src/packages/runtime/src/migrations';

const Database = createRequire(new URL('../src/packages/runtime/package.json', import.meta.url))('better-sqlite3') as new (path: string, options?: { readonly: boolean }) => ReturnType<typeof openDatabase>;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it('upgrades v28 to drama-capable storage while preserving legacy projects, frozen inputs and recovery receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-drama-v28-')); directories.push(directory);
  const previous = new Database(join(directory, 'workspace.sqlite'));
  previous.function('vq_thumbnail', { deterministic: true }, body => JSON.stringify(thumbnailShot(JSON.parse(String(body)))));
  previous.function('vq_upgrade_legacy_project', { deterministic: true }, body => body);
  const previousMigrations = WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 28);
  migrateDatabase(previous, directory, previousMigrations);
  const project = projectSchema.parse({ id: 'old-project', title: '旧项目', brief: '保留已有内容', originalText: '原始小说文本', revision: 8, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(),
    episode: { workId: 'retired-work', number: 3, originalText: '旧分集原文' },
    shots: [{ id: 'old-shot', title: '旧镜头', narration: '保留旁白', visualPrompt: '保留画面', durationUs: 4_000_000 }], createdAt: 'original-time', updatedAt: 'original-time',
  });
  const snapshot = { project, nodes: project.workflow.nodes, handlerVersion: 4, characters: [], characterAssets: [], retainedOpaqueField: { id: 'original-input' } };
  const store = new DocumentStore(previous);
  store.put('project', project.id, project); store.put('run-snapshot', 'original-run', snapshot);
  store.put('media-operation', 'original-run:video:old-shot', { status: 'submitted', remoteTaskId: 'remote-original', inputHash: 'original-hash' });
  previous.prepare("INSERT INTO activities(run_id, activity_id, input_hash, safety, status, remote_id, started_at) VALUES ('original-run', 'video', 'original-hash', 'external', 'unknown', 'remote-original', 'original-time')").run();
  const originalDocuments = previous.prepare("SELECT kind, id, body FROM documents WHERE kind != 'project-summary' ORDER BY rowid").all();
  const originalActivities = previous.prepare('SELECT * FROM activities').all(); previous.close();

  const upgraded = openDatabase(directory);
  try {
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_MIGRATIONS.at(-1)?.version);
    expect(upgraded.prepare("SELECT kind, id, body FROM documents WHERE kind != 'project-summary' ORDER BY rowid").all()).toEqual(originalDocuments);
    expect(upgraded.prepare('SELECT * FROM activities').all()).toEqual(originalActivities);
    expect(new DocumentStore(upgraded).get('project', project.id)).toEqual(project);
    expect(new DocumentStore(upgraded).get('run-snapshot', 'original-run')).toEqual(snapshot);
    expect(new DocumentStore(upgraded).get('project-summary', project.id)).not.toHaveProperty('drama');
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'projects_drama_episode'").get()).toEqual({ name: 'projects_drama_episode' });
    expect(() => migrateDatabase(upgraded, directory, previousMigrations)).toThrow('高于此客户端支持的版本');
  } finally { upgraded.close(); }
  const backups = await readdir(join(directory, 'database-backups'));
  expect(backups).toHaveLength(1);
  const backup = new Database(join(directory, 'database-backups', backups[0]), { readonly: true });
  try {
    expect(backup.pragma('user_version', { simple: true })).toBe(28);
    expect(new DocumentStore(backup).get('project', project.id)).toEqual(project);
    expect(new DocumentStore(backup).get('run-snapshot', 'original-run')).toEqual(snapshot);
  } finally { backup.close(); }
});
