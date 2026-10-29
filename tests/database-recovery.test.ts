import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DocumentStore, openDatabase } from '../packages/runtime/src/database';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
it('recovers a standalone SQLite snapshot into a new directory and refuses to overwrite it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-recover-')); directories.push(directory);
  const source = openDatabase(join(directory, 'source'));
  new DocumentStore(source).put('project', 'example', { title: '可恢复的项目' });
  const backup = join(directory, 'snapshot.sqlite');
  source.prepare('VACUUM INTO ?').run(backup); source.close();
  const destination = join(directory, '中文恢复目录');
  const command = [resolve('scripts/recover-database.mjs'), '--backup', backup, '--destination', destination];
  expect(spawnSync(process.execPath, command, { encoding: 'utf8' }).status).toBe(0);
  const db = openDatabase(destination);
  try { expect(new DocumentStore(db).get('project', 'example')).toEqual({ title: '可恢复的项目' }); } finally { db.close(); }
  const before = await readFile(join(destination, 'workspace.sqlite'));
  expect(spawnSync(process.execPath, command, { encoding: 'utf8' }).status).not.toBe(0);
  expect(await readFile(join(destination, 'workspace.sqlite'))).toEqual(before);
});
