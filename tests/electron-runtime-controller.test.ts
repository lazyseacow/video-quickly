import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RuntimeController } from '../apps/desktop/electron/runtime-controller.mjs';
import { createLogger } from '../packages/runtime/src/logging.js';

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
  const project = await controller.request('project.create', { title: 'Electron工作区重启恢复', templateId: 'history-handdrawn' });
  await controller.request('workflow.save', { projectId: project.id, revision: project.revision, workflow: { ...project.workflow, id: 'controller-custom-review', nodes: project.workflow.nodes.map((node: { id: string }) => node.id === 'style' ? { ...node, requiresReview: true } : node) } });
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

it.each(['start', 'reconnect'] as const)('waits for %s readiness before dispatching concurrent reads or starting their request deadlines', async operation => {
  const path = await directory(), script = join(path, 'fixture.mjs');
  await writeFile(script, `import {createInterface} from 'node:readline';
setTimeout(()=>console.log(JSON.stringify({method:'runtime.ready'})),450);
createInterface({input:process.stdin}).on('line',line=>{
  const q=JSON.parse(line);
  if(q.method==='disconnect')process.exit(0);
  console.log(JSON.stringify({id:q.id,result:q.method}));
});`);
  const controller = own({ command: process.execPath, args: [script], requestTimeoutMs: 300 });
  if (operation === 'reconnect') {
    await controller.start();
    await expect(controller.request('disconnect')).rejects.toThrow(/失联|退出/);
  }
  const connecting = controller[operation]();
  await expect(Promise.all([controller.request('workspace.summary'), controller.request('project.get')])).resolves.toEqual(['workspace.summary', 'project.get']);
  expect(await connecting).toMatchObject({ state: 'ready', generation: operation === 'start' ? 1 : 2 });
});

it('rejects reads waiting on failed startup without replaying them after explicit reconnect', async () => {
  const path = await directory(), script = join(path, 'fixture.mjs'), calls = join(path, 'calls');
  await writeFile(script, `console.log(JSON.stringify({method:'runtime.failed'}));process.stdin.resume();`);
  const controller = own({ command: process.execPath, args: [script, calls] });
  const startup = expect(controller.start()).rejects.toThrow('工作区无法打开');
  await expect(controller.request('workspace.summary')).rejects.toThrow('未连接');
  await startup;
  expect(controller.status().state).toBe('disconnected');
  await writeFile(script, `import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
console.log(JSON.stringify({method:'runtime.ready'}));
createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);appendFileSync(process.argv[2],q.method+'\\n');console.log(JSON.stringify({id:q.id,result:'ready'}));});`);
  await controller.reconnect();
  expect(await controller.request('workspace.summary')).toBe('ready');
  expect(await readFile(calls, 'utf8')).toBe('workspace.summary\n');
});

it('rejects waiting startup reads when the application begins closing', async () => {
  const path = await directory(), script = join(path, 'fixture.mjs'), calls = join(path, 'calls');
  await writeFile(script, `import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
setTimeout(()=>console.log(JSON.stringify({method:'runtime.ready'})),100);
createInterface({input:process.stdin}).on('line',line=>appendFileSync(process.argv[2],line));`);
  let closing: Promise<unknown> | undefined;
  const controller = own({ command: process.execPath, args: [script, calls], onSpawn: () => { closing = controller.close(); } });
  const startup = controller.start();
  const request = expect(controller.request('workspace.summary')).rejects.toThrow('未连接');
  await Promise.all([startup, request]);
  await closing;
  await expect(readFile(calls, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(controller.status().state).toBe('disconnected');
});

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
  const startup = expect(controller.start()).rejects.toThrow('启动未完成');
  await expect(controller.request('workspace.summary')).rejects.toThrow('未连接');
  await startup;
  expect(events.some(event => event.type === 'runtime.ready' || event.data?.state === 'ready')).toBe(false);
  expect(controller.status().state).toBe('disconnected');
});

