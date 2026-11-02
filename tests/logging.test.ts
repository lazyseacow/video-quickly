import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createLogger, logError } from '../packages/runtime/src/logging.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-日志 logging-')); directories.push(directory); return directory;
}
async function records(directory: string, file = 'runtime.log') {
  return (await readFile(join(directory, 'logs', file), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

it('preserves current readiness and recovery RPC labels without accepting unknown method words', async () => {
  const directory = await fixture(), logger = createLogger({ dataDirectory: directory, component: 'runtime' });
  const methods = ['project.readiness', 'project.readiness.cancel', 'asset.recovery.start', 'asset.recovery.get', 'asset.recovery.scan', 'asset.recovery.confirm', 'asset.recovery.cancel'];
  for (const method of methods) logger.info('rpc.completed', { method });
  const privateWord = 'private-provider-token';
  logger.info('rpc.failed', { method: `project.${privateWord}` });
  logger.info('rpc.failed', { method: 'run.retry' });
  expect((await records(directory)).map(record => record.method)).toEqual([...methods, 'unknown', 'unknown']);
  expect(await readFile(join(directory, 'logs/runtime.log'), 'utf8')).not.toContain(privateWord);
});

it('writes structured records with stable correlation and safe exception locations, excluding private content', async () => {
  const directory = await fixture();
  const logger = createLogger({ dataDirectory: directory, component: 'runtime', level: 'info' });
  const secret = 'fixture-private-credential';
  const error = Object.assign(new TypeError(`authorization=Bearer ${secret}`), { code: 'ETIMEDOUT', status: 503 });
  error.stack = `${error.name}: ${error.message}\n    at provider (/private/customer-folder/worker.ts:42:7)\n    at https://api.example.test/?key=${secret}`;
  logger.debug('rpc.started');
  logger.child({ requestId: secret }).info('rpc.completed', { method: 'project.create', durationMs: 12.45, params: { secret }, result: secret, path: secret, apiKey: secret });
  logger.error('rpc.failed', { requestId: secret, nodeId: secret, method: `project.${secret}`, error: logError(error) });
  const lines = await records(directory);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ schemaVersion: 1, level: 'info', component: 'runtime', event: 'rpc.completed', method: 'project.create', durationMs: 12.45, pid: process.pid });
  expect(Number.isNaN(Date.parse(lines[0].time))).toBe(false);
  expect(lines[0].runtimeSessionId).toBe(lines[1].runtimeSessionId);
  expect(lines[0].requestId).toBe(lines[1].requestId);
  expect(lines[1]).toMatchObject({ method: 'unknown', error: { name: 'TypeError', code: 'ETIMEDOUT', statusCode: 503, frames: [expect.stringMatching(/^sha256:[a-f0-9]{16}:42:7$/)] } });
  const text = JSON.stringify(lines);
  for (const privateValue of [secret, 'customer-folder', 'api.example.test', 'authorization', 'params', 'apiKey']) expect(text).not.toContain(privateValue);
  if (process.platform !== 'win32') expect((await stat(join(directory, 'logs/runtime.log'))).mode & 0o077).toBe(0);
});

it('omits provider-defined error codes even when they resemble system codes', async () => {
  const directory = await fixture(), logger = createLogger({ dataDirectory: directory, component: 'runtime' });
  const privateCode = 'EPRIVATE_PROVIDER_TOKEN';
  logger.error('rpc.failed', { error: Object.assign(new Error('private-provider-body'), { code: privateCode }) });
  logger.error('rpc.failed', { error: Object.assign(new Error('private-provider-body'), { code: 'EACCES' }) });
  const text = await readFile(join(directory, 'logs/runtime.log'), 'utf8');
  expect(text).not.toContain(privateCode);
  const lines = await records(directory);
  expect(lines[0].error.code).toBeUndefined();
  expect(lines[1].error.code).toBe('EACCES');
});

it('hashes stack basenames from POSIX, Windows and preformatted errors while retaining coordinates', async () => {
  const directory = await fixture(), logger = createLogger({ dataDirectory: directory, component: 'runtime' });
  const privateName = 'private-provider-token.ts', error = new Error('private-provider-body');
  error.stack = `${error.name}: ${error.message}\n    at provider (/private/customer/${privateName}:42:7)\n    at provider (C:\\private\\customer\\${privateName}:42:7)`;
  logger.error('rpc.failed', { error: logError(error) });
  logger.error('rpc.failed', { error: { name: 'Error', frames: [`${privateName}:42:7`] } });
  const text = await readFile(join(directory, 'logs/runtime.log'), 'utf8'), lines = await records(directory);
  expect(text).not.toContain(privateName);
  expect(text).not.toContain('private-provider-body');
  expect(lines[0].error.frames).toHaveLength(2);
  expect(lines[0].error.frames[0]).toMatch(/^sha256:[a-f0-9]{16}:42:7$/);
  expect(lines[0].error.frames[1]).toBe(lines[0].error.frames[0]);
  expect(lines[1].error.frames).toEqual([lines[0].error.frames[0]]);
});

it('keeps a bounded current file and one parseable archive while accepting new records', async () => {
  const directory = await fixture();
  const logger = createLogger({ dataDirectory: directory, component: 'runtime', level: 'debug', maxSize: 1024 });
  for (let sequence = 0; sequence < 100; sequence++) logger.debug('rpc.completed', { sequence, method: 'project.get' });
  expect((await readdir(join(directory, 'logs'))).sort()).toEqual(['runtime.log', 'runtime.old.log']);
  const current = await records(directory), previous = await records(directory, 'runtime.old.log');
  expect(current.at(-1).sequence).toBe(99);
  expect(current.length + previous.length).toBeLessThan(100);
  for (const name of ['runtime.log', 'runtime.old.log']) expect((await stat(join(directory, 'logs', name))).size).toBeLessThan(1600);
});

it('removes the entire multiline exception message before parsing stack frames', async () => {
  const directory = await fixture();
  const logger = createLogger({ dataDirectory: directory, component: 'runtime' });
  const secret = 'sk-fixture-private-multiline-token';
  const error = new Error(`provider response\n    at /${secret}:42:7`);
  logger.error('activity.failed', { error: logError(error) });
  const text = await readFile(join(directory, 'logs/runtime.log'), 'utf8');
  expect(text).not.toContain(secret);
  expect(text).not.toContain('provider response');
  expect((await records(directory))[0].error.frames).toContainEqual(expect.stringMatching(/^sha256:[a-f0-9]{16}:\d+:\d+$/));
});

it('degrades to one safe stderr notice when file writing fails and never contaminates stdout', async () => {
  const directory = await fixture();
  await writeFile(join(directory, 'logs'), 'not a directory');
  const script = join(directory, 'fixture.mjs');
  await writeFile(script, `import {createLogger} from ${JSON.stringify(pathToFileURL(resolve('packages/runtime/src/logging.ts')).href)};
const logger=createLogger({dataDirectory:process.argv[2],component:'runtime'});
logger.info('runtime.ready');logger.error('rpc.failed',{error:new Error('fixture-secret-never-forward')});
console.log(JSON.stringify({jsonrpc:'2.0',method:'runtime.ready'}));`);
  const child = spawnSync(process.execPath, ['--import', 'tsx', script, directory], { encoding: 'utf8', timeout: 10_000 });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ jsonrpc: '2.0', method: 'runtime.ready' });
  expect(child.stderr.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(child.stderr)).toMatchObject({ level: 'warn', event: 'logging.file_unavailable' });
  expect(child.stderr).not.toContain(directory);
  expect(child.stderr).not.toContain('fixture-secret-never-forward');
});

