import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RuntimeController } from '../apps/desktop/electron/runtime-controller.mjs';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'vq-electron-controller-'));
  cleanups.push(() => rm(path, { recursive: true, force: true })); return path;
}
function own(options: ConstructorParameters<typeof RuntimeController>[0]) {
  const controller = new RuntimeController(options); cleanups.push(() => controller.close()); return controller;
}

it('reconnects the actual Node runtime once and preserves project data and the original review', async () => {
  const path = await directory(), events: unknown[] = [];
  const controller = own({ command: process.execPath, args: ['--import', 'tsx', resolve('packages/runtime/src/main.ts'), '--data-dir', path], cwd: resolve('.'), onEvent: (event: unknown) => events.push(event) });
  expect(await controller.start()).toMatchObject({ state: 'ready', generation: 1 });
  const project = await controller.request('project.create', { title: 'Electron工作区重启恢复' });
  const run = await controller.request('run.start', { projectId: project.id, nodeId: 'style' });
  await expect.poll(async () => (await controller.request('run.inspect', { runId: run.id })).run.status, { timeout: 15_000 }).toBe('waiting_review');
  const before = await controller.request('run.activities', { runId: run.id });
  await controller.close();
  const reopened = own({ command: process.execPath, args: ['--import', 'tsx', resolve('packages/runtime/src/main.ts'), '--data-dir', path], cwd: resolve('.') });
  const [first, second] = await Promise.all([reopened.reconnect(), reopened.reconnect()]);
  expect(first.generation).toBe(1); expect(second.generation).toBe(1);
  expect((await reopened.request('project.get', { projectId: project.id })).project.title).toBe(project.title);
  expect((await reopened.request('run.inspect', { runId: run.id })).run.status).toBe('waiting_review');
  expect(await reopened.request('run.activities', { runId: run.id })).toEqual(before);
  expect(events).toContainEqual({ type: 'runtime.ready' });
}, 30_000);

it('rejects an ambiguous timed-out write without replaying it, and serializes concurrent reconnects', async () => {
  const path = await directory(), script = join(path, 'fixture.mjs'), calls = join(path, 'calls');
  await writeFile(script, `import {appendFileSync} from 'node:fs'; import {createInterface} from 'node:readline';
console.log(JSON.stringify({method:'runtime.ready'}));
createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);appendFileSync(process.argv[2],q.method+'\\n'); if(q.method==='ping')console.log(JSON.stringify({id:q.id,result:'pong'}));});`);
  const controller = own({ command: process.execPath, args: [script, calls], requestTimeoutMs: 300, shutdownTimeoutMs: 1_000 });
  await controller.start();
  await expect(controller.request('write')).rejects.toThrow('超时');
  await expect(controller.request('write')).rejects.toThrow('未连接');
  const states = await Promise.all([controller.reconnect(), controller.reconnect(), controller.reconnect()]);
  expect(states.map((state: { generation: number }) => state.generation)).toEqual([2, 2, 2]);
  expect(await controller.request('ping')).toBe('pong');
  expect(await readFile(calls, 'utf8')).toBe('write\nping\n');
  await expect(controller.request('host.secret.get', { key: 'never-read' })).rejects.toThrow('不能由界面调用');
});

it('requires explicit reconnect after a malformed generation, even if that process later announces ready', async () => {
  const path = await directory(), script = join(path, 'fixture.mjs');
  await writeFile(script, `import {createInterface} from 'node:readline'; console.log(JSON.stringify({method:'runtime.ready'}));
createInterface({input:process.stdin}).on('line',()=>{process.stdout.write('invalid json\\n'+JSON.stringify({method:'runtime.ready'})+'\\n');});`);
  const controller = own({ command: process.execPath, args: [script] });
  await controller.start();
  await expect(controller.request('fixture')).rejects.toThrow('无效消息');
  // Both lines arrive in one write; readline dispatches them before this resumes.
  expect(controller.status().state).toBe('disconnected');
  await expect(controller.request('fixture')).rejects.toThrow('未连接');
  expect((await controller.reconnect()).generation).toBe(2);
});

it('releases its OS process container and reaps a child when containment fails before readiness', async () => {
  const path = await directory(), script = join(path, 'fixture.mjs');
  await writeFile(script, `console.log(JSON.stringify({method:'runtime.ready'}));process.stdin.resume();`);
  let releases = 0, pid = 0;
  const controller = own({ command: process.execPath, args: [script], onSpawn: (child: { pid: number }) => { pid = child.pid; return { close() { releases++; } }; } });
  await controller.start(); await controller.close(); expect(releases).toBe(1);
  expect(() => process.kill(pid, 0)).toThrow();
  await writeFile(script, 'process.stdin.resume();');
  const failed = own({ command: process.execPath, args: [script], onSpawn: (child: { pid: number }) => { pid = child.pid; throw new Error('containment unavailable'); } });
  await expect(failed.start()).rejects.toThrow('containment unavailable');
  expect(failed.status().state).toBe('disconnected');
  expect(() => process.kill(pid, 0)).toThrow();
});

it('never announces ready after its startup deadline while the failed process is being reaped', async () => {
  const path = await directory(), script = join(path, 'fixture.mjs'), events: Array<{ type: string; data?: { state: string } }> = [];
  await writeFile(script, `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({method:'runtime.ready'}));setInterval(()=>{},1000);});`);
  const controller = own({ command: process.execPath, args: [script], readyTimeoutMs: 100, shutdownTimeoutMs: 100, onEvent: (event: { type: string }) => events.push(event) });
  await expect(controller.start()).rejects.toThrow('启动未完成');
  expect(events.some(event => event.type === 'runtime.ready' || event.data?.state === 'ready')).toBe(false);
  expect(controller.status().state).toBe('disconnected');
});

it('keeps credentials behind the host boundary and reports startup failures without hanging shutdown', async () => {
  const path = await directory(), script = join(path, 'fixture.mjs');
  await writeFile(script, `import {createInterface} from 'node:readline'; console.log(JSON.stringify({method:'runtime.ready'}));
const input=createInterface({input:process.stdin});let original;
input.on('line',line=>{const q=JSON.parse(line);if(q.method){original=q.id; console.log(JSON.stringify({id:'host-1',method:'host.secret.get',params:{key:'fixture'}}));}
else console.log(JSON.stringify({id:original,result:q.result}));});`);
  const hostCalls: unknown[] = [];
  const controller = own({ command: process.execPath, args: [script], hostRequest: async (method: string, params: unknown) => { hostCalls.push([method, params]); return 'test-only'; } });
  await controller.start(); expect(await controller.request('fixture')).toBe('test-only');
  expect(hostCalls).toEqual([['host.secret.get', { key: 'fixture' }]]);
  const missing = own({ command: join(path, 'does-not-exist'), readyTimeoutMs: 1_000, shutdownTimeoutMs: 100 });
  await expect(missing.start()).rejects.toThrow('无法启动');
  expect(missing.status().state).toBe('disconnected');
});