it('keeps credentials behind the host boundary and reports startup failures without hanging shutdown', async () => {
  const path = await directory(), script = join(path, 'fixture.mjs');
  const logger = createLogger({ dataDirectory: path, component: 'desktop', level: 'debug' }).child({ component: 'runtime-controller' });
  await writeFile(script, `import {createInterface} from 'node:readline'; console.log(JSON.stringify({method:'runtime.ready'}));
const input=createInterface({input:process.stdin});let original;
input.on('line',line=>{const q=JSON.parse(line);if(q.method){original=q.id; console.log(JSON.stringify({id:'host-1',method:'host.secret.get',params:{key:'fixture'}}));}
else console.log(JSON.stringify({id:original,result:q.result}));});`);
  const hostCalls: unknown[] = [];
  const controller = own({ command: process.execPath, args: [script], logger, hostRequest: async (method: string, params: unknown) => { hostCalls.push([method, params]); return 'test-only'; } });
  await controller.start(); expect(await controller.request('fixture')).toBe('test-only');
  expect(hostCalls).toEqual([['host.secret.get', { key: 'fixture' }]]);
  const missing = own({ command: join(path, 'does-not-exist'), logger, readyTimeoutMs: 1_000, shutdownTimeoutMs: 100 });
  await expect(missing.start()).rejects.toThrow('无法启动');
  expect(missing.status().state).toBe('disconnected');
  const log = await readFile(join(path, 'logs', 'desktop.log'), 'utf8');
  expect(log).toContain('"event":"runtime.spawn_failed"');
  expect(log).not.toContain('test-only');
  expect(log).not.toContain('does-not-exist');
});

it('persists correlated lifecycle and RPC logs without protocol payloads or provider output', async () => {
  const path = await directory(), script = join(path, 'fixture.mjs');
  await writeFile(script, `import {createInterface} from 'node:readline';
process.stderr.write('provider-stderr-fixture-secret\\n');
console.log(JSON.stringify({method:'runtime.ready'}));
createInterface({input:process.stdin}).on('line',line=>{
  const q=JSON.parse(line);
  if(q.method==='project.create')console.log(JSON.stringify({id:q.id,error:{message:'provider-error-fixture-secret https://private.example/api?token=fixture'}}));
  else if(q.method==='project.archive')process.stdout.write('malformed-fixture-secret\\n');
  else console.log(JSON.stringify({id:q.id,result:q.params.secret}));
});`);
  const logger = createLogger({ dataDirectory: path, component: 'desktop', level: 'debug' }).child({ component: 'runtime-controller' });
  const controller = own({ command: process.execPath, args: [script], logger });
  await controller.start();
  expect(await controller.request('project.get', { secret: 'rpc-input-output-fixture-secret' })).toBe('rpc-input-output-fixture-secret');
  await expect(controller.request('project.create', { prompt: 'private-prompt-fixture-secret' })).rejects.toThrow('provider-error-fixture-secret');
  expect(await controller.request('unknown-method-fixture-secret', { secret: 'unknown-result-fixture-secret' })).toBe('unknown-result-fixture-secret');
  await expect(controller.request('project.archive')).rejects.toThrow('无效消息');
  await controller.close();
  const text = await readFile(join(path, 'logs', 'desktop.log'), 'utf8');
  const records: Array<Record<string, unknown>> = text.trim().split('\n').map(line => JSON.parse(line));
  expect(records).toContainEqual(expect.objectContaining({ event: 'runtime.spawned', generation: 1, childPid: expect.any(Number) }));
  expect(records).toContainEqual(expect.objectContaining({ event: 'rpc.completed', requestId: 1, method: 'project.get', generation: 1, durationMs: expect.any(Number) }));
  expect(records).toContainEqual(expect.objectContaining({ event: 'rpc.failed', requestId: 2, method: 'project.create', reason: 'runtime_error' }));
  expect(records).toContainEqual(expect.objectContaining({ event: 'rpc.completed', requestId: 3, method: 'unknown' }));
  expect(records).toContainEqual(expect.objectContaining({ event: 'runtime.disconnected', reason: 'invalid_json', generation: 1 }));
  expect(records).toContainEqual(expect.objectContaining({ event: 'rpc.aborted', requestId: 4, method: 'project.archive', reason: 'invalid_json' }));
  expect(records.every(record => record.component === 'runtime-controller' && record.schemaVersion === 1 && typeof record.time === 'string' && typeof record.runtimeSessionId === 'string')).toBe(true);
  expect(text).not.toContain('fixture-secret');
  expect(text).not.toContain('private.example');
});

