import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

it.skipIf(process.platform !== 'win32')('Windows kills the actual runtime and encoder process tree when their owning main process is forcibly terminated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-electron-job-'));
  const script = join(directory, 'owner.mjs');
  const containerUrl = pathToFileURL(resolve('apps/desktop/electron/windows-job.mjs')).href;
  // Wait for the owner to assign its job before starting a descendant encoder.
  const childCode = `const {spawn}=require('node:child_process');process.stdin.once('data',()=>{const encoder=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(JSON.stringify({runtime:process.pid,encoder:encoder.pid}));});`;
  await writeFile(script, `import {spawn} from 'node:child_process';
import {windowsJobContainer} from ${JSON.stringify(containerUrl)};
const contain=await windowsJobContainer();
const runtime=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['pipe','pipe','inherit'],windowsHide:true});
const container=contain(runtime);
runtime.stdout.pipe(process.stdout);
runtime.stdin.write('begin\\n');
process.on('SIGTERM',()=>{container.close();process.exit();});`);
  const owner = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const descendants: number[] = []; let diagnostics = '';
  owner.stderr.on('data', chunk => { diagnostics += String(chunk); });
  try {
    const tree = await new Promise<{ runtime: number; encoder: number }>((resolveTree, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Job owner did not become ready: ${diagnostics}`)), 15_000);
      const input = createInterface({ input: owner.stdout });
      input.once('line', line => { clearTimeout(timeout); resolveTree(JSON.parse(line)); });
      owner.once('exit', code => { clearTimeout(timeout); reject(new Error(`Job owner exited ${code}: ${diagnostics}`)); });
    });
    descendants.push(tree.runtime, tree.encoder);
    expect(alive(tree.runtime)).toBe(true); expect(alive(tree.encoder)).toBe(true);
    // SIGKILL maps to TerminateProcess on Windows. Do not use taskkill /T here:
    // it is specifically the OS job closing that must kill both descendants.
    owner.kill('SIGKILL');
    await expect.poll(() => descendants.map(pid => alive(pid)), { timeout: 10_000 }).toEqual([false, false]);
  } finally {
    if (owner.pid && alive(owner.pid)) spawnSync('taskkill.exe', ['/PID', String(owner.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    for (const pid of descendants) if (alive(pid)) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