it('keeps complete JSON lines and bounded files when the old archive cannot be replaced', async () => {
  const directory = await fixture(), script = join(directory, 'fixture.mjs');
  await writeFile(script, `import {createLogger} from ${JSON.stringify(pathToFileURL(resolve('packages/runtime/src/logging.ts')).href)};
import {mkdirSync,readFileSync,statSync} from 'node:fs';import {join} from 'node:path';
const root=process.argv[2],logger=createLogger({dataDirectory:root,component:'runtime',maxSize:256});
logger.info('runtime.ready',{sequence:0});logger.info('runtime.ready',{sequence:1});
mkdirSync(join(root,'logs/runtime.old.log'));
for(let sequence=2;sequence<100;sequence++)logger.info('runtime.ready',{sequence});
const text=readFileSync(join(root,'logs/runtime.log'),'utf8');
const records=text.trim().split('\\n').map(line=>JSON.parse(line));
console.log(JSON.stringify({count:records.length,size:statSync(join(root,'logs/runtime.log')).size}));`);
  const child = spawnSync(process.execPath, ['--import', 'tsx', script, directory], { encoding: 'utf8', timeout: 10_000 });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({ count: 2 });
  expect(JSON.parse(child.stdout).size).toBeLessThan(800);
  expect(child.stderr.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(child.stderr)).toMatchObject({ event: 'logging.file_unavailable' });
  expect(child.stderr).not.toContain(directory);
});
