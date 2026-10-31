import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createRuntime } from '../packages/runtime/src/index';
import { DocumentStore, openDatabase, thumbnailShot, WORKSPACE_MIGRATIONS } from '../packages/runtime/src/database';
import { migrateDatabase } from '../packages/runtime/src/migrations';
import type { RunRecord, WorkspaceSnapshot } from '@video-quickly/contracts';
import { fixtureSecretCall, prepareInstalledUpgrade, upgradeFixtureSecret, verifyInstalledUpgrade, verifyUpgradeBackup } from '../scripts/installed-upgrade-fixture.mjs';

const directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it('creates real project, media and credential references through RPC, then resumes its original reviewed activity after reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-upgrade-fixture-')); directories.push(directory);
  const secrets = new Map<string, string>();
  const open = () => {
    const value = createRuntime({ dataDirectory: join(directory, 'workspace'), seed: false, secretStore: {
      persistent: true, async get(key) { return secrets.get(key); },
      async set(key, value) { expect(value).toBe(upgradeFixtureSecret); secrets.set(key, value); },
      async delete(key) { secrets.delete(key); },
    } });
    runtimes.push(value); return value;
  };
  let runtime = open();
  const rpc = (method: string, params = {}) => runtime.dispatch(method, params);
  const wait = async (id: string, status: string) => { await runtime.waitForIdle(); const run = (await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot).runs.find(run => run.id === id)!; expect(run.status).toBe(status); return run as RunRecord; };
  const saved = await prepareInstalledUpgrade(rpc, directory, wait);
  expect(saved.project.shots.find((shot: { id: string }) => shot.id === 'upgrade-shot').assetId).toBe(saved.asset.id);
  expect(secrets.has(saved.model.credentialRef)).toBe(true); expect(JSON.stringify(saved)).not.toContain(upgradeFixtureSecret);
  await runtime.close(); runtime = open();
  expect(await verifyInstalledUpgrade(rpc, saved, wait)).toMatchObject({ originalRunRetained: true, completedActivityReused: true, modelCredentialReferenceRetained: true, nativeCredentialStoreRoundTrip: 'not-tested' });

  // Exercise the snapshot verifier against a real migration, using the v6
  // migration list to create test data; no shipped database is downgraded.
  const legacyDirectory = await mkdtemp(join(tmpdir(), 'vq-upgrade-backup-')); directories.push(legacyDirectory);
  const Database = createRequire(new URL('../packages/runtime/package.json', import.meta.url))('better-sqlite3');
  const legacy = new Database(join(legacyDirectory, 'workspace.sqlite'));
  legacy.function('vq_thumbnail', { deterministic: true }, (body: string) => JSON.stringify(thumbnailShot(JSON.parse(body))));
  migrateDatabase(legacy, legacyDirectory, WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 6));
  const store = new DocumentStore(legacy);
  for (const [kind, value] of [['project', saved.project], ['asset', saved.asset], ['model', saved.model]]) store.put(kind, value.id, value);
  store.put('run', saved.runId, { id: saved.runId, projectId: saved.projectId, status: 'waiting_review' });
  legacy.prepare('INSERT INTO activities(run_id, activity_id, input_hash, safety, status, result, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(saved.runId, saved.activity.id, saved.activity.inputHash, 'local', 'completed', JSON.stringify(saved.activity.result), new Date().toISOString());
  legacy.exec('CREATE TABLE writes (thread_id TEXT, channel TEXT)');
  legacy.prepare('INSERT INTO writes VALUES (?, ?)').run(saved.runId, '__interrupt__'); legacy.close();
  openDatabase(legacyDirectory).close();
  const evidence = await verifyUpgradeBackup(legacyDirectory, { ...saved, schemaVersion: 6 }, Database);
  expect(evidence).toMatchObject({ schemaVersion: 6, quickCheck: 'ok', originalRunRetained: true, nativeReviewCheckpointRetained: true });
  expect(evidence.sha256).toBe(createHash('sha256').update(await readFile(evidence.path)).digest('hex'));
  const corrupt = new Database(evidence.path); corrupt.prepare("DELETE FROM documents WHERE kind = 'model'").run(); corrupt.close();
  await expect(verifyUpgradeBackup(legacyDirectory, { ...saved, schemaVersion: 6 }, Database)).rejects.toThrow('缺少 model');
});
it('limits the host RPC fixture to synthetic model secrets without accessing a native credential store', () => {
  const values = new Map();
  expect(() => fixtureSecretCall('host.secret.set', { key: 'model:fixture', value: 'unexpected-real-key' }, values)).toThrow();
  expect(() => fixtureSecretCall('host.secret.get', { key: 'arbitrary-user-secret' }, values)).toThrow();
  fixtureSecretCall('host.secret.set', { key: 'model:fixture', value: upgradeFixtureSecret }, values);
  expect(fixtureSecretCall('host.secret.get', { key: 'model:fixture' }, values)).toBe(upgradeFixtureSecret);
});
