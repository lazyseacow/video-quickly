import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function close(server: Server) { return new Promise<void>((resolveClose, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolveClose()); }); }
async function listen(server: Server) {
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Launcher fixture did not acquire a local port');
  return address.port;
}
async function fixture() {
  const directory = resolve(await mkdtemp(join(tmpdir(), 'vq-desktop-launcher-')));
  const part = relative(resolve(tmpdir()), directory);
  if (isAbsolute(part) || part.startsWith('..') || !part.startsWith('vq-desktop-launcher-')) throw new Error('Launcher fixture must remain inside its temporary root');
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const desktop = join(directory, 'apps', 'desktop'), modules = join(desktop, 'node_modules');
  await Promise.all([mkdir(join(directory, 'scripts')), ...['vite/bin', 'electron', 'tsx'].map(name => mkdir(join(modules, name), { recursive: true }))]);
  await copyFile(resolve('scripts/desktop.mjs'), join(directory, 'scripts', 'desktop.mjs'));
  await Promise.all([
    writeFile(join(desktop, 'package.json'), JSON.stringify({ main: 'electron-entry.cjs' })),
    writeFile(join(modules, 'electron', 'package.json'), JSON.stringify({ main: 'index.cjs' })),
    writeFile(join(modules, 'electron', 'index.cjs'), 'module.exports = process.execPath;'),
    writeFile(join(modules, 'tsx', 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' })),
    writeFile(join(modules, 'tsx', 'index.mjs'), 'export {};'),
    writeFile(join(modules, 'vite', 'package.json'), JSON.stringify({ type: 'module' })),
    writeFile(join(desktop, 'electron-entry.cjs'), `
const {writeFileSync} = require('node:fs');
const {join} = require('node:path');
writeFileSync(join(process.env.VQ_LAUNCHER_FIXTURE, 'electron.json'), JSON.stringify({
  url: process.env.VIDEO_QUICKLY_DEV_URL,
  runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  args: process.argv.slice(2)
}));
`),
    writeFile(join(modules, 'vite', 'bin', 'vite.js'), `
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const directory = process.env.VQ_LAUNCHER_FIXTURE;
const args = process.argv.slice(2), port = Number(args[args.indexOf('--port') + 1]);
if (!args.includes('--strictPort')) throw new Error('Fixture requires strict port ownership');
writeFileSync(join(directory, 'vite.json'), JSON.stringify({pid: process.pid, parentPid: process.ppid, native: process.env.VIDEO_QUICKLY_NATIVE_DESKTOP}));
const server = createServer((request, response) => {
  writeFileSync(join(directory, 'probe.json'), JSON.stringify({method: request.method, url: request.url}));
  response.end('<!doctype html><title>Owned Vite fixture</title>');
});
server.on('error', error => { console.error(error.code); process.exit(1); });
// Delay the owned bind so the launcher cannot mistake another server's HTTP 200
// for its own readiness before strict-port failure is reported.
if (process.env.VQ_LAUNCHER_OUTPUT === 'occupied') await delay(350);
server.listen(port, '127.0.0.1', async () => {
  const url = 'http://127.0.0.1:' + port + '/';
  if (process.env.VQ_LAUNCHER_OUTPUT === 'plain') process.stdout.write(url + '\\n');
  else if (process.env.VQ_LAUNCHER_OUTPUT === 'colored') process.stdout.write('\\x1b[36mhttp://127.0.0.1:\\x1b[1m' + port + '\\x1b[22m/\\x1b[39m\\n');
  else {
    const pieces = ['\\x1b[36mhttp://127.0.0.1:\\x1b[', '1m' + String(port).slice(0, 2), String(port).slice(2) + '\\x1b[22', 'm/\\x1b[39m\\n'];
    for (const piece of pieces) { process.stdout.write(piece); await delay(75); }
  }
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`),
  ]);
  return { directory, command: join(directory, 'scripts', 'desktop.mjs') };
}

function run(f: Awaited<ReturnType<typeof fixture>>, port: number, output: string) {
  const env = { ...process.env, VIDEO_QUICKLY_PORT: String(port), VIDEO_QUICKLY_DATA_DIR: join(f.directory, 'workspace'), VQ_LAUNCHER_FIXTURE: f.directory, VQ_LAUNCHER_OUTPUT: output, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NO_COLOR; delete env.FORCE_COLOR;
  const child = spawn(process.execPath, [f.command, 'dev', '--fixture-electron'], { cwd: f.directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Desktop launcher did not finish: ${stdout}\n${stderr}`)), 8_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolveExit({ code, stdout, stderr }); });
  });
  cleanups.push(async () => {
    const owned = await readFile(join(f.directory, 'vite.json'), 'utf8').then(value => JSON.parse(value) as { pid: number; parentPid: number }, () => undefined);
    if (owned && owned.parentPid === child.pid && Number.isSafeInteger(owned.pid)) {
      try { process.kill(owned.pid, 'SIGTERM'); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await result.catch(() => {});
  });
  return result;
}

it.each(['plain', 'colored', 'split'] as const)('starts Electron after owned HTTP readiness with %s Vite output', async output => {
  const f = await fixture(), reservation = createServer();
  const port = await listen(reservation); await close(reservation);
  const result = await run(f, port, output);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(await readFile(join(f.directory, 'electron.json'), 'utf8'))).toEqual({ url: `http://127.0.0.1:${port}`, runAsNode: null, args: ['--fixture-electron'] });
  expect(JSON.parse(await readFile(join(f.directory, 'probe.json'), 'utf8'))).toEqual({ method: 'GET', url: '/' });
  expect(JSON.parse(await readFile(join(f.directory, 'vite.json'), 'utf8')).native).toBe('1');
  if (output !== 'plain') expect(result.stdout).toContain('\u001b[1m');
});

it('never probes an unrelated server or starts Electron when the owned strict-port Vite fails', async () => {
  const f = await fixture(); let foreignRequests = 0;
  const foreign = createServer((_request, response) => { foreignRequests++; response.end('Unrelated development session'); });
  const port = await listen(foreign); cleanups.push(() => close(foreign));
  const result = await run(f, port, 'occupied');
  expect(result.code).not.toBe(0); expect(result.stderr).toContain('EADDRINUSE'); expect(result.stderr).toContain('开发服务器退出');
  expect(foreignRequests).toBe(0);
  await expect(readFile(join(f.directory, 'electron.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});