it('records request deadlines and unexpected exits across actual sidecar generations', async () => {
  const path = await directory(), script = join(path, 'fixture.mjs');
  await writeFile(script, `import {createInterface} from 'node:readline';
console.log(JSON.stringify({method:'runtime.ready'}));
createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.method==='project.archive')process.exit(9);});`);
  const logger = createLogger({ dataDirectory: path, component: 'desktop' }).child({ component: 'runtime-controller' });
  const controller = own({ command: process.execPath, args: [script], logger, requestTimeoutMs: 150 });
  await controller.start();
  await expect(controller.request('project.get')).rejects.toThrow('超时');
  expect((await controller.reconnect()).generation).toBe(2);
  await expect(controller.request('project.archive')).rejects.toThrow(/失联|退出/);
  await controller.close();
  const records: Array<Record<string, unknown>> = (await readFile(join(path, 'logs', 'desktop.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(records).toContainEqual(expect.objectContaining({ event: 'rpc.timeout', level: 'error', requestId: 1, method: 'project.get', generation: 1, durationMs: expect.any(Number) }));
  expect(records).toContainEqual(expect.objectContaining({ event: 'runtime.exited', level: 'error', generation: 2, exitCode: 9, reason: 'nonzero_exit' }));
});

it.skipIf(process.platform === 'win32')('records a sidecar killed by a signal as abnormal even when cleanup starts before exit is delivered', async () => {
  const path = await directory(), script = join(path, 'fixture.mjs');
  await writeFile(script, `import {createInterface} from 'node:readline';
console.log(JSON.stringify({method:'runtime.ready'}));
createInterface({input:process.stdin}).on('line',()=>process.kill(process.pid,'SIGKILL'));`);
  const logger = createLogger({ dataDirectory: path, component: 'desktop' }).child({ component: 'runtime-controller' });
  const controller = own({ command: process.execPath, args: [script], logger });
  await controller.start();
  await expect(controller.request('project.get')).rejects.toThrow(/失联|退出/);
  await controller.close();
  const records: Array<Record<string, unknown>> = (await readFile(join(path, 'logs', 'desktop.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(records).toContainEqual(expect.objectContaining({ event: 'runtime.exited', level: 'error', generation: 1, signal: 'SIGKILL', reason: 'unexpected_exit' }));
});

it('keeps an ordinary requested sidecar shutdown at info level', async () => {
  const path = await directory(), script = join(path, 'fixture.mjs');
  await writeFile(script, `console.log(JSON.stringify({method:'runtime.ready'}));process.stdin.resume();`);
  const logger = createLogger({ dataDirectory: path, component: 'desktop' }).child({ component: 'runtime-controller' });
  const controller = own({ command: process.execPath, args: [script], logger });
  await controller.start();
  await controller.close();
  const records: Array<Record<string, unknown>> = (await readFile(join(path, 'logs', 'desktop.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(records).toContainEqual(expect.objectContaining({ event: 'runtime.exited', level: 'info', generation: 1, exitCode: 0, reason: 'requested_stop' }));
  expect(records.some(record => record.level === 'error')).toBe(false);
});
